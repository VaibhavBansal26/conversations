import { describe, expect, it } from "vitest";
import { normalizeDomain, originMatches, SESSION_TTL_DAYS } from "../src/services/visitors.js";
import { agentSays, fullApp, messagesOf, seedWorkspace, setSettings, tokenFor, addMemberRaw, mkInbox, roomRow } from "./helpers.js";
import { assignRoom } from "../src/services/rooms.js";

describe("origin matching", () => {
  const cases: [string, string | null | undefined, boolean][] = [
    ["example.com", "https://example.com", true],
    ["example.com", "http://example.com", true],
    ["example.com", "https://EXAMPLE.COM", true],
    ["Example.com", "https://example.com", true],
    ["example.com", "https://example.com:8443", false],
    ["example.com", "https://www.example.com", false],
    ["example.com", "https://example.com.evil.test", false],
    ["example.com", "https://evilexample.com", false],
    ["example.com", "https://notexample.com", false],
    ["localhost:3000", "http://localhost:3000", true],
    ["localhost:3000", "http://localhost", false],
    ["localhost:3000", "http://localhost:3001", false],
    ["localhost", "http://localhost:3000", false],
    ["*.example.com", "https://app.example.com", true],
    ["*.example.com", "https://a.b.example.com", true],
    ["*.example.com", "https://APP.Example.com", true],
    ["*.example.com", "https://example.com", false],
    ["*.example.com", "https://evilexample.com", false],
    ["*.example.com", "https://example.com.evil.test", false],
    ["*.example.com", "https://x.example.com:8443", false],
    ["*.example.com:8443", "https://x.example.com:8443", true],
    ["example.com", undefined, false],
    ["example.com", null, false],
    ["example.com", "", false],
    ["example.com", "null", false],
    ["example.com", "not a url", false],
    ["example.com", "file:///etc/passwd", false],
    ["example.com", "chrome-extension://abcdef", false],
    ["example.com", "https://user@example.com", true],
  ];
  it.each(cases)("pattern %s vs origin %s -> %s", (pattern, origin, expected) => {
    expect(originMatches(origin, pattern)).toBe(expected);
  });
  it("normalises and validates token domains", () => {
    expect(normalizeDomain("  HTTPS://Shop.Example.com/path?x=1 ")).toBe("shop.example.com");
    expect(normalizeDomain("*.example.com")).toBe("*.example.com");
    expect(normalizeDomain("localhost:3000")).toBe("localhost:3000");
    for (const bad of ["", "exa mple.com", "*example.com", "a..b", "-bad.com", "http://", "ex_ample.com"]) expect(() => normalizeDomain(bad), bad).toThrow(/domain/i);
  });
});

async function widgetWorld(env: Record<string, string> = {}, domain = "shop.example.com") {
  const f = await fullApp(env);
  const created = await f.http.post("/api/tokens", { domain }, f.token);
  const apiKey = created.body.token as string;
  const origin = `https://${domain.replace("*.", "app.")}`;
  const h = (device = "device-aaaa-0001", extra: Record<string, string> = {}) => ({ "x-api-key": apiKey, origin, "x-device-id": device, ...extra });
  const newSession = async (body: object = {}, device = "device-aaaa-0001") => {
    const r = await f.http.post("/public/sessions", body, undefined, h(device));
    return { res: r, headers: { "x-support-session": r.body.session_token ?? "", "x-device-id": device, origin } };
  };
  return { ...f, apiKey, origin, h, newSession, tokenId: created.body.id as string };
}

describe("embed tokens", () => {
  it("creates one token per domain per workspace, rotates and revokes", async () => {
    const w = await widgetWorld();
    expect(w.apiKey).toMatch(/^cvt_[A-Za-z0-9_-]{32}$/);
    expect((await w.http.post("/api/tokens", { domain: "SHOP.example.com" }, w.token)).body.error.code).toBe("TOKEN_EXISTS");
    const other = await w.http.post("/api/tokens", { domain: "*.example.com" }, w.token);
    expect(other.status).toBe(201);
    const rotated = await w.http.post(`/api/tokens/${w.tokenId}/rotate`, {}, w.token);
    expect(rotated.body.token).not.toBe(w.apiKey);
    expect(rotated.body.domain).toBe("shop.example.com");
    expect((await w.http.get("/public/widget/config", undefined, w.h())).status).toBe(401);
    expect((await w.http.get("/public/widget/config", undefined, { ...w.h(), "x-api-key": rotated.body.token })).status).toBe(200);
    expect((await w.http.del(`/api/tokens/${rotated.body.id}`, w.token)).status).toBe(204);
    expect((await w.http.get("/public/widget/config", undefined, { ...w.h(), "x-api-key": rotated.body.token })).status).toBe(401);
    expect((await w.http.post("/api/tokens", { domain: "shop.example.com" }, w.token)).status).toBe(201); // revoked tokens free the domain
    expect((await w.http.get("/api/tokens", w.token)).body.data).toHaveLength(2 + 0);
  });
  it("allows the same domain in different workspaces and keeps them isolated", async () => {
    const w = await widgetWorld();
    const other = await seedWorkspace(w.ctx, "Other");
    const ot = await w.http.post("/api/tokens", { domain: "shop.example.com" }, await tokenFor(w.ctx, other.owner));
    expect(ot.status).toBe(201);
    const mine = await w.http.get("/public/widget/config", undefined, w.h());
    const theirs = await w.http.get("/public/widget/config", undefined, { ...w.h(), "x-api-key": ot.body.token });
    expect(mine.body.workspace_id).toBe(w.wsId);
    expect(theirs.body.workspace_id).toBe(other.wsId);
    expect((await w.http.get("/api/tokens", await tokenFor(w.ctx, other.owner))).body.data).toHaveLength(1);
  });
  it("only managers manage tokens", async () => {
    const w = await widgetWorld();
    const agent = await addMemberRaw(w.ctx, w.wsId, { name: "Ann" });
    const at = await tokenFor(w.ctx, agent);
    expect((await w.http.get("/api/tokens", at)).status).toBe(403);
    expect((await w.http.post("/api/tokens", { domain: "x.test" }, at)).status).toBe(403);
    expect((await w.http.post(`/api/tokens/${w.tokenId}/rotate`, {}, at)).status).toBe(403);
    expect((await w.http.del(`/api/tokens/${w.tokenId}`, at)).status).toBe(403);
  });
  it("checks the Origin on config and sessions: wrong, missing, null and wildcard", async () => {
    const w = await widgetWorld();
    const get = (origin?: string) => w.http.get("/public/widget/config", undefined, { "x-api-key": w.apiKey, ...(origin !== undefined ? { origin } : {}) });
    expect((await get(w.origin)).status).toBe(200);
    expect((await get("https://evil.test")).body.error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect((await get()).status).toBe(403);
    expect((await get("null")).status).toBe(403);
    expect((await w.http.get("/public/widget/config", undefined, { origin: w.origin })).body.error.code).toBe("INVALID_API_KEY");
    const wild = await widgetWorld({}, "*.example.com");
    expect((await wild.http.get("/public/widget/config", undefined, { "x-api-key": wild.apiKey, origin: "https://deep.sub.example.com" })).status).toBe(200);
    expect((await wild.http.get("/public/widget/config", undefined, { "x-api-key": wild.apiKey, origin: "https://example.com" })).status).toBe(403);
    expect((await w.http.post("/public/sessions", {}, undefined, { "x-api-key": w.apiKey, origin: "https://evil.test", "x-device-id": "device-aaaa-0001" })).status).toBe(403);
  });
  it("serves public config without leaking private settings", async () => {
    const w = await widgetWorld();
    setSettings(w.ctx, w.wsId, { widget: { title: "Hi!", primary_color: "#112233", default_inbox_id: "inb_secret", required_info: ["email"] } });
    const inbox = mkInbox(w.ctx, w.owner, { name: "Sales", live_routing_visibility: true });
    mkInbox(w.ctx, w.owner, { name: "Internal" });
    const r = await w.http.get("/public/widget/config", undefined, w.h());
    expect(r.body.widget).toMatchObject({ title: "Hi!", primary_color: "#112233", required_info: ["email"] });
    expect(JSON.stringify(r.body)).not.toContain("inb_secret");
    expect(r.body.live_routing_inboxes).toEqual([{ id: inbox.id, name: "Sales", icon: "inbox" }]);
    expect(r.body.office_open).toBe(true);
  });
  it("sets CORS for public endpoints", async () => {
    const w = await widgetWorld();
    const res = await w.app.request("/public/sessions", { method: "OPTIONS", headers: { origin: "https://shop.example.com", "access-control-request-method": "POST", "access-control-request-headers": "x-api-key,x-device-id" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://shop.example.com");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-support-session");
  });
});

describe("visitor sessions", () => {
  it("creates an anonymous session and reuses the contact on the same device", async () => {
    const w = await widgetWorld();
    const a = await w.newSession();
    expect(a.res.status).toBe(201);
    expect(a.res.body).toMatchObject({ verified: false, workspace_id: w.wsId, requires_verification: false });
    const b = await w.newSession();
    expect(b.res.body.contact.id).toBe(a.res.body.contact.id);
    expect(b.res.body.session_id).not.toBe(a.res.body.session_id);
    // only one active session per contact+device: the first stops working
    expect((await w.http.get("/public/rooms", undefined, a.headers)).body.error.code).toBe("SESSION_EXPIRED");
    expect((await w.http.get("/public/rooms", undefined, b.headers)).status).toBe(200);
    const c = await w.newSession({}, "device-bbbb-0002");
    expect(c.res.body.contact.id).not.toBe(a.res.body.contact.id);
  });
  it("enforces required info and the device header", async () => {
    const w = await widgetWorld();
    setSettings(w.ctx, w.wsId, { widget: { required_info: ["name", "email"] } });
    const missing = await w.newSession({ name: "Pat" });
    expect(missing.res.status).toBe(422);
    expect(missing.res.body.error.details).toEqual({ missing: ["email"] });
    expect((await w.newSession({ name: "Pat", email: "pat@example.test" })).res.status).toBe(201);
    expect((await w.http.post("/public/sessions", {}, undefined, { "x-api-key": w.apiKey, origin: w.origin })).body.error.code).toBe("DEVICE_ID_REQUIRED");
    expect((await w.http.post("/public/sessions", { email: "nope" }, undefined, w.h())).status).toBe(400);
  });
  it("expires after 30 days", async () => {
    const w = await widgetWorld();
    const s = await w.newSession();
    expect(SESSION_TTL_DAYS).toBe(30);
    w.ctx.clockCtl.advance(30 * 86400_000 - 1000);
    expect((await w.http.get("/public/session", undefined, s.headers)).status).toBe(200);
    w.ctx.clockCtl.advance(2000);
    const gone = await w.http.get("/public/session", undefined, s.headers);
    expect(gone.status).toBe(401);
    expect(gone.body.error.code).toBe("SESSION_EXPIRED");
  });
  it("accepts a session from the same device or the same IP, and rejects a stranger", async () => {
    const w = await widgetWorld();
    const s = await w.newSession();
    const secret = s.headers["x-support-session"];
    const use = (device?: string) => w.http.get("/public/session", undefined, { "x-support-session": secret, ...(device ? { "x-device-id": device } : {}) });
    expect((await use("device-aaaa-0001")).status).toBe(200);
    // no real socket in app.request(): IP is "unknown" for both, which never counts as a match
    const stranger = await use("device-zzzz-9999");
    expect(stranger.status).toBe(401);
    expect(stranger.body.error.code).toBe("SESSION_DEVICE_MISMATCH");
    expect((await use()).status).toBe(401);
    expect((await w.http.get("/public/session", undefined, { "x-device-id": "device-aaaa-0001" })).body.error.code).toBe("INVALID_SESSION");
    expect((await w.http.get("/public/session", undefined, { "x-support-session": "ses_bogus", "x-device-id": "device-aaaa-0001" })).status).toBe(401);
  });
  it("IP match works when the device id differs (trusted proxy header)", async () => {
    const w = await widgetWorld({ TRUST_PROXY: "true" });
    const s = await w.http.post("/public/sessions", {}, undefined, { ...w.h(), "x-forwarded-for": "203.0.113.9" });
    const secret = s.body.session_token;
    const same = await w.http.get("/public/session", undefined, { "x-support-session": secret, "x-device-id": "device-other-0002", "x-forwarded-for": "203.0.113.9" });
    expect(same.status).toBe(200);
    const other = await w.http.get("/public/session", undefined, { "x-support-session": secret, "x-device-id": "device-other-0002", "x-forwarded-for": "198.51.100.1" });
    expect(other.status).toBe(401);
  });
  it("rejects a session used with an origin outside its token's domain, or after the token is revoked", async () => {
    const w = await widgetWorld();
    const s = await w.newSession();
    expect((await w.http.get("/public/rooms", undefined, { ...s.headers, origin: "https://evil.test" })).body.error.code).toBe("ORIGIN_NOT_ALLOWED");
    await w.http.del(`/api/tokens/${w.tokenId}`, w.token);
    expect((await w.http.get("/public/rooms", undefined, s.headers)).body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });
  it("cross-tenant: a session from workspace A cannot touch workspace B's rooms", async () => {
    const a = await widgetWorld();
    const sa = await a.newSession();
    const room = await a.http.post("/public/rooms", {}, undefined, sa.headers);
    const b = await widgetWorld({}, "other.example.com");
    // a different server context entirely: the id means nothing there
    expect((await b.http.get(`/public/rooms/${room.body.room.id}/messages`, undefined, sa.headers)).status).toBe(401);
  });
});

describe("visitor rooms and chat", () => {
  it("creates one room (idempotent) with a welcome bot message, and chats with idempotent sends", async () => {
    const w = await widgetWorld();
    const s = await w.newSession({ name: "Vic" });
    const r1 = await w.http.post("/public/rooms", {}, undefined, s.headers);
    const r2 = await w.http.post("/public/rooms", {}, undefined, s.headers);
    expect([r1.status, r2.status]).toEqual([201, 200]);
    expect(r2.body.room.id).toBe(r1.body.room.id);
    const roomId = r1.body.room.id;
    const body = { content: "Hello <b>team</b>", client_msg_id: "visitor-qid-0001" };
    const m1 = await w.http.post(`/public/rooms/${roomId}/messages`, body, undefined, s.headers);
    const m2 = await w.http.post(`/public/rooms/${roomId}/messages`, body, undefined, s.headers);
    expect([m1.status, m2.status]).toEqual([201, 200]);
    expect(m2.body.id).toBe(m1.body.id);
    expect(m1.body.content).toBe("Hello &lt;b&gt;team&lt;/b&gt;");
    const list = await w.http.get(`/public/rooms/${roomId}/messages`, undefined, s.headers);
    const kinds = list.body.data.map((m: any) => `${m.sender.type}:${m.kind}`);
    expect(kinds).toEqual(["system:system", "bot:text", "contact:text"]);
    expect(list.body.data[1].content_text).toContain("Hi there");
    expect(messagesOf(w.ctx, roomId).filter((m) => m.client_msg_id === "visitor-qid-0001")).toHaveLength(1);
    expect((await w.http.post(`/public/rooms/${roomId}/messages`, { content: "" }, undefined, s.headers)).status).toBe(400);
    expect((await w.http.post(`/public/rooms/${roomId}/messages`, { content: "x".repeat(4001) }, undefined, s.headers)).status).toBe(400);
  });
  it("hides internal notes and internal metadata from visitors, shows agent replies", async () => {
    const w = await widgetWorld();
    const s = await w.newSession();
    const room = (await w.http.post("/public/rooms", {}, undefined, s.headers)).body.room;
    await agentSays(w.ctx, w.owner, room.id, "internal only", { kind: "note" });
    await agentSays(w.ctx, w.owner, room.id, "Hi from the team");
    const list = (await w.http.get(`/public/rooms/${room.id}/messages`, undefined, s.headers)).body.data;
    expect(list.map((m: any) => m.content_text)).not.toContain("internal only");
    const reply = list.find((m: any) => m.content_text === "Hi from the team");
    expect(reply.sender).toMatchObject({ type: "agent" });
    expect(reply).not.toHaveProperty("from_addr");
    expect(reply.failure_reason).toBeNull();
  });
  it("emits visitor-visible events to the visitor channel only for non-notes", async () => {
    const w = await widgetWorld();
    const s = await w.newSession();
    const room = (await w.http.post("/public/rooms", {}, undefined, s.headers)).body.room;
    w.ctx.bus.clear();
    await w.http.post(`/public/rooms/${room.id}/messages`, { content: "ping" }, undefined, s.headers);
    const ev = w.ctx.bus.ofType("message:new").find((e) => e.payload.message.content === "ping")!;
    expect((ev.visitor as any).message.content).toBe("ping");
    expect(JSON.stringify(ev.visitor)).not.toContain("triage");
  });
  it("unverified sessions see only rooms created in their own session; a known contact must verify", async () => {
    const w = await widgetWorld();
    const a = await w.newSession({ email: "pat@example.test", name: "Pat" });
    const room = (await w.http.post("/public/rooms", {}, undefined, a.headers)).body.room;
    // another device claims the same email: the contact (and its room) exist but are not theirs
    const b = await w.newSession({ email: "pat@example.test" }, "device-bbbb-0002");
    expect(b.res.body.requires_verification).toBe(true);
    expect((await w.http.get("/public/rooms", undefined, b.headers)).body.data).toEqual([]);
    expect((await w.http.get(`/public/rooms/${room.id}/messages`, undefined, b.headers)).status).toBe(404);
    expect((await w.http.post(`/public/rooms/${room.id}/messages`, { content: "snoop" }, undefined, b.headers)).status).toBe(404);
    const blocked = await w.http.post("/public/rooms", {}, undefined, b.headers);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("VERIFICATION_REQUIRED");
    // the original device continues where it left off, with a fresh session
    const a2 = await w.newSession({ email: "pat@example.test" });
    expect(a2.res.body.requires_verification).toBe(false);
    expect((await w.http.get("/public/rooms", undefined, a2.headers)).body.data.map((r: any) => r.id)).toEqual([room.id]);
  });
  it("returns a visitor read cursor that produces agent-visible receipts", async () => {
    const w = await widgetWorld();
    const s = await w.newSession();
    const room = (await w.http.post("/public/rooms", {}, undefined, s.headers)).body.room;
    const reply = await agentSays(w.ctx, w.owner, room.id, "hello?");
    w.ctx.bus.clear();
    const r = await w.http.post(`/public/rooms/${room.id}/read`, { message_id: reply.id }, undefined, s.headers);
    expect(r.body.moved).toBe(true);
    expect(roomRow(w.ctx, room.id).visitor_read_seq).toBe(reply.seq);
    expect(w.ctx.bus.ofType("message:receipt")[0]!.payload.reader).toEqual({ type: "contact" });
    expect((await w.http.post(`/public/rooms/${room.id}/read`, { message_id: reply.id }, undefined, s.headers)).body.moved).toBe(false);
    const list = (await w.http.get(`/public/rooms/${room.id}/messages`, undefined, s.headers)).body.data;
    expect(list.find((m: any) => m.id === reply.id).read).toBe(true);
    const rooms = (await w.http.get("/public/rooms", undefined, s.headers)).body.data;
    expect(rooms[0].unread_count).toBe(0);
  });
  it("routes new widget rooms through the configured inbox and round robin", async () => {
    const w = await widgetWorld();
    const ann = await addMemberRaw(w.ctx, w.wsId, { name: "Ann" });
    const inbox = mkInbox(w.ctx, w.owner, { name: "Chat", algorithm: "round_robin", member_ids: [ann.memberId], live_routing_visibility: true });
    setSettings(w.ctx, w.wsId, { widget: { default_inbox_id: inbox.id } });
    const s = await w.newSession();
    const room = (await w.http.post("/public/rooms", {}, undefined, s.headers)).body.room;
    expect(w.ctx.db.get("SELECT member_id FROM room_assignees WHERE room_id = ?", room.id)).toEqual({ member_id: ann.memberId });
    expect(roomRow(w.ctx, room.id).inbox_id).toBe(inbox.id);
    const s2 = await w.newSession({}, "device-cccc-0003");
    const hidden = mkInbox(w.ctx, w.owner, { name: "Hidden" });
    expect((await w.http.post("/public/rooms", { inbox_id: hidden.id }, undefined, s2.headers)).body.error.code).toBe("INBOX_NOT_AVAILABLE");
    assignRoom(w.ctx, w.owner, room.id, { member_ids: [] });
  });
  it("posts the away message outside office hours, once per window", async () => {
    const w = await widgetWorld();
    // 2026-03-02 is a Monday 10:00 UTC; hours Tue-Thu only
    setSettings(w.ctx, w.wsId, { widget: { away_message: "We're out.", office_hours: { enabled: true, timezone: "UTC", days: [2, 3, 4].map((day) => ({ day, start: "09:00", end: "17:00" })) } } });
    const s = await w.newSession();
    const room = (await w.http.post("/public/rooms", {}, undefined, s.headers)).body.room;
    await w.http.post(`/public/rooms/${room.id}/messages`, { content: "anyone?" }, undefined, s.headers);
    await w.http.post(`/public/rooms/${room.id}/messages`, { content: "hello??" }, undefined, s.headers);
    await w.ctx.background.settle();
    const away = messagesOf(w.ctx, room.id).filter((m) => m.meta.includes('"away":true'));
    expect(away).toHaveLength(1);
    expect(away[0]!.content_text).toBe("We're out. We'll be back tomorrow at 09:00 (UTC).");
    expect((await w.http.get("/public/widget/config", undefined, w.h())).body.office_open).toBe(false);
    // 24h later (Tuesday 10:00) the office is open: no away message
    w.ctx.clockCtl.advance(86400_000);
    await w.http.post(`/public/rooms/${room.id}/messages`, { content: "now?" }, undefined, s.headers);
    await w.ctx.background.settle();
    expect(messagesOf(w.ctx, room.id).filter((m) => m.meta.includes('"away":true'))).toHaveLength(1);
  });
  it("rate limits visitor sends", async () => {
    const w = await widgetWorld();
    const s = await w.newSession();
    const room = (await w.http.post("/public/rooms", {}, undefined, s.headers)).body.room;
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await w.http.post(`/public/rooms/${room.id}/messages`, { content: `m${i}` }, undefined, s.headers)).status;
    expect(last).toBe(429);
  });
});

describe("OTP verification", () => {
  async function otpWorld(contact: object = { email: "pat@example.test", name: "Pat" }) {
    const w = await widgetWorld();
    const s = await w.newSession(contact);
    const sent = () => w.ctx.email.sent.at(-1) ?? w.ctx.sms.sent.at(-1);
    const code = () => /code is (\d{5})/.exec((sent() as any).text ?? (sent() as any).body)![1]!;
    const send = () => w.http.post("/public/otp/send", {}, undefined, s.headers);
    const verify = (c: string) => w.http.post("/public/otp/verify", { code: c }, undefined, s.headers);
    return { ...w, s, code, send, verify };
  }
  it("emails a 5-digit code and verifies it, after which all contact rooms are visible", async () => {
    const w = await otpWorld();
    const sent = await w.send();
    expect(sent.body).toMatchObject({ channel: "email" });
    expect(w.ctx.email.sent.at(-1)).toMatchObject({ to: "pat@example.test", subject: "Your verification code" });
    const code = w.code();
    expect(code).toMatch(/^\d{5}$/);
    expect((await w.verify(code)).body).toEqual({ verified: true });
    expect((await w.http.get("/public/session", undefined, w.s.headers)).body.verified).toBe(true);
    expect(w.ctx.bus.refreshed.some((r) => r.startsWith("visitor:"))).toBe(true);
  });
  it("falls back to SMS from the workspace number when the contact has only a phone", async () => {
    const w = await widgetWorld();
    const { addSmsNumberRaw } = await import("./helpers.js");
    const s = await w.newSession({ phone: "415-555-2671" });
    const noNumber = await w.http.post("/public/otp/send", {}, undefined, s.headers);
    expect(noNumber.body.error.code).toBe("OTP_CHANNEL_UNAVAILABLE");
    addSmsNumberRaw(w.ctx, w.wsId, "+15550000001", true);
    const ok = await w.http.post("/public/otp/send", {}, undefined, s.headers);
    expect(ok.body.channel).toBe("sms");
    expect(w.ctx.sms.sent[0]).toMatchObject({ to: "+14155552671", from: "+15550000001" });
    const anon = await w.newSession({}, "device-zzzz-0009");
    expect((await w.http.post("/public/otp/send", {}, undefined, anon.headers)).body.error.code).toBe("OTP_CHANNEL_UNAVAILABLE");
  });
  it("rejects wrong codes, counts attempts and locks after 5 until a new code is requested", async () => {
    const w = await otpWorld();
    await w.send();
    const good = w.code();
    const wrong = good === "00000" ? "11111" : "00000";
    for (let i = 1; i <= 4; i++) {
      const r = await w.verify(wrong);
      expect(r.body.error).toMatchObject({ code: "OTP_INVALID", details: { attempts_left: 5 - i } });
    }
    const fifth = await w.verify(wrong);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe("OTP_ATTEMPTS_EXCEEDED");
    expect((await w.verify(good)).body.error.code).toBe("NO_ACTIVE_OTP"); // even the right code is dead now
    w.ctx.clockCtl.advance(31_000);
    await w.send();
    expect((await w.verify(w.code())).body.verified).toBe(true);
  });
  it("rejects malformed codes without leaking or counting differently", async () => {
    const w = await otpWorld();
    await w.send();
    expect((await w.verify("12ab5")).status).toBe(400);
    expect((await w.verify("1234")).status).toBe(400);
    expect((await w.verify("123456")).status).toBe(400);
  });
  it("enforces the resend cooldown (30s)", async () => {
    const w = await otpWorld();
    expect((await w.send()).status).toBe(200);
    const early = await w.send();
    expect(early.status).toBe(429);
    expect(early.body.error.code).toBe("OTP_COOLDOWN");
    w.ctx.clockCtl.advance(29_999);
    expect((await w.send()).status).toBe(429);
    w.ctx.clockCtl.advance(1);
    expect((await w.send()).status).toBe(200);
    expect(w.ctx.email.sent).toHaveLength(2);
  });
  it("expires after exactly 2 minutes: valid at 1:59.999, invalid at 2:00", async () => {
    const w = await otpWorld();
    await w.send();
    const code = w.code();
    w.ctx.clockCtl.advance(119_999);
    const w2 = await otpWorld();
    await w2.send();
    const code2 = w2.code();
    expect((await w.verify(code)).body.verified).toBe(true);
    w2.ctx.clockCtl.advance(120_000);
    const late = await w2.verify(code2);
    expect(late.body.error.code).toBe("OTP_EXPIRED");
    expect((await w2.verify(code2)).body.error.code).toBe("NO_ACTIVE_OTP");
  });
  it("a code cannot be replayed after verification or used on another session", async () => {
    const w = await otpWorld();
    await w.send();
    const code = w.code();
    const other = await w.newSession({ email: "pat@example.test" }, "device-bbbb-0002");
    expect((await w.http.post("/public/otp/verify", { code }, undefined, other.headers)).body.error.code).toBe("NO_ACTIVE_OTP");
    expect((await w.verify(code)).status).toBe(200);
    expect((await w.verify(code)).body.error.code).toBe("ALREADY_VERIFIED");
    expect((await w.send()).body.error.code).toBe("ALREADY_VERIFIED");
  });
  it("verification unlocks existing rooms for a second device", async () => {
    const w = await widgetWorld();
    const a = await w.newSession({ email: "pat@example.test" });
    const room = (await w.http.post("/public/rooms", {}, undefined, a.headers)).body.room;
    const b = await w.newSession({ email: "pat@example.test" }, "device-bbbb-0002");
    expect(b.res.body.requires_verification).toBe(true);
    await w.http.post("/public/otp/send", {}, undefined, b.headers);
    const code = /code is (\d{5})/.exec(w.ctx.email.sent.at(-1)!.text)![1]!;
    await w.http.post("/public/otp/verify", { code }, undefined, b.headers);
    expect((await w.http.get("/public/rooms", undefined, b.headers)).body.data.map((r: any) => r.id)).toEqual([room.id]);
    expect((await w.http.post("/public/rooms", {}, undefined, b.headers)).body.room.id).toBe(room.id);
  });
});
