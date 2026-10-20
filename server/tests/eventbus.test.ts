import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { KafkaBus, MemoryBus, NatsBus, NotImplementedError, RedisStreamsBus, type BusEvent, type EventBus } from "../src/infra/eventbus.js";
import { RedisHub } from "../src/infra/redis.js";
import { silentLogger } from "../src/logger.js";
import { TOPIC_MESSAGES, once, outboxLag, pruneOutbox, relayOutbox, rollupHandler, startOutbox } from "../src/events/outbox.js";
import { agentSays, makeCtx, mkRoom, seedWorkspace } from "./helpers.js";
import { insertMessage } from "../src/services/messageStore.js";

const url = process.env.TEST_REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error("condition not met in time");
}

const hubs: RedisHub[] = [];
const buses: EventBus[] = [];
afterEach(async () => {
  for (const b of buses.splice(0)) await b.close();
  for (const h of hubs.splice(0)) await h.close();
});
afterAll(async () => {
  for (const h of hubs.splice(0)) await h.close();
});

type Factory = () => { make: () => EventBus };
const factories: [string, Factory, boolean][] = [
  ["memory", () => { const shared = new MemoryBus(4); return { make: () => shared }; }, true],
  [
    "redis-streams",
    () => {
      const prefix = `eb${randomBytes(4).toString("hex")}`;
      return {
        make: () => {
          const h = new RedisHub(url!, silentLogger, prefix);
          hubs.push(h);
          const b = new RedisStreamsBus(h, { partitions: 4, leaseMs: 800, pollMs: 60 });
          return b;
        },
      };
    },
    !!url,
  ],
];

for (const [name, factory, enabled] of factories) {
  describe.skipIf(!enabled)(`EventBus contract: ${name}`, () => {
    const mk = () => {
      const f = factory();
      const bus = f.make();
      buses.push(bus);
      return { f, bus };
    };

    it("delivers every event once to a group and every event to each group", async () => {
      const { bus } = mk();
      const a: string[] = [];
      const b: string[] = [];
      await bus.subscribe({ group: "a", topics: ["t"], handler: async (e) => void a.push(e.id) });
      await bus.subscribe({ group: "b", topics: ["t"], handler: async (e) => void b.push(e.id) });
      const ids = [];
      for (let i = 0; i < 50; i++) ids.push(await bus.publish("t", `k${i % 7}`, { i }));
      await until(() => a.length === 50 && b.length === 50);
      expect(new Set(a)).toEqual(new Set(ids));
      expect(a).toHaveLength(50);
      expect(b).toHaveLength(50);
    });

    it("a subscriber that starts late still receives the backlog", async () => {
      const { bus } = mk();
      for (let i = 0; i < 20; i++) await bus.publish("late", "k", { i });
      const got: number[] = [];
      await bus.subscribe({ group: "g", topics: ["late"], handler: async (e) => void got.push((e.payload as { i: number }).i) });
      await until(() => got.length === 20);
      expect(got).toEqual([...Array(20).keys()]);
    });

    it("preserves order per key, with many keys interleaved and a slow handler", async () => {
      const { bus } = mk();
      const seen = new Map<string, number[]>();
      await bus.subscribe({
        group: "g",
        topics: ["ord"],
        handler: async (e) => {
          if (Math.random() < 0.1) await sleep(3);
          const l = seen.get(e.key) ?? [];
          l.push((e.payload as { n: number }).n);
          seen.set(e.key, l);
        },
      });
      const per = new Map<string, number>();
      for (let i = 0; i < 400; i++) {
        const k = `room${i % 23}`;
        const n = per.get(k) ?? 0;
        per.set(k, n + 1);
        await bus.publish("ord", k, { n });
      }
      await until(() => [...seen.values()].reduce((a, l) => a + l.length, 0) === 400);
      for (const [k, l] of seen) expect(l, k).toEqual([...Array(l.length).keys()]);
    });

    it("competing consumers in one group split the work with no duplicates", async () => {
      const f = factory();
      const b1 = f.make();
      const b2 = f.make();
      buses.push(b1, b2);
      const seen: string[] = [];
      const h = async (e: BusEvent) => {
        await sleep(1);
        seen.push(e.id);
      };
      await b1.subscribe({ group: "g", topics: ["cc"], handler: h });
      await b2.subscribe({ group: "g", topics: ["cc"], handler: h });
      for (let i = 0; i < 120; i++) await b1.publish("cc", `k${i % 11}`, { i });
      await until(() => seen.length >= 120);
      await sleep(200);
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
    });

    it("retries with an increasing attempt count, then succeeds", async () => {
      const { bus } = mk();
      const attempts: number[] = [];
      await bus.subscribe({
        group: "g",
        topics: ["retry"],
        backoffMs: 5,
        handler: async (e) => {
          attempts.push(e.attempt);
          if (e.attempt < 3) throw new Error("flaky");
        },
      });
      await bus.publish("retry", "k", {});
      await until(() => attempts.length >= 3);
      await sleep(50);
      expect(attempts).toEqual([1, 2, 3]);
      expect(await bus.deadLetters("retry", "g")).toEqual([]);
    });

    it("parks a poison event in the dead letters after maxDeliveries and keeps going", async () => {
      const { bus } = mk();
      const ok: number[] = [];
      await bus.subscribe({
        group: "g",
        topics: ["poison"],
        maxDeliveries: 3,
        backoffMs: 5,
        handler: async (e) => {
          if ((e.payload as { bad?: boolean }).bad) throw new Error("cannot process");
          ok.push((e.payload as { n: number }).n);
        },
      });
      await bus.publish("poison", "k", { n: 1 });
      await bus.publish("poison", "k", { bad: true });
      await bus.publish("poison", "k", { n: 3 });
      await until(() => ok.length === 2);
      expect(ok).toEqual([1, 3]);
      await until(async () => (await bus.deadLetters("poison", "g")).length === 1);
      const dl = (await bus.deadLetters("poison", "g"))[0]!;
      expect(dl.error).toContain("cannot process");
      expect(dl.event.attempt).toBe(3);
    });

    it("when a consumer stops mid-stream another consumer of the group takes over and nothing is lost", async () => {
      const f = factory();
      const b1 = f.make();
      const b2 = f.make();
      buses.push(b1, b2);
      const seen = new Map<string, number>();
      const h = async (e: BusEvent) => {
        await sleep(2);
        seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      };
      const s1 = await b1.subscribe({ group: "g", topics: ["fo"], handler: h });
      await b2.subscribe({ group: "g", topics: ["fo"], handler: h });
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) ids.push(await b1.publish("fo", `k${i % 5}`, { i }));
      await sleep(40);
      await s1.close(); // "crash": the first consumer goes away with events still unprocessed
      await until(() => ids.every((id) => seen.has(id)), 12000);
      expect(ids.every((id) => seen.has(id))).toBe(true);
      // at-least-once: an event may be delivered twice around the hand-over, never zero times
      expect([...seen.values()].every((n) => n >= 1)).toBe(true);
    });
  });
}

describe("EventBus adapters that are documented stubs", () => {
  it.each([
    ["kafka", new KafkaBus(["localhost:9092"])],
    ["nats", new NatsBus("nats://localhost:4222")],
  ])("%s fails loudly instead of pretending to work", (_n, bus) => {
    expect(() => bus.publish()).toThrow(NotImplementedError);
    expect(() => bus.subscribe()).toThrow(NotImplementedError);
  });
});

describe("transactional outbox", () => {
  it("an event exists only if the transaction commits, and nothing is published before commit", async () => {
    const ctx = await makeCtx();
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    const published: string[] = [];
    const bus = { publish: async (t: string, k: string, _p: unknown, id: string) => void published.push(id) } as unknown as EventBus;
    await relayOutbox(ctx, bus); // drain whatever setup produced
    published.length = 0;
    const before = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox_events"))!.n;
    await expect(
      ctx.db.tx(async () => {
        await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "agent", senderId: owner.memberId, senderName: "x", kind: "text", source: "dm", content: "boom" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox_events"))!.n).toBe(before);
    expect(await relayOutbox(ctx, bus)).toBe(0);
    await agentSays(ctx, owner, room.id, "committed");
    expect(await relayOutbox(ctx, bus)).toBeGreaterThan(0);
    expect(published.length).toBeGreaterThan(0);
  });

  it("a bus outage loses nothing: unpublished rows stay, and the next pass delivers them in order", async () => {
    const ctx = await makeCtx();
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    for (let i = 0; i < 5; i++) await agentSays(ctx, owner, room.id, `m${i}`);
    const down = { publish: async () => Promise.reject(new Error("bus down")) } as unknown as EventBus;
    await expect(relayOutbox(ctx, down)).rejects.toThrow("bus down");
    expect((await outboxLag(ctx)).unpublished).toBeGreaterThanOrEqual(5);
    const got: number[] = [];
    const up = { publish: async (t: string, k: string, p: { seq: number }) => void (t === TOPIC_MESSAGES && k === room.id && got.push(p.seq)) } as unknown as EventBus;
    await relayOutbox(ctx, up);
    expect((await outboxLag(ctx)).unpublished).toBe(0);
    expect(got).toEqual([...got].sort((a, b) => a - b));
    expect(got.length).toBeGreaterThanOrEqual(5);
  });

  it("crash after publish but before marking republishes; an idempotent consumer applies each event once", async () => {
    const ctx = await makeCtx();
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    for (let i = 0; i < 4; i++) await agentSays(ctx, owner, room.id, `m${i}`);
    const events: BusEvent[] = [];
    const rec = { publish: async (topic: string, key: string, payload: unknown, id: string) => void events.push({ id, topic, key, payload, attempt: 1 }) } as unknown as EventBus;
    await relayOutbox(ctx, rec);
    // simulate the crash: the rows are marked unpublished again
    await ctx.db.run("UPDATE outbox_events SET published_at = NULL");
    await relayOutbox(ctx, rec);
    expect(events.length).toBeGreaterThanOrEqual(8);
    for (const e of events) await rollupHandler(ctx, e);
    const total = (await ctx.db.get<{ n: number }>("SELECT COALESCE(SUM(messages), 0) AS n FROM rollup_messages_daily"))!.n;
    const unique = new Set(events.filter((e) => e.topic === TOPIC_MESSAGES && (e.payload as { sender_type: string }).sender_type !== "system").map((e) => e.id)).size;
    expect(Number(total)).toBe(unique);
  });

  it("once() runs the effect a single time per (consumer, event) and rolls the marker back with a failing effect", async () => {
    const ctx = await makeCtx();
    const ev: BusEvent = { id: "evt_x", topic: "t", key: "k", payload: {}, attempt: 1 };
    let n = 0;
    expect(await once(ctx, "c", ev, async () => void n++)).toBe(true);
    expect(await once(ctx, "c", ev, async () => void n++)).toBe(false);
    expect(await once(ctx, "other", ev, async () => void n++)).toBe(true);
    expect(n).toBe(2);
    await expect(once(ctx, "c2", ev, async () => Promise.reject(new Error("effect failed")))).rejects.toThrow();
    expect(await once(ctx, "c2", ev, async () => void n++)).toBe(true); // marker was rolled back with the failed effect
  });

  it("end to end through a real bus: relay -> consumer group -> rollup table; pruning keeps unpublished rows", async () => {
    const ctx = await makeCtx();
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    const rt = await startOutbox(ctx, 30);
    for (let i = 0; i < 6; i++) await agentSays(ctx, owner, room.id, `out${i}`);
    await until(async () => Number((await ctx.db.get<{ n: number }>("SELECT COALESCE(SUM(messages),0) AS n FROM rollup_messages_daily WHERE direction = 'out'"))!.n) >= 6);
    expect((await outboxLag(ctx)).unpublished).toBe(0);
    ctx.clockCtl.advance(48 * 3600_000);
    await agentSays(ctx, owner, room.id, "unpublished-later");
    expect(await pruneOutbox(ctx, 24)).toBeGreaterThan(0);
    expect((await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox_events WHERE published_at IS NULL"))!.n).toBeGreaterThanOrEqual(1);
    await rt.stop();
    expect(TOPIC_MESSAGES).toBe("message.events");
  });
});
