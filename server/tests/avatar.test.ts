import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentBodySchema, createAgent, updateAgent, type AgentRow } from "../src/agents/config.js";
import { DidAvatarProvider } from "../src/avatar/did.js";
import { FakeAvatarProvider } from "../src/avatar/fake.js";
import { setAvatarProvider } from "../src/avatar/service.js";
import { sweepCalls } from "../src/calls/service.js";
import { scrubString } from "../src/monitoring/scrub.js";
import { redactSecrets } from "../src/util/redact.js";
import { createKb } from "../src/services/settings.js";
import { supportOverview } from "../src/services/supportAnalytics.js";
import { ALL_EVENTS, ack, recorder, sleep, startServer } from "./rt-helpers.js";
import { addMemberRaw, setSettings, tokenFor } from "./helpers.js";
import { KB } from "./agent-helpers.js";

/** a D-ID-shaped key built at run time (never a literal in the repository) */
const mkKey = () => `${randomBytes(12).toString("base64url")}:${randomBytes(12).toString("base64url")}`;

/* ---------- the D-ID adapter against a recorded fetch ---------- */
function recordingFetch(answer: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const seen: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answer(url, init);
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("the D-ID adapter (request shapes from D-ID's reference; NOT run against the real service)", () => {
  it("test connection reads GET /credits with Basic auth and the key as given; base64 is an option", async () => {
    const key = mkKey();
    const r = recordingFetch(() => ({ status: 200, body: { remaining: 12, total: 20, credits: [] } }));
    expect(await new DidAvatarProvider({ baseUrl: "https://did.test", fetchFn: r.f }).testConnection(key)).toEqual({ credits_remaining: 12 });
    expect(r.seen[0]).toMatchObject({ url: "https://did.test/credits", method: "GET" });
    expect(r.seen[0]!.headers.authorization).toBe(`Basic ${key}`);
    const r2 = recordingFetch(() => ({ status: 200, body: {} }));
    expect(await new DidAvatarProvider({ baseUrl: "https://did.test", fetchFn: r2.f, authEncoding: "base64" }).testConnection(key)).toEqual({ credits_remaining: null });
    expect(r2.seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from(key).toString("base64")}`);
  });

  it("agents from a stock presenter (clip) or a photo (talk), the stream, SDP, ICE, speak and close, each with the session id", async () => {
    const r = recordingFetch((url, init) => {
      if (url.endsWith("/agents") && init.method === "POST") return { status: 201, body: { id: "agt_1", embed: false } };
      if (url.endsWith("/agents/agt_1/streams") && init.method === "POST") return { status: 201, body: { id: "strm_1", jsep: { type: "offer", sdp: "v=0 offer" }, ice_servers: [{ urls: ["stun:x"] }, { urls: "turn:y", username: "u", credential: "c" }, { nope: 1 }], session_id: "sess_1" } };
      return { status: 200, body: { status: "success", duration: 2.5 } };
    });
    const p = new DidAvatarProvider({ baseUrl: "https://did.test", fetchFn: r.f });
    const key = mkKey();
    expect(await p.ensureAgent(key, { name: "Aria", source: "presenter", presenter_id: "v2_public_amy", voice_provider: "microsoft", voice_id: "en-US-JennyNeural" }, null)).toBe("agt_1");
    expect(r.seen[0]!.body).toEqual({ presenter: { type: "clip", presenter_id: "v2_public_amy", voice: { type: "microsoft", voice_id: "en-US-JennyNeural" } }, preview_name: "Aria" });
    await p.ensureAgent(key, { name: "Photo", source: "image", image_url: "https://img.test/a.jpg" }, null);
    expect(r.seen[1]!.body).toEqual({ presenter: { type: "talk", source_url: "https://img.test/a.jpg", thumbnail: "https://img.test/a.jpg" }, preview_name: "Photo" });
    expect(await p.ensureAgent(key, { name: "x", source: "presenter", presenter_id: "y" }, "agt_existing")).toBe("agt_existing");
    expect(r.seen).toHaveLength(2);
    const st = await p.startStream(key, "agt_1");
    expect(st).toEqual({ streamId: "strm_1", sessionId: "sess_1", offer: { type: "offer", sdp: "v=0 offer" }, iceServers: [{ urls: ["stun:x"] }, { urls: "turn:y", username: "u", credential: "c" }] });
    expect(r.seen[2]!.body).toEqual({ compatibility_mode: "auto", stream_warmup: true });
    const ref = { streamId: st.streamId, sessionId: st.sessionId };
    await p.sendAnswer(key, "agt_1", ref, { type: "answer", sdp: "v=0 answer" });
    await p.sendIce(key, "agt_1", ref, { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
    await p.speak(key, "agt_1", ref, "Hi", { provider: "microsoft", id: "en-US-JennyNeural" });
    await p.close(key, "agt_1", ref);
    expect(r.seen.slice(3).map((s) => [s.method, s.url.replace("https://did.test", ""), s.body])).toEqual([
      ["POST", "/agents/agt_1/streams/strm_1/sdp", { answer: { type: "answer", sdp: "v=0 answer" }, session_id: "sess_1" }],
      ["POST", "/agents/agt_1/streams/strm_1/ice", { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, session_id: "sess_1" }],
      ["POST", "/agents/agt_1/streams/strm_1", { script: { type: "text", input: "Hi...", provider: { type: "microsoft", voice_id: "en-US-JennyNeural" } }, session_id: "sess_1" }],
      ["DELETE", "/agents/agt_1/streams/strm_1", { session_id: "sess_1" }],
    ]);
  });

  it("maps failures to safe messages: the response body (which may echo the key) is never kept", async () => {
    const key = mkKey();
    for (const [status, kind] of [[401, "auth"], [403, "auth"], [402, "credits"], [409, "not_ready"], [429, "rate_limited"], [500, "unavailable"], [400, "bad_request"]] as const) {
      const r = recordingFetch(() => ({ status, body: { description: `bad key ${key}` } }));
      const e = await new DidAvatarProvider({ baseUrl: "https://did.test", fetchFn: r.f }).testConnection(key).catch((x) => x);
      expect(e.kind, String(status)).toBe(kind);
      expect(String(e.message)).not.toContain(key.split(":")[1]);
    }
    const slow = (async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect((await new DidAvatarProvider({ fetchFn: slow }).testConnection(key).catch((x) => x)).kind).toBe("timeout");
    const bad = recordingFetch(() => ({ status: 201, body: { id: "s", jsep: { type: "answer" } } }));
    expect((await new DidAvatarProvider({ baseUrl: "https://did.test", fetchFn: bad.f }).startStream(key, "a").catch((x) => x)).kind).toBe("malformed");
  });

  it("redaction and the error-monitoring scrubber remove user:password keys and Basic headers", () => {
    const key = mkKey();
    for (const s of [redactSecrets(`failed with ${key}`), redactSecrets(`Authorization: Basic ${key}`), scrubString(`D-ID said Basic ${key} oops`), scrubString(`key=${key}`)]) {
      expect(s).not.toContain(key.split(":")[1]);
    }
  });
});

/* ---------- settings, the key, calls ---------- */
type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
const fake = new FakeAvatarProvider();
const logs: string[] = [];
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "400", SOCKET_RATE_PER_SEC: "2000", DATA_ENCRYPTION_KEY: randomBytes(32).toString("hex") });
  setAvatarProvider(fake);
  const l = srv.ctx.log as any;
  for (const lvl of ["debug", "info", "warn", "error"]) {
    const orig = l[lvl];
    l[lvl] = (m: string, f?: unknown) => (logs.push(`${m} ${JSON.stringify(f ?? {})}`), orig?.(m, f));
  }
});
afterAll(async () => {
  setAvatarProvider(null);
  await srv.close();
});

const EVENTS = [...ALL_EVENTS, "call:state", "aicall:avatar_state"];
async function world(o: { avatar?: Record<string, unknown>; connect?: boolean; assign?: boolean } = {}) {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
  await setSettings(srv.ctx, wsId, {
    routing: { require_online: false },
    calls: { browser: { enabled: false, voice: true, video: true, screen_share: true }, ring_seconds: 45, turn_provider: "none", ai: { enabled: true, voice: true, video: true, max_duration_s: 600, idle_timeout_s: 120, max_concurrent: 5, daily_limit: 100 }, avatar: { enabled: true, minutes_daily: 10, max_concurrent: 2, ...o.avatar } },
  });
  await srv.ctx.cache.invalidate(`settings:${wsId}`);
  for (const k of KB) await createKb(srv.ctx, owner, k);
  const agent: AgentRow = await createAgent(srv.ctx, owner, AgentBodySchema.parse({ name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "" }));
  const token = await tokenFor(srv.ctx, owner);
  const api = async (method: string, path: string, body?: unknown, tok = token) => {
    const r = await fetch(`${srv.url}/api${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, text };
  };
  const key = mkKey();
  let avatarId: string | null = null;
  if (o.connect !== false) {
    await api("PUT", "/calls/avatar/connection", { provider: "did", api_key: key });
    await api("POST", "/calls/avatar/connection/test");
    avatarId = (await api("POST", "/calls/avatar/avatars", { name: "Amy", source: "presenter", presenter_id: "v2_public_amy", voice_provider: "microsoft", voice_id: "en-US-JennyNeural" })).body.id;
    if (o.assign !== false) await api("PUT", `/agents/${agent.id}/photoreal-avatar`, { avatar_id: avatarId });
  }
  const visitor = async (device: string) => {
    const v = await srv.visitor(wsId, "chat.example.com", device);
    const vis = await srv.connect(wsId, v.auth);
    const rec = recorder(vis, EVENTS);
    const room = await ack(vis, "room:create", {});
    let seq = 0;
    return { vis, rec, roomId: room.room.id as string, start: (kind: "voice" | "video" = "video", webrtc = true) => ack(vis, "aicall:start", { room_id: room.room.id, kind, locale: "en-US", speech: { stt: true, tts: true, webrtc } }), say: (callId: string, text: string) => ack(vis, "aicall:say", { call_id: callId, text, seq: ++seq, via: "voice" }) };
  };
  return { wsId, owner, agent, token, api, key, avatarId, visitor };
}
const sessionOf = (callId: string) => srv.ctx.db.get<any>("SELECT * FROM avatar_sessions WHERE call_id = ? ORDER BY started_at DESC", callId);

describe("connecting a key (Settings > Calls > Photoreal avatar)", () => {
  it("off and not connected by default; the key is stored encrypted, never returned, never in the audit log or the logs", async () => {
    const w = await world({ connect: false });
    const s0 = (await w.api("GET", "/calls/avatar")).body;
    expect(s0).toMatchObject({ provider: null, connection: null, state: "not_connected", kill_switch: false, avatars: [] });
    const put = await w.api("PUT", "/calls/avatar/connection", { provider: "did", api_key: w.key });
    expect(put.status).toBe(200);
    expect(put.body.connection).toMatchObject({ source: "workspace", status: "pending", key_hint: `…${w.key.slice(-4)}` });
    const [user, pass] = w.key.split(":");
    for (const t of [put.text, (await w.api("GET", "/calls/avatar")).text]) {
      expect(t).not.toContain(pass);
      expect(t).not.toContain(user);
    }
    const row = await srv.ctx.db.get<{ credentials_enc: string }>("SELECT credentials_enc FROM avatar_connections WHERE workspace_id = ?", w.wsId);
    expect(row!.credentials_enc).toMatch(/^enc2\./);
    expect(row!.credentials_enc).not.toContain(pass);
    const t = await w.api("POST", "/calls/avatar/connection/test");
    expect(t.body).toMatchObject({ ok: true, credits_remaining: 20, status: { connection: { status: "connected" }, state: "on" } });
    expect(fake.of("test").pop()!.key).toBe(w.key); // the provider got the real key: decryption works
    const audit = JSON.stringify(await srv.ctx.db.all("SELECT * FROM audit_log WHERE workspace_id = ? AND action LIKE 'avatar.%'", w.wsId));
    expect(audit).toContain("avatar.connected");
    expect(audit).not.toContain(pass);
    expect(logs.join("\n")).not.toContain(pass);
  });

  it("a key the provider refuses shows Failing with a safe reason; Disconnect deletes the key", async () => {
    const w = await world({ connect: false });
    await w.api("PUT", "/calls/avatar/connection", { provider: "did", api_key: "no-colon-key-123" });
    const t = await w.api("POST", "/calls/avatar/connection/test");
    expect(t.body).toMatchObject({ ok: false, error: "D-ID refused the API key", status: { state: "failing", connection: { status: "failing", last_error: "D-ID refused the API key" } } });
    expect((await w.api("DELETE", "/calls/avatar/connection")).body).toMatchObject({ connection: null, state: "not_connected" });
    expect(await srv.ctx.db.get("SELECT 1 FROM avatar_connections WHERE workspace_id = ?", w.wsId)).toBeUndefined();
    expect((await w.api("DELETE", "/calls/avatar/connection")).status).toBe(404);
    expect((await w.api("POST", "/calls/avatar/connection/test")).body.error.code).toBe("AVATAR_NOT_CONNECTED");
    expect((await w.api("PUT", "/calls/avatar/connection", { provider: "did", api_key: "has spaces in it" })).body.error.code).toBe("INVALID_API_KEY");
  });

  it("needs calls:settings; another workspace sees and changes nothing", async () => {
    const w = await world();
    const agent = await addMemberRaw(srv.ctx, w.wsId, { name: "Ann", role: "agent" });
    const at = await tokenFor(srv.ctx, agent);
    for (const [m, p, b] of [["GET", "/calls/avatar"], ["PUT", "/calls/avatar/connection", { provider: "did", api_key: mkKey() }], ["POST", "/calls/avatar/connection/test"], ["DELETE", "/calls/avatar/connection"], ["POST", "/calls/avatar/avatars", { name: "x", source: "presenter", presenter_id: "abc" }], ["PUT", `/agents/${w.agent.id}/photoreal-avatar`, { avatar_id: null }]] as const) {
      expect((await w.api(m, p, b, at)).status, `${m} ${p}`).toBe(403);
    }
    const other = await world({ connect: false });
    expect((await other.api("GET", "/calls/avatar")).body.avatars).toEqual([]);
    expect((await other.api("DELETE", `/calls/avatar/avatars/${w.avatarId}`)).status).toBe(404);
    expect((await other.api("PUT", `/agents/${other.agent.id}/photoreal-avatar`, { avatar_id: w.avatarId })).status).toBe(404);
    expect((await other.api("PUT", `/agents/${w.agent.id}/photoreal-avatar`, { avatar_id: null })).status).toBe(404);
    expect((await w.api("GET", "/calls/avatar")).body.agents).toEqual([{ id: w.agent.id, name: "Aria", avatar_id: w.avatarId }]);
  });

  it("avatars: a stock presenter, or an https photo only with consent recorded; at most five", async () => {
    const w = await world();
    expect((await w.api("POST", "/calls/avatar/avatars", { name: "P", source: "image", image_url: "https://img.example.test/p.jpg" })).body.error.code).toBe("CONSENT_REQUIRED");
    expect((await w.api("POST", "/calls/avatar/avatars", { name: "P", source: "image", image_url: "http://img.example.test/p.jpg", consent: true })).body.error.code).toBe("INVALID_IMAGE_URL");
    expect((await w.api("POST", "/calls/avatar/avatars", { name: "P", source: "presenter", presenter_id: "bad id!" })).body.error.code).toBe("INVALID_PRESENTER");
    const ok = await w.api("POST", "/calls/avatar/avatars", { name: "Photo", source: "image", image_url: "https://img.example.test/p.jpg", consent: true });
    expect(ok.body).toMatchObject({ source: "image", consent_at: expect.any(String), prepared: false });
    for (let i = 0; i < 3; i++) await w.api("POST", "/calls/avatar/avatars", { name: `P${i}`, source: "presenter", presenter_id: `p_${i}` });
    expect((await w.api("POST", "/calls/avatar/avatars", { name: "six", source: "presenter", presenter_id: "p6" })).body.error.code).toBe("TOO_MANY_AVATARS");
    // deleting an avatar puts its agents back on the built-in face
    expect((await w.api("DELETE", `/calls/avatar/avatars/${w.avatarId}`)).status).toBe(200);
    expect((await w.api("GET", "/calls/avatar")).body.agents[0].avatar_id).toBeNull();
  });
});

describe("a video call with the AI", () => {
  it("photoreal when everything allows it: the browser gets only the offer and ICE servers; the answer, candidates and speech go through this server; the label and disclosure are unchanged", async () => {
    const w = await world();
    const v = await w.visitor("dev-av-1");
    const r = await v.start("video");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ai.avatar).toMatchObject({ mode: "photoreal", reason: null, session: { offer: { type: "offer" }, ice_servers: [{ urls: ["stun:stun.fake-avatar.test:3478"] }] } });
    const ackText = JSON.stringify(r);
    for (const secret of [w.key.split(":")[1], "agt_fake", "strm_", "sess_"]) expect(ackText).not.toContain(secret);
    // the AI is announced exactly as with the built-in face
    expect(r.ai.agent.label).toBe("AI assistant");
    expect(r.ai.disclosure).toMatch(/Aria \(AI assistant\), not a person/);
    const id = r.call.id;
    expect(await sessionOf(id)).toMatchObject({ state: "starting", provider: "did" });
    expect((await ack(v.vis, "aicall:avatar", { call_id: id, op: "answer", data: { type: "answer", sdp: "v=0 answer" } })).mode).toBe("photoreal");
    expect(fake.of("sdp").pop()!.args[1]).toMatchObject({ sessionId: expect.stringMatching(/^sess_/) });
    await ack(v.vis, "aicall:avatar", { call_id: id, op: "ice", data: { candidate: "candidate:1 1 udp 1 192.0.2.1 1 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    expect(fake.of("ice")).not.toHaveLength(0);
    const speaks = fake.of("speak").length;
    await ack(v.vis, "aicall:avatar", { call_id: id, op: "connected" });
    // the first thing the avatar says is the greeting with the disclosure
    expect(String(fake.of("speak")[speaks]!.args[2])).toMatch(/AI assistant\), not a person/);
    await ack(v.vis, "aicall:avatar", { call_id: id, op: "connected" }); // a repeated report does not greet twice
    expect(fake.of("speak")).toHaveLength(speaks + 1);
    const a = await v.say(id, "How do I reset my password?");
    expect(a.ok).toBe(true);
    expect(fake.of("speak").pop()!.args[2]).toBe(a.reply.speech);
    srv.clockCtl.advance(90_000);
    await ack(v.vis, "aicall:end", { call_id: id });
    expect(await sessionOf(id)).toMatchObject({ state: "ended", seconds: 90 });
    expect(fake.of("close").length).toBeGreaterThan(0);
    // and the analytics count the minutes with no price assumed
    const ov = await supportOverview(srv.ctx, w.wsId, { from: new Date(srv.ctx.clock().getTime() - 86400_000), to: new Date(srv.ctx.clock().getTime() + 86400_000), tz: "UTC", interval: "day" });
    expect(ov.ai_calls.photoreal).toEqual({ sessions: 1, minutes: 1.5, fell_back: 0, estimated_cost_usd: null });
  });

  it("the built-in face, with the reason, whenever photoreal cannot be used", async () => {
    const off = await world({ avatar: { enabled: false } });
    expect((await (await off.visitor("d-off")).start("video")).ai.avatar).toEqual({ mode: "builtin", reason: "off", session: null });
    const w = await world();
    expect((await (await w.visitor("d-voice")).start("voice")).ai.avatar.reason).toBe("not_video");
    expect((await (await w.visitor("d-nortc")).start("video", false)).ai.avatar.reason).toBe("no_webrtc");
    const none = await world({ connect: false });
    expect((await (await none.visitor("d-none")).start("video")).ai.avatar.reason).toBe("not_connected");
    const noAv = await world({ assign: false });
    expect((await (await noAv.visitor("d-noav")).start("video")).ai.avatar.reason).toBe("no_avatar");
    srv.ctx.config.AVATAR_PHOTOREAL_ENABLED = false;
    try {
      expect((await (await w.visitor("d-kill")).start("video")).ai.avatar.reason).toBe("kill_switch");
      expect((await w.api("GET", "/calls/avatar")).body.state).toBe("switched_off_on_server");
    } finally {
      srv.ctx.config.AVATAR_PHOTOREAL_ENABLED = true;
    }
    fake.failNext.set("stream", "unavailable");
    const pf = await (await w.visitor("d-pf")).start("video");
    expect(pf.ai.avatar.reason).toBe("provider_failed");
    expect(await sessionOf(pf.call.id)).toMatchObject({ state: "failed", end_reason: "unavailable" });
  });

  it("the concurrency cap and the day's minutes fall back to the built-in face", async () => {
    const w = await world({ avatar: { max_concurrent: 1, minutes_daily: 1 } });
    const a = await (await w.visitor("d-c1")).start("video");
    expect(a.ai.avatar.mode).toBe("photoreal");
    expect((await (await w.visitor("d-c2")).start("video")).ai.avatar.reason).toBe("concurrency");
    await srv.ctx.db.run("UPDATE avatar_sessions SET state = 'ended', seconds = 61, ended_at = started_at WHERE call_id = ?", a.call.id);
    expect((await (await w.visitor("d-c3")).start("video")).ai.avatar.reason).toBe("budget");
  });

  it("any failure later switches the visitor to the built-in face and voice, and the call goes on", async () => {
    const w = await world();
    const v = await w.visitor("d-fail");
    const r = await v.start("video");
    const id = r.call.id;
    await ack(v.vis, "aicall:avatar", { call_id: id, op: "answer", data: { type: "answer", sdp: "v=0" } });
    await ack(v.vis, "aicall:avatar", { call_id: id, op: "connected" });
    fake.failNext.set("speak", "unavailable");
    const a = await v.say(id, "How do I reset my password?");
    expect(a.ok).toBe(true);
    expect(a.reply.text).toBeTruthy();
    expect((await v.rec.waitFor("aicall:avatar_state", (p) => p.call_id === id)).state).toBe("failed");
    expect((await sessionOf(id)).state).toBe("failed");
    // the browser's own report of a failure is accepted too, and the call stays active
    const v2 = await w.visitor("d-fail2");
    const r2 = await v2.start("video");
    expect((await ack(v2.vis, "aicall:avatar", { call_id: r2.call.id, op: "failed", data: "ice_failed" })).mode).toBe("builtin");
    expect((await srv.ctx.db.get<any>("SELECT state FROM calls WHERE id = ?", r2.call.id)).state).toBe("active");
    // switching photoreal off mid-call stops it at the next sweep and tells the visitor
    const v3 = await w.visitor("d-fail3");
    const r3 = await v3.start("video");
    await ack(v3.vis, "aicall:avatar", { call_id: r3.call.id, op: "connected" });
    await setSettings(srv.ctx, w.wsId, { calls: { avatar: { enabled: false } } });
    await srv.ctx.cache.invalidate(`settings:${w.wsId}`);
    await sweepCalls(srv.ctx);
    expect((await v3.rec.waitFor("aicall:avatar_state", (p) => p.call_id === r3.call.id)).reason).toBe("kill_switch");
  });

  it("nobody else can signal a visitor's photoreal stream; bad signals are refused", async () => {
    const w = await world();
    const v = await w.visitor("d-own");
    const r = await v.start("video");
    const other = await w.visitor("d-other");
    expect((await ack(other.vis, "aicall:avatar", { call_id: r.call.id, op: "answer", data: { type: "answer", sdp: "x" } })).error.code).toBe("NOT_FOUND");
    expect((await ack(v.vis, "aicall:avatar", { call_id: r.call.id, op: "answer", data: { type: "offer", sdp: "x" } })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(v.vis, "aicall:avatar", { call_id: r.call.id, op: "ice", data: { candidate: "x".repeat(3000) } })).error.code).toBe("INVALID_SIGNAL");
    const team = await srv.team(w.wsId, w.owner);
    expect((await ack(team, "aicall:avatar", { call_id: r.call.id, op: "connected" })).ok).toBe(false);
  });

  it("the AI label cannot be removed: an agent's disclosure label must have at least two characters, photoreal or not", async () => {
    const w = await world();
    await expect(updateAgent(srv.ctx, w.owner, w.agent.id, { disclosure_label: "" } as any)).rejects.toThrow();
    await expect(updateAgent(srv.ctx, w.owner, w.agent.id, { disclosure_label: " " } as any)).rejects.toThrow();
    await sleep(1);
  });
});
