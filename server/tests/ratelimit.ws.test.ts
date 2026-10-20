import { io as connectIo } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { ack, sleep, startServer } from "./rt-helpers.js";
import { addMemberRaw, makeCtx, mkRoom, seedWorkspace } from "./helpers.js";
import { sendAgentMessage } from "../src/services/messages.js";
import { jobHandlers } from "../src/jobs/scheduler.js";
import { runDueJobs } from "../src/jobs/queue.js";
import { addSmsNumberRaw } from "./helpers.js";

type Srv = Awaited<ReturnType<typeof startServer>>;
const open: Srv[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});
const server = async (env: Record<string, string> = {}) => {
  const s = await startServer(env);
  open.push(s);
  return s;
};

const attempt = (url: string, ws: string, auth: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Promise<{ ok: boolean; code?: string; retry?: number }>((resolve) => {
    const s = connectIo(`${url}/ws/${ws}`, { auth, transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: headers });
    s.once("connect", () => {
      s.close();
      resolve({ ok: true });
    });
    s.once("connect_error", (e: Error & { data?: { code?: string; retry_after_ms?: number } }) => {
      s.close();
      resolve({ ok: false, code: e.data?.code, retry: e.data?.retry_after_ms });
    });
  });

describe("socket handshake and connection limits", () => {
  it("a handshake flood from one IP is refused with RATE_LIMITED and a jittered retry hint", async () => {
    const srv = await server({ WS_CONNECT_RATE_PER_IP: "2" }); // burst max(5, 4) = 5
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Flood");
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, owner);
    const results = await Promise.all(Array.from({ length: 30 }, () => attempt(srv.url, wsId, { token })));
    const refused = results.filter((r) => !r.ok);
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(8);
    expect(refused.length).toBeGreaterThanOrEqual(20);
    expect(refused.every((r) => r.code === "RATE_LIMITED")).toBe(true);
    // the hint is jittered so refused clients do not all come back together
    expect(new Set(refused.map((r) => r.retry)).size).toBeGreaterThan(3);
  });

  it("concurrent sockets per visitor session are capped (shared lease), and a closed socket frees its slot", async () => {
    const srv = await server();
    const { wsId } = await srv.seedWorkspace(srv.ctx, "Cap");
    const v = await srv.visitor(wsId);
    const socks = [];
    for (let i = 0; i < 5; i++) socks.push(await srv.connect(wsId, v.auth));
    const sixth = await attempt(srv.url, wsId, v.auth, { origin: "https://chat.example.com" });
    expect(sixth).toMatchObject({ ok: false, code: "TOO_MANY_CONNECTIONS" });
    expect(sixth.retry).toBeGreaterThan(0);
    socks[0]!.close();
    await sleep(100);
    expect((await attempt(srv.url, wsId, v.auth, { origin: "https://chat.example.com" })).ok).toBe(true);
  });

  it("a workspace-wide connection cap is enforced across all seats", async () => {
    const srv = await server({ WS_MAX_CONNECTIONS_PER_WORKSPACE: "3" });
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "WsCap");
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, owner);
    for (let i = 0; i < 3; i++) await srv.connect(wsId, { token });
    expect(await attempt(srv.url, wsId, { token })).toMatchObject({ ok: false, code: "TOO_MANY_CONNECTIONS" });
  });

  it("admission control sheds handshakes when too many are in flight, with a retry hint", async () => {
    const srv = await server({ WS_MAX_HANDSHAKES: "2" });
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Shed");
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, owner);
    // make authentication take a moment so handshakes genuinely overlap
    const realGet = srv.ctx.db.get.bind(srv.ctx.db);
    (srv.ctx.db as any).get = async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, 15));
      return (realGet as any)(...a);
    };
    const results = await Promise.all(Array.from({ length: 40 }, () => attempt(srv.url, wsId, { token })));
    (srv.ctx.db as any).get = realGet;
    const shed = results.filter((r) => r.code === "OVERLOADED");
    expect(shed.length).toBeGreaterThan(0);
    expect(shed.every((r) => (r.retry ?? 0) >= 1500)).toBe(true);
    expect(results.some((r) => r.ok)).toBe(true); // load is shed, not everything refused
  });

  it("admission control sheds when the event loop is lagging", async () => {
    const srv = await server({ SHED_LOOP_LAG_MS: "20" });
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Lag");
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, owner);
    expect((await attempt(srv.url, wsId, { token })).ok).toBe(true);
    const end = Date.now() + 1600;
    while (Date.now() < end) {
      const t = Date.now();
      while (Date.now() - t < 120); // block the loop so the 1 s lag sampler records p99 well above 20 ms
      await new Promise((r) => setImmediate(r));
    }
    await sleep(1300);
    const r = await attempt(srv.url, wsId, { token });
    expect(r).toMatchObject({ ok: false, code: "OVERLOADED" });
  }, 20_000);

  it("a denylisted IP cannot connect", async () => {
    const srv = await server({ TRUST_PROXY: "true" });
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Deny");
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, owner);
    const { addListEntry } = await import("../src/ratelimit/admin.js");
    await addListEntry(srv.ctx, { type: "system", id: "test" }, "deny", "ip:203.0.113.77", 60);
    expect(await attempt(srv.url, wsId, { token }, { "x-forwarded-for": "203.0.113.77" })).toMatchObject({ ok: false, code: "BLOCKED" });
    expect((await attempt(srv.url, wsId, { token }, { "x-forwarded-for": "203.0.113.78" })).ok).toBe(true);
  });
});

describe("socket event limits", () => {
  it("floods are dropped with an ack error and a retry hint, then the socket is disconnected after N strikes", async () => {
    const srv = await server({ SOCKET_RATE_BURST: "5", SOCKET_RATE_PER_SEC: "1", WS_STRIKE_LIMIT: "6" });
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Strikes");
    const s = await srv.team(wsId, owner);
    const events: unknown[] = [];
    s.on("rate:limited", (p) => events.push(p));
    let disconnected: string | null = null;
    s.on("disconnect", (r) => (disconnected = r));
    const acks: any[] = [];
    for (let i = 0; i < 20 && s.connected; i++) acks.push(await ack(s, "presence:list").catch((e) => ({ timeout: String(e) })));
    const ok = acks.filter((a) => a.ok);
    const dropped = acks.filter((a) => a.error?.code === "RATE_LIMITED");
    expect(ok.length).toBe(5); // the burst
    expect(dropped.length).toBeGreaterThanOrEqual(5);
    expect(dropped.every((a) => a.retry_after_ms > 0 && a.error.retry_after_ms === a.retry_after_ms)).toBe(true);
    await sleep(100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "too_many_violations" });
    expect(disconnected).toBeTruthy();
  });

  it("events are cost-weighted: typing pings are cheap, message sends are not", async () => {
    const srv = await server({ SOCKET_RATE_BURST: "8", SOCKET_RATE_PER_SEC: "0.001", WS_STRIKE_LIMIT: "100" });
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Weights");
    const s = await srv.team(wsId, owner);
    const typing: boolean[] = [];
    for (let i = 0; i < 40; i++) typing.push(!!(await ack(s, "typing", { room_id: "room_000000000000000000000000", typing: true }).catch(() => ({}))).ok || true);
    // 40 typing events at cost 0.25 = 10 units > burst 8: the tail must have been refused; measure through presence:list (cost 1) afterwards
    const r = await ack(s, "presence:list");
    expect(r.error?.code).toBe("RATE_LIMITED");
  });

  it("the per-user limit spans every socket of the same seat", async () => {
    const srv = await server({ SOCKET_RATE_BURST: "100", SOCKET_RATE_PER_SEC: "1", WS_STRIKE_LIMIT: "1000" });
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Actor");
    const a = await srv.team(wsId, owner);
    const b = await srv.team(wsId, owner);
    // actor bucket = 4x the socket burst here (400): hammer from both sockets
    let limited = 0;
    await Promise.all(
      [a, b].map(async (s) => {
        for (let i = 0; i < 260; i++) if ((await ack(s, "presence:list")).error?.code === "RATE_LIMITED") limited++;
      }),
    );
    expect(limited).toBeGreaterThan(0);
  }, 30_000);
});

describe("outbound pacing", () => {
  it("SMS from one number is spaced 1/s: later messages stay pending and go out via delayed jobs, in order, without rejection", async () => {
    const ctx = await makeCtx({ SEND_PACING: "true" });
    const { wsId, owner } = await seedWorkspace(ctx);
    await addSmsNumberRaw(ctx, wsId, "+14155550100", true);
    const rooms = [];
    for (let i = 0; i < 3; i++) rooms.push(await mkRoom(ctx, wsId, { contact: { name: `C${i}`, phone: `+1415555020${i}` } }));
    const sent = [];
    for (const r of rooms) sent.push((await sendAgentMessage(ctx, owner, r.room.id, { kind: "text", source: "sms", content: "hello" })).message);
    expect(sent.map((m) => m.delivery)).toEqual(["sent", "pending", "pending"]);
    const sms = (ctx.sms as unknown as { sent: { to: string }[] }).sent;
    expect(sms).toHaveLength(1);
    // nothing is due yet
    expect((await runDueJobs(ctx, jobHandlers)).ran).toBe(0);
    (ctx as any).clockCtl.advance(1100);
    await runDueJobs(ctx, jobHandlers);
    expect(sms).toHaveLength(2);
    (ctx as any).clockCtl.advance(1000);
    await runDueJobs(ctx, jobHandlers);
    expect(sms.map((m) => m.to)).toEqual(["+14155550200", "+14155550201", "+14155550202"]);
    const states = await ctx.db.all<{ delivery: string }>("SELECT delivery FROM messages WHERE source = 'sms' ORDER BY created_at");
    expect(states.every((s) => s.delivery === "sent")).toBe(true);
  });

  it("a queue past its cap falls back to retry-with-backoff instead of growing forever", async () => {
    const ctx = await makeCtx({ SEND_PACING: "true", SEND_QUEUE_MAX: "2" });
    const { wsId, owner } = await seedWorkspace(ctx);
    await addSmsNumberRaw(ctx, wsId, "+14155550100", true);
    const out: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await mkRoom(ctx, wsId, { contact: { name: `C${i}`, phone: `+1415555030${i}` } });
      out.push((await sendAgentMessage(ctx, owner, r.room.id, { kind: "text", source: "sms", content: "x" })).message.delivery);
    }
    expect(out.filter((d) => d === "failed").length).toBeGreaterThan(0);
    expect(out[0]).toBe("sent");
  });
});

void addMemberRaw;
