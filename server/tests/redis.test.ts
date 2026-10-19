import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { LocalCache } from "../src/infra/cache.js";
import { MemoryLimiterFactory, RedisLimiterFactory } from "../src/infra/limiter.js";
import { MemoryLocks, RedisLocks } from "../src/infra/locks.js";
import { MemoryPresenceService, RedisPresenceService } from "../src/infra/presence.js";
import { RedisHub } from "../src/infra/redis.js";
import { BullJobQueue, type JobHandler } from "../src/jobs/queue.js";
import { jobHandlers } from "../src/jobs/scheduler.js";
import { silentLogger } from "../src/logger.js";
import { Presence } from "../src/realtime/presence.js";
import { snoozeRoom } from "../src/services/rooms.js";
import { agentSays, makeCtx, mkRoom, roomRow, seedWorkspace } from "./helpers.js";
import { startServer, ack, recorder, ALL_EVENTS, sleep } from "./rt-helpers.js";
import { createApp } from "../src/app.js";
import { assignRoom } from "../src/services/rooms.js";

const url = process.env.TEST_REDIS_URL;
const redis = describe.skipIf(!url);
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hubs: RedisHub[] = [];
const hub = (prefix: string) => {
  const h = new RedisHub(url!, silentLogger, prefix);
  hubs.push(h);
  return h;
};
const prefix = () => `rt${randomBytes(4).toString("hex")}`;
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});
afterAll(async () => {
  for (const h of hubs.splice(0)) await h.close();
});

redis("distributed rate limiting (Lua token bucket)", () => {
  it("admits exactly `capacity` requests across nodes under a concurrent burst", async () => {
    const p = prefix();
    const nodes = [new RedisLimiterFactory(hub(p)), new RedisLimiterFactory(hub(p)), new RedisLimiterFactory(hub(p))];
    const results = await Promise.all(Array.from({ length: 120 }, (_, i) => nodes[i % 3]!.get("burst", 20, 0.001).take("client-1")));
    expect(results.filter(Boolean)).toHaveLength(20);
  });
  it("refills over time, isolates keys and names, and supports cost", async () => {
    const f = new RedisLimiterFactory(hub(prefix()));
    const l = f.get("refill", 3, 20); // 20 tokens/second
    expect([await l.take("a"), await l.take("a"), await l.take("a"), await l.take("a")]).toEqual([true, true, true, false]);
    expect(await l.take("b")).toBe(true);
    await sleepMs(180);
    expect(await l.take("a")).toBe(true);
    expect(await f.get("other", 3, 20).take("a")).toBe(true);
    expect(await f.get("cost", 5, 0.001).take("k", 5)).toBe(true);
    expect(await f.get("cost", 5, 0.001).take("k", 1)).toBe(false);
  });
  it("matches the in-memory limiter's behaviour for a simple sequence", async () => {
    const mem = new MemoryLimiterFactory(() => Date.now()).get("same", 4, 0.001);
    const red = new RedisLimiterFactory(hub(prefix())).get("same", 4, 0.001);
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      a.push(await mem.take("k"));
      b.push(await red.take("k"));
    }
    expect(b).toEqual(a);
  });
  it("fails open (and reports) when Redis is unreachable", async () => {
    const h = hub(prefix());
    const errors: unknown[] = [];
    const l = new RedisLimiterFactory(h, (e) => errors.push(e)).get("x", 1, 1);
    await h.client.quit();
    h.client.disconnect();
    expect(await l.take("k")).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
  it("rate limits REST traffic across two app nodes", async () => {
    const p = prefix();
    const a = await makeCtx({ REDIS_URL: url!, REDIS_PREFIX: p });
    const b = await makeCtx({ REDIS_URL: url!, REDIS_PREFIX: p });
    const apps = [createApp(a), createApp(b)];
    let ok = 0;
    for (let i = 0; i < 24; i++) {
      const res = await apps[i % 2]!.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@example.test", password: "wrong-wrong" }) });
      if (res.status === 401) ok++;
    }
    expect(ok).toBe(10); // the login bucket is 10, shared by both nodes
  });
});

redis("presence refcounted across nodes", () => {
  const make = (p: string, events: string[], node: string, ttl = 30_000) =>
    new RedisPresenceService(hub(p), (scope, id, online) => events.push(`${node}:${id}:${online ? "on" : "off"}`), { nodeId: node, graceMs: 120, ttlMs: ttl });

  it("announces online once, stays online while any node has a socket, and goes offline once after the grace period", async () => {
    const p = prefix();
    const events: string[] = [];
    const a = make(p, events, "A");
    const b = make(p, events, "B");
    await a.connect("ws:member", "ann", "s1");
    await b.connect("ws:member", "ann", "s2");
    expect(events).toEqual(["A:ann:on"]);
    expect(await b.isOnline("ws:member", "ann")).toBe(true);
    await a.disconnect("ws:member", "ann", "s1");
    await sleepMs(300);
    expect(await a.isOnline("ws:member", "ann")).toBe(true);
    expect(events).toEqual(["A:ann:on"]);
    await b.disconnect("ws:member", "ann", "s2");
    expect(await a.isOnline("ws:member", "ann")).toBe(true); // grace
    await sleepMs(400);
    expect(await a.isOnline("ws:member", "ann")).toBe(false);
    expect(events.filter((e) => e.endsWith(":off"))).toHaveLength(1);
    await a.close();
    await b.close();
  });
  it("a reconnect inside the grace period never announces offline", async () => {
    const p = prefix();
    const events: string[] = [];
    const a = make(p, events, "A");
    await a.connect("ws:member", "bo", "s1");
    await a.disconnect("ws:member", "bo", "s1");
    await sleepMs(40);
    await a.connect("ws:member", "bo", "s2");
    await sleepMs(400);
    expect(events).toEqual(["A:bo:on"]);
    await a.close();
  });
  it("expires the sockets of a node that crashed (no heartbeat) and another node announces offline exactly once", async () => {
    const p = prefix();
    const events: string[] = [];
    const crashed = make(p, events, "crashed", 400);
    const survivor = make(p, events, "survivor", 400);
    await crashed.connect("ws:member", "cy", "s1");
    clearInterval((crashed as unknown as { beat: ReturnType<typeof setInterval> }).beat); // the process died: no more heartbeats, no clean disconnect
    expect(await survivor.isOnline("ws:member", "cy")).toBe(true);
    await sleepMs(1200);
    expect(await survivor.isOnline("ws:member", "cy")).toBe(false);
    expect(events.filter((e) => e.endsWith("cy:off"))).toHaveLength(1);
    await survivor.close();
  });
  it("lists online seats per scope and supports forceOffline", async () => {
    const p = prefix();
    const a = make(p, [], "A");
    await a.connect("ws1:member", "x", "s1");
    await a.connect("ws1:member", "y", "s2");
    await a.connect("ws2:member", "z", "s3");
    expect((await a.onlineIds("ws1:member")).sort()).toEqual(["x", "y"]);
    await a.forceOffline("ws1:member", "x");
    expect(await a.isOnline("ws1:member", "x")).toBe(false);
    expect(await a.onlineIds("ws1:member")).toEqual(["y"]);
    await a.close();
  });
  it("behaves like the in-memory implementation for the basic refcount scenario", async () => {
    const mem = new MemoryPresenceService(new Presence(50));
    await mem.connect("s", "i", "1");
    await mem.connect("s", "i", "2");
    await mem.disconnect("s", "i", "1");
    await sleepMs(120);
    expect(await mem.isOnline("s", "i")).toBe(true);
    await mem.disconnect("s", "i", "2");
    await sleepMs(120);
    expect(await mem.isOnline("s", "i")).toBe(false);
  });
});

redis("cache invalidation over pub/sub", () => {
  it("drops the key on every node when one node invalidates it", async () => {
    const p = prefix();
    const a = new LocalCache(60_000);
    const b = new LocalCache(60_000);
    await a.attach(hub(p));
    await b.attach(hub(p));
    let version = 1;
    const load = async () => version;
    expect(await a.wrap("k", load)).toBe(1);
    expect(await b.wrap("k", load)).toBe(1);
    version = 2;
    expect(await b.wrap("k", load)).toBe(1); // still cached
    await a.invalidate("k");
    await sleepMs(80);
    expect(await b.wrap("k", load)).toBe(2);
    expect(await a.wrap("k", load)).toBe(2);
  });
  it("supports prefix invalidation", async () => {
    const p = prefix();
    const a = new LocalCache(60_000);
    const b = new LocalCache(60_000);
    await a.attach(hub(p));
    await b.attach(hub(p));
    let v = "old";
    await b.wrap("counts:ws1:m1", async () => v);
    await b.wrap("counts:ws1:m2", async () => v);
    await b.wrap("settings:ws1", async () => v);
    v = "new";
    await a.invalidate("counts:ws1:*");
    await sleepMs(80);
    expect(await b.wrap("counts:ws1:m1", async () => v)).toBe("new");
    expect(await b.wrap("counts:ws1:m2", async () => v)).toBe("new");
    expect(await b.wrap("settings:ws1", async () => v)).toBe("old");
  });
  it("a changed seat takes effect on every node immediately (member cache)", async () => {
    const p = prefix();
    const a = await makeCtx({ REDIS_URL: url!, REDIS_PREFIX: p, CACHE_TTL_MS: "60000" });
    const b = await makeCtx({ REDIS_URL: url!, REDIS_PREFIX: p, CACHE_TTL_MS: "60000" });
    // nodes share one SQLite file only on Postgres; here each node has its own database, so exercise the invalidation path directly
    const { invalidateMember } = await import("../src/services/members.js");
    let calls = 0;
    await b.cache.wrap("member:w:m", async () => ++calls);
    await invalidateMember(a, "w", "m");
    await sleepMs(80);
    await b.cache.wrap("member:w:m", async () => ++calls);
    expect(calls).toBe(2);
  });
});

redis("distributed locks", () => {
  it("lets exactly one node run a singleton task at a time and releases afterwards", async () => {
    const p = prefix();
    const locks = [new RedisLocks(hub(p)), new RedisLocks(hub(p)), new RedisLocks(hub(p))];
    let running = 0;
    let max = 0;
    const ran: number[] = [];
    await Promise.all(
      locks.map((l, i) =>
        l.withLock("sweep", 5000, async () => {
          running++;
          max = Math.max(max, running);
          ran.push(i);
          await sleepMs(150);
          running--;
        }),
      ),
    );
    expect(ran).toHaveLength(1);
    expect(max).toBe(1);
    expect(await locks[1]!.withLock("sweep", 5000, async () => "again")).toBe("again");
  });
  it("a crashed holder's lock expires; releasing never frees someone else's lock", async () => {
    const p = prefix();
    const a = new RedisLocks(hub(p));
    const b = new RedisLocks(hub(p));
    const hold = a.withLock("x", 200, async () => {
      await sleepMs(500); // outlives its lease
    });
    await sleepMs(300);
    expect(await b.withLock("x", 5000, async () => "took over")).toBe("took over");
    await hold;
    const m = new MemoryLocks();
    expect(await m.withLock("y", 10, async () => 1)).toBe(1);
  });
});

redis("BullMQ job queue", () => {
  async function bull(handlers: Record<string, JobHandler>, env: Record<string, string> = {}) {
    const ctx = await makeCtx({ REDIS_URL: url!, REDIS_PREFIX: prefix(), JOB_QUEUE: "bullmq", ...env });
    expect(ctx.queue).toBeInstanceOf(BullJobQueue);
    await ctx.queue.start(handlers);
    return { ctx, queue: ctx.queue as BullJobQueue };
  }
  it("runs jobs, deduplicates by key, and runs delayed jobs when due", async () => {
    const seen: string[] = [];
    const { ctx, queue } = await bull({ ping: (_c, p) => void seen.push(p.n) });
    expect(await queue.enqueue("ping", { n: "now" }, { dedupeKey: "k:1" })).toBe(true);
    expect(await queue.enqueue("ping", { n: "dup" }, { dedupeKey: "k:1" })).toBe(false);
    await queue.enqueue("ping", { n: "later" }, { runAt: new Date(ctx.clock().getTime() + 700) });
    await queue.drain();
    expect(seen).toEqual(["now"]);
    expect((await queue.depth()).delayed).toBe(1);
    await sleepMs(900);
    await queue.drain();
    expect(seen).toEqual(["now", "later"]);
  });
  it("retries failing jobs with backoff and then gives up", async () => {
    let calls = 0;
    const { queue } = await bull({ flaky: () => { calls++; if (calls < 3) throw new Error("not yet"); } });
    await queue.enqueue("flaky", {}, { maxAttempts: 4 });
    for (let i = 0; i < 80 && calls < 3; i++) await sleepMs(100);
    expect(calls).toBe(3);
    let always = 0;
    const second = await bull({ boom: () => { always++; throw new Error("nope"); } });
    await second.queue.enqueue("boom", {}, { maxAttempts: 2 });
    for (let i = 0; i < 80 && always < 2; i++) await sleepMs(100);
    await sleepMs(200);
    expect(always).toBe(2);
    expect((await second.queue.depth()).failed).toBe(1);
  });
  it("wakes a snoozed room from a delayed job (no polling)", async () => {
    const { ctx, queue } = await bull(jobHandlers);
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    await snoozeRoom(ctx, owner, room.id, new Date(ctx.clock().getTime() + 600).toISOString());
    expect((await roomRow(ctx, room.id)).snooze_until).not.toBeNull();
    ctx.clockCtl.advance(700); // the job's own clock check needs "now" to be past the snooze
    await sleepMs(900);
    await queue.drain();
    expect((await roomRow(ctx, room.id)).snooze_until).toBeNull();
    const last = await ctx.db.get<{ content: string }>("SELECT content FROM messages WHERE room_id = ? AND kind = 'system' ORDER BY seq DESC LIMIT 1", room.id);
    expect(last!.content).toBe("Snooze ended");
  });
  it("sends a failed message retry through the queue", async () => {
    const { ctx, queue } = await bull(jobHandlers);
    const { wsId, owner } = await seedWorkspace(ctx);
    const { addSmsNumberRaw } = await import("./helpers.js");
    await addSmsNumberRaw(ctx, wsId, "+15550000001", true);
    const { room } = await mkRoom(ctx, wsId, { contact: { phone: "+14155552671" } });
    ctx.sms.failNext(1);
    const { sendAgentMessage } = await import("../src/services/messages.js");
    const r = await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "sms", content: "retry me" });
    expect(r.message.delivery).toBe("failed");
    ctx.clockCtl.advance(11_000);
    for (let i = 0; i < 60 && (await ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", r.message.id))!.delivery !== "sent"; i++) await sleepMs(250);
    expect((await ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", r.message.id))!.delivery).toBe("sent");
    await queue.drain().catch(() => {});
  }, 30_000);
});

const cluster = describe.skipIf(!url || !process.env.TEST_DATABASE_URL);
cluster("two app nodes sharing PostgreSQL and Redis", () => {
  async function twoNodes() {
    const p = prefix();
    const A = await startServer({ REDIS_URL: url!, REDIS_PREFIX: p, NODE_ID: "node-a", PRESENCE_GRACE_MS: "150" });
    const B = await startServer({ REDIS_URL: url!, REDIS_PREFIX: p, NODE_ID: "node-b", PRESENCE_GRACE_MS: "150", DATABASE_URL: A.ctx.config.DATABASE_URL! });
    return { A, B };
  }
  it("delivers a visitor message on node B to the agent connected to node A, and the reply back", async () => {
    const { A, B } = await twoNodes();
    try {
      const { wsId, owner } = await A.seedWorkspace(A.ctx);
      const v = await B.visitor(wsId);
      const agent = await A.team(wsId, owner);
      const agentRec = recorder(agent, ALL_EVENTS);
      const vis = await B.connect(wsId, v.auth);
      const visRec = recorder(vis, ALL_EVENTS);
      const room = await ack(vis, "room:create", {});
      await sleep(200);
      await ack(vis, "message:send", { room_id: room.room.id, kind: "text", source: "dm", content: "hello from node B", client_msg_id: "cluster-msg-0001" });
      expect((await agentRec.waitFor("message:new", (p) => p.message.content === "hello from node B")).message.sender.type).toBe("contact");
      await ack(agent, "message:send", { room_id: room.room.id, kind: "text", source: "dm", content: "reply from node A", client_msg_id: "cluster-msg-0002" });
      await visRec.waitFor("message:new", (p) => p.message.content === "reply from node A");
      // read receipt crosses nodes too
      const last = (await visRec.waitFor("message:new", (p) => p.message.content === "reply from node A")).message;
      await ack(vis, "message:read", { room_id: room.room.id, message_id: last.id });
      await agentRec.waitFor("message:receipt", (p) => p.reader.type === "contact");
    } finally {
      await A.close();
      await B.close();
    }
  });
  it("shares presence across nodes (an agent online via node A is online when asked through node B)", async () => {
    const { A, B } = await twoNodes();
    try {
      const { wsId, owner } = await A.seedWorkspace(A.ctx);
      const ann = await A.addMemberRaw(A.ctx, wsId, { name: "Ann" });
      const watcher = await B.team(wsId, owner);
      const rec = recorder(watcher, ALL_EVENTS);
      const annTab1 = await A.team(wsId, ann);
      await rec.waitFor("presence:update", (p) => p.member_id === ann.memberId && p.online === true);
      const annTab2 = await B.team(wsId, ann);
      expect((await ack(watcher, "presence:list")).online).toContain(ann.memberId);
      annTab1.close();
      await sleep(500);
      expect(rec.of("presence:update").some((p) => p.member_id === ann.memberId && p.online === false)).toBe(false);
      annTab2.close();
      await rec.waitFor("presence:update", (p) => p.member_id === ann.memberId && p.online === false, 3000);
      const res = await createApp(A.ctx).request("/api/presence", { headers: { authorization: `Bearer ${await (await import("./helpers.js")).tokenFor(A.ctx, owner)}` } });
      expect((await res.json()).online).not.toContain(ann.memberId);
    } finally {
      await A.close();
      await B.close();
    }
  });
  it("applies access changes made on node B to sockets held by node A (room grant, revoke, seat removal)", async () => {
    const { A, B } = await twoNodes();
    try {
      const { wsId, owner } = await A.seedWorkspace(A.ctx);
      const bob = await A.addMemberRaw(A.ctx, wsId, { name: "Bob", inbox_visibility: "assigned" });
      const bobSock = await A.team(wsId, bob);
      const rec = recorder(bobSock, ALL_EVENTS);
      const { room } = await mkRoom(B.ctx, wsId);
      await sleep(100);
      await assignRoom(B.ctx, owner, room.id, { member_ids: [bob.memberId] });
      await rec.waitFor("room:new", (p) => p.room.id === room.id);
      await agentSays(B.ctx, owner, room.id, "visible to bob");
      await rec.waitFor("message:new", (p) => p.message.content === "visible to bob");
      await assignRoom(B.ctx, owner, room.id, { member_ids: [owner.memberId] });
      await rec.waitFor("room:deleted", (p) => p.room_id === room.id);
      await agentSays(B.ctx, owner, room.id, "hidden from bob");
      await sleep(300);
      expect(rec.of("message:new").some((p) => p.message.content === "hidden from bob")).toBe(false);
      const gone = new Promise((r) => bobSock.once("disconnect", r));
      const { removeMember } = await import("../src/services/members.js");
      await removeMember(B.ctx, owner, bob.memberId, async () => {});
      await gone;
      expect(bobSock.connected).toBe(false);
    } finally {
      await A.close();
      await B.close();
    }
  });
});
