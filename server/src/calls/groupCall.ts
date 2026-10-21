import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import { can } from "../authz/permissions.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { newId } from "../util/ids.js";
import { recordAudit } from "../services/audit.js";
import { actorFromRow, findMember, isDnd, memberScope } from "../services/members.js";
import { accessChannel, postTeamSystemMessage, updateTeamSystemMessage } from "../services/teamChat.js";
import { getSettings } from "../services/workspaces.js";
import { notifyPushById } from "../push/service.js";
import { afterDeparture, clampGroupMax, groupCardText, hasRoom, nextStatus, type ParticipantStatus } from "./groupMachine.js";
import { iceConfig, type IceConfig } from "./turn.js";

/**
 * Voice and video calls between up to four teammates (docs/CALLS.md, ADR 0038). Media is a WebRTC MESH: every browser sends to every other browser,
 * so a call of four is three upstreams per person. That is why the cap is four and why this is not an SFU. The server only keeps who is in the call,
 * relays signalling between two bound sockets and posts the card. Every change takes a row lock on the call first (the compare-and-set of the
 * other call kinds does not work for "a count below a cap"), so two joins at the cap, a leave during an offer and a duplicate join are decided
 * by the database, not by timing.
 */
export interface GroupCallRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  kind: "voice" | "video";
  state: "live" | "ended" | "missed";
  host_id: string;
  max_participants: number;
  sharing_id: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  end_reason: string | null;
  message_id: string | null;
  updated_at: string;
}
export interface ParticipantRow {
  call_id: string;
  member_id: string;
  workspace_id: string;
  status: ParticipantStatus;
  socket_id: string | null;
  invited_by: string | null;
  invited_at: string;
  joined_at: string | null;
  left_at: string | null;
  gone_at: string | null;
  muted: number;
  camera_off: number;
}

export const GROUP_RECONNECT_GRACE_S = 20;
const noRoom = () => new AppError(409, "GROUP_CALL_FULL", "This call is full");

const nameOf = async (ctx: AppContext, ws: string, id: string) => (await findMember(ctx, ws, id, true))?.name ?? "Former member";
const parts = (ctx: AppContext, callId: string) => ctx.db.all<ParticipantRow>("SELECT * FROM group_call_participants WHERE call_id = ? ORDER BY invited_at, member_id", callId);
const loadCall = (ctx: AppContext, id: string) => ctx.db.get<GroupCallRow>("SELECT * FROM group_calls WHERE id = ?", id);
const joinedCount = async (ctx: AppContext, callId: string) => (await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM group_call_participants WHERE call_id = ? AND status = 'joined'", callId))!.n;

/** What the people of a call (and nobody else) learn about it. Socket ids never leave the server. */
export async function groupCallDto(ctx: AppContext, c: GroupCallRow, ps?: ParticipantRow[]) {
  const rows = ps ?? (await parts(ctx, c.id));
  return {
    id: c.id,
    channel_id: c.channel_id,
    kind: c.kind,
    state: c.state,
    host_id: c.host_id,
    max_participants: c.max_participants,
    sharing_id: c.sharing_id,
    created_at: c.created_at,
    started_at: c.started_at,
    ended_at: c.ended_at,
    duration_s: c.duration_s,
    end_reason: c.end_reason,
    participants: await Promise.all(
      rows.map(async (p) => ({ member_id: p.member_id, name: await nameOf(ctx, c.workspace_id, p.member_id), status: p.status, joined_at: p.joined_at, muted: !!p.muted, camera_off: !!p.camera_off })),
    ),
  };
}
type Dto = Awaited<ReturnType<typeof groupCallDto>>;

const cardMeta = (c: GroupCallRow, joined: number) => ({ sub_type: "group_call", call: { id: c.id, kind: c.kind, state: c.state, duration_s: c.duration_s, host_id: c.host_id, joined, max: c.max_participants } });

/** Tell everyone who has a row in the call (every tab of each) and refresh the card. Never carries signalling. */
async function publish(ctx: AppContext, call: GroupCallRow): Promise<Dto> {
  const ps = await parts(ctx, call.id);
  const dto = await groupCallDto(ctx, call, ps);
  for (const p of ps) ctx.bus.toMember(call.workspace_id, p.member_id, "gcall:state", { call: dto });
  if (call.message_id) {
    const joined = ps.filter((p) => p.status === "joined").length;
    await updateTeamSystemMessage(ctx, call.message_id, call.workspace_id, groupCardText({ kind: call.kind, state: call.state, joined, duration_s: call.duration_s }), cardMeta(call, joined));
  }
  return dto;
}

export const groupSettings = async (ctx: AppContext, ws: string) => {
  const s = (await getSettings(ctx, ws)).calls.internal;
  return { ...s, group_max: clampGroupMax(s.group_max) };
};
const turnOf = async (ctx: AppContext, ws: string) => (await getSettings(ctx, ws)).calls.turn_provider;
const iceFor = async (ctx: AppContext, ws: string, id: string): Promise<IceConfig> => iceConfig(ctx, ws, await turnOf(ctx, ws), id);

/** Is this member in a call right now, of any kind? (team 1:1, visitor call as the agent, or a group call) */
export async function inGroupCall(ctx: AppContext, ws: string, memberId: string): Promise<boolean> {
  return !!(await ctx.db.get("SELECT 1 FROM group_call_participants WHERE workspace_id = ? AND member_id = ? AND status = 'joined'", ws, memberId));
}
async function busyElsewhere(ctx: AppContext, ws: string, memberId: string): Promise<boolean> {
  if (await ctx.db.get("SELECT 1 FROM team_calls WHERE workspace_id = ? AND (caller_id = ? OR callee_id = ?) AND state IN ('ringing','connecting','active')", ws, memberId, memberId)) return true;
  return !!(await ctx.db.get("SELECT 1 FROM calls WHERE workspace_id = ? AND initiated_by = ? AND transport = 'webrtc' AND state IN ('ringing','connecting','active')", ws, memberId));
}

/** Why this person cannot be rung right now, or null. */
async function unavailableReason(ctx: AppContext, ws: string, memberId: string, channelVisible: (id: string) => Promise<boolean>): Promise<string | null> {
  const m = await findMember(ctx, ws, memberId);
  if (!m) return "gone";
  if (!can(actorFromRow(m), "calls:internal")) return "cannot_receive";
  if (!(await channelVisible(memberId))) return "not_in_conversation";
  if (isDnd(ctx, m) || m.availability === "inactive") return "unavailable";
  if (!(await ctx.presence.isOnline(memberScope(ws), memberId))) return "offline";
  if ((await inGroupCall(ctx, ws, memberId)) || (await busyElsewhere(ctx, ws, memberId))) return "busy";
  return null;
}

export interface GroupStart {
  call: Dto;
  ice: IceConfig;
  /** people who could not be rung, and why */
  skipped: { member_id: string; name: string; reason: string }[];
}

export async function startGroupCall(ctx: AppContext, actor: Actor, socketId: string | null, input: { channel_id: string; kind: "voice" | "video"; invite_ids?: string[] }): Promise<GroupStart> {
  const ws = actor.workspaceId;
  const s = await groupSettings(ctx, ws);
  if (!s.enabled) throw new AppError(403, "TEAM_CALLS_DISABLED", "Calls between teammates are switched off for this workspace");
  if (!s.group) throw new AppError(403, "GROUP_CALLS_DISABLED", "Group calls are switched off for this workspace");
  if (!s[input.kind]) throw new AppError(403, "TEAM_CALL_KIND_DISABLED", `${input.kind === "video" ? "Video" : "Voice"} calls between teammates are switched off for this workspace`);
  const { channel } = await accessChannel(ctx, actor, input.channel_id, { write: true });
  if (channel.kind === "dm") throw unprocessable("USE_DIRECT_CALL", "A direct message is a call between two people: use the call buttons of the conversation");
  const memberIds = (await ctx.db.all<{ member_id: string }>("SELECT member_id FROM team_channel_members WHERE channel_id = ?", channel.id)).map((r) => r.member_id);
  const visible = async (id: string) => channel.visibility === "public" || memberIds.includes(id);
  let wanted = [...new Set(input.invite_ids ?? (channel.kind === "group" ? memberIds : []))].filter((m) => m !== actor.memberId);
  if (wanted.length > s.group_max - 1) throw unprocessable("TOO_MANY_PARTICIPANTS", `A group call has at most ${s.group_max} people, including you`, { max: s.group_max });
  if (await ctx.db.get("SELECT 1 FROM group_calls WHERE channel_id = ? AND state = 'live'", channel.id)) throw new AppError(409, "GROUP_CALL_EXISTS", "There is already a call in this conversation: join it");
  if ((await inGroupCall(ctx, ws, actor.memberId)) || (await busyElsewhere(ctx, ws, actor.memberId))) throw new AppError(409, "CALL_IN_PROGRESS", "You are already in a call");
  const hourly = await ctx.ratelimit.check("calls.internal.member", { key: `${ws}:${actor.memberId}`, workspaceId: ws });
  if (!hourly.allowed) throw new RateLimitedError(hourly);

  const skipped: GroupStart["skipped"] = [];
  const ring: string[] = [];
  for (const m of wanted) {
    const why = await unavailableReason(ctx, ws, m, visible);
    if (why) skipped.push({ member_id: m, name: await nameOf(ctx, ws, m), reason: why });
    else ring.push(m);
  }
  if (wanted.length && !ring.length) throw new AppError(409, "NOBODY_TO_RING", "Nobody you chose can take a call right now", { skipped });
  wanted = ring;

  const id = newId("gcall");
  const now = nowIso(ctx);
  try {
    await ctx.db.tx(async () => {
      await ctx.db.run("INSERT INTO group_calls(id, workspace_id, channel_id, kind, state, host_id, max_participants, created_at, updated_at) VALUES (?,?,?,?,'live',?,?,?,?)", id, ws, channel.id, input.kind, actor.memberId, s.group_max, now, now);
      await ctx.db.run("INSERT INTO group_call_participants(call_id, member_id, workspace_id, status, socket_id, invited_at, joined_at) VALUES (?,?,?,'joined',?,?,?)", id, actor.memberId, ws, socketId, now, now);
      for (const m of wanted) await ctx.db.run("INSERT INTO group_call_participants(call_id, member_id, workspace_id, status, invited_by, invited_at) VALUES (?,?,?,'invited',?,?)", id, m, ws, actor.memberId, now);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CALL_IN_PROGRESS", "There is already a call in this conversation, or you are in a call");
    throw e;
  }
  let call = (await loadCall(ctx, id))!;
  const card = await postTeamSystemMessage(ctx, channel.id, ws, { senderId: actor.memberId, senderName: actor.name, text: groupCardText({ kind: call.kind, state: "live", joined: 1, duration_s: null }), meta: cardMeta(call, 1) });
  await ctx.db.run("UPDATE group_calls SET message_id = ? WHERE id = ?", card.id, id);
  call = (await loadCall(ctx, id))!;
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "group_call.started", target: id, detail: { channel_id: channel.id, kind: input.kind, invited: wanted.length } });
  const dto = await publish(ctx, call);
  return { call: dto, ice: await iceFor(ctx, ws, id), skipped };
}

/** A call the actor may see: they have a row in it, or they can see the conversation. Anyone else (another workspace, a private channel) gets a 404. */
async function visibleCall(ctx: AppContext, actor: Actor, callId: string): Promise<GroupCallRow> {
  const c = await loadCall(ctx, callId);
  if (!c || c.workspace_id !== actor.workspaceId) throw notFound("Call");
  const mine = await ctx.db.get("SELECT 1 FROM group_call_participants WHERE call_id = ? AND member_id = ?", c.id, actor.memberId);
  if (mine) return c;
  try {
    await accessChannel(ctx, actor, c.channel_id);
  } catch {
    throw notFound("Call");
  }
  return c;
}
const myRow = (ctx: AppContext, callId: string, memberId: string) => ctx.db.get<ParticipantRow>("SELECT * FROM group_call_participants WHERE call_id = ? AND member_id = ?", callId, memberId);

/** The first statement of every change: locks the call row (a no-op write that serialises concurrent changes on PostgreSQL) and returns the live call, or throws. */
async function lock(ctx: AppContext, c: GroupCallRow): Promise<GroupCallRow> {
  const row = await ctx.db.get<GroupCallRow>("UPDATE group_calls SET updated_at = ? WHERE id = ? AND state = 'live' RETURNING *", nowIso(ctx), c.id);
  if (!row) throw new AppError(409, "CALL_STATE", "The call has ended", { state: (await loadCall(ctx, c.id))?.state ?? "ended" });
  return row;
}

export interface GroupJoin {
  call: Dto;
  ice: IceConfig;
  /** the people already in the call: the newcomer sends each of them an offer */
  peers: string[];
}

export async function joinGroupCall(ctx: AppContext, actor: Actor, socketId: string, callId: string): Promise<GroupJoin> {
  const c0 = await visibleCall(ctx, actor, callId);
  const ws = actor.workspaceId;
  const s = await groupSettings(ctx, ws);
  if (!s.enabled || !s.group) throw new AppError(403, "GROUP_CALLS_DISABLED", "Group calls are switched off for this workspace");
  if (c0.state !== "live") throw new AppError(409, "CALL_STATE", "The call has ended", { state: c0.state });
  const existing = await myRow(ctx, callId, actor.memberId);
  if (existing?.status === "joined" && existing.socket_id === socketId) return joinResult(ctx, c0, actor.memberId);
  if (existing?.status === "joined") throw new AppError(409, "ALREADY_IN_THIS_CALL", "You are already in this call on another device");
  if (!can(actor, "calls:internal")) throw new AppError(403, "PERMISSION_DENIED", "You do not have permission to take calls");
  if ((await inGroupCall(ctx, ws, actor.memberId)) || (await busyElsewhere(ctx, ws, actor.memberId))) throw new AppError(409, "CALL_IN_PROGRESS", "You are already in a call");
  try {
    await ctx.db.tx(async () => {
      const c = await lock(ctx, c0);
      const me = await myRow(ctx, callId, actor.memberId);
      if (me?.status === "joined" && me.socket_id === socketId) return; // the same connection asked twice (a double click, a retry): nothing to do
      if (me?.status === "joined") throw new AppError(409, "ALREADY_IN_THIS_CALL", "You are already in this call on another device");
      if (!hasRoom(await joinedCount(ctx, callId), c.max_participants)) throw noRoom();
      nextStatus(me?.status ?? null, "join");
      const now = nowIso(ctx);
      await ctx.db.run(
        `INSERT INTO group_call_participants(call_id, member_id, workspace_id, status, socket_id, invited_at, joined_at) VALUES (?,?,?,'joined',?,?,?)
         ON CONFLICT(call_id, member_id) DO UPDATE SET status = 'joined', socket_id = excluded.socket_id, joined_at = excluded.joined_at, left_at = NULL, gone_at = NULL, muted = 0, camera_off = 0`,
        callId, actor.memberId, ws, socketId, now, now,
      );
      if (!c.started_at && (await joinedCount(ctx, callId)) >= 2) await ctx.db.run("UPDATE group_calls SET started_at = ? WHERE id = ?", now, callId);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CALL_IN_PROGRESS", "You are already in a call");
    throw e;
  }
  const call = (await loadCall(ctx, callId))!;
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "group_call.joined", target: callId, detail: { channel_id: call.channel_id } });
  await publish(ctx, call);
  return joinResult(ctx, call, actor.memberId);
}
async function joinResult(ctx: AppContext, call: GroupCallRow, me: string): Promise<GroupJoin> {
  const ps = await parts(ctx, call.id);
  return { call: await groupCallDto(ctx, call, ps), ice: await iceFor(ctx, call.workspace_id, call.id), peers: ps.filter((p) => p.status === "joined" && p.member_id !== me).map((p) => p.member_id) };
}

export async function declineGroupCall(ctx: AppContext, actor: Actor, callId: string): Promise<Dto> {
  const c0 = await visibleCall(ctx, actor, callId);
  const out = await ctx.db.tx(async () => {
    const c = await lock(ctx, c0);
    const me = await myRow(ctx, callId, actor.memberId);
    if (!me) return c; // nothing was offered to them
    if (me.status !== "invited") throw new AppError(409, "CALL_STATE", `You are ${me.status === "joined" ? "in the call" : me.status}: there is nothing to decline`, { state: me.status });
    await ctx.db.run("UPDATE group_call_participants SET status = ? WHERE call_id = ? AND member_id = ?", nextStatus("invited", "decline"), callId, actor.memberId);
    return c;
  });
  return publish(ctx, (await loadCall(ctx, out.id))!);
}

/** The shared tail of leaving, being swept away and a closed socket: remove one person, free the screen, end the call when it is empty. */
async function depart(ctx: AppContext, c0: GroupCallRow, memberId: string, event: "leave" | "gone_timeout", reason: string): Promise<GroupCallRow> {
  await ctx.db.tx(async () => {
    const c = await lock(ctx, c0);
    const me = await myRow(ctx, c.id, memberId);
    if (!me || me.status !== "joined") return;
    const now = nowIso(ctx);
    await ctx.db.run("UPDATE group_call_participants SET status = ?, socket_id = NULL, left_at = ?, gone_at = NULL WHERE call_id = ? AND member_id = ?", nextStatus("joined", event), now, c.id, memberId);
    if (c.sharing_id === memberId) await ctx.db.run("UPDATE group_calls SET sharing_id = NULL WHERE id = ?", c.id);
    const left = await joinedCount(ctx, c.id);
    const to = afterDeparture(left, !!c.started_at);
    if (to !== "live") {
      const duration = c.started_at ? Math.max(0, Math.round((Date.parse(now) - Date.parse(c.started_at)) / 1000)) : 0;
      await ctx.db.run("UPDATE group_calls SET state = ?, ended_at = ?, duration_s = ?, end_reason = ?, sharing_id = NULL WHERE id = ?", to, now, duration, reason === "completed" && !c.started_at ? "nobody_joined" : reason, c.id);
      await ctx.db.run("UPDATE group_call_participants SET status = 'missed' WHERE call_id = ? AND status = 'invited'", c.id);
    }
  });
  const after = (await loadCall(ctx, c0.id))!;
  if (after.state !== "live") await recordAudit(ctx, { workspaceId: after.workspace_id, actor: { type: "member", id: memberId }, action: `group_call.${after.state}`, target: after.id, detail: { channel_id: after.channel_id, kind: after.kind, duration_s: after.duration_s, reason: after.end_reason } });
  return after;
}

/** Leaving is idempotent: someone who already left, or a call that already ended, answers with the call as it is. */
export async function leaveGroupCall(ctx: AppContext, actor: Actor, callId: string): Promise<Dto> {
  const c = await visibleCall(ctx, actor, callId);
  const after = c.state === "live" ? await depart(ctx, c, actor.memberId, "leave", "completed") : c;
  return publish(ctx, after);
}

export async function inviteGroupCall(ctx: AppContext, actor: Actor, callId: string, memberIds: string[]): Promise<{ call: Dto; skipped: GroupStart["skipped"] }> {
  const c0 = await visibleCall(ctx, actor, callId);
  const ws = actor.workspaceId;
  const me = await myRow(ctx, callId, actor.memberId);
  if (me?.status !== "joined") throw new AppError(403, "NOT_IN_THIS_CALL", "Join the call to invite people to it");
  const { channel } = await accessChannel(ctx, actor, c0.channel_id);
  const chMembers = (await ctx.db.all<{ member_id: string }>("SELECT member_id FROM team_channel_members WHERE channel_id = ?", channel.id)).map((r) => r.member_id);
  const visible = async (id: string) => channel.visibility === "public" || chMembers.includes(id);
  const skipped: GroupStart["skipped"] = [];
  const ok: string[] = [];
  for (const m of [...new Set(memberIds)].filter((x) => x !== actor.memberId)) {
    const existing = await myRow(ctx, callId, m);
    const why = existing?.status === "joined" ? "already_in_call" : existing?.status === "invited" ? "already_invited" : await unavailableReason(ctx, ws, m, visible);
    if (why) skipped.push({ member_id: m, name: await nameOf(ctx, ws, m), reason: why });
    else ok.push(m);
  }
  if (memberIds.length && !ok.length && skipped.every((x) => x.reason !== "already_invited" && x.reason !== "already_in_call")) throw new AppError(409, "NOBODY_TO_RING", "Nobody you chose can take a call right now", { skipped });
  await ctx.db.tx(async () => {
    const c = await lock(ctx, c0);
    const active = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM group_call_participants WHERE call_id = ? AND status IN ('joined','invited')", callId))!.n;
    if (active + ok.length > c.max_participants) throw new AppError(409, "GROUP_CALL_FULL", `A group call has at most ${c.max_participants} people`, { max: c.max_participants });
    const now = nowIso(ctx);
    for (const m of ok) {
      const ex = await myRow(ctx, callId, m);
      nextStatus(ex?.status ?? null, "invite");
      await ctx.db.run(
        `INSERT INTO group_call_participants(call_id, member_id, workspace_id, status, invited_by, invited_at) VALUES (?,?,?,'invited',?,?)
         ON CONFLICT(call_id, member_id) DO UPDATE SET status = 'invited', invited_by = excluded.invited_by, invited_at = excluded.invited_at, left_at = NULL, gone_at = NULL`,
        callId, m, ws, actor.memberId, now,
      );
    }
  });
  if (ok.length) await recordAudit(ctx, { workspaceId: ws, actor: { type: "member", id: actor.memberId }, action: "group_call.invited", target: callId, detail: { invited: ok.length } });
  return { call: await publish(ctx, (await loadCall(ctx, callId))!), skipped };
}

export async function setGroupMedia(ctx: AppContext, actor: Actor, callId: string, patch: { muted?: boolean; camera_off?: boolean }): Promise<Dto> {
  const c = await visibleCall(ctx, actor, callId);
  const me = await myRow(ctx, callId, actor.memberId);
  if (me?.status !== "joined") throw new AppError(403, "NOT_IN_THIS_CALL", "You are not in this call");
  if (c.state !== "live") throw new AppError(409, "CALL_STATE", "The call has ended", { state: c.state });
  await ctx.db.run("UPDATE group_call_participants SET muted = ?, camera_off = ? WHERE call_id = ? AND member_id = ?", patch.muted === undefined ? me.muted : patch.muted ? 1 : 0, patch.camera_off === undefined ? me.camera_off : patch.camera_off ? 1 : 0, callId, actor.memberId);
  return publish(ctx, (await loadCall(ctx, callId))!);
}

/** One person shares their screen at a time: the first to ask holds it until they stop or leave. */
export async function setGroupShare(ctx: AppContext, actor: Actor, callId: string, on: boolean): Promise<Dto> {
  const c0 = await visibleCall(ctx, actor, callId);
  const s = await groupSettings(ctx, actor.workspaceId);
  await ctx.db.tx(async () => {
    const c = await lock(ctx, c0);
    const me = await myRow(ctx, callId, actor.memberId);
    if (me?.status !== "joined") throw new AppError(403, "NOT_IN_THIS_CALL", "You are not in this call");
    if (!on) {
      if (c.sharing_id === actor.memberId) await ctx.db.run("UPDATE group_calls SET sharing_id = NULL WHERE id = ?", callId);
      return;
    }
    if (c.kind !== "video" || !s.screen_share) throw unprocessable("SHARE_NOT_AVAILABLE", "Screen sharing is not available in this call");
    if (c.sharing_id && c.sharing_id !== actor.memberId) throw new AppError(409, "SHARE_IN_USE", `${await nameOf(ctx, c.workspace_id, c.sharing_id)} is sharing their screen`, { by: c.sharing_id });
    await ctx.db.run("UPDATE group_calls SET sharing_id = ? WHERE id = ?", actor.memberId, callId);
  });
  return publish(ctx, (await loadCall(ctx, callId))!);
}

const MAX_SDP = 16_384;
const MAX_CANDIDATE = 2_048;
/** Relay one signalling message of one link of the mesh to the bound socket of the other person, and to nobody else. */
export async function relayGroupSignal(ctx: AppContext, actor: Actor, socketId: string, type: "offer" | "answer" | "ice", input: { call_id: string; to: string; data: unknown }): Promise<void> {
  const c = await visibleCall(ctx, actor, input.call_id);
  if (c.state !== "live") throw new AppError(409, "CALL_STATE", "The call has ended", { state: c.state });
  const me = await myRow(ctx, c.id, actor.memberId);
  if (me?.status !== "joined") throw new AppError(403, "NOT_IN_THIS_CALL", "You are not in this call");
  if (!me.socket_id || me.socket_id !== socketId) throw new AppError(403, "NOT_THIS_DEVICE", "This connection is not the one on the call");
  const peer = await myRow(ctx, c.id, input.to);
  if (!peer || peer.status !== "joined" || !peer.socket_id || input.to === actor.memberId) throw new AppError(409, "PEER_NOT_READY", "That person is not in the call");
  const d = input.data as { sdp?: unknown; type?: unknown } | null;
  if (!d || typeof d !== "object") throw unprocessable("INVALID_SIGNAL", "Signal needs data");
  if (type === "ice") {
    if (JSON.stringify(d).length > MAX_CANDIDATE) throw unprocessable("INVALID_SIGNAL", "Candidate too large");
  } else if (typeof d.sdp !== "string" || d.sdp.length > MAX_SDP || (d.type !== "offer" && d.type !== "answer") || d.type !== type) throw unprocessable("INVALID_SIGNAL", "Not a valid session description");
  ctx.bus.toSocket(c.workspace_id, peer.socket_id, `gcall:${type}`, { call_id: c.id, from: actor.memberId, data: input.data });
}

/** Re-bind a reconnected socket; the others restart ICE on their links to this person. */
export async function resumeGroupCall(ctx: AppContext, actor: Actor, socketId: string, callId: string): Promise<GroupJoin> {
  const c = await visibleCall(ctx, actor, callId);
  if (c.state !== "live") throw new AppError(409, "CALL_STATE", "The call has ended", { state: c.state });
  const row = await ctx.db.get<ParticipantRow>("UPDATE group_call_participants SET socket_id = ?, gone_at = NULL WHERE call_id = ? AND member_id = ? AND status = 'joined' RETURNING *", socketId, callId, actor.memberId);
  if (!row) throw new AppError(409, "CALL_STATE", "You are not in this call any more", { state: "left" });
  for (const p of await parts(ctx, callId)) if (p.status === "joined" && p.member_id !== actor.memberId && p.socket_id) ctx.bus.toSocket(c.workspace_id, p.socket_id, "gcall:peer", { call_id: callId, member_id: actor.memberId, event: "resumed" });
  return joinResult(ctx, c, actor.memberId);
}

/** A socket closed: note when, so the sweep removes the person if nobody resumes within the grace period. */
export async function groupSocketGone(ctx: AppContext, workspaceId: string, socketId: string): Promise<void> {
  const rows = await ctx.db.all<ParticipantRow>("SELECT * FROM group_call_participants WHERE workspace_id = ? AND socket_id = ? AND status = 'joined'", workspaceId, socketId);
  for (const p of rows) {
    await ctx.db.run("UPDATE group_call_participants SET gone_at = ? WHERE call_id = ? AND member_id = ? AND socket_id = ?", nowIso(ctx), p.call_id, p.member_id, socketId);
    for (const q of await parts(ctx, p.call_id)) if (q.status === "joined" && q.member_id !== p.member_id && q.socket_id) ctx.bus.toSocket(workspaceId, q.socket_id, "gcall:peer", { call_id: p.call_id, member_id: p.member_id, event: "lost" });
  }
}

/** Time-based changes, safe on every node: ringing past the ring time is missed, a person gone past the grace period leaves, a host nobody answered ends the call. */
export async function sweepGroupCalls(ctx: AppContext): Promise<{ missed: number; ended: number }> {
  const out = { missed: 0, ended: 0 };
  const now = ctx.clock().getTime();
  const calls = await ctx.db.all<GroupCallRow>("SELECT * FROM group_calls WHERE state = 'live' ORDER BY created_at LIMIT 200");
  for (const c0 of calls) {
    try {
      const ring = (await groupSettings(ctx, c0.workspace_id)).ring_seconds;
      let changed = false;
      for (const p of await parts(ctx, c0.id)) {
        if (p.status === "invited" && now - Date.parse(p.invited_at) >= ring * 1000) {
          const r = await ctx.db.run("UPDATE group_call_participants SET status = 'missed' WHERE call_id = ? AND member_id = ? AND status = 'invited'", c0.id, p.member_id);
          if (r.changes) {
            out.missed++;
            changed = true;
            await notifyPushById(ctx, c0.workspace_id, p.member_id, "missed_call", { title: "Missed group call", body: `${await nameOf(ctx, c0.workspace_id, c0.host_id)} invited you to a group call.`, url: `/team/${c0.channel_id}`, tag: `call-${c0.id}` });
          }
        } else if (p.status === "joined" && p.gone_at && now - Date.parse(p.gone_at) >= GROUP_RECONNECT_GRACE_S * 1000) {
          const after = await depart(ctx, c0, p.member_id, "gone_timeout", "disconnected");
          out.ended += after.state === "live" ? 0 : 1;
          changed = true;
        }
      }
      let cur = (await loadCall(ctx, c0.id))!;
      if (cur.state === "live" && !cur.started_at) {
        const ps = await parts(ctx, c0.id);
        const waiting = ps.some((p) => p.status === "invited");
        const joined = ps.filter((p) => p.status === "joined");
        // everyone rang out and the host is still alone: nobody is coming
        if (!waiting && joined.length === 1 && ps.length > 1) {
          cur = await depart(ctx, cur, joined[0]!.member_id, "leave", "no_answer");
          out.ended++;
          changed = true;
        }
      }
      if (changed) await publish(ctx, cur);
    } catch (e) {
      if (!(e instanceof AppError && e.code === "CALL_STATE")) throw e;
    }
  }
  return out;
}

/** What a tab that opens in the middle of things needs: the call the member is in, and the calls that ring for them. */
export async function liveGroupCallsOf(ctx: AppContext, actor: Actor): Promise<Dto[]> {
  const rows = await ctx.db.all<GroupCallRow>(
    `SELECT c.* FROM group_calls c JOIN group_call_participants p ON p.call_id = c.id WHERE c.workspace_id = ? AND p.member_id = ? AND c.state = 'live' AND p.status IN ('joined','invited')`,
    actor.workspaceId, actor.memberId,
  );
  return Promise.all(rows.map((c) => groupCallDto(ctx, c)));
}

/** The live call of one conversation (for the card's Join button), or null. */
export async function groupCallOfChannel(ctx: AppContext, actor: Actor, channelId: string): Promise<Dto | null> {
  await accessChannel(ctx, actor, channelId);
  const c = await ctx.db.get<GroupCallRow>("SELECT * FROM group_calls WHERE channel_id = ? AND workspace_id = ? AND state = 'live'", channelId, actor.workspaceId);
  return c ? groupCallDto(ctx, c) : null;
}
