import { createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";
import AjvPkg from "ajv";
import formatsPkg from "ajv-formats";
import { describe, expect, it } from "vitest";
import { SCHEMAS } from "../src/analytics/schemas.js";
import { relayOutbox, rollupHandler } from "../src/events/outbox.js";
import { MemoryBus, type BusEvent } from "../src/infra/eventbus.js";
import { businessSeconds } from "../src/services/office.js";
import { KEY_SCOPES } from "../src/routes/analyticsApi.js";
import { bucketStarts } from "../src/services/analytics.js";
import { setStatus, snoozeRoom, unsnoozeRoom, wakeRoom } from "../src/services/rooms.js";
import { visitorSend } from "../src/services/visitorChat.js";
import { agentSays, addMemberRaw, fullApp, messagesOf, mkRoom, setSettings } from "./helpers.js";
import type { TestCtx } from "./helpers.js";
import { sendAgentMessage } from "../src/services/messages.js";
import { createApp } from "../src/app.js";

// both packages are CommonJS with a default export; resolve it the same way under ESM, TypeScript and the test runner
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: any = (AjvPkg as any).default ?? AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (formatsPkg as any).default ?? formatsPkg;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = (name: string, data: unknown) => {
  const v = ajv.compile(SCHEMAS[name]!);
  const ok = v(data);
  if (!ok) throw new Error(`${name} does not match its schema: ${JSON.stringify(v.errors)} for ${JSON.stringify(data).slice(0, 400)}`);
};

/** run every pending outbox row through the rollup consumer (what the relay + consumer group do in a running node) */
async function drain(ctx: TestCtx) {
  const events: BusEvent[] = [];
  const rec = { publish: async (topic: string, key: string, payload: unknown, id: string) => void events.push({ id, topic, key, payload, attempt: 1 }) } as unknown as MemoryBus;
  await relayOutbox(ctx, rec as never, 5000);
  for (const e of events) await rollupHandler(ctx, e);
}

const T0 = "2026-03-02T10:00:00.000Z"; // a Monday, 10:00 UTC

async function world(office?: object) {
  const f = await fullApp({ TRUST_PROXY: "true" });
  if (office) await setSettings(f.ctx, f.wsId, { widget: { office_hours: office } });
  return f;
}

describe("business hours arithmetic", () => {
  const nine5 = { enabled: true, timezone: "UTC", days: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })) };
  it("counts only time inside the schedule", () => {
    const d = (s: string) => new Date(s);
    expect(businessSeconds(nine5, d("2026-03-02T10:00:00Z"), d("2026-03-02T12:00:00Z"))).toBe(2 * 3600); // inside one day
    expect(businessSeconds(nine5, d("2026-03-02T16:00:00Z"), d("2026-03-03T10:00:00Z"))).toBe(2 * 3600); // 16-17 and 09-10
    expect(businessSeconds(nine5, d("2026-03-06T16:00:00Z"), d("2026-03-09T10:00:00Z"))).toBe(2 * 3600); // Friday 16-17 then the weekend is skipped, Monday 09-10
    expect(businessSeconds(nine5, d("2026-03-07T10:00:00Z"), d("2026-03-08T10:00:00Z"))).toBe(0); // all weekend
    expect(businessSeconds({ ...nine5, enabled: false }, d("2026-03-07T10:00:00Z"), d("2026-03-08T10:00:00Z"))).toBe(86400); // disabled = calendar time
    expect(businessSeconds(nine5, d("2026-03-02T12:00:00Z"), d("2026-03-02T10:00:00Z"))).toBe(0);
  });
  it("honours the workspace time zone, including daylight saving", () => {
    const ny = { enabled: true, timezone: "America/New_York", days: [{ day: 1, start: "09:00", end: "17:00" }] };
    // Monday 2026-03-09 is the day after US DST began: 09:00 local = 13:00 UTC
    expect(businessSeconds(ny, new Date("2026-03-09T13:00:00Z"), new Date("2026-03-09T21:00:00Z"))).toBe(8 * 3600);
    expect(businessSeconds(ny, new Date("2026-03-09T12:00:00Z"), new Date("2026-03-09T13:30:00Z"))).toBe(1800);
    // a week earlier (standard time) the same wall hours are one hour later in UTC
    expect(businessSeconds(ny, new Date("2026-03-02T14:00:00Z"), new Date("2026-03-02T22:00:00Z"))).toBe(8 * 3600);
  });
});

describe("room metrics: first response and resolution", () => {
  it("first response is contact message -> first HUMAN agent message; bots, notes and system lines never count", async () => {
    const { ctx, wsId, owner } = await world();
    const { room, contact } = await mkRoom(ctx, wsId);
    ctx.clockCtl.set(T0);
    const clk = ctx.clockCtl;
    const sess = { id: "x" };
    void sess;
    // the contact writes at 10:00 via the visitor path equivalent: insert as contact message
    const { insertMessage } = await import("../src/services/messageStore.js");
    await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "contact", senderId: contact.id, senderName: "C", kind: "text", source: "dm", content: "hello" });
    clk.advance(60_000);
    await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "bot", senderName: "Bot", kind: "text", source: "dm", content: "auto reply" });
    clk.advance(60_000);
    await sendAgentMessage(ctx, owner, room.id, { kind: "note", source: "dm", content: "internal" });
    clk.advance(60_000);
    let m = (await ctx.db.get<{ first_response_s: number | null }>("SELECT first_response_s FROM room_metrics WHERE room_id = ?", room.id))!;
    expect(m.first_response_s).toBeNull(); // 3 minutes in, nobody human has answered
    clk.advance(120_000);
    await agentSays(ctx, owner, room.id, "Hi, how can I help?");
    m = (await ctx.db.get<{ first_response_s: number | null }>("SELECT first_response_s FROM room_metrics WHERE room_id = ?", room.id))!;
    expect(m.first_response_s).toBe(300);
    clk.advance(3600_000);
    await agentSays(ctx, owner, room.id, "second reply does not change it");
    expect((await ctx.db.get<{ first_response_s: number }>("SELECT first_response_s FROM room_metrics WHERE room_id = ?", room.id))!.first_response_s).toBe(300);
  });

  it("with office hours on, nights and weekends do not count", async () => {
    const { ctx, wsId, owner } = await world({ enabled: true, timezone: "UTC", days: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })) });
    const { room, contact } = await mkRoom(ctx, wsId);
    const { insertMessage } = await import("../src/services/messageStore.js");
    ctx.clockCtl.set("2026-03-06T16:30:00.000Z"); // Friday 16:30
    await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "contact", senderId: contact.id, senderName: "C", kind: "text", source: "dm", content: "help" });
    ctx.clockCtl.set("2026-03-09T09:20:00.000Z"); // Monday 09:20
    await agentSays(ctx, owner, room.id, "morning");
    const m = (await ctx.db.get<{ first_response_s: number }>("SELECT first_response_s FROM room_metrics WHERE room_id = ?", room.id))!;
    expect(m.first_response_s).toBe(30 * 60 + 20 * 60); // 30 min on Friday + 20 min on Monday, not 64 hours
  });

  it("resolution excludes snoozed time; reopening starts a new interval and clears the rating", async () => {
    const { ctx, wsId, owner } = await world();
    const { room } = await mkRoom(ctx, wsId);
    const base = Date.parse("2026-03-02T10:00:00.000Z");
    ctx.clockCtl.set(new Date(base).toISOString());
    // metrics rows are created with the room: align the interval start with the test clock
    await ctx.db.run("UPDATE room_metrics SET created_at = ?, opened_at = ? WHERE room_id = ?", new Date(base).toISOString(), new Date(base).toISOString(), room.id);
    ctx.clockCtl.advance(600_000); // 10 min of work
    await snoozeRoom(ctx, owner, room.id, new Date(base + 600_000 + 7200_000).toISOString());
    ctx.clockCtl.advance(7200_000); // snoozed for 2 h
    const fresh = (await ctx.db.get<import("../src/services/roomStore.js").RoomRow>("SELECT * FROM rooms WHERE id = ?", room.id))!;
    await wakeRoom(ctx, fresh);
    ctx.clockCtl.advance(300_000); // 5 more minutes
    await setStatus(ctx, owner, room.id, "closed");
    const m = (await ctx.db.get<{ resolution_s: number; snoozed_count: number; closed_at: string }>("SELECT * FROM room_metrics WHERE room_id = ?", room.id))!;
    expect(m.resolution_s).toBe(900); // 10 + 5 minutes, the 2 snoozed hours are not counted
    expect(m.snoozed_count).toBe(1);
    // reopen -> new interval
    ctx.clockCtl.advance(86400_000);
    await setStatus(ctx, owner, room.id, "open");
    const re = (await ctx.db.get<{ reopen_count: number; csat: number | null }>("SELECT * FROM room_metrics WHERE room_id = ?", room.id))!;
    expect(re.reopen_count).toBe(1);
    ctx.clockCtl.advance(120_000);
    await setStatus(ctx, owner, room.id, "closed");
    expect((await ctx.db.get<{ resolution_s: number }>("SELECT resolution_s FROM room_metrics WHERE room_id = ?", room.id))!.resolution_s).toBe(120);
    void unsnoozeRoom;
  });

  it("closing a snoozed room ends the snooze clock at the close", async () => {
    const { ctx, wsId, owner } = await world();
    const { room } = await mkRoom(ctx, wsId);
    const base = Date.parse("2026-03-02T10:00:00.000Z");
    ctx.clockCtl.set(new Date(base).toISOString());
    await ctx.db.run("UPDATE room_metrics SET created_at = ?, opened_at = ? WHERE room_id = ?", new Date(base).toISOString(), new Date(base).toISOString(), room.id);
    await snoozeRoom(ctx, owner, room.id, new Date(base + 86400_000).toISOString());
    ctx.clockCtl.advance(3600_000);
    await setStatus(ctx, owner, room.id, "closed");
    expect((await ctx.db.get<{ resolution_s: number }>("SELECT resolution_s FROM room_metrics WHERE room_id = ?", room.id))!.resolution_s).toBe(0);
  });
});

describe("CSAT", () => {
  it("accepts 1-5 once per closure, only after close, and a reopen allows a new rating", async () => {
    const { ctx, wsId, owner } = await world();
    const { room } = await mkRoom(ctx, wsId);
    const { recordCsat } = await import("../src/services/roomMetrics.js");
    const row = (await ctx.db.get<import("../src/services/roomStore.js").RoomRow>("SELECT * FROM rooms WHERE id = ?", room.id))!;
    expect(await recordCsat(ctx, row, 5)).toBe(false); // still open
    await setStatus(ctx, owner, room.id, "closed");
    expect(await recordCsat(ctx, row, 4, "fast")).toBe(true);
    expect(await recordCsat(ctx, row, 1)).toBe(false); // once
    expect((await ctx.db.get<{ csat: number }>("SELECT csat FROM room_metrics WHERE room_id = ?", room.id))!.csat).toBe(4);
    await setStatus(ctx, owner, room.id, "open");
    await setStatus(ctx, owner, room.id, "closed");
    expect(await recordCsat(ctx, row, 2)).toBe(true);
  });

  it("the widget endpoint rejects out-of-range scores and a room that is not closed", async () => {
    const { ctx, http, token, wsId, owner } = await world();
    const created = await http.post("/api/tokens", { domain: "shop.example.com" }, token);
    const h = (extra: Record<string, string> = {}) => ({ "x-api-key": created.body.token, origin: "https://shop.example.com", "x-device-id": "device-csat-0001", ...extra });
    const s = await http.post("/public/sessions", {}, undefined, h());
    const hs = { ...h(), "x-support-session": s.body.session_token };
    const r = await http.post("/public/rooms", {}, undefined, hs);
    const roomId = r.body.room.id as string;
    expect((await http.post(`/public/rooms/${roomId}/csat`, { score: 5 }, undefined, hs)).status).toBe(409);
    await setStatus(ctx, owner, roomId, "closed");
    expect((await http.post(`/public/rooms/${roomId}/csat`, { score: 6 }, undefined, hs)).status).toBe(400);
    expect((await http.post(`/public/rooms/${roomId}/csat`, { score: 0 }, undefined, hs)).status).toBe(400);
    expect((await http.post(`/public/rooms/${roomId}/csat`, { score: 5, comment: "great" }, undefined, hs)).status).toBe(200);
    expect((await http.post(`/public/rooms/${roomId}/csat`, { score: 4 }, undefined, hs)).status).toBe(409);
    void wsId;
    void visitorSend;
  });
});

describe("API keys", () => {
  async function keyed(scopes = ["analytics:read", "analytics:export", "analytics_identity:manage"], extra: Record<string, unknown> = {}) {
    const f = await world();
    const created = await f.http.post("/api/v1/api-keys", { name: "BI", scopes, ...extra }, f.token);
    expect(created.status).toBe(201);
    const auth = (key = created.body.key as string, ip?: string) => ({ authorization: `Bearer ${key}`, ...(ip ? { "x-forwarded-for": ip } : {}) });
    return { ...f, created: created.body, auth };
  }

  it("the plaintext is shown once and only a hash is stored; the key works and records last use", async () => {
    const { ctx, http, created, auth } = await keyed();
    expect(created.key).toMatch(/^ca_live_[A-Za-z0-9_-]{32}$/);
    const rows = await ctx.db.all<{ key_hash: string; prefix: string }>("SELECT key_hash, prefix FROM api_keys");
    expect(rows[0]!.key_hash).toHaveLength(64);
    expect(JSON.stringify(rows)).not.toContain(created.key);
    expect(rows[0]!.prefix).toBe(created.key.slice(0, 12));
    expect(JSON.stringify((await http.get("/api/v1/api-keys", undefined)).body)).not.toContain(created.key);
    const r = await http.get("/api/v1/analytics/overview", undefined, auth());
    expect(r.status).toBe(200);
    const row = await ctx.db.get<{ last_used_at: string | null }>("SELECT last_used_at FROM api_keys");
    expect(row!.last_used_at).toBeTruthy();
  });

  it("every failure is the same 401: unknown, malformed, revoked, expired and wrong-address keys", async () => {
    const { ctx, http, token, created, auth } = await keyed(["analytics:read"], { ip_allowlist: ["203.0.113.0/24"] });
    const ok = await http.get("/api/v1/analytics/overview", undefined, auth(created.key, "203.0.113.7"));
    expect(ok.status).toBe(200);
    const wrongIp = await http.get("/api/v1/analytics/overview", undefined, auth(created.key, "198.51.100.1"));
    const unknown = await http.get("/api/v1/analytics/overview", undefined, auth("ca_live_" + "x".repeat(32), "203.0.113.7"));
    const malformed = await http.get("/api/v1/analytics/overview", undefined, { authorization: "Bearer nope" });
    const none = await http.get("/api/v1/analytics/overview");
    for (const r of [wrongIp, unknown, malformed, none]) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("INVALID_API_KEY");
      expect(r.body.error.message).toBe("Invalid API key");
    }
    expect((await http.del(`/api/v1/api-keys/${created.id}`, token)).status).toBe(204);
    expect((await http.get("/api/v1/analytics/overview", undefined, auth(created.key, "203.0.113.7"))).status).toBe(401); // revocation is immediate
    // expiry
    const f2 = await keyed(["analytics:read"], { expires_at: new Date(ctx.clock().getTime() + 3600_000).toISOString() });
    expect((await f2.http.get("/api/v1/analytics/overview", undefined, f2.auth())).status).toBe(200);
    f2.ctx.clockCtl.advance(2 * 3600_000);
    expect((await f2.http.get("/api/v1/analytics/overview", undefined, f2.auth())).status).toBe(401);
  });

  it("scopes are enforced per endpoint; a key cannot carry more than its creator may do", async () => {
    const f = await keyed(["analytics:read"]);
    const { ctx, http, wsId } = f;
    const read = { authorization: `Bearer ${f.created.key}` };
    expect((await f.http.get("/api/v1/analytics/overview", undefined, read)).status).toBe(200);
    expect((await f.http.get("/api/v1/analytics/export/rooms", undefined, read)).body.error.code).toBe("INSUFFICIENT_SCOPE");
    expect((await f.http.get("/api/v1/analytics/identity-pepper", undefined, read)).body.error.code).toBe("INSUFFICIENT_SCOPE");
    const agent = await addMemberRaw(ctx, wsId, { name: "Ann", role: "agent" });
    const { tokenFor } = await import("./helpers.js");
    const esc = await http.post("/api/v1/api-keys", { name: "x", scopes: ["analytics:export"] }, await tokenFor(ctx, agent));
    expect(esc.status).toBe(403); // agents lack api_keys:manage at all
    const mgr = await addMemberRaw(ctx, wsId, { name: "Mia", role: "manager" });
    expect((await http.post("/api/v1/api-keys", { name: "x", scopes: ["analytics_identity:manage"] }, await tokenFor(ctx, mgr))).body.error.code).toBe("PRIVILEGE_ESCALATION");
    expect((await http.post("/api/v1/api-keys", { name: "x", scopes: ["bogus"] }, f.token)).status).toBe(400);
    expect((await http.post("/api/v1/api-keys", { name: "x", scopes: ["analytics:read"], ip_allowlist: ["not-an-ip"] }, f.token)).status).toBe(400);
    // every route of the API has a scope declared
    const app = createApp(ctx);
    for (const r of app.routes.filter((x) => x.path.startsWith("/api/v1/analytics/") && x.method !== "ALL")) expect(KEY_SCOPES[`${r.method} ${r.path}`], `${r.method} ${r.path}`).toBeDefined();
  });

  it("is isolated per workspace: data of another workspace is never returned", async () => {
    const a = await keyed();
    const { mkRoom: mk } = await import("./helpers.js");
    await mk(a.ctx, a.wsId);
    const { seedWorkspace } = await import("./helpers.js");
    const other = await seedWorkspace(a.ctx, "Other Co");
    await mk(a.ctx, other.wsId);
    await mk(a.ctx, other.wsId);
    const r = await a.http.get("/api/v1/analytics/overview?from=2026-01-01&to=2026-12-31", undefined, a.auth());
    expect(r.body.rooms_opened).toBe(1);
  });

  it("rate limits per key: 60 reads then 429 with Retry-After; one key does not spend another's budget", async () => {
    const k1 = await keyed(["analytics:read"]);
    const k2 = await k1.http.post("/api/v1/api-keys", { name: "second", scopes: ["analytics:read"] }, k1.token);
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await k1.http.get("/api/v1/analytics/schema", undefined, k1.auth())).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(60);
    expect(statuses.slice(60)).toEqual([429, 429]);
    expect((await k1.http.get("/api/v1/analytics/schema", undefined, { authorization: `Bearer ${k2.body.key}` })).status).toBe(200);
  });
});

describe("analytics endpoints (contract tests against the JSON Schemas)", () => {
  async function seeded() {
    const f = await world();
    const { ctx, wsId, owner } = f;
    const created = await f.http.post("/api/v1/api-keys", { name: "BI", scopes: ["analytics:read", "analytics:export", "analytics_identity:manage"] }, f.token);
    const auth = { authorization: `Bearer ${created.body.key}` };
    const { insertMessage } = await import("../src/services/messageStore.js");
    const rooms = [];
    for (let i = 0; i < 6; i++) {
      const { room, contact } = await mkRoom(ctx, wsId, { contact: { name: `Person ${i}`, email: `person${i}@example.test`, phone: `+1415555010${i}` } });
      ctx.clockCtl.set(`2026-03-0${2 + (i % 3)}T1${i}:00:00.000Z`);
      await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "contact", senderId: contact.id, senderName: `Person ${i}`, kind: "text", source: i % 2 ? "sms" : "dm", content: `my secret message ${i}` });
      ctx.clockCtl.advance((i + 1) * 60_000);
      await agentSays(ctx, owner, room.id, `answer ${i} with details`);
      if (i % 2 === 0) {
        ctx.clockCtl.advance(30 * 60_000);
        await setStatus(ctx, owner, room.id, "closed");
      }
      rooms.push({ room, contact });
    }
    await drain(ctx);
    return { ...f, auth, rooms, key: created.body };
  }
  const q = "from=2026-03-01&to=2026-03-10";

  it("overview matches its schema and its numbers", async () => {
    const { http, auth } = await seeded();
    const r = await http.get(`/api/v1/analytics/overview?${q}`, undefined, auth);
    expect(r.status).toBe(200);
    validate("overview", r.body);
    expect(r.body.rooms_opened).toBe(6);
    expect(r.body.rooms_closed).toBe(3);
    expect(r.body.messages_in).toBe(6);
    expect(r.body.messages_out).toBe(6);
    expect(r.body.by_channel.sms.messages_in).toBe(3);
    expect(r.body.by_channel.dm.messages_in).toBe(3);
    // first responses were 1..6 minutes
    expect(r.body.first_response_p50_s).toBe(180);
    expect(r.body.first_response_p90_s).toBe(360);
    expect(r.body.by_agent[0].agent_key).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/Olivia|Owner|@example/); // no names or addresses
  });

  it("timeseries is zero filled, aligned to the requested time zone, and matches its schema", async () => {
    const { http, auth } = await seeded();
    const day = await http.get(`/api/v1/analytics/timeseries?metric=rooms_opened&interval=day&${q}`, undefined, auth);
    validate("timeseries", day.body);
    expect(day.body.points).toHaveLength(10); // from the 1st to the 10th inclusive
    expect(day.body.points.reduce((a: number, p: { value: number }) => a + p.value, 0)).toBe(6);
    expect(day.body.points.filter((p: { value: number }) => p.value === 0).length).toBeGreaterThan(0);
    const tokyo = await http.get(`/api/v1/analytics/timeseries?metric=rooms_opened&interval=day&tz=Asia/Tokyo&${q}`, undefined, auth);
    expect(tokyo.body.points[1].t).toBe("2026-03-01T15:00:00.000Z"); // Tokyo midnight is 15:00 UTC the day before
    for (const metric of ["messages_in", "messages_out", "first_response_p50", "resolution_p50", "backlog"]) {
      const r = await http.get(`/api/v1/analytics/timeseries?metric=${metric}&interval=week&${q}`, undefined, auth);
      expect(r.status, metric).toBe(200);
      validate("timeseries", r.body);
    }
    expect((await http.get("/api/v1/analytics/timeseries?metric=bogus", undefined, auth)).status).toBe(400);
    expect((await http.get("/api/v1/analytics/timeseries?metric=rooms_opened&from=2020-01-01&to=2022-01-01", undefined, auth)).body.error.code).toBe("RANGE_TOO_LARGE");
    expect((await http.get("/api/v1/analytics/timeseries?metric=rooms_opened&tz=Mars/Base", undefined, auth)).body.error.code).toBe("INVALID_TZ");
    expect((await http.get(`/api/v1/analytics/timeseries?metric=rooms_opened&interval=hour&${q}`, undefined, auth)).body.points).toHaveLength(10 * 24);
    const backlog = await http.get(`/api/v1/analytics/timeseries?metric=backlog&interval=day&${q}`, undefined, auth);
    expect(backlog.body.points.at(-1).value).toBe(3); // 6 rooms, 3 closed
  });

  it("exports rooms as NDJSON: schema valid, no raw PII or content, stable order, resumable by cursor, gzip", async () => {
    const { app, auth, rooms } = await seeded();
    const get = (qs: string, headers: Record<string, string> = {}) => app.request(`/api/v1/analytics/export/rooms?${qs}`, { headers: { ...auth, ...headers } });
    const first = await get(`${q}&limit=4`);
    expect(first.headers.get("content-type")).toContain("application/x-ndjson");
    const next = first.headers.get("x-next-cursor");
    expect(next).toBeTruthy();
    const text1 = await first.text();
    const lines1 = text1.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines1).toHaveLength(4);
    for (const l of lines1) validate("export-rooms-line", l);
    const second = await get(`${q}&limit=4&cursor=${encodeURIComponent(next!)}`);
    expect(second.headers.get("x-next-cursor")).toBeNull(); // 6 rows: the second page is the last
    const lines2 = (await second.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines2).toHaveLength(2);
    const all = [...lines1, ...lines2];
    expect(new Set(all.map((l) => l.id)).size).toBe(6); // no gaps, no repeats
    expect(all.map((l) => l.created_at)).toEqual([...all.map((l) => l.created_at)].sort());
    const blob = JSON.stringify(all);
    for (let i = 0; i < 6; i++) expect(blob).not.toContain(`person${i}@example.test`);
    expect(blob).not.toMatch(/\+1415555010|Person \d|my secret message|answer \d/);
    expect(all.every((l) => l.contact_key && /^[0-9a-f]{64}$/.test(l.contact_key))).toBe(true);
    void rooms;
    // gzip when asked and worthwhile
    const big = await get(`${q}&limit=100`, { "accept-encoding": "gzip" });
    const raw = Buffer.from(await big.arrayBuffer());
    if (big.headers.get("content-encoding") === "gzip") expect(gunzipSync(raw).toString().trim().split("\n")).toHaveLength(6);
    // a malformed cursor is a clean 400
    expect((await get(`${q}&cursor=garbage`)).status).toBe(400);
  });

  it("contact_key follows the contract algorithm exactly, so two systems with the same pepper join on it", async () => {
    const { app, auth, http, key, wsId, ctx } = await seeded();
    const pepper = (await http.get("/api/v1/analytics/identity-pepper", undefined, auth)).body;
    validate("identity-pepper", pepper);
    const expected = createHmac("sha256", pepper.pepper).update("person0@example.test").digest("hex");
    const lines = (await (await app.request(`/api/v1/analytics/export/rooms?${q}&limit=100`, { headers: auth })).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.contact_key)).toContain(expected);
    // case and whitespace do not change the key
    const { identityKey } = await import("../src/services/analytics.js");
    expect(identityKey(pepper.pepper, "  Person0@Example.TEST ")).toBe(expected);
    expect(key.id).toBeTruthy();
    // rotating the pepper changes every key and bumps the version
    const owner = await ctx.db.get<{ id: string }>("SELECT id FROM members WHERE workspace_id = ? AND role = 'owner'", wsId);
    const { rotatePepper } = await import("../src/services/analytics.js");
    const { actorFromRow, getMember } = await import("../src/services/members.js");
    const rotated = await rotatePepper(ctx, actorFromRow(await getMember(ctx, wsId, owner!.id)));
    expect(rotated.version).toBe(pepper.version + 1);
    expect(rotated.pepper).not.toBe(pepper.pepper);
  });

  it("messages-meta carries ids, time, direction, channel, size and delivery state, never content", async () => {
    const { app, auth } = await seeded();
    const res = await app.request(`/api/v1/analytics/export/messages-meta?${q}&limit=100`, { headers: auth });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(12);
    for (const l of lines) validate("export-messages-meta-line", l);
    expect(JSON.stringify(lines)).not.toMatch(/secret message|answer \d/);
    expect(lines.filter((l) => l.direction === "in")).toHaveLength(6);
    expect(lines.every((l) => l.length_chars > 0)).toBe(true);
  });

  it("the schema endpoint serves the same schemas the tests validate against", async () => {
    const { http, auth } = await seeded();
    const r = await http.get("/api/v1/analytics/schema", undefined, auth);
    expect(r.body.schema_version).toBe(1);
    expect(Object.keys(r.body.schemas).sort()).toEqual(Object.keys(SCHEMAS).sort());
  });

  it("export concurrency per key is capped (503 when full)", async () => {
    const { ctx, http, auth, key } = await seeded();
    for (let i = 0; i < 2; i++) await ctx.ratelimit.acquire("analytics.concurrency", key.id, `held${i}`);
    const r = await http.get(`/api/v1/analytics/export/rooms?${q}`, undefined, auth);
    expect(r.status).toBe(503);
  });

  it("the in-app dashboard endpoint shows agent names, the API never does", async () => {
    const { http, ctx, owner } = await seeded();
    const { tokenFor } = await import("./helpers.js");
    const r = await http.get(`/api/analytics/overview?${q}`, await tokenFor(ctx, owner));
    expect(r.status).toBe(200);
    expect(r.body.by_agent[0].agent_name).toBeTruthy();
    expect(bucketStarts).toBeDefined();
  });
});

describe("rollup consumer", () => {
  it("counts only real conversation messages (no notes, bots or system lines), exactly once per event", async () => {
    const { ctx, wsId, owner } = await world();
    const { room, contact } = await mkRoom(ctx, wsId);
    const { insertMessage } = await import("../src/services/messageStore.js");
    await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "contact", senderId: contact.id, senderName: "C", kind: "text", source: "dm", content: "hi" });
    await agentSays(ctx, owner, room.id, "hello");
    await sendAgentMessage(ctx, owner, room.id, { kind: "note", source: "dm", content: "private" });
    await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "bot", senderName: "Bot", kind: "text", source: "dm", content: "bot" });
    await drain(ctx);
    await drain(ctx); // nothing new
    const rows = await ctx.db.all<{ direction: string; messages: number }>("SELECT direction, SUM(messages) AS messages FROM rollup_messages_daily WHERE workspace_id = ? GROUP BY direction", wsId);
    const by = Object.fromEntries(rows.map((r) => [r.direction, Number(r.messages)]));
    expect(by).toEqual({ in: 1, out: 1 });
    expect((await messagesOf(ctx, room.id)).length).toBeGreaterThan(4);
  });
});
