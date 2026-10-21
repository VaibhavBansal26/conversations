import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import { can } from "../authz/permissions.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "../services/audit.js";
import { actorFromRow, findMember, isDnd, memberScope } from "../services/members.js";
import { accessChannel, postTeamSystemMessage, updateTeamSystemMessage } from "../services/teamChat.js";
import { getSettings } from "../services/workspaces.js";
import { notifyPushById } from "../push/service.js";
import { isLive, next, IllegalTransition, type CallEvent, type CallState } from "./machine.js";
import { iceConfig, type IceConfig } from "./turn.js";

/**
 * Voice and video calls between two teammates (docs/CALLS.md, ADR 0036): the two members of a direct message, one call at a time each. The state machine,
 * the compare-and-set transitions, TURN credentials and signalling rules are those of calls with visitors; the difference is who the two parties are
 * (members, not a visitor), where the card lives (the direct message) and what is checked before a phone rings (presence, do-not-disturb, being busy).
 * Calls of three or four people are group calls (groupCall.ts, ADR 0038).
 */
export interface TeamCallRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  kind: "voice" | "video";
  state: CallState;
  caller_id: string;
  callee_id: string;
  caller_socket: string | null;
  callee_socket: string | null;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  ended_by: string | null;
  end_reason: string | null;
  message_id: string | null;
  meta: string;
  updated_at: string;
}

export const TEAM_CONNECT_TIMEOUT_S = 30;
export const TEAM_RECONNECT_GRACE_S = 20;
const KIND = { voice: "Voice call", video: "Video call" } as const;

const nameOf = async (ctx: AppContext, ws: string, memberId: string) => (await findMember(ctx, ws, memberId, true))?.name ?? "Former member";

/** What the two parties (and nobody else) learn about a call. */
export async function teamCallDto(ctx: AppContext, c: TeamCallRow) {
  return {
    id: c.id,
    channel_id: c.channel_id,
    kind: c.kind,
    state: c.state,
    caller: { id: c.caller_id, name: await nameOf(ctx, c.workspace_id, c.caller_id) },
    callee: { id: c.callee_id, name: await nameOf(ctx, c.workspace_id, c.callee_id) },
    created_at: c.created_at,
    answered_at: c.answered_at,
    ended_at: c.ended_at,
    duration_s: c.duration_s,
    ended_by: c.ended_by,
    end_reason: c.end_reason,
  };
}

export function teamCardText(c: Pick<TeamCallRow, "kind" | "state" | "duration_s">): string {
  const k = KIND[c.kind];
  switch (c.state) {
    case "ringing":
      return `${k}: ringing`;
    case "connecting":
      return `${k}: connecting`;
    case "active":
      return `${k} in progress`;
    case "declined":
      return `${k} declined`;
    case "missed":
      return `Missed ${k.toLowerCase()}`;
    case "failed":
      return `${k} failed to connect`;
    default: {
      const secs = c.duration_s ?? 0;
      return secs > 0 ? `${k}, ${secs < 60 ? `${secs} s` : `${Math.max(1, Math.round(secs / 60))} min`}` : `${k}, not connected`;
    }
  }
}
const cardMeta = (c: TeamCallRow) => ({ sub_type: "team_call", call: { id: c.id, kind: c.kind, state: c.state, duration_s: c.duration_s, caller_id: c.caller_id, callee_id: c.callee_id, ended_by: c.ended_by } });

const getCall = async (ctx: AppContext, id: string): Promise<TeamCallRow> => {
  const c = await ctx.db.get<TeamCallRow>("SELECT * FROM team_calls WHERE id = ?", id);
  if (!c) throw notFound("Call");
  return c;
};

/** Tell the two parties (every tab of each) the call changed. Never carries signalling. */
export async function publishTeamCall(ctx: AppContext, c: TeamCallRow): Promise<void> {
  const dto = await teamCallDto(ctx, c);
  ctx.bus.toMember(c.workspace_id, c.caller_id, "tcall:state", { call: dto });
  ctx.bus.toMember(c.workspace_id, c.callee_id, "tcall:state", { call: dto });
}

interface Patch {
  caller_socket?: string | null;
  callee_socket?: string | null;
  ended_by?: string;
  end_reason?: string;
}

async function step(ctx: AppContext, c: TeamCallRow, event: CallEvent, patch: Patch = {}): Promise<TeamCallRow> {
  const to = next(c.state, event);
  if (to === c.state) return c;
  const now = nowIso(ctx);
  const final = !isLive(to);
  const answered = to === "active" && !c.answered_at ? now : c.answered_at;
  const duration = final ? (answered ? Math.max(0, Math.round((Date.parse(now) - Date.parse(answered)) / 1000)) : 0) : null;
  const row = await ctx.db.get<TeamCallRow>(
    `UPDATE team_calls SET state = ?, answered_at = ?, ended_at = ?, duration_s = ?, ended_by = COALESCE(?, ended_by), end_reason = COALESCE(?, end_reason),
       caller_socket = ?, callee_socket = ?, updated_at = ? WHERE id = ? AND state = ? RETURNING *`,
    to, answered, final ? now : null, duration, patch.ended_by ?? null, patch.end_reason ?? null,
    patch.caller_socket === undefined ? c.caller_socket : patch.caller_socket,
    patch.callee_socket === undefined ? c.callee_socket : patch.callee_socket,
    now, c.id, c.state,
  );
  if (!row) throw new AppError(409, "CALL_STATE_CHANGED", "The call has already changed");
  if (row.message_id) await updateTeamSystemMessage(ctx, row.message_id, row.workspace_id, teamCardText(row), cardMeta(row));
  await publishTeamCall(ctx, row);
  if (row.state === "missed") await notifyPushById(ctx, row.workspace_id, row.callee_id, "missed_call", { title: "Missed call", body: `${await nameOf(ctx, row.workspace_id, row.caller_id)} called you.`, url: `/team/${row.channel_id}`, tag: `call-${row.id}` });
  if (final) await recordAudit(ctx, { workspaceId: row.workspace_id, actor: { type: "member", id: row.caller_id }, action: `team_call.${row.state}`, target: row.id, detail: { channel_id: row.channel_id, kind: row.kind, duration_s: row.duration_s, reason: row.end_reason } });
  return row;
}
const conflict = (e: unknown): never => {
  if (e instanceof IllegalTransition) throw new AppError(409, "CALL_STATE", `The call is ${e.from}: it cannot ${e.event.replace(/_/g, " ")}`, { state: e.from });
  throw e;
};

export async function teamCallSettings(ctx: AppContext, ws: string) {
  return (await getSettings(ctx, ws)).calls.internal;
}

/** Is this member in a call right now, as a teammate or as the agent of a visitor call? */
export async function memberBusy(ctx: AppContext, ws: string, memberId: string): Promise<boolean> {
  const t = await ctx.db.get("SELECT 1 FROM team_calls WHERE workspace_id = ? AND (caller_id = ? OR callee_id = ?) AND state IN ('ringing','connecting','active')", ws, memberId, memberId);
  if (t) return true;
  if (await ctx.db.get("SELECT 1 FROM group_call_participants WHERE workspace_id = ? AND member_id = ? AND status = 'joined'", ws, memberId)) return true;
  return !!(await ctx.db.get("SELECT 1 FROM calls WHERE workspace_id = ? AND initiated_by = ? AND transport = 'webrtc' AND state IN ('ringing','connecting','active')", ws, memberId));
}

/* ---------- entry points ---------- */

export interface TeamCallStart {
  call: Awaited<ReturnType<typeof teamCallDto>>;
  ice: IceConfig;
}

export async function inviteTeamCall(ctx: AppContext, actor: Actor, socketId: string | null, input: { channel_id: string; kind: "voice" | "video" }): Promise<TeamCallStart> {
  const ws = actor.workspaceId;
  const s = await teamCallSettings(ctx, ws);
  if (!s.enabled) throw new AppError(403, "TEAM_CALLS_DISABLED", "Calls between teammates are switched off for this workspace");
  if (!s[input.kind]) throw new AppError(403, "TEAM_CALL_KIND_DISABLED", `${KIND[input.kind]}s between teammates are switched off for this workspace`);
  // the channel is the permission: only a member of a direct message can ring the other member (404 for anyone who cannot see it, 403 NOT_A_MEMBER for a public channel)
  const { channel } = await accessChannel(ctx, actor, input.channel_id, { write: true });
  if (channel.kind !== "dm") throw unprocessable("USE_GROUP_CALL", "This conversation has more than two people: start a group call (gcall:start) instead");
  const ids = (await ctx.db.all<{ member_id: string }>("SELECT member_id FROM team_channel_members WHERE channel_id = ?", channel.id)).map((r) => r.member_id);
  const calleeId = ids.find((m) => m !== actor.memberId);
  if (!calleeId || ids.length !== 2) throw unprocessable("USE_GROUP_CALL", "This conversation has more than two people: start a group call (gcall:start) instead");
  const callee = await findMember(ctx, ws, calleeId);
  if (!callee) throw new AppError(409, "CALLEE_GONE", "That person is no longer in this workspace");
  if (!can(actorFromRow(callee), "calls:internal")) throw new AppError(409, "CALLEE_CANNOT_RECEIVE", `${callee.name} cannot take calls`);
  if (isDnd(ctx, callee) || callee.availability === "inactive") throw new AppError(409, "CALLEE_UNAVAILABLE", `${callee.name} is not available for calls right now`);
  if (!(await ctx.presence.isOnline(memberScope(ws), calleeId))) throw new AppError(409, "CALLEE_OFFLINE", `${callee.name} is not online, so the call could not ring`);
  if (await memberBusy(ctx, ws, actor.memberId)) throw new AppError(409, "CALL_IN_PROGRESS", "You are already in a call");
  if (await memberBusy(ctx, ws, calleeId)) throw new AppError(409, "CALLEE_BUSY", `${callee.name} is in another call`);
  const hourly = await ctx.ratelimit.check("calls.internal.member", { key: `${ws}:${actor.memberId}`, workspaceId: ws });
  if (!hourly.allowed) throw new RateLimitedError(hourly);
  const pair = await ctx.ratelimit.check("calls.internal.pair", { key: `${ws}:${actor.memberId}:${calleeId}`, workspaceId: ws });
  if (!pair.allowed) throw new RateLimitedError(pair);

  const id = newId("tcall");
  const now = nowIso(ctx);
  try {
    await ctx.db.run(
      "INSERT INTO team_calls(id, workspace_id, channel_id, kind, state, caller_id, callee_id, caller_socket, created_at, updated_at) VALUES (?,?,?,?,'ringing',?,?,?,?,?)",
      id, ws, channel.id, input.kind, actor.memberId, calleeId, socketId, now, now,
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CALL_IN_PROGRESS", "There is already a call in this conversation, or one of you is in a call");
    throw e;
  }
  let row = await getCall(ctx, id);
  const card = await postTeamSystemMessage(ctx, channel.id, ws, { senderId: actor.memberId, senderName: actor.name, text: teamCardText(row), meta: cardMeta(row) });
  await ctx.db.run("UPDATE team_calls SET message_id = ? WHERE id = ?", card.id, id);
  row = await getCall(ctx, id);
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "team_call.invited", target: id, detail: { channel_id: channel.id, kind: input.kind, callee_id: calleeId } });
  await publishTeamCall(ctx, row);
  return { call: await teamCallDto(ctx, row), ice: await iceConfig(ctx, ws, (await getSettings(ctx, ws)).calls.turn_provider, id) };
}

/** Only the two parties: anyone else (another member, another workspace) gets a 404 so call ids are not probes. */
async function partyCall(ctx: AppContext, actor: Actor, callId: string): Promise<{ c: TeamCallRow; side: "caller" | "callee" }> {
  const c = await getCall(ctx, callId);
  if (c.workspace_id !== actor.workspaceId) throw notFound("Call");
  if (c.caller_id === actor.memberId) return { c, side: "caller" };
  if (c.callee_id === actor.memberId) return { c, side: "callee" };
  throw notFound("Call");
}

export async function acceptTeamCall(ctx: AppContext, actor: Actor, socketId: string, callId: string): Promise<TeamCallStart> {
  const { c, side } = await partyCall(ctx, actor, callId);
  if (side !== "callee") throw new AppError(403, "NOT_YOUR_CALL", "Only the person being called can answer");
  let row: TeamCallRow;
  try {
    row = await step(ctx, c, "accept", { callee_socket: socketId });
  } catch (e) {
    return conflict(e);
  }
  return { call: await teamCallDto(ctx, row), ice: await iceConfig(ctx, c.workspace_id, (await getSettings(ctx, c.workspace_id)).calls.turn_provider, c.id) };
}

export async function declineTeamCall(ctx: AppContext, actor: Actor, callId: string): Promise<TeamCallRow> {
  const { c, side } = await partyCall(ctx, actor, callId);
  if (side !== "callee") throw new AppError(403, "NOT_YOUR_CALL", "Only the person being called can decline");
  try {
    return await step(ctx, c, "decline", { ended_by: "callee", end_reason: "declined" });
  } catch (e) {
    return conflict(e);
  }
}

/** Either side ends it; the caller cancels a ringing call, the callee declines instead. */
export async function endTeamCall(ctx: AppContext, actor: Actor, callId: string): Promise<TeamCallRow> {
  const { c, side } = await partyCall(ctx, actor, callId);
  if (c.state === "ringing" && side === "callee") throw new AppError(409, "CALL_STATE", "Decline the call instead", { state: c.state });
  try {
    return await step(ctx, c, c.state === "ringing" ? "cancel" : "end", { ended_by: side, end_reason: c.state === "ringing" ? "cancelled" : "completed" });
  } catch (e) {
    return conflict(e);
  }
}

export async function reportTeamConnected(ctx: AppContext, actor: Actor, callId: string): Promise<TeamCallRow> {
  const { c } = await partyCall(ctx, actor, callId);
  try {
    return await step(ctx, c, "connected");
  } catch (e) {
    return conflict(e);
  }
}

export async function reportTeamFailed(ctx: AppContext, actor: Actor, callId: string, reason: string): Promise<TeamCallRow> {
  const { c, side } = await partyCall(ctx, actor, callId);
  try {
    return await step(ctx, c, "fail", { ended_by: side, end_reason: reason.replace(/[^a-z_]/g, "").slice(0, 30) || "failed" });
  } catch (e) {
    return conflict(e);
  }
}

const MAX_SDP = 16_384;
const MAX_CANDIDATE = 2_048;

/** Relay one signalling message to the other party's bound socket, and to nobody else. */
export async function relayTeamSignal(ctx: AppContext, actor: Actor, socketId: string, type: "offer" | "answer" | "ice", input: { call_id: string; data: unknown }): Promise<void> {
  const { c, side } = await partyCall(ctx, actor, input.call_id);
  if (c.state !== "connecting" && c.state !== "active") throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  const mine = side === "caller" ? c.caller_socket : c.callee_socket;
  const peer = side === "caller" ? c.callee_socket : c.caller_socket;
  if (!mine || mine !== socketId) throw new AppError(403, "NOT_THIS_DEVICE", "This connection is not the one on the call");
  if (!peer) throw new AppError(409, "PEER_NOT_READY", "The other side has not connected yet");
  const d = input.data as { sdp?: unknown; type?: unknown } | null;
  if (!d || typeof d !== "object") throw unprocessable("INVALID_SIGNAL", "Signal needs data");
  if (type === "ice") {
    if (JSON.stringify(d).length > MAX_CANDIDATE) throw unprocessable("INVALID_SIGNAL", "Candidate too large");
  } else if (typeof d.sdp !== "string" || d.sdp.length > MAX_SDP || (d.type !== "offer" && d.type !== "answer") || d.type !== type) throw unprocessable("INVALID_SIGNAL", "Not a valid session description");
  ctx.bus.toSocket(c.workspace_id, peer, `tcall:${type}`, { call_id: c.id, data: input.data });
}

export async function resumeTeamCall(ctx: AppContext, actor: Actor, socketId: string, callId: string): Promise<TeamCallStart> {
  const { c, side } = await partyCall(ctx, actor, callId);
  if (!isLive(c.state)) throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  const meta = parseJson<Record<string, unknown>>(c.meta, {});
  const gone = { ...(meta.gone as Record<string, string> | undefined) };
  delete gone[side];
  const col = side === "caller" ? "caller_socket" : "callee_socket";
  const row = await ctx.db.get<TeamCallRow>(`UPDATE team_calls SET ${col} = ?, meta = ?, updated_at = ? WHERE id = ? AND state IN ('ringing','connecting','active') RETURNING *`, socketId, JSON.stringify({ ...meta, gone }), nowIso(ctx), c.id);
  if (!row) throw new AppError(409, "CALL_STATE_CHANGED", "The call has already ended");
  const peer = side === "caller" ? row.callee_socket : row.caller_socket;
  if (peer) ctx.bus.toSocket(row.workspace_id, peer, "tcall:peer", { call_id: row.id, event: "resumed" });
  return { call: await teamCallDto(ctx, row), ice: await iceConfig(ctx, row.workspace_id, (await getSettings(ctx, row.workspace_id)).calls.turn_provider, row.id) };
}

/** A socket closed: note when, so the sweep ends the call if nobody resumes it within the grace period. */
export async function teamSocketGone(ctx: AppContext, workspaceId: string, socketId: string): Promise<void> {
  const calls = await ctx.db.all<TeamCallRow>("SELECT * FROM team_calls WHERE workspace_id = ? AND state IN ('connecting','active') AND (caller_socket = ? OR callee_socket = ?)", workspaceId, socketId, socketId);
  for (const c of calls) {
    const meta = parseJson<Record<string, unknown>>(c.meta, {});
    const side = c.caller_socket === socketId ? "caller" : "callee";
    const gone = { ...(meta.gone as Record<string, string> | undefined), [side]: nowIso(ctx) };
    await ctx.db.run("UPDATE team_calls SET meta = ? WHERE id = ? AND state IN ('connecting','active') AND (caller_socket = ? OR callee_socket = ?)", JSON.stringify({ ...meta, gone }), c.id, socketId, socketId);
    const peer = side === "caller" ? c.callee_socket : c.caller_socket;
    if (peer) ctx.bus.toSocket(workspaceId, peer, "tcall:peer", { call_id: c.id, event: "lost" });
  }
}

/** Time-based transitions, safe on every node: ringing past the ring time is missed, connecting too long fails, a side gone past the grace period ends the call. */
export async function sweepTeamCalls(ctx: AppContext): Promise<{ missed: number; failed: number; ended: number }> {
  const out = { missed: 0, failed: 0, ended: 0 };
  const now = ctx.clock().getTime();
  const rows = await ctx.db.all<TeamCallRow>("SELECT * FROM team_calls WHERE state IN ('ringing','connecting','active') ORDER BY created_at LIMIT 200");
  const ringByWs = new Map<string, number>();
  for (const c of rows) {
    try {
      if (c.state === "ringing") {
        let ring = ringByWs.get(c.workspace_id);
        if (ring === undefined) ringByWs.set(c.workspace_id, (ring = (await teamCallSettings(ctx, c.workspace_id)).ring_seconds));
        if (now - Date.parse(c.created_at) >= ring * 1000) (await step(ctx, c, "ring_timeout", { ended_by: "system", end_reason: "timeout" }), out.missed++);
        continue;
      }
      const gone = parseJson<{ gone?: Record<string, string> }>(c.meta, {}).gone ?? {};
      const since = Object.values(gone).map((t) => Date.parse(t)).sort((a, b) => a - b)[0];
      if (since !== undefined && now - since >= TEAM_RECONNECT_GRACE_S * 1000) {
        await step(ctx, c, c.state === "active" ? "end" : "fail", { ended_by: "system", end_reason: "disconnected" });
        out.ended++;
        continue;
      }
      if (c.state === "connecting" && now - Date.parse(c.updated_at) >= TEAM_CONNECT_TIMEOUT_S * 1000) (await step(ctx, c, "connect_timeout", { ended_by: "system", end_reason: "connect_timeout" }), out.failed++);
    } catch (e) {
      if (!(e instanceof AppError && (e.code === "CALL_STATE_CHANGED" || e.code === "CALL_STATE")) && !(e instanceof IllegalTransition)) throw e;
    }
  }
  return out;
}

/** The member's live team call (for a tab that opens in the middle of one), if any. */
export async function liveTeamCallOf(ctx: AppContext, actor: Actor) {
  const c = await ctx.db.get<TeamCallRow>("SELECT * FROM team_calls WHERE workspace_id = ? AND (caller_id = ? OR callee_id = ?) AND state IN ('ringing','connecting','active')", actor.workspaceId, actor.memberId, actor.memberId);
  return c ? teamCallDto(ctx, c) : null;
}
