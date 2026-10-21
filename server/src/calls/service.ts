import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "../services/audit.js";
import { visitorScope } from "../services/members.js";
import { emitMessage, insertMessage, emitInserted, type MessageRow } from "../services/messageStore.js";
import { getRoomRow, getVisibleRoom, type RoomRow } from "../services/roomStore.js";
import { handoffTicket } from "../services/routing.js";
import { liveTicketOf, recordTicketEvent } from "../services/tickets.js";
import { requestVisitorInfo } from "../services/visitorInfo.js";
import { getVisitorRoom } from "../services/visitorChat.js";
import type { SessionRow } from "../services/visitors.js";
import { getSettings } from "../services/workspaces.js";
import { canDo, isLive, next, IllegalTransition, type CallEvent, type CallState } from "./machine.js";
import { iceConfig, type IceConfig } from "./turn.js";
import { sweepPhone } from "./phone.js";
import { sweepAi } from "./aiCall.js";
import { consumeCallLink } from "./links.js";
import { sweepTeamCalls } from "./teamCall.js";
import { sweepGroupCalls } from "./groupCall.js";

/**
 * Calls between a team member and a visitor (docs/CALLS.md). This service owns the database row and the thread card; the sockets carry the
 * signalling and nothing else. Every transition is a compare-and-set on the state, so two events racing (accept and cancel, end and end) end in
 * exactly one outcome and the loser gets a clear error instead of a corrupted call.
 */

export interface CallRow {
  id: string;
  workspace_id: string;
  room_id: string;
  ticket_id: string | null;
  contact_id: string;
  transport: "webrtc" | "phone" | "ai";
  kind: "voice" | "video" | "ai_voice" | "ai_video";
  state: CallState;
  initiated_by: string;
  agent_socket: string | null;
  visitor_socket: string | null;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  ended_by: string | null;
  end_reason: string | null;
  message_id: string | null;
  meta: string;
  updated_at: string;
  ai_agent_id: string | null;
  engine: string | null;
  handoff_reason: string | null;
}

/** seconds a connecting call may take to carry media, and how long a side may be gone (network change) before the call ends */
export const CONNECT_TIMEOUT_S = 30;
export const RECONNECT_GRACE_S = 20;

export const callDto = (c: CallRow) => ({
  id: c.id,
  room_id: c.room_id,
  ticket_id: c.ticket_id,
  transport: c.transport,
  kind: c.kind,
  state: c.state,
  initiated_by: c.initiated_by,
  created_at: c.created_at,
  answered_at: c.answered_at,
  ended_at: c.ended_at,
  duration_s: c.duration_s,
  ended_by: c.ended_by,
  end_reason: c.end_reason,
  ai_agent_id: c.ai_agent_id,
  handoff_reason: c.handoff_reason,
});
/** What a visitor may know of a call: no member ids. */
export const visitorCallDto = (c: CallRow, agentName: string) => ({ id: c.id, room_id: c.room_id, transport: c.transport, kind: c.kind, state: c.state, duration_s: c.duration_s, ended_by: c.ended_by, end_reason: c.end_reason, agent_name: agentName, ...(c.transport === "ai" ? { handoff_reason: c.handoff_reason } : {}) });

const getCall = async (ctx: AppContext, id: string): Promise<CallRow> => {
  const c = await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", id);
  if (!c) throw notFound("Call");
  return c;
};
const aiNameOf = (c: CallRow): string => parseJson<{ agent_name?: string }>(c.meta, {}).agent_name ?? "AI assistant";
const nameOf = async (ctx: AppContext, ws: string, memberId: string): Promise<string> => (await ctx.db.get<{ name: string }>("SELECT u.name AS name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.workspace_id = ?", memberId, ws))?.name.split(" ")[0] ?? "Our team";

export async function callSettings(ctx: AppContext, ws: string) {
  return (await getSettings(ctx, ws)).calls;
}

/* ---------- the card in the thread ---------- */

const KIND_LABEL = { voice: "Voice call", video: "Video call", ai_voice: "AI voice call", ai_video: "AI video call (avatar)" } as const;
const AI_END: Record<string, string> = { handoff: "handed to a person", taken_over: "a person took over", idle: "ended after silence", max_duration: "reached the time limit", resolved: "resolved", silence: "ended after silence", unsupported: "ended: speech is not available in this browser", error: "ended after an error", monitor: "ended by the safety monitor, handed to a person", kill_switch: "ended: realtime voice was switched off", budget: "ended: the realtime minutes for today are used up" };
export function cardText(c: Pick<CallRow, "kind" | "state" | "duration_s" | "ended_by" | "end_reason"> & { transport?: "webrtc" | "phone" | "ai" }): string {
  const k = c.transport === "phone" ? "Phone call" : KIND_LABEL[c.kind];
  if (c.transport === "ai" && c.state !== "active") {
    const secs = c.duration_s ?? 0;
    const dur = secs < 60 ? `${secs} s` : `${Math.max(1, Math.round(secs / 60))} min`;
    if (c.state === "failed") return `${k} failed`;
    const why = (c.end_reason && AI_END[c.end_reason]) ?? `ended by ${c.ended_by === "visitor" ? "the visitor" : "the system"}`;
    return `${k}, ${dur}, ${why}`;
  }
  switch (c.state) {
    case "ringing":
      return c.transport === "phone" ? `${k}: calling the agent's phone` : `${k}: ringing`;
    case "connecting":
      return c.transport === "phone" ? `${k}: calling the contact` : `${k}: connecting`;
    case "active":
      return `${k} in progress`;
    case "declined":
      return `${k} declined`;
    case "missed":
      return `Missed ${k.toLowerCase()}`;
    case "failed":
      return `${k} failed to connect`;
    default: {
      const min = Math.max(1, Math.round((c.duration_s ?? 0) / 60));
      const secs = c.duration_s ?? 0;
      const dur = secs > 0 && secs < 60 ? `${secs} s` : `${min} min`;
      if (c.end_reason === "cancelled") return `${k} cancelled`;
      return `${k}, ${secs > 0 ? dur : "not connected"}, ended by ${c.ended_by === "visitor" ? "the visitor" : c.ended_by === "agent" ? "the agent" : "the system"}`;
    }
  }
}

export async function postCardFor(ctx: AppContext, room: RoomRow, c: CallRow): Promise<string> {
  return postCard(ctx, room, c);
}
async function postCard(ctx: AppContext, room: RoomRow, c: CallRow): Promise<string> {
  const r = await insertMessage(ctx, {
    workspaceId: room.workspace_id,
    roomId: room.id,
    senderType: "system",
    kind: "system",
    source: "dm",
    content: cardText(c),
    contentText: cardText(c),
    meta: { sub_type: "call", call: { id: c.id, kind: c.kind, transport: c.transport, state: c.state, duration_s: c.duration_s, ended_by: c.ended_by } },
  });
  await emitInserted(ctx, r);
  return r.message.id;
}
async function updateCard(ctx: AppContext, c: CallRow): Promise<void> {
  if (!c.message_id) return;
  const m = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND room_id = ?", c.message_id, c.room_id);
  if (!m) return;
  const text = cardText(c);
  await ctx.db.run("UPDATE messages SET content = ?, content_text = ?, meta = ? WHERE id = ? AND room_id = ?", text, text, JSON.stringify({ sub_type: "call", call: { id: c.id, kind: c.kind, transport: c.transport, state: c.state, duration_s: c.duration_s, ended_by: c.ended_by } }), m.id, m.room_id);
  const fresh = (await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND room_id = ?", m.id, m.room_id))!;
  await emitMessage(ctx, await getRoomRow(ctx, c.workspace_id, c.room_id), fresh, "message:updated");
}

/** Tell everybody who may see the room (team) and the visitor that the state changed. Never carries signalling. */
export async function publish(ctx: AppContext, c: CallRow): Promise<void> {
  const agentName = c.transport === "ai" ? aiNameOf(c) : await nameOf(ctx, c.workspace_id, c.initiated_by);
  ctx.bus.toRoom(c.workspace_id, c.room_id, "call:state", { call: callDto(c) }, { visitor: { call: visitorCallDto(c, agentName) } });
}

/* ---------- transitions ---------- */

export interface Patch {
  agent_socket?: string | null;
  visitor_socket?: string | null;
  ended_by?: string;
  end_reason?: string;
  handoff_reason?: string;
}

/** Move a call by one event with a compare-and-set on its current state. Throws IllegalTransition (as 409) when the call already moved. */
export const stepCall = (ctx: AppContext, c: CallRow, event: CallEvent, patch: Patch = {}) => step(ctx, c, event, patch);

/** Phone calls end through provider callbacks that may repeat or arrive late: a call that already moved is not an error. */
export async function finishPhone(ctx: AppContext, c: CallRow, event: CallEvent, patch: Patch = {}): Promise<CallRow | null> {
  try {
    const fresh = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", c.id)) ?? c;
    return await step(ctx, fresh, event, patch);
  } catch (e) {
    if (e instanceof IllegalTransition || (e instanceof AppError && (e.code === "CALL_STATE_CHANGED" || e.code === "CALL_STATE"))) return null;
    throw e;
  }
}

async function step(ctx: AppContext, c: CallRow, event: CallEvent, patch: Patch = {}): Promise<CallRow> {
  const to = next(c.state, event);
  if (to === c.state) return c; // a repeated `connected`
  const now = nowIso(ctx);
  const final = !isLive(to);
  const answered = to === "active" && !c.answered_at ? now : c.answered_at;
  const duration = final ? (answered ? Math.max(0, Math.round((Date.parse(now) - Date.parse(answered)) / 1000)) : 0) : null;
  const row = await ctx.db.get<CallRow>(
    `UPDATE calls SET state = ?, answered_at = ?, ended_at = ?, duration_s = ?, ended_by = COALESCE(?, ended_by), end_reason = COALESCE(?, end_reason),
       handoff_reason = COALESCE(?, handoff_reason), agent_socket = ?, visitor_socket = ?, updated_at = ? WHERE id = ? AND state = ? RETURNING *`,
    to,
    answered,
    final ? now : null,
    duration,
    patch.ended_by ?? null,
    patch.end_reason ?? null,
    patch.handoff_reason ?? null,
    patch.agent_socket === undefined ? c.agent_socket : patch.agent_socket,
    patch.visitor_socket === undefined ? c.visitor_socket : patch.visitor_socket,
    now,
    c.id,
    c.state,
  );
  if (!row) throw new AppError(409, "CALL_STATE_CHANGED", "The call has already changed");
  await updateCard(ctx, row);
  await publish(ctx, row);
  if (final) await afterCall(ctx, row);
  return row;
}

const asAppError = (e: unknown): never => {
  if (e instanceof IllegalTransition) throw new AppError(409, "CALL_STATE", `The call is ${e.from}: it cannot ${e.event.replace(/_/g, " ")}`, { state: e.from });
  throw e;
};

async function afterCall(ctx: AppContext, c: CallRow): Promise<void> {
  const ticket = c.ticket_id ? await ctx.db.get<import("../services/tickets.js").TicketRow>("SELECT * FROM tickets WHERE id = ?", c.ticket_id) : undefined;
  const linkId = parseJson<{ link_id?: string }>(c.meta, {}).link_id;
  if (linkId) await consumeCallLink(ctx, linkId).catch((e) => ctx.log.warn("call link could not be closed", { error: e instanceof Error ? e.message : String(e) }));
  const who = c.transport === "ai" ? ({ type: "bot", id: c.ai_agent_id ?? "" } as const) : ({ type: "member", id: c.initiated_by } as const);
  if (c.transport === "ai") await ctx.ratelimit.release("ai.concurrency", c.workspace_id, c.id).catch(() => {});
  if (ticket) await recordTicketEvent(ctx, ticket, c.state === "ended" ? "call_ended" : `call_${c.state}`, who, { call_id: c.id, kind: c.transport === "phone" ? "phone" : c.kind, duration_s: c.duration_s, reason: c.end_reason, ...(c.handoff_reason ? { handoff_reason: c.handoff_reason } : {}) });
  await recordAudit(ctx, { workspaceId: c.workspace_id, actor: c.transport === "ai" ? { type: "system" } : { type: "member", id: c.initiated_by }, action: `call.${c.state}`, target: c.id, detail: { room_id: c.room_id, kind: c.kind, transport: c.transport, duration_s: c.duration_s, reason: c.end_reason } });
  // a call nobody took leaves a way to reach the visitor: the callback form
  if ((c.state === "missed" || c.state === "declined") && ticket && c.transport === "webrtc") {
    await requestVisitorInfo(ctx, ticket.id, "callback", { text: c.state === "missed" ? "Sorry we missed each other. Leave a number and we will call you back." : "No problem. If you would like us to call you back later, leave a number." }).catch(() => null);
  }
}

/* ---------- entry points ---------- */

export interface CallStart {
  call: ReturnType<typeof callDto>;
  ice: IceConfig;
}

export async function inviteCall(ctx: AppContext, actor: Actor, socketId: string | null, input: { room_id: string; kind: "voice" | "video" }): Promise<CallStart> {
  const ws = actor.workspaceId;
  const s = await callSettings(ctx, ws);
  if (!s.browser.enabled) throw new AppError(403, "CALLS_DISABLED", "Browser calls are switched off for this workspace");
  if (!s.browser[input.kind]) throw new AppError(403, "CALL_KIND_DISABLED", `${KIND_LABEL[input.kind]}s are switched off for this workspace`);
  const room = await getVisibleRoom(ctx, actor, input.room_id);
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket) throw new AppError(409, "NO_CONVERSATION", "The visitor has not written yet");
  if (!(await ctx.presence.isOnline(visitorScope(ws), room.contact_id))) throw new AppError(409, "VISITOR_OFFLINE", "The visitor is not in the chat right now, so the call could not ring");
  const id = newId("call");
  const now = nowIso(ctx);
  try {
    await ctx.db.run(
      "INSERT INTO calls(id, workspace_id, room_id, ticket_id, contact_id, transport, kind, state, initiated_by, agent_socket, created_at, updated_at) VALUES (?,?,?,?,?,'webrtc',?,'ringing',?,?,?,?)",
      id,
      ws,
      room.id,
      ticket.id,
      room.contact_id,
      input.kind,
      actor.memberId,
      socketId,
      now,
      now,
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CALL_IN_PROGRESS", "There is already a call in this conversation");
    throw e;
  }
  let row = await getCall(ctx, id);
  const messageId = await postCard(ctx, room, row);
  await ctx.db.run("UPDATE calls SET message_id = ? WHERE id = ?", messageId, id);
  row = await getCall(ctx, id);
  await recordTicketEvent(ctx, ticket, "call_started", { type: "member", id: actor.memberId }, { call_id: id, kind: input.kind });
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "call.invited", target: id, detail: { room_id: room.id, kind: input.kind } });
  await publish(ctx, row);
  return { call: callDto(row), ice: await iceConfig(ctx, ws, s.turn_provider, id) };
}

/** The visitor answers. Only the visitor of the call's conversation, only while it rings. */
export async function acceptCall(ctx: AppContext, session: SessionRow, socketId: string, callId: string): Promise<CallStart> {
  const c = await visitorsCall(ctx, session, callId);
  let row: CallRow;
  try {
    row = await step(ctx, c, "accept", { visitor_socket: socketId });
    // answered by someone who came in through a call link: the link is used up when this call ends
    if (session.call_link_id) {
      const meta = parseJson<Record<string, unknown>>(row.meta, {});
      await ctx.db.run("UPDATE calls SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, link_id: session.call_link_id }), row.id);
    }
  } catch (e) {
    return asAppError(e);
  }
  const s = await callSettings(ctx, c.workspace_id);
  return { call: callDto(row), ice: await iceConfig(ctx, c.workspace_id, s.turn_provider, c.id) };
}

export async function declineCall(ctx: AppContext, session: SessionRow, callId: string): Promise<CallRow> {
  const c = await visitorsCall(ctx, session, callId);
  try {
    return await step(ctx, c, "decline", { ended_by: "visitor", end_reason: "declined" });
  } catch (e) {
    return asAppError(e);
  }
}

/** Either side ends it: the agent cancels a ringing call or ends a running one, the visitor ends a running one. */
export async function endCall(ctx: AppContext, who: { actor?: Actor; session?: SessionRow }, callId: string): Promise<CallRow> {
  const c = await participantCall(ctx, who, callId);
  const byAgent = !!who.actor;
  const event: CallEvent = c.state === "ringing" ? "cancel" : "end";
  if (c.state === "ringing" && !byAgent) throw new AppError(409, "CALL_STATE", "Decline the call instead", { state: c.state });
  try {
    return await step(ctx, c, event, { ended_by: byAgent ? "agent" : "visitor", end_reason: c.state === "ringing" ? "cancelled" : "completed" });
  } catch (e) {
    return asAppError(e);
  }
}

/** Either side reports that media is flowing. The first report moves the call to active; the second is a no-op. */
export async function reportConnected(ctx: AppContext, who: { actor?: Actor; session?: SessionRow }, callId: string): Promise<CallRow> {
  const c = await participantCall(ctx, who, callId);
  try {
    return await step(ctx, c, "connected");
  } catch (e) {
    return asAppError(e);
  }
}

/** A side reports that the connection is lost for good (ICE failed, no media). */
export async function reportFailed(ctx: AppContext, who: { actor?: Actor; session?: SessionRow }, callId: string, reason: string): Promise<CallRow> {
  const c = await participantCall(ctx, who, callId);
  try {
    return await step(ctx, c, "fail", { ended_by: who.actor ? "agent" : "visitor", end_reason: reason.replace(/[^a-z_]/g, "").slice(0, 30) || "failed" });
  } catch (e) {
    return asAppError(e);
  }
}

/* ---------- signalling ---------- */

export type SignalType = "offer" | "answer" | "ice";
const MAX_SDP = 16_384;
const MAX_CANDIDATE = 2_048;

/**
 * Relay one signalling message to the other party, and to nobody else. The sender must be a participant of THIS call on the socket the call is
 * bound to (a second tab or another seat cannot inject or eavesdrop), the call must be set up or running, and sizes are bounded.
 */
export async function relaySignal(ctx: AppContext, who: { actor?: Actor; session?: SessionRow }, socketId: string, type: SignalType, input: { call_id: string; data: unknown }): Promise<void> {
  const c = await participantCall(ctx, who, input.call_id);
  if (c.state !== "connecting" && c.state !== "active") throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  const mine = who.actor ? c.agent_socket : c.visitor_socket;
  const peer = who.actor ? c.visitor_socket : c.agent_socket;
  if (!mine || mine !== socketId) throw new AppError(403, "NOT_THIS_DEVICE", "This connection is not the one on the call");
  if (!peer) throw new AppError(409, "PEER_NOT_READY", "The other side has not connected yet");
  const d = input.data as { sdp?: unknown; type?: unknown; candidate?: unknown } | null;
  if (!d || typeof d !== "object") throw unprocessable("INVALID_SIGNAL", "Signal needs data");
  if (type === "ice") {
    // an end-of-candidates marker is `null` / empty
    const json = JSON.stringify(d);
    if (json.length > MAX_CANDIDATE) throw unprocessable("INVALID_SIGNAL", "Candidate too large");
  } else {
    if (typeof d.sdp !== "string" || d.sdp.length > MAX_SDP || (d.type !== "offer" && d.type !== "answer") || d.type !== type) throw unprocessable("INVALID_SIGNAL", "Not a valid session description");
  }
  ctx.bus.toSocket(c.workspace_id, peer, `call:${type}`, { call_id: c.id, data: input.data });
}

/** A side came back (a new socket after a network change or a reload): bind it, cancel the grace timer and tell the other side to restart ICE. */
export async function resumeCall(ctx: AppContext, who: { actor?: Actor; session?: SessionRow }, socketId: string, callId: string): Promise<CallStart> {
  const c = await participantCall(ctx, who, callId);
  if (!isLive(c.state)) throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  if (c.transport === "ai" && who.actor) throw new AppError(403, "NOT_YOUR_CALL", "A call with the AI assistant belongs to the visitor");
  const meta = parseJson<Record<string, unknown>>(c.meta, {});
  const side = who.actor ? "agent" : "visitor";
  const gone = { ...(meta.gone as Record<string, string> | undefined) };
  delete gone[side];
  const col = who.actor ? "agent_socket" : "visitor_socket";
  const row = await ctx.db.get<CallRow>(`UPDATE calls SET ${col} = ?, meta = ?, updated_at = ? WHERE id = ? AND state IN ('ringing','connecting','active') RETURNING *`, socketId, JSON.stringify({ ...meta, gone }), nowIso(ctx), c.id);
  if (!row) throw new AppError(409, "CALL_STATE_CHANGED", "The call has already ended");
  const peer = who.actor ? row.visitor_socket : row.agent_socket;
  if (peer) ctx.bus.toSocket(row.workspace_id, peer, "call:peer", { call_id: row.id, event: "resumed" });
  // a call with the AI has no media connection to restart: the visitor's browser only needs its socket bound again
  if (row.transport === "ai") return { call: callDto(row), ice: { provider: "none", iceServers: [], expiresAt: null, warning: null } };
  const s = await callSettings(ctx, row.workspace_id);
  return { call: callDto(row), ice: await iceConfig(ctx, row.workspace_id, s.turn_provider, row.id) };
}

/** A socket closed. If it was on a running call, note the time: the sweep ends the call when nobody resumes it within the grace period. */
export async function socketGone(ctx: AppContext, workspaceId: string, socketId: string): Promise<void> {
  const calls = await ctx.db.all<CallRow>("SELECT * FROM calls WHERE workspace_id = ? AND state IN ('connecting','active') AND (agent_socket = ? OR visitor_socket = ?)", workspaceId, socketId, socketId);
  for (const c of calls) {
    const meta = parseJson<Record<string, unknown>>(c.meta, {});
    const side = c.agent_socket === socketId ? "agent" : "visitor";
    const gone = { ...(meta.gone as Record<string, string> | undefined), [side]: nowIso(ctx) };
    await ctx.db.run("UPDATE calls SET meta = ? WHERE id = ? AND state IN ('connecting','active') AND (agent_socket = ? OR visitor_socket = ?)", JSON.stringify({ ...meta, gone }), c.id, socketId, socketId);
    const peer = side === "agent" ? c.visitor_socket : c.agent_socket;
    if (peer) ctx.bus.toSocket(workspaceId, peer, "call:peer", { call_id: c.id, event: "lost" });
  }
}

/** A visitor asks for a call: a card in the thread, the conversation goes to a person when it is not with one, and the team is told. */
export async function requestCall(ctx: AppContext, session: SessionRow, roomId: string, kind: "voice" | "video") {
  const room = await getVisitorRoom(ctx, session, roomId);
  const s = await callSettings(ctx, room.workspace_id);
  if (!s.browser.enabled || !s.browser[kind]) throw new AppError(403, "CALLS_DISABLED", "Calls are not available here");
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket) throw new AppError(409, "NO_CONVERSATION", "Write a message first");
  const live = await ctx.db.get("SELECT 1 FROM calls WHERE room_id = ? AND state IN ('ringing','connecting','active')", room.id);
  if (live) throw new AppError(409, "CALL_IN_PROGRESS", "There is already a call in this conversation");
  // one open request per ticket: a visitor tapping twice asks once
  const meta = parseJson<{ call_requested_at?: string }>(ticket.meta, {});
  const recent = meta.call_requested_at && Date.parse(nowIso(ctx)) - Date.parse(meta.call_requested_at) < 5 * 60_000;
  if (recent) return { ok: true as const, already: true };
  const claimed = await ctx.db.run("UPDATE tickets SET meta = ? WHERE id = ? AND meta = ?", JSON.stringify({ ...meta, call_requested_at: nowIso(ctx) }), ticket.id, ticket.meta);
  if (!claimed.changes) return { ok: true as const, already: true };
  const text = `${KIND_LABEL[kind]} requested`;
  const r = await insertMessage(ctx, { workspaceId: room.workspace_id, roomId: room.id, senderType: "system", kind: "system", source: "dm", content: text, contentText: text, meta: { sub_type: "call_request", kind } });
  await emitInserted(ctx, r);
  await recordTicketEvent(ctx, ticket, "call_requested", { type: "contact" }, { kind });
  if (!ticket.handler?.startsWith("human:")) await handoffTicket(ctx, ticket.id, { reason: "call_requested", by: { type: "contact" }, note: `The visitor asks for a ${kind} call.` });
  return { ok: true as const, already: false };
}

/* ---------- authorisation helpers ---------- */

async function visitorsCall(ctx: AppContext, session: SessionRow, callId: string): Promise<CallRow> {
  const c = await getCall(ctx, callId);
  // 404, not 403: another visitor learns nothing about the call
  if (c.workspace_id !== session.workspace_id || c.contact_id !== session.contact_id) throw notFound("Call");
  return c;
}
async function participantCall(ctx: AppContext, who: { actor?: Actor; session?: SessionRow }, callId: string): Promise<CallRow> {
  if (who.session) return visitorsCall(ctx, who.session, callId);
  const c = await getCall(ctx, callId);
  // the seat that placed the call (a manager may end it too: ending needs the same rights as placing)
  if (!who.actor || c.workspace_id !== who.actor.workspaceId) throw notFound("Call");
  if (c.initiated_by !== who.actor.memberId) throw new AppError(403, "NOT_YOUR_CALL", "Only the person who placed the call can control it");
  return c;
}

/* ---------- sweeps ---------- */

/**
 * Time-based transitions, safe to run on every node: ringing past `ring_seconds` is missed, connecting past the connect timeout fails, and a call
 * one side has been gone from for longer than the grace period ends. Idempotent: each is a compare-and-set.
 */
export async function sweepCalls(ctx: AppContext): Promise<{ missed: number; failed: number; ended: number }> {
  const out = { missed: 0, failed: 0, ended: 0 };
  const now = ctx.clock().getTime();
  const rows = await ctx.db.all<CallRow>("SELECT * FROM calls WHERE state IN ('ringing','connecting','active') ORDER BY created_at LIMIT 200");
  const ringByWs = new Map<string, number>();
  for (const c of rows) {
    try {
      if (c.transport === "phone") {
        if ((await sweepPhone(ctx, c)) === "ended") out.failed++;
        continue;
      }
      if (c.transport === "ai") {
        const r = await sweepAi(ctx, c);
        if (r) out.ended++;
        continue;
      }
      if (c.state === "ringing") {
        let ring = ringByWs.get(c.workspace_id);
        if (ring === undefined) ringByWs.set(c.workspace_id, (ring = (await callSettings(ctx, c.workspace_id)).ring_seconds));
        if (now - Date.parse(c.created_at) >= ring * 1000) (await step(ctx, c, "ring_timeout", { ended_by: "system", end_reason: "timeout" }), out.missed++);
        continue;
      }
      const gone = parseJson<{ gone?: Record<string, string> }>(c.meta, {}).gone ?? {};
      const goneSince = Object.values(gone).map((t) => Date.parse(t)).sort((a, b) => a - b)[0];
      if (goneSince !== undefined && now - goneSince >= RECONNECT_GRACE_S * 1000) {
        await step(ctx, c, c.state === "active" ? "end" : "fail", { ended_by: "system", end_reason: "disconnected" });
        out.ended++;
        continue;
      }
      if (c.state === "connecting" && now - Date.parse(c.updated_at) >= CONNECT_TIMEOUT_S * 1000) (await step(ctx, c, "connect_timeout", { ended_by: "system", end_reason: "connect_timeout" }), out.failed++);
    } catch (e) {
      // somebody else moved it first (another node, or the people on the call): that is fine
      if (!(e instanceof AppError && (e.code === "CALL_STATE_CHANGED" || e.code === "CALL_STATE")) && !(e instanceof IllegalTransition)) throw e;
    }
  }
  const g = await sweepGroupCalls(ctx);
  out.missed += g.missed;
  out.ended += g.ended;
  const t = await sweepTeamCalls(ctx);
  out.missed += t.missed;
  out.failed += t.failed;
  out.ended += t.ended;
  return out;
}

export const listRoomCalls = async (ctx: AppContext, actor: Actor, roomId: string) => {
  await getVisibleRoom(ctx, actor, roomId);
  return (await ctx.db.all<CallRow>("SELECT * FROM calls WHERE room_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 50", roomId, actor.workspaceId)).map(callDto);
};

export { canDo };
