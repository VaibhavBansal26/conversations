import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentBodySchema, createAgent } from "../src/agents/config.js";
import { executeTool } from "../src/agents/tools.js";
import { toolsFor } from "../src/calls/realtime.js";
import { idFromToken, linkUrl, scrubCallPath, tokenOf } from "../src/calls/links.js";
import { sweepCalls } from "../src/calls/service.js";
import { scrubEvent, scrubString } from "../src/monitoring/scrub.js";
import { agentDto } from "../src/agents/config.js";
import { getRoomRow } from "../src/services/roomStore.js";
import { liveTicketOf } from "../src/services/tickets.js";
import { createKb } from "../src/services/settings.js";
import { setMemberRole } from "../src/services/roles.js";
import { ALL_EVENTS, ack, recorder, sleep, startServer } from "./rt-helpers.js";
import { addMemberRaw, addSenderRaw, addSmsNumberRaw, setSettings, tokenFor } from "./helpers.js";
import { KB } from "./agent-helpers.js";

const EVENTS = [...ALL_EVENTS, "call:state", "call:offer", "call:answer", "call:ice", "call:peer"];
type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
const logged: string[] = [];
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "800", SOCKET_RATE_PER_SEC: "4000", PUBLIC_URL: "https://chat.example.test", TRUST_PROXY: "true", SHED_LOOP_LAG_MS: "0" });
  const cap = (l: string) => (msg: string, f?: Record<string, unknown>) => void logged.push(`${l} ${msg} ${JSON.stringify(f ?? {})}`);
  srv.ctx.log = { debug: cap("d"), info: cap("i"), warn: cap("w"), error: cap("e") };
});
afterAll(async () => {
  await srv.close();
});

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
let ipN = 0;
/** every request comes from its own address (the limiter is per IP), unless a test names one */
const call = async (method: string, path: string, o: { token?: string; json?: unknown; headers?: Record<string, string>; ip?: string } = {}) => {
  const ip = o.ip ?? `10.${Math.floor(++ipN / 250) % 250}.${ipN % 250}.${(ipN * 7) % 250 + 1}`;
  const r = await fetch(`${srv.url}${path}`, { method, headers: { "x-forwarded-for": ip, ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.json !== undefined ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) }, body: o.json !== undefined ? JSON.stringify(o.json) : undefined });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, body, headers: r.headers, text };
};
let deviceN = 0;
const device = () => `device-link-${(++deviceN).toString().padStart(6, "0")}`;
/** a session that was closed is disconnected rather than answered: the next event it sends ends in a drop */
const kicked = (s: any, event: string, payload: object) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    s.once("disconnect", () => (clearTimeout(t), resolve(true)));
    s.emit(event, payload, () => {});
  });
const sdp = (type: "offer" | "answer") => ({ type, sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n" });

/** a workspace with browser calls, calls with the AI and call links on, an AI agent, a team member online, and a visitor in a conversation with a live ticket */
async function world(o: { links?: Record<string, unknown>; ai?: boolean; browser?: boolean; agent?: Record<string, unknown> } = {}) {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
  await setSettings(srv.ctx, wsId, {
    routing: { require_online: false },
    calls: { browser: { enabled: o.browser ?? true, voice: true, video: true, screen_share: true }, ai: { enabled: o.ai ?? true, voice: true, video: true, max_duration_s: 600, idle_timeout_s: 120, max_concurrent: 5, daily_limit: 100 }, links: { enabled: true, ttl_minutes: 30, allow_ai: true, allow_team: true, ...o.links }, ring_seconds: 45, turn_provider: "none" },
  });
  await srv.ctx.cache.invalidate(`settings:${wsId}`);
  for (const k of KB) await createKb(srv.ctx, owner, k);
  const agent = await createAgent(srv.ctx, owner, AgentBodySchema.parse({ name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", ...o.agent }));
  const v = await srv.visitor(wsId, "chat.example.com", device());
  const team = await srv.team(wsId, owner);
  const teamRec = recorder(team, EVENTS);
  const vis = await srv.connect(wsId, v.auth);
  const visRec = recorder(vis, EVENTS);
  const room = await ack(vis, "room:create", {});
  const roomId = room.room.id as string;
  await ack(vis, "message:send", { room_id: roomId, kind: "text", source: "dm", content: "Hello, can we talk?", client_msg_id: `lk-hello-${deviceN}${wsId.slice(-4)}` });
  await srv.ctx.background.settle();
  const ownerToken = await tokenFor(srv.ctx, owner);
  const create = (body: Record<string, unknown> = { mode: "team", kind: "voice" }, token = ownerToken) => call("POST", `/api/rooms/${roomId}/call-links`, { token, json: body });
  const row = (id: string) => srv.ctx.db.get<any>("SELECT * FROM call_links WHERE id = ?", id);
  const redeem = (token: string, dev = device(), extra: Record<string, unknown> = {}) => call("POST", "/public/call-links/redeem", { json: { token, device_id: dev, ...extra } });
  const connectLink = async (r: any, dev: string) => {
    const s = await srv.connect(wsId, { session: r.session_token, deviceId: dev });
    return { s, rec: recorder(s, EVENTS) };
  };
  return { wsId, owner, agent, v, team, teamRec, vis, visRec, roomId, ownerToken, create, row, redeem, connectLink };
}
const tokenIn = (url: string) => url.split("/call/")[1]!;

describe("the address of a call link", () => {
  it("has at least 128 random bits plus a server-secret HMAC, is different every time, and is not stored anywhere (only its hash is)", async () => {
    const w = await world();
    const a = await w.create();
    expect(a.status).toBe(201);
    const token = tokenIn(a.body.url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(a.body.url).toBe(`https://chat.example.test/call/${token}`);
    expect(Buffer.from(token.split(".")[0]!, "base64url")).toHaveLength(16); // 128 bits
    expect(idFromToken(srv.ctx, token)).toBe(a.body.id);
    expect(tokenOf(srv.ctx, a.body.id)).toBe(token);
    expect(linkUrl(srv.ctx, a.body.id)).toBe(a.body.url);
    const b = await w.create();
    expect(tokenIn(b.body.url)).not.toBe(token);
    // tampered or foreign addresses do not even reach the database
    expect(idFromToken(srv.ctx, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(idFromToken(srv.ctx, `${a.body.id}.${"A".repeat(43)}`)).toBeNull();
    expect(idFromToken(srv.ctx, "nonsense")).toBeNull();
    expect(idFromToken(srv.ctx, null)).toBeNull();
    // what is at rest: the hash, never the token, and not in the thread, the audit log or any listing
    const rows = await srv.ctx.db.all<any>("SELECT * FROM call_links WHERE room_id = ?", w.roomId);
    expect(rows.find((r) => r.id === a.body.id).token_hash).toBe(sha(token));
    for (const t of ["call_links", "messages", "audit_log", "ticket_events", "calls", "visitor_sessions"]) expect(JSON.stringify(await srv.ctx.db.all(`SELECT * FROM ${t}`)), t).not.toContain(token);
    const list = await call("GET", `/api/rooms/${w.roomId}/call-links`, { token: w.ownerToken });
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.data[0]).toMatchObject({ mode: "team", kind: "voice", status: expect.any(String) });
  });

  it("the visitor's own copy of the thread shows the address in a card with a status; the team's copy never has it; a used or revoked link has none", async () => {
    const w = await world();
    const made = await w.create({ mode: "team", kind: "video" });
    const msgs = async (token: string, headers: Record<string, string> = {}) => call("GET", `/api/rooms/${w.roomId}/messages`, { token, headers });
    const team = await msgs(w.ownerToken);
    const card = team.body.data.find((m: any) => m.meta?.card?.type === "call_link");
    expect(card.meta.card).toMatchObject({ link_id: made.body.id, mode: "team", kind: "video", status: "active" });
    expect(JSON.stringify(card)).not.toContain(tokenIn(made.body.url));
    const vmsgs = await call("GET", `/public/rooms/${w.roomId}/messages`, { headers: { "x-support-session": w.v.secret, "x-device-id": w.v.auth.deviceId, origin: "https://chat.example.com" } });
    const vcard = vmsgs.body.data.find((m: any) => m.meta?.card?.type === "call_link");
    expect(vcard.meta.card.url).toBe(made.body.url);
    // delivered live to the visitor's socket the same way
    const live = w.visRec.of("message:new").find((m: any) => m.message?.meta?.card?.type === "call_link" || m.meta?.card?.type === "call_link");
    expect(JSON.stringify(live)).toContain(tokenIn(made.body.url));
    expect(JSON.stringify(w.teamRec.log)).not.toContain(tokenIn(made.body.url));
    await call("DELETE", `/api/rooms/${w.roomId}/call-links/${made.body.id}`, { token: w.ownerToken });
    const after = await call("GET", `/public/rooms/${w.roomId}/messages`, { headers: { "x-support-session": w.v.secret, "x-device-id": w.v.auth.deviceId, origin: "https://chat.example.com" } });
    const revokedCard = after.body.data.find((m: any) => m.meta?.card?.type === "call_link");
    expect(revokedCard.meta.card).toMatchObject({ status: "revoked" });
    expect(revokedCard.meta.card.url).toBeUndefined();
  });
});

describe("creating links", () => {
  it("is refused when links are off, per mode, when the matching calls are off, without the permission, and for conversations you cannot see", async () => {
    const off = await world({ links: { enabled: false } });
    expect((await off.create()).body.error.code).toBe("CALL_LINKS_DISABLED");
    const noAi = await world({ links: { allow_ai: false } });
    expect((await noAi.create({ mode: "ai", kind: "voice" })).body.error.code).toBe("CALL_LINKS_DISABLED");
    expect((await noAi.create({ mode: "team", kind: "voice" })).status).toBe(201);
    const noTeam = await world({ links: { allow_team: false } });
    expect((await noTeam.create({ mode: "team", kind: "voice" })).body.error.code).toBe("CALL_LINKS_DISABLED");
    const noBrowser = await world({ browser: false });
    expect((await noBrowser.create({ mode: "team", kind: "voice" })).body.error.code).toBe("CALLS_DISABLED");
    const noAiCalls = await world({ ai: false });
    expect((await noAiCalls.create({ mode: "ai", kind: "voice" })).body.error.code).toBe("AI_CALL_UNAVAILABLE");
    const noAction = await world({ agent: { allowed_actions: ["route"] } });
    expect((await noAction.create({ mode: "ai", kind: "voice" })).body.error.code).toBe("AI_CALL_UNAVAILABLE");
    // permission and visibility
    const w = await world();
    const viewer = await addMemberRaw(srv.ctx, w.wsId, { name: "Vic Viewer", role: "agent" });
    await setMemberRole(srv.ctx, w.owner, viewer.memberId, "role_viewer");
    expect((await w.create({ mode: "team", kind: "voice" }, await tokenFor(srv.ctx, viewer))).status).toBe(403);
    const other = await world();
    expect((await call("POST", `/api/rooms/${w.roomId}/call-links`, { token: other.ownerToken, json: { mode: "team", kind: "voice" } })).status).toBe(404);
    const unassigned = await addMemberRaw(srv.ctx, w.wsId, { name: "Ann Agent", role: "agent", inbox_visibility: "assigned_inbox" });
    expect((await w.create({ mode: "team", kind: "voice" }, await tokenFor(srv.ctx, unassigned))).status).toBe(404);
  });

  it("expires after the workspace's time (30 minutes by default), a shorter or longer time can be asked for within 5 minutes to 24 hours, and a new link replaces the old one", async () => {
    const w = await world();
    const a = await w.create();
    expect(Date.parse(a.body.expires_at) - srv.ctx.clock().getTime()).toBe(30 * 60_000);
    const short = await w.create({ mode: "team", kind: "voice", ttl_minutes: 5 });
    expect(Date.parse(short.body.expires_at) - srv.ctx.clock().getTime()).toBe(5 * 60_000);
    expect((await w.row(a.body.id)).revoked_at).not.toBeNull(); // replaced
    const day = await w.create({ mode: "team", kind: "voice", ttl_minutes: 1440 });
    expect(Date.parse(day.body.expires_at) - srv.ctx.clock().getTime()).toBe(1440 * 60_000);
    for (const bad of [4, 1441, 0, -5, 30.5]) expect((await w.create({ mode: "team", kind: "voice", ttl_minutes: bad })).status, String(bad)).toBe(400);
    const audit = await srv.ctx.db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit_log WHERE action = 'call_link.created' AND detail LIKE ?", `%${w.roomId}%`);
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit)).not.toContain(tokenIn(day.body.url));
  });

  it("is rate limited per conversation (10 an hour)", async () => {
    const w = await world();
    const results = [];
    for (let i = 0; i < 12; i++) results.push((await w.create({ mode: "team", kind: "voice", ttl_minutes: 5 })).status);
    expect(results.filter((s) => s === 201)).toHaveLength(10);
    expect(results.slice(10)).toEqual([429, 429]);
  });

  it("can be sent by email or SMS only to a contact who agreed, never to someone who unsubscribed or opted out, and test mode is reported honestly", async () => {
    const w = await world();
    const contactId = (await srv.ctx.db.get<{ contact_id: string }>("SELECT contact_id FROM rooms WHERE id = ?", w.roomId))!.contact_id;
    await addSenderRaw(srv.ctx, w.wsId, "support@acme.example.test", true, true);
    await addSmsNumberRaw(srv.ctx, w.wsId, "+14155550100", true);
    const mail = ["visitor", "example.test"].join("@");
    const send = (via: "email" | "sms") => w.create({ mode: "team", kind: "voice", send: via, ttl_minutes: 5 });
    expect((await send("email")).body.error.code).toBe("CONTACT_EMAIL_REQUIRED");
    await srv.ctx.db.run("UPDATE contacts SET email = ?, phone = ? WHERE id = ?", mail, "+14155552671", contactId);
    expect((await send("email")).body.error.code).toBe("NO_CONSENT");
    expect((await send("sms")).body.error.code).toBe("NO_CONSENT");
    await srv.ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ contact_consent: { at: "2026-03-01T00:00:00Z", text: "I agree" } }), contactId);
    const ok = await send("email");
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.sent).toMatchObject({ channel: "email", delivery: expect.stringMatching(/^(pending|sent|delivered|not_sent_test_mode)$/) });
    const m = await srv.ctx.db.get<{ content_text: string; source: string }>("SELECT content_text, source FROM messages WHERE id = ?", ok.body.sent.message_id);
    expect(m!.source).toBe("email");
    expect(m!.content_text).toContain(ok.body.url);
    expect(m!.content_text).toMatch(/works until \d\d:\d\d UTC, once, on one device/);
    const sms = await send("sms");
    expect(sms.status, JSON.stringify(sms.body)).toBe(201);
    expect(sms.body.sent).toMatchObject({ channel: "sms" });
    await srv.ctx.db.run("UPDATE contacts SET sms_opt_out = 1 WHERE id = ?", contactId);
    expect((await send("sms")).body.error.code).toBe("NO_CONSENT");
    await srv.ctx.db.run("UPDATE contacts SET sms_opt_out = 0, unsubscribed = 1 WHERE id = ?", contactId);
    expect((await send("email")).body.error.code).toBe("NO_CONSENT");
    expect((await send("sms")).body.error.code).toBe("NO_CONSENT");
  });
});

describe("opening a link", () => {
  it("shows who is on the other end before anything is joined; every kind of unusable link gets the same refusal", async () => {
    const w = await world();
    const ai = await w.create({ mode: "ai", kind: "video" });
    const pre = await call("POST", "/public/call-links/preview", { json: { token: tokenIn(ai.body.url) } });
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ mode: "ai", kind: "video", workspace_name: "Acme", ai: { name: "Aria", label: "AI assistant" } });
    const team = await w.create({ mode: "team", kind: "voice" });
    expect((await call("POST", "/public/call-links/preview", { json: { token: tokenIn(team.body.url) } })).body).toMatchObject({ mode: "team", kind: "voice", ai: null });
    // unknown, malformed, forged, replaced, expired, revoked: one and the same answer
    const replaced = tokenIn(ai.body.url);
    const forged = `${team.body.id}.${"B".repeat(43)}`;
    const unknownButWellFormed = tokenOf(srv.ctx, "A".repeat(22));
    const refusals = [];
    for (const t of [replaced, forged, unknownButWellFormed, "garbage", "", "x".repeat(150)]) {
      const r = await call("POST", "/public/call-links/preview", { json: { token: t || "x" } });
      refusals.push(JSON.stringify([r.status, r.body]));
    }
    expect(new Set(refusals).size).toBe(1);
    expect(JSON.parse(refusals[0]!)[0]).toBe(404);
    expect(JSON.parse(refusals[0]!)[1].error.code).toBe("LINK_UNAVAILABLE");
    const t30 = tokenIn(team.body.url);
    srv.clockCtl.advance(31 * 60_000);
    const expired = await call("POST", "/public/call-links/preview", { json: { token: t30 } });
    expect(JSON.stringify([expired.status, expired.body])).toBe(refusals[0]);
    expect((await w.redeem(t30)).body.error.code).toBe("LINK_UNAVAILABLE");
    expect((await call("GET", `/api/rooms/${w.roomId}/call-links`, { token: await tokenFor(srv.ctx, w.owner) })).body.data.find((l: any) => l.id === team.body.id).status).toBe("expired");
  });

  it("hands out a session that can only take part in the call: no messages, no history, no new conversations, nothing over REST", async () => {
    const w = await world();
    const made = await w.create({ mode: "team", kind: "voice" });
    const dev = device();
    const r = await w.redeem(tokenIn(made.body.url), dev, { name: "Pat from the shop" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mode: "team", kind: "voice", workspace_id: w.wsId, room_id: w.roomId, display_name: "Pat from the shop" });
    const { s, rec } = await w.connectLink(r.body, dev);
    // nothing of the conversation is readable or writable
    for (const [ev, p] of [["message:send", { room_id: w.roomId, kind: "text", source: "dm", content: "hi", client_msg_id: "link-msg-0001" }], ["message:read", { room_id: w.roomId }], ["room:create", {}], ["typing", { room_id: w.roomId, typing: true }], ["call:request", { room_id: w.roomId, kind: "voice" }], ["otp:verify", { code: "123456" }]] as const) {
      expect((await ack(s, ev, p)).error?.code, ev).toBe("LINK_SESSION");
    }
    const headers = { "x-support-session": r.body.session_token, "x-device-id": dev, origin: "https://chat.example.com" };
    for (const path of ["/public/rooms", `/public/rooms/${w.roomId}/messages`, "/public/session"]) expect((await call("GET", path, { headers })).body.error.code, path).toBe("LINK_SESSION");
    expect((await call("POST", `/public/rooms/${w.roomId}/messages`, { headers, json: { content: "x" } })).body.error.code).toBe("LINK_SESSION");
    // and the thread's live messages do not reach it, but the calls of the conversation do
    await ack(w.team, "message:send", { room_id: w.roomId, kind: "text", source: "dm", content: "a private reply nobody on the link may read", client_msg_id: "team-reply-0001" });
    await sleep(80);
    expect(rec.of("message:new")).toHaveLength(0);
    expect(JSON.stringify(rec.log)).not.toContain("private reply");
    const inv = await ack(w.team, "call:invite", { room_id: w.roomId, kind: "voice" });
    expect(inv.ok).toBe(true);
    const ring = await rec.waitFor("call:state", (p) => p.call.id === inv.call.id);
    expect(ring.call).toMatchObject({ state: "ringing", kind: "voice" });
    // the first person (chat) must not be confused: the link session is another socket of the same contact
    await ack(w.team, "call:end", { call_id: inv.call.id });
  });

  it("the whole call with the team: the visitor waits, the team is told and rings, the visitor answers, media is signalled, and ending uses the link up", async () => {
    const w = await world();
    const made = await w.create({ mode: "team", kind: "video" });
    const dev = device();
    const r = await w.redeem(tokenIn(made.body.url), dev);
    const { s, rec } = await w.connectLink(r.body, dev);
    // the team reads that the visitor opened the link and is waiting, with the usual "call requested" line
    await sleep(80);
    const thread = await srv.ctx.db.all<{ content_text: string; meta: string }>("SELECT content_text, meta FROM messages WHERE room_id = ? ORDER BY seq", w.roomId);
    expect(thread.some((m) => JSON.parse(m.meta).sub_type === "call_link_opened")).toBe(true);
    expect(thread.some((m) => JSON.parse(m.meta).sub_type === "call_request")).toBe(true);
    // the opened-line is for the team only
    const vthread = await call("GET", `/public/rooms/${w.roomId}/messages`, { headers: { "x-support-session": w.v.secret, "x-device-id": w.v.auth.deviceId, origin: "https://chat.example.com" } });
    expect(JSON.stringify(vthread.body)).not.toContain("opened the");
    const inv = await ack(w.team, "call:invite", { room_id: w.roomId, kind: "video" });
    expect(inv.ok).toBe(true);
    await rec.waitFor("call:state", (p) => p.call.id === inv.call.id && p.call.state === "ringing");
    const acc = await ack(s, "call:accept", { call_id: inv.call.id });
    expect(acc).toMatchObject({ ok: true, call: { state: "connecting" } });
    await ack(w.team, "call:offer", { call_id: inv.call.id, data: sdp("offer") });
    await rec.waitFor("call:offer");
    await ack(s, "call:answer", { call_id: inv.call.id, data: sdp("answer") });
    await ack(w.team, "call:connected", { call_id: inv.call.id });
    await ack(s, "call:connected", { call_id: inv.call.id });
    expect((await w.row(made.body.id)).consumed_at).toBeNull(); // in use
    expect((await call("GET", `/api/rooms/${w.roomId}/call-links`, { token: w.ownerToken })).body.data[0].status).toBe("in_use");
    // the chat's own socket of the same visitor heard nothing of the signalling
    expect(w.visRec.of("call:offer")).toHaveLength(0);
    await ack(s, "call:end", { call_id: inv.call.id });
    expect((await w.row(made.body.id)).consumed_at).not.toBeNull();
    expect((await call("GET", `/api/rooms/${w.roomId}/call-links`, { token: w.ownerToken })).body.data[0].status).toBe("used");
    // used up: the address is dead, the session is gone, the card has no address
    expect((await w.redeem(tokenIn(made.body.url), dev)).body.error.code).toBe("LINK_UNAVAILABLE");
    expect(await kicked(s, "call:end", { call_id: inv.call.id })).toBe(true);
  });

  it("the whole call with the AI assistant, on a device with no chat: it starts through the link's session, answers from the knowledge base and uses the link up", async () => {
    const w = await world();
    const made = await w.create({ mode: "ai", kind: "voice" });
    expect(made.status).toBe(201);
    const dev = device();
    const r = await w.redeem(tokenIn(made.body.url), dev);
    expect(r.body).toMatchObject({ mode: "ai", kind: "voice", ai: { name: "Aria", label: "AI assistant" } });
    const { s } = await w.connectLink(r.body, dev);
    const started = await ack(s, "aicall:start", { room_id: w.roomId, kind: "voice", speech: { stt: true, tts: true } });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(started.ai.disclosure).toMatch(/not a person/);
    const said = await ack(s, "aicall:say", { call_id: started.call.id, text: "How do I reset my password?", seq: 1, via: "voice" });
    expect(said.reply.kind).toBe("answer");
    const row = await srv.ctx.db.get<any>("SELECT meta FROM calls WHERE id = ?", started.call.id);
    expect(JSON.parse(row.meta).link_id).toBe(made.body.id);
    await ack(s, "aicall:end", { call_id: started.call.id });
    expect((await w.row(made.body.id)).consumed_at).not.toBeNull();
    expect((await w.redeem(tokenIn(made.body.url), dev)).body.error.code).toBe("LINK_UNAVAILABLE");
    // the transcript is in the thread as ordinary messages, tagged with the call
    const t = await srv.ctx.db.all<{ content_text: string; meta: string }>("SELECT content_text, meta FROM messages WHERE room_id = ?", w.roomId);
    expect(t.find((m) => m.content_text === "How do I reset my password?" && JSON.parse(m.meta).call_id === started.call.id)).toBeTruthy();
  });

  it("belongs to one device at a time: a second device is refused, the same device can come back, and two first openings at once give one winner", async () => {
    const w = await world();
    const made = await w.create({ mode: "team", kind: "voice" });
    const token = tokenIn(made.body.url);
    const d1 = device();
    const first = await w.redeem(token, d1);
    expect(first.status).toBe(201);
    expect((await w.redeem(token, device())).body.error.code).toBe("LINK_UNAVAILABLE");
    expect((await call("POST", "/public/call-links/preview", { json: { token } })).status).toBe(200); // the page can still be shown on the first device
    const again = await w.redeem(token, d1);
    expect(again.status).toBe(201);
    expect(again.body.session_token).not.toBe(first.body.session_token);
    // the older session no longer works
    const old = await srv.connect(w.wsId, { session: first.body.session_token, deviceId: d1 }).catch((e: any) => e);
    expect(old.code ?? old.message).toMatch(/SESSION_EXPIRED|expired/i);
    const w2 = await world();
    const m2 = await w2.create({ mode: "team", kind: "voice" });
    const results = await Promise.all([w2.redeem(tokenIn(m2.body.url), device()), w2.redeem(tokenIn(m2.body.url), device()), w2.redeem(tokenIn(m2.body.url), device())]);
    expect(results.map((x) => x.status).sort()).toEqual([201, 404, 404]);
  });

  it("can be revoked by the team: it stops working at once, the link's call ends, the card says so, and only the conversation's own team may revoke it", async () => {
    const w = await world();
    const made = await w.create({ mode: "team", kind: "voice" });
    const dev = device();
    const r = await w.redeem(tokenIn(made.body.url), dev);
    const { s, rec } = await w.connectLink(r.body, dev);
    const inv = await ack(w.team, "call:invite", { room_id: w.roomId, kind: "voice" });
    await ack(s, "call:accept", { call_id: inv.call.id });
    const other = await world();
    expect((await call("DELETE", `/api/rooms/${w.roomId}/call-links/${made.body.id}`, { token: other.ownerToken })).status).toBe(404);
    expect((await call("GET", `/api/rooms/${w.roomId}/call-links`, { token: other.ownerToken })).status).toBe(404);
    const del = await call("DELETE", `/api/rooms/${w.roomId}/call-links/${made.body.id}`, { token: w.ownerToken });
    expect(del.body.status).toBe("revoked");
    expect(await srv.ctx.db.get<any>("SELECT state, end_reason FROM calls WHERE id = ?", inv.call.id)).toMatchObject({ state: "ended", end_reason: "link_revoked" });
    expect((await w.redeem(tokenIn(made.body.url), dev)).body.error.code).toBe("LINK_UNAVAILABLE");
    expect((await call("POST", "/public/call-links/preview", { json: { token: tokenIn(made.body.url) } })).status).toBe(404);
    expect(await kicked(s, "call:end", { call_id: inv.call.id })).toBe(true);
    void rec;
    expect((await call("DELETE", `/api/rooms/${w.roomId}/call-links/${made.body.id}`, { token: w.ownerToken })).status).toBe(200); // idempotent
    const audit = (await srv.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE target = ?", made.body.id)).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["call_link.created", "call_link.opened", "call_link.revoked"]));
  });

  it("is bound to one conversation and one workspace: another room of the same contact, another workspace's namespace and another workspace's link are refused", async () => {
    const a = await world();
    const b = await world();
    const made = await a.create({ mode: "ai", kind: "voice" });
    const dev = device();
    const r = await a.redeem(tokenIn(made.body.url), dev);
    // the link's session in another workspace's namespace
    await expect(srv.connect(b.wsId, { session: r.body.session_token, deviceId: dev })).rejects.toBeTruthy();
    const { s } = await a.connectLink(r.body, dev);
    // another conversation of the same workspace (here: workspace b's room id): not found
    expect((await ack(s, "aicall:start", { room_id: b.roomId, kind: "voice" })).error.code).toBe("NOT_FOUND");
    // a second conversation of the same contact is not reachable either
    const second = await srv.ctx.db.get<{ contact_id: string }>("SELECT contact_id FROM rooms WHERE id = ?", a.roomId);
    await srv.ctx.db.run("INSERT INTO rooms(id, workspace_id, contact_id, created_at, updated_at) VALUES ('room_second_x', ?, ?, ?, ?)", a.wsId, second!.contact_id, srv.ctx.clock().toISOString(), srv.ctx.clock().toISOString()).catch(() => {});
    expect((await ack(s, "aicall:start", { room_id: "room_second_x", kind: "voice" })).error.code).toBe("NOT_FOUND");
    // a link of workspace a, offered to workspace b's routes
    expect((await call("DELETE", `/api/rooms/${b.roomId}/call-links/${made.body.id}`, { token: b.ownerToken })).status).toBe(404);
  });

  it("expires its session with the link plus the time a running call may take, and a call that is running when the link expires goes on", async () => {
    const w = await world();
    const made = await w.create({ mode: "team", kind: "voice", ttl_minutes: 5 });
    const dev = device();
    const r = await w.redeem(tokenIn(made.body.url), dev);
    expect(Date.parse(r.body.expires_at) - Date.parse(made.body.expires_at)).toBe(120 * 60_000);
    const { s } = await w.connectLink(r.body, dev);
    const inv = await ack(w.team, "call:invite", { room_id: w.roomId, kind: "voice" });
    await ack(s, "call:accept", { call_id: inv.call.id });
    await ack(w.team, "call:offer", { call_id: inv.call.id, data: sdp("offer") });
    await ack(s, "call:answer", { call_id: inv.call.id, data: sdp("answer") });
    await ack(w.team, "call:connected", { call_id: inv.call.id });
    await ack(s, "call:connected", { call_id: inv.call.id });
    srv.clockCtl.advance(10 * 60_000); // the link has expired, the call has not ended
    await sweepCalls(srv.ctx);
    expect((await srv.ctx.db.get<any>("SELECT state FROM calls WHERE id = ?", inv.call.id)).state).toBe("active");
    expect((await w.redeem(tokenIn(made.body.url), dev)).body.error.code).toBe("LINK_UNAVAILABLE"); // but nobody new can open it
  });
});

describe("what the page and the logs reveal", () => {
  it("the page is the same document for every address, never cached, never framed, with no referrer and the address nowhere in it", async () => {
    const w = await world();
    const made = await w.create();
    const token = tokenIn(made.body.url);
    const good = await call("GET", `/call/${token}`);
    const bad = await call("GET", `/call/${"z".repeat(66)}`);
    expect(good.status).toBe(200);
    expect(good.text).toBe(bad.text);
    expect(good.text).not.toContain(token);
    for (const r of [good, bad]) {
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(r.headers.get("x-robots-tag")).toContain("noindex");
    }
    expect(good.text).toContain('<meta name="referrer" content="no-referrer">');
    expect(good.text).toContain("/chat/assets/callpage.js");
  });

  it("the address never reaches the logs, the error reports or the audit log, whether the link works or not", async () => {
    const w = await world();
    const made = await w.create();
    const token = tokenIn(made.body.url);
    logged.length = 0;
    await call("GET", `/call/${token}`);
    await call("POST", "/public/call-links/preview", { json: { token } });
    await call("POST", "/public/call-links/redeem", { json: { token, device_id: device() } });
    await call("POST", "/public/call-links/preview", { json: { token: `${token.slice(0, 30)}tampered` } });
    await call("GET", `/call/${token}?x=1`);
    await sleep(50);
    const lines = logged.join("\n");
    expect(lines).not.toContain(token);
    expect(lines).not.toContain(token.split(".")[0]!);
    expect(lines).toContain('"path":"/call/[link]"');
    expect(JSON.stringify(await srv.ctx.db.all("SELECT * FROM audit_log"))).not.toContain(token);
    // the error-report scrubber knows both shapes
    expect(scrubString(`failed at https://chat.example.test/call/${token}`)).not.toContain(token);
    expect(scrubString(token)).toBe("[call-link]");
    expect(scrubString("/call/abc.def-ghi")).toBe("/call/[link]");
    expect(scrubCallPath(`/call/${token}`)).toBe("/call/[link]");
    const ev = scrubEvent({ message: `GET /call/${token}`, exception: { values: [{ type: "Error", value: `bad link ${token}` }] }, request: { url: `https://chat.example.test/call/${token}` } } as any);
    expect(JSON.stringify(ev)).not.toContain(token);
  });

  it("brute force is throttled: failed guesses escalate into a block of that address, and a flood of previews is rate limited", async () => {
    const w = await world();
    const made = await w.create();
    // the flood limit (20 a minute) first
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await call("POST", "/public/call-links/preview", { ip: "203.0.113.9", json: { token: tokenOf(srv.ctx, `${"A".repeat(21)}${String.fromCharCode(66 + (i % 20))}`) } })).status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 404).length).toBeGreaterThan(5);
    // blocked: even the right address does not get through while the block lasts
    const blocked = await call("POST", "/public/call-links/preview", { ip: "203.0.113.9", json: { token: tokenIn(made.body.url) } });
    // and another address is not affected
    expect((await call("POST", "/public/call-links/preview", { ip: "203.0.113.77", json: { token: tokenIn(made.body.url) } })).status).toBe(200);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("the AI assistant's tool", () => {
  it("posts the link as a card from the assistant, for the visitor, in the mode it is allowed; refuses when it may not, or links are off", async () => {
    const w = await world();
    const room = await getRoomRow(srv.ctx, w.wsId, w.roomId);
    const ticket = (await liveTicketOf(srv.ctx, w.roomId))!;
    const agentRow = (await srv.ctx.db.get<any>("SELECT * FROM ai_agents WHERE id = ?", w.agent.id))!;
    const agent = agentDto(agentRow);
    expect(toolsFor(agent).map((t) => t.name)).toContain("share_call_link");
    const ok = await executeTool(srv.ctx, { room, ticket, agent, action: { tool: "share_call_link", kind: "voice", with: "ai" } });
    expect(ok).toMatchObject({ ok: true });
    const links = await srv.ctx.db.all<any>("SELECT * FROM call_links WHERE room_id = ?", w.roomId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ mode: "ai", kind: "voice", created_by: `bot:${w.agent.id}` });
    const card = await srv.ctx.db.get<{ meta: string; sender_type: string }>("SELECT meta, sender_type FROM messages WHERE id = ?", links[0].message_id);
    expect(card!.sender_type).toBe("bot");
    expect(JSON.parse(card!.meta)).toMatchObject({ ai: true, agent: { name: "Aria", label: "AI assistant" }, card: { type: "call_link", mode: "ai", status: "active" } });
    // a link to the team, when the assistant asks for it
    const team = await executeTool(srv.ctx, { room, ticket, agent, action: { tool: "share_call_link", kind: "video", with: "team" } });
    expect(team.ok).toBe(true);
    expect((await srv.ctx.db.all<any>("SELECT mode FROM call_links WHERE room_id = ? AND revoked_at IS NULL", w.roomId)).map((l) => l.mode)).toEqual(["team"]);
    // an agent that may not take AI calls cannot offer one
    const noAi = { ...agent, allowed_actions: ["share_call_link"] as typeof agent.allowed_actions };
    const refused = await executeTool(srv.ctx, { room, ticket, agent: noAi, action: { tool: "share_call_link", kind: "voice", with: "ai" } });
    expect(refused.ok).toBe(false);
    expect(toolsFor({ ...agent, allowed_actions: ["route"] }).map((t) => t.name)).not.toContain("share_call_link");
    // links switched off
    await setSettings(srv.ctx, w.wsId, { calls: { browser: { enabled: true }, ai: { enabled: true }, links: { enabled: false } } });
    await srv.ctx.cache.invalidate(`settings:${w.wsId}`);
    const off = await executeTool(srv.ctx, { room, ticket, agent, action: { tool: "share_call_link", kind: "voice", with: "ai" } });
    expect(off).toMatchObject({ ok: false, summary: expect.stringContaining("call links disabled") });
  });
});

describe("the settings of call links", () => {
  it("are off by default and bounded", async () => {
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Defaults");
    const token = await tokenFor(srv.ctx, owner);
    const patch = (b: unknown) => call("PATCH", "/api/calls/settings", { token, json: b });
    const cfg = await patch({ links: { allow_ai: true } });
    expect(cfg.body.settings.calls.links).toEqual({ enabled: false, ttl_minutes: 30, allow_ai: true, allow_team: true });
    expect((await patch({ links: { enabled: true, ttl_minutes: 120 } })).body.settings.calls.links).toMatchObject({ enabled: true, ttl_minutes: 120, allow_ai: true });
    for (const bad of [{ ttl_minutes: 4 }, { ttl_minutes: 1441 }, { enabled: "yes" }]) expect((await patch({ links: bad })).status, JSON.stringify(bad)).toBe(400);
    void wsId;
  });
});
