import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { decryptWithDataKey, encryptWithDataKey } from "../util/dataCrypto.js";
import { redactSecrets } from "../util/redact.js";
import { recordAudit } from "../services/audit.js";
import { getSettings } from "../services/workspaces.js";
import { DidAvatarProvider } from "./did.js";
import { FakeAvatarProvider } from "./fake.js";
import { AvatarError, type AvatarProvider, type AvatarSpec } from "./provider.js";

/**
 * The photoreal avatar of AI video calls (docs/CALLS.md "Photoreal avatar", ADR 0039). OFF unless ALL of these hold for a call:
 *   the instance kill switch AVATAR_PHOTOREAL_ENABLED is on; the workspace connected a key (or the instance has DID_API_KEY) AND switched
 *   `calls.avatar.enabled` on; the call is a video call on the browser speech engine; the agent has a photoreal avatar chosen; today's minutes
 *   and the concurrency cap allow it; and the provider answers. Otherwise, and on ANY failure later, the call shows the built-in face.
 * The key is encrypted at rest, never returned, never logged, never in the audit log.
 */

let override: AvatarProvider | null = null;
let fakeSingleton: FakeAvatarProvider | null = null;
export const setAvatarProvider = (p: AvatarProvider | null) => void (override = p);
export function avatarProvider(ctx: AppContext): AvatarProvider {
  if (override) return override;
  if (ctx.config.AVATAR_TEST_PROVIDER === "fake" && ctx.config.NODE_ENV !== "production") return (fakeSingleton ??= new FakeAvatarProvider());
  return new DidAvatarProvider({ baseUrl: ctx.config.DID_API_BASE, authEncoding: ctx.config.DID_AUTH_ENCODE });
}

const aad = (ws: string) => `avatar:${ws}:did`;
interface ConnRow {
  workspace_id: string;
  provider: "did";
  credentials_enc: string;
  key_hint: string;
  status: "pending" | "connected" | "failing";
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface AvatarRow {
  id: string;
  workspace_id: string;
  name: string;
  provider: "did";
  source: "presenter" | "image";
  presenter_id: string | null;
  image_url: string | null;
  voice_provider: string | null;
  voice_id: string | null;
  external_id: string | null;
  consent_by: string | null;
  consent_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface SessionRow {
  id: string;
  workspace_id: string;
  call_id: string;
  avatar_id: string;
  provider: string;
  external_agent_id: string | null;
  stream_id: string | null;
  provider_session: string | null;
  state: "starting" | "live" | "ended" | "failed";
  greeted: number;
  started_at: string;
  connected_at: string | null;
  ended_at: string | null;
  seconds: number | null;
  end_reason: string | null;
}

const conn = (ctx: AppContext, ws: string) => ctx.db.get<ConnRow>("SELECT * FROM avatar_connections WHERE workspace_id = ?", ws);
/** The key to use for this workspace: its own, else the instance fallback, else none. Never leaves this module except into a provider call. */
async function keyFor(ctx: AppContext, ws: string): Promise<{ key: string; source: "workspace" | "instance" } | null> {
  const row = await conn(ctx, ws);
  if (row) {
    try {
      return { key: decryptWithDataKey(ctx.config, row.credentials_enc, aad(ws)).plain, source: "workspace" };
    } catch {
      return null;
    }
  }
  return ctx.config.DID_API_KEY ? { key: ctx.config.DID_API_KEY, source: "instance" } : null;
}
const safe = (e: unknown) => (e instanceof AvatarError ? redactSecrets(e.message).slice(0, 200) : "The provider could not be used");

const avatarDto = (a: AvatarRow) => ({ id: a.id, name: a.name, provider: a.provider, source: a.source, presenter_id: a.presenter_id, image_url: a.image_url, voice_provider: a.voice_provider, voice_id: a.voice_id, prepared: !!a.external_id, consent_at: a.consent_at, created_at: a.created_at });

const startOfUtcDay = (ctx: AppContext) => {
  const d = ctx.clock();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};
/** seconds of photoreal video today: finished sessions by their length, live ones by how long they have run */
export async function avatarSecondsToday(ctx: AppContext, ws: string): Promise<number> {
  const rows = await ctx.db.all<{ state: string; seconds: number | null; connected_at: string | null; started_at: string }>("SELECT state, seconds, connected_at, started_at FROM avatar_sessions WHERE workspace_id = ? AND started_at >= ?", ws, startOfUtcDay(ctx));
  const now = ctx.clock().getTime();
  return rows.reduce((s, r) => s + (r.state === "live" || r.state === "starting" ? Math.max(0, Math.round((now - Date.parse(r.connected_at ?? r.started_at)) / 1000)) : r.seconds ?? 0), 0);
}

/* ---------- settings screen ---------- */

export async function avatarStatus(ctx: AppContext, actor: Actor) {
  const ws = actor.workspaceId;
  const row = await conn(ctx, ws);
  const s = (await getSettings(ctx, ws)).calls.avatar;
  const avatars = await ctx.db.all<AvatarRow>("SELECT * FROM photoreal_avatars WHERE workspace_id = ? ORDER BY created_at", ws);
  const agents = await ctx.db.all<{ id: string; name: string; photoreal_avatar_id: string | null }>("SELECT id, name, photoreal_avatar_id FROM ai_agents WHERE workspace_id = ? ORDER BY name", ws);
  const usedS = await avatarSecondsToday(ctx, ws);
  const connected = row?.status === "connected" || (!row && !!ctx.config.DID_API_KEY);
  return {
    provider: row ? row.provider : ctx.config.DID_API_KEY ? "did" : null,
    connection: row ? { source: "workspace" as const, status: row.status, key_hint: `…${row.key_hint}`, last_error: row.last_error, last_checked_at: row.last_checked_at } : ctx.config.DID_API_KEY ? { source: "instance" as const, status: "connected" as const, key_hint: null, last_error: null, last_checked_at: null } : null,
    /** what a call would show right now, in one word, for the status chip */
    state: !ctx.config.AVATAR_PHOTOREAL_ENABLED ? "switched_off_on_server" : !row && !ctx.config.DID_API_KEY ? "not_connected" : row?.status === "failing" ? "failing" : !s.enabled ? "connected_off" : connected ? "on" : "pending",
    kill_switch: !ctx.config.AVATAR_PHOTOREAL_ENABLED,
    settings: s,
    usage_today: { minutes: Math.round((usedS / 60) * 100) / 100, limit_minutes: s.minutes_daily, estimated_cost_usd: ctx.config.AVATAR_COST_PER_MINUTE_USD === undefined ? null : Math.round((usedS / 60) * ctx.config.AVATAR_COST_PER_MINUTE_USD * 100) / 100 },
    avatars: avatars.map(avatarDto),
    agents: agents.map((a) => ({ id: a.id, name: a.name, avatar_id: a.photoreal_avatar_id })),
  };
}

/** Store (or replace) the workspace's key. Status is "pending" until a test succeeds. */
export async function connectAvatar(ctx: AppContext, actor: Actor, input: { provider: "did"; api_key: string }) {
  const ws = actor.workspaceId;
  const key = input.api_key.trim();
  if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw unprocessable("INVALID_API_KEY", "That does not look like an API key");
  let sealed: string;
  try {
    sealed = encryptWithDataKey(ctx.config, key, aad(ws));
  } catch (e) {
    if (e instanceof AppError && e.code === "DATA_ENCRYPTION_KEY_REQUIRED") throw new AppError(503, "DATA_ENCRYPTION_KEY_REQUIRED", "This server has no DATA_ENCRYPTION_KEY, so it cannot store provider keys. Ask the operator to set it.");
    throw e;
  }
  const now = nowIso(ctx);
  await ctx.db.run(
    `INSERT INTO avatar_connections(workspace_id, provider, credentials_enc, key_hint, status, created_by, created_at, updated_at) VALUES (?,?,?,?,'pending',?,?,?)
     ON CONFLICT(workspace_id) DO UPDATE SET provider = excluded.provider, credentials_enc = excluded.credentials_enc, key_hint = excluded.key_hint, status = 'pending', last_error = NULL, last_checked_at = NULL, updated_at = excluded.updated_at`,
    ws, input.provider, sealed, key.slice(-4), actor.memberId, now, now,
  );
  // a new key means new provider-side agents: the old ids belong to the old account
  await ctx.db.run("UPDATE photoreal_avatars SET external_id = NULL WHERE workspace_id = ?", ws);
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "avatar.connected", target: ws, detail: { provider: input.provider } });
  return avatarStatus(ctx, actor);
}

/** "Test connection": the provider's cheapest authenticated read (D-ID: GET /credits). */
export async function testAvatarConnection(ctx: AppContext, actor: Actor) {
  const ws = actor.workspaceId;
  const k = await keyFor(ctx, ws);
  if (!k) throw new AppError(409, "AVATAR_NOT_CONNECTED", "Connect an API key first");
  const rl = await ctx.ratelimit.check("avatar.test", { key: ws, workspaceId: ws });
  if (!rl.allowed) throw new AppError(429, "RATE_LIMITED", "Wait a minute before testing again");
  const now = nowIso(ctx);
  try {
    const r = await avatarProvider(ctx).testConnection(k.key);
    if (k.source === "workspace") await ctx.db.run("UPDATE avatar_connections SET status = 'connected', last_error = NULL, last_checked_at = ?, updated_at = ? WHERE workspace_id = ?", now, now, ws);
    await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "avatar.tested", target: ws, detail: { ok: true } });
    return { ok: true, credits_remaining: r.credits_remaining, status: await avatarStatus(ctx, actor) };
  } catch (e) {
    const msg = safe(e);
    if (k.source === "workspace") await ctx.db.run("UPDATE avatar_connections SET status = 'failing', last_error = ?, last_checked_at = ?, updated_at = ? WHERE workspace_id = ?", msg, now, now, ws);
    await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "avatar.tested", target: ws, detail: { ok: false, kind: e instanceof AvatarError ? e.kind : "error" } });
    return { ok: false, error: msg, status: await avatarStatus(ctx, actor) };
  }
}

/** Disconnect: the key is deleted (not kept disabled), photoreal stops at once (running sessions end at their next step). */
export async function disconnectAvatar(ctx: AppContext, actor: Actor) {
  const ws = actor.workspaceId;
  const r = await ctx.db.run("DELETE FROM avatar_connections WHERE workspace_id = ?", ws);
  if (!r.changes) throw notFound("Avatar connection");
  await ctx.db.run("UPDATE photoreal_avatars SET external_id = NULL WHERE workspace_id = ?", ws);
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "avatar.disconnected", target: ws });
  return avatarStatus(ctx, actor);
}

const PRESENTER = /^[A-Za-z0-9_.:-]{2,120}$/;
export async function createAvatar(ctx: AppContext, actor: Actor, input: { name: string; source: "presenter" | "image"; presenter_id?: string; image_url?: string; voice_provider?: string; voice_id?: string; consent?: boolean }) {
  const ws = actor.workspaceId;
  const n = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM photoreal_avatars WHERE workspace_id = ?", ws))!.n;
  if (Number(n) >= 5) throw unprocessable("TOO_MANY_AVATARS", "A workspace can have 5 photoreal avatars");
  if (input.source === "presenter" && !PRESENTER.test(input.presenter_id ?? "")) throw unprocessable("INVALID_PRESENTER", "Enter the presenter id from D-ID");
  if (input.source === "image") {
    let u: URL | null = null;
    try {
      u = new URL(input.image_url ?? "");
    } catch {
      u = null;
    }
    if (!u || u.protocol !== "https:") throw unprocessable("INVALID_IMAGE_URL", "The photo must be at an https address the provider can download");
    // a photo of a real person needs that person's permission: the workspace says so explicitly, and it is recorded
    if (input.consent !== true) throw unprocessable("CONSENT_REQUIRED", "Confirm that you have the right and the person's consent to use this photo as an AI avatar");
  }
  const now = nowIso(ctx);
  const id = newId("pav");
  await ctx.db.run(
    "INSERT INTO photoreal_avatars(id, workspace_id, name, provider, source, presenter_id, image_url, voice_provider, voice_id, consent_by, consent_at, created_at, updated_at) VALUES (?,?,?,'did',?,?,?,?,?,?,?,?,?)",
    id, ws, input.name.trim().slice(0, 60), input.source, input.source === "presenter" ? input.presenter_id! : null, input.source === "image" ? input.image_url! : null,
    input.voice_provider ?? null, input.voice_id ?? null, input.source === "image" ? actor.memberId : null, input.source === "image" ? now : null, now, now,
  );
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "avatar.created", target: id, detail: { source: input.source, consent: input.source === "image" } });
  return avatarDto((await ctx.db.get<AvatarRow>("SELECT * FROM photoreal_avatars WHERE id = ?", id))!);
}
export async function deleteAvatar(ctx: AppContext, actor: Actor, id: string) {
  const r = await ctx.db.run("DELETE FROM photoreal_avatars WHERE id = ? AND workspace_id = ?", id, actor.workspaceId);
  if (!r.changes) throw notFound("Avatar");
  await ctx.db.run("UPDATE ai_agents SET photoreal_avatar_id = NULL WHERE workspace_id = ? AND photoreal_avatar_id = ?", actor.workspaceId, id);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "avatar.deleted", target: id });
  return { ok: true };
}
/** Which photoreal avatar an AI agent shows in video calls (null: its built-in face). */
export async function setAgentAvatar(ctx: AppContext, actor: Actor, agentId: string, avatarId: string | null) {
  const ws = actor.workspaceId;
  if (!(await ctx.db.get("SELECT 1 FROM ai_agents WHERE id = ? AND workspace_id = ?", agentId, ws))) throw notFound("Agent");
  if (avatarId && !(await ctx.db.get("SELECT 1 FROM photoreal_avatars WHERE id = ? AND workspace_id = ?", avatarId, ws))) throw notFound("Avatar");
  await ctx.db.run("UPDATE ai_agents SET photoreal_avatar_id = ? WHERE id = ? AND workspace_id = ?", avatarId, agentId, ws);
  await ctx.cache.invalidate(`agents:${ws}`).catch(() => undefined);
  return { agent_id: agentId, avatar_id: avatarId };
}

/* ---------- during a call ---------- */

export type AvatarFallback = "off" | "kill_switch" | "not_connected" | "failing" | "no_avatar" | "not_video" | "realtime_engine" | "no_webrtc" | "budget" | "concurrency" | "provider_failed";
export interface AvatarAck {
  mode: "photoreal" | "builtin";
  /** why the built-in face is used (null when photoreal) */
  reason: AvatarFallback | null;
  /** short-lived session information for the browser: the provider's offer and ICE servers. No key, no provider ids. */
  session: { id: string; offer: { type: "offer"; sdp: string }; ice_servers: { urls: string | string[]; username?: string; credential?: string }[] } | null;
}
const builtin = (reason: AvatarFallback): AvatarAck => ({ mode: "builtin", reason, session: null });

/** Called once the AI call exists. Never throws: anything wrong means the built-in face. */
export async function negotiateAvatar(ctx: AppContext, o: { callId: string; workspaceId: string; agentId: string; kind: "voice" | "video"; engine: string; webrtc: boolean }): Promise<AvatarAck> {
  try {
    const ws = o.workspaceId;
    const s = (await getSettings(ctx, ws)).calls.avatar;
    if (!s.enabled) return builtin("off");
    if (!ctx.config.AVATAR_PHOTOREAL_ENABLED) return builtin("kill_switch");
    if (o.kind !== "video") return builtin("not_video");
    if (o.engine === "realtime") return builtin("realtime_engine");
    if (!o.webrtc) return builtin("no_webrtc");
    const row = await conn(ctx, ws);
    if (row && row.status === "failing") return builtin("failing");
    const k = await keyFor(ctx, ws);
    if (!k) return builtin("not_connected");
    const agent = await ctx.db.get<{ photoreal_avatar_id: string | null }>("SELECT photoreal_avatar_id FROM ai_agents WHERE id = ? AND workspace_id = ?", o.agentId, ws);
    const av = agent?.photoreal_avatar_id ? await ctx.db.get<AvatarRow>("SELECT * FROM photoreal_avatars WHERE id = ? AND workspace_id = ?", agent.photoreal_avatar_id, ws) : undefined;
    if (!av) return builtin("no_avatar");
    if ((await avatarSecondsToday(ctx, ws)) >= s.minutes_daily * 60) return builtin("budget");
    const live = Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM avatar_sessions WHERE workspace_id = ? AND state IN ('starting','live')", ws))!.n);
    if (live >= s.max_concurrent) return builtin("concurrency");
    const id = newId("avs");
    const now = nowIso(ctx);
    await ctx.db.run("INSERT INTO avatar_sessions(id, workspace_id, call_id, avatar_id, provider, state, started_at) VALUES (?,?,?,?,?,'starting',?)", id, ws, o.callId, av.id, "did", now);
    // a race past the cap: the row is written first, then counted up to it (parallel starts can only over-refuse)
    const ahead = Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM avatar_sessions WHERE workspace_id = ? AND state IN ('starting','live') AND (started_at < ? OR (started_at = ? AND id <= ?))", ws, now, now, id))!.n);
    if (ahead > s.max_concurrent) {
      await ctx.db.run("UPDATE avatar_sessions SET state = 'failed', ended_at = ?, seconds = 0, end_reason = 'concurrency' WHERE id = ?", now, id);
      return builtin("concurrency");
    }
    const p = avatarProvider(ctx);
    try {
      const agentId = await p.ensureAgent(k.key, { name: av.name, source: av.source, presenter_id: av.presenter_id, image_url: av.image_url, voice_provider: av.voice_provider, voice_id: av.voice_id } satisfies AvatarSpec, av.external_id);
      if (agentId !== av.external_id) await ctx.db.run("UPDATE photoreal_avatars SET external_id = ?, updated_at = ? WHERE id = ?", agentId, now, av.id);
      const st = await p.startStream(k.key, agentId);
      await ctx.db.run("UPDATE avatar_sessions SET external_agent_id = ?, stream_id = ?, provider_session = ? WHERE id = ?", agentId, st.streamId, st.sessionId, id);
      await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "call.avatar_started", target: o.callId, detail: { avatar_id: av.id, provider: p.id } });
      return { mode: "photoreal", reason: null, session: { id, offer: st.offer, ice_servers: st.iceServers } };
    } catch (e) {
      await failSession(ctx, id, e instanceof AvatarError ? e.kind : "error");
      ctx.log.warn("photoreal avatar could not start", { workspace_id: ws, reason: safe(e) });
      return builtin("provider_failed");
    }
  } catch (e) {
    ctx.log.warn("photoreal avatar negotiation failed", { error: e instanceof Error ? e.name : "error" });
    return builtin("provider_failed");
  }
}

const sessionOf = (ctx: AppContext, callId: string) => ctx.db.get<SessionRow>("SELECT * FROM avatar_sessions WHERE call_id = ? AND state IN ('starting','live')", callId);
const avatarOf = (ctx: AppContext, s: SessionRow) => ctx.db.get<AvatarRow>("SELECT * FROM photoreal_avatars WHERE id = ?", s.avatar_id);

async function failSession(ctx: AppContext, id: string, reason: string) {
  const now = nowIso(ctx);
  const s = await ctx.db.get<SessionRow>("SELECT * FROM avatar_sessions WHERE id = ?", id);
  if (!s || (s.state !== "starting" && s.state !== "live")) return;
  const secs = s.connected_at ? Math.max(0, Math.round((Date.parse(now) - Date.parse(s.connected_at)) / 1000)) : 0;
  await ctx.db.run("UPDATE avatar_sessions SET state = 'failed', ended_at = ?, seconds = ?, end_reason = ? WHERE id = ? AND state IN ('starting','live')", now, secs, String(reason).replace(/[^a-z_]/g, "").slice(0, 30) || "error", id);
  void closeRemote(ctx, s);
}
async function closeRemote(ctx: AppContext, s: SessionRow) {
  if (!s.stream_id || !s.external_agent_id) return;
  const k = await keyFor(ctx, s.workspace_id);
  if (!k) return;
  await avatarProvider(ctx)
    .close(k.key, s.external_agent_id, { streamId: s.stream_id, sessionId: s.provider_session })
    .catch((e) => ctx.log.warn("photoreal stream close failed", { reason: safe(e) }));
}

/** Tell the visitor's page that photoreal is gone (it switches to the built-in face and the browser voice). */
function tellBrowser(ctx: AppContext, ws: string, socketId: string | null, callId: string, state: "failed" | "ended", reason: string) {
  if (socketId) ctx.bus.toSocket(ws, socketId, "aicall:avatar_state", { call_id: callId, state, reason });
}

/** The browser's half of the WebRTC exchange, relayed to the provider; `connected` and `failed` reports. Errors mean: fall back. */
export async function avatarSignal(ctx: AppContext, call: { id: string; workspace_id: string; visitor_socket: string | null; state: string }, op: "answer" | "ice" | "connected" | "failed", data: unknown): Promise<{ ok: true; mode: "photoreal" | "builtin" }> {
  const s = await sessionOf(ctx, call.id);
  if (!s) return { ok: true, mode: "builtin" };
  if (op === "failed") {
    await failSession(ctx, s.id, typeof data === "string" ? data : "client_failed");
    await recordAudit(ctx, { workspaceId: s.workspace_id, actor: { type: "system" }, action: "call.avatar_fallback", target: call.id, detail: { reason: typeof data === "string" ? data.replace(/[^a-z_]/g, "").slice(0, 30) : "client_failed" } });
    return { ok: true, mode: "builtin" };
  }
  const k = await keyFor(ctx, s.workspace_id);
  if (!k || !ctx.config.AVATAR_PHOTOREAL_ENABLED || !s.stream_id || !s.external_agent_id) {
    await failSession(ctx, s.id, !ctx.config.AVATAR_PHOTOREAL_ENABLED ? "kill_switch" : "not_connected");
    return { ok: true, mode: "builtin" };
  }
  const p = avatarProvider(ctx);
  const ref = { streamId: s.stream_id, sessionId: s.provider_session };
  try {
    if (op === "answer") {
      const d = data as { type?: unknown; sdp?: unknown } | null;
      if (!d || d.type !== "answer" || typeof d.sdp !== "string" || d.sdp.length > 16_384) throw unprocessable("INVALID_SIGNAL", "Not a valid session description");
      await p.sendAnswer(k.key, s.external_agent_id, ref, { type: "answer", sdp: d.sdp });
    } else if (op === "ice") {
      const d = (data ?? {}) as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown };
      if (JSON.stringify(d).length > 2048) throw unprocessable("INVALID_SIGNAL", "Candidate too large");
      await p.sendIce(k.key, s.external_agent_id, ref, { candidate: typeof d.candidate === "string" ? d.candidate : null, sdpMid: typeof d.sdpMid === "string" ? d.sdpMid : null, sdpMLineIndex: typeof d.sdpMLineIndex === "number" ? d.sdpMLineIndex : null });
    } else if (op === "connected") {
      const now = nowIso(ctx);
      const first = await ctx.db.run("UPDATE avatar_sessions SET state = 'live', connected_at = COALESCE(connected_at, ?) WHERE id = ? AND state IN ('starting','live')", now, s.id);
      // the greeting (with the AI disclosure) is the first thing the avatar says
      if (first.changes && !s.greeted) {
        await ctx.db.run("UPDATE avatar_sessions SET greeted = 1 WHERE id = ?", s.id);
        const g = await ctx.db.get<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = (SELECT room_id FROM calls WHERE id = ?) AND sender_type = 'bot' AND meta LIKE ? ORDER BY seq LIMIT 1", call.id, `%"call_id":"${call.id}"%`);
        if (g?.content_text) await avatarSpeak(ctx, call, g.content_text);
      }
    }
    return { ok: true, mode: "photoreal" };
  } catch (e) {
    if (e instanceof AppError) throw e;
    await failSession(ctx, s.id, e instanceof AvatarError ? e.kind : "error");
    return { ok: true, mode: "builtin" };
  }
}

/** The avatar says the AI's answer (the same text the captions show). A failure switches the visitor to the built-in face and voice. */
export async function avatarSpeak(ctx: AppContext, call: { id: string; workspace_id: string; visitor_socket: string | null }, text: string): Promise<boolean> {
  const s = await sessionOf(ctx, call.id);
  if (!s || s.state !== "live" || !s.stream_id || !s.external_agent_id || !text.trim()) return false;
  const k = await keyFor(ctx, s.workspace_id);
  const av = await avatarOf(ctx, s);
  const set = (await getSettings(ctx, s.workspace_id)).calls.avatar;
  const over = (await avatarSecondsToday(ctx, s.workspace_id)) >= set.minutes_daily * 60;
  if (!k || !av || !ctx.config.AVATAR_PHOTOREAL_ENABLED || !set.enabled || over) {
    const why = !ctx.config.AVATAR_PHOTOREAL_ENABLED || !set.enabled ? "kill_switch" : over ? "budget" : "not_connected";
    await failSession(ctx, s.id, why);
    tellBrowser(ctx, call.workspace_id, call.visitor_socket, call.id, "failed", why);
    return false;
  }
  try {
    await avatarProvider(ctx).speak(k.key, s.external_agent_id, { streamId: s.stream_id, sessionId: s.provider_session }, text, { provider: av.voice_provider, id: av.voice_id });
    return true;
  } catch (e) {
    await failSession(ctx, s.id, e instanceof AvatarError ? e.kind : "error");
    tellBrowser(ctx, call.workspace_id, call.visitor_socket, call.id, "failed", "provider_failed");
    return false;
  }
}

/** The call ended: close the stream and count its seconds. Idempotent. */
export async function endAvatarFor(ctx: AppContext, callId: string, reason: string): Promise<void> {
  const s = await sessionOf(ctx, callId);
  if (!s) return;
  const now = nowIso(ctx);
  const secs = s.connected_at ? Math.max(0, Math.round((Date.parse(now) - Date.parse(s.connected_at)) / 1000)) : 0;
  const r = await ctx.db.run("UPDATE avatar_sessions SET state = 'ended', ended_at = ?, seconds = ?, end_reason = ? WHERE id = ? AND state IN ('starting','live')", now, secs, reason.slice(0, 30), s.id);
  if (r.changes) await closeRemote(ctx, s);
}

/** Every sweep: a live session past the day's minutes, or after the kill switch, a disconnection or the workspace switch going off, is stopped. */
export async function sweepAvatar(ctx: AppContext, call: { id: string; workspace_id: string; visitor_socket: string | null }): Promise<void> {
  const s = await sessionOf(ctx, call.id);
  if (!s) return;
  const set = (await getSettings(ctx, s.workspace_id)).calls.avatar;
  const k = await keyFor(ctx, s.workspace_id);
  const why = !ctx.config.AVATAR_PHOTOREAL_ENABLED || !set.enabled ? "kill_switch" : !k ? "not_connected" : (await avatarSecondsToday(ctx, s.workspace_id)) >= set.minutes_daily * 60 ? "budget" : null;
  if (!why) return;
  await failSession(ctx, s.id, why);
  tellBrowser(ctx, call.workspace_id, call.visitor_socket, call.id, "failed", why);
}
