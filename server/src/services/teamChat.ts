import { can } from "../authz/permissions.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import type { Actor, Attachment } from "../domain/types.js";
import { AppError, forbidden, notFound, unprocessable } from "../errors.js";
import { enqueueJob } from "../jobs/queue.js";
import { enforceTeamSend } from "../ratelimit/enforce.js";
import { cleanPlainText, snippet } from "../util/html.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "./audit.js";
import { resolveAttachments } from "./attachments.js";
import { actorFromRow, isDnd, listMemberRows, memberScope, prefsOf, type MemberRow } from "./members.js";
import { canSeeRoom, getVisibleRoom } from "./roomStore.js";
import { contactDisplay } from "./teamShare.js";

/*
 * Internal team chat: channels (public to the workspace or private), direct messages and group messages between workspace members.
 * Separate from customer conversations. Rules shared with the rest of the product:
 *  - every query is workspace-scoped; a private channel (and every dm/group) does not exist for non-members: 404, on REST and on sockets;
 *  - messages have a per-channel monotonic `seq`; unread is computed from each member's read cursor (no stored counters);
 *  - sends are idempotent on `client_msg_id` (unique index backstop); deletes are soft;
 *  - realtime events go to each member of the channel through the member's own channel (`member:<id>`), computed from the database at emit time,
 *    so removing someone from a private channel stops delivery immediately.
 */

export const MAX_TEAM_CONTENT = 4000;
export const MAX_DM_MEMBERS = 8;
export const MAX_REACTION_KINDS = 20;
export const THREAD_PAGE = 200;

export interface ChannelRow {
  id: string;
  workspace_id: string;
  kind: "channel" | "dm" | "group";
  visibility: "public" | "private";
  name: string | null;
  slug: string | null;
  topic: string;
  dm_key: string | null;
  is_general: number;
  created_by: string | null;
  next_seq: number;
  last_message_at: string | null;
  last_message_seq: number;
  archived_at: string | null;
  created_at: string;
}
export interface ChannelMemberRow {
  channel_id: string;
  member_id: string;
  workspace_id: string;
  role: "owner" | "member";
  last_read_seq: number;
  muted: number;
  joined_at: string;
}
export interface TeamMessageRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  seq: number;
  thread_root_id: string | null;
  sender_id: string;
  sender_name: string;
  kind: "text" | "share" | "system";
  content: string;
  content_text: string;
  attachments: string;
  meta: string;
  client_msg_id: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
}

const use = (a: Actor) => {
  if (!can(a, "team_chat:use")) throw forbidden("Your role cannot use team chat");
};
const MENTION_TOKEN = /@\[([^\]]*)\]\((mem_[0-9a-f]{24})\)/g;
const toSearchText = (s: string) => s.replace(MENTION_TOKEN, "@$1");

/* ------------------------------------------------------------------ channels */

export const slugOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[\s.]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-");
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

async function loadChannel(ctx: AppContext, ws: string, id: string): Promise<ChannelRow | undefined> {
  return ctx.db.get<ChannelRow>("SELECT * FROM team_channels WHERE id = ? AND workspace_id = ?", id, ws);
}
export async function membershipOf(ctx: AppContext, channelId: string, memberId: string): Promise<ChannelMemberRow | undefined> {
  return ctx.db.get<ChannelMemberRow>("SELECT * FROM team_channel_members WHERE channel_id = ? AND member_id = ?", channelId, memberId);
}
async function channelMemberIds(ctx: AppContext, channelId: string): Promise<string[]> {
  return (await ctx.db.all<{ member_id: string }>("SELECT member_id FROM team_channel_members WHERE channel_id = ?", channelId)).map((r) => r.member_id);
}

/**
 * The channel as this actor may see it, or 404. A public channel can be read by every member of the workspace (to preview it before joining);
 * a private channel, direct message or group message exists only for its members. `write` additionally requires membership and an active channel.
 */
export async function accessChannel(ctx: AppContext, actor: Actor, id: string, opts: { write?: boolean } = {}): Promise<{ channel: ChannelRow; membership: ChannelMemberRow | undefined }> {
  use(actor);
  const channel = await loadChannel(ctx, actor.workspaceId, id);
  if (!channel) throw notFound("Channel");
  const membership = await membershipOf(ctx, id, actor.memberId);
  if (!membership && channel.visibility !== "public") throw notFound("Channel");
  if (opts.write) {
    if (!membership) throw new AppError(403, "NOT_A_MEMBER", "Join the channel to write in it");
    if (channel.archived_at) throw new AppError(409, "CHANNEL_ARCHIVED", "This channel is archived");
  }
  return { channel, membership };
}

/** #general exists once per workspace and everyone is in it. Idempotent; called whenever team chat is opened. */
export async function ensureGeneral(ctx: AppContext, ws: string, memberId?: string): Promise<ChannelRow> {
  let g = await ctx.db.get<ChannelRow>("SELECT * FROM team_channels WHERE workspace_id = ? AND is_general = 1", ws);
  if (!g) {
    const id = newId("tch");
    try {
      await ctx.db.run(
        "INSERT INTO team_channels(id, workspace_id, kind, visibility, name, slug, topic, is_general, created_at) VALUES (?,?,'channel','public','general','general','Company-wide announcements and chat',1,?)",
        id,
        ws,
        nowIso(ctx),
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    g = (await ctx.db.get<ChannelRow>("SELECT * FROM team_channels WHERE workspace_id = ? AND is_general = 1", ws))!;
  }
  if (memberId) {
    await ctx.db.run("INSERT OR IGNORE INTO team_channel_members(channel_id, member_id, workspace_id, role, joined_at) VALUES (?,?,?,'member',?)", g.id, memberId, ws, nowIso(ctx));
  }
  return g;
}

/** Display name of a channel for one viewer: its name, or the other people of a dm/group. */
function titleOf(c: ChannelRow, viewerId: string, names: Map<string, string>, memberIds: string[]): string {
  if (c.kind === "channel") return c.name ?? "channel";
  const others = memberIds.filter((m) => m !== viewerId);
  if (!others.length) return `${names.get(viewerId) ?? "You"} (you)`;
  return others.map((m) => names.get(m) ?? "Former member").join(", ");
}

export interface UnreadInfo {
  unread: number;
  mention_unread: number;
}

async function unreadByChannel(ctx: AppContext, actor: Actor): Promise<Map<string, UnreadInfo>> {
  // both statements start from the member's own memberships (ix_tcm_member) and probe messages / mentions by (channel, seq)
  const rows = await ctx.db.all<{ channel_id: string; n: number }>(
    `SELECT cm.channel_id AS channel_id, COUNT(*) AS n FROM team_channel_members cm
       JOIN team_messages m ON m.channel_id = cm.channel_id AND m.seq > cm.last_read_seq
      WHERE cm.workspace_id = ? AND cm.member_id = ? AND m.deleted_at IS NULL AND m.sender_id != ? AND m.kind != 'system'
      GROUP BY cm.channel_id`,
    actor.workspaceId,
    actor.memberId,
    actor.memberId,
  );
  const men = await ctx.db.all<{ channel_id: string; n: number }>(
    `SELECT cm.channel_id AS channel_id, COUNT(*) AS n FROM team_channel_members cm
       JOIN team_mentions t ON t.channel_id = cm.channel_id AND t.member_id = cm.member_id AND t.seq > cm.last_read_seq
      WHERE cm.workspace_id = ? AND cm.member_id = ? GROUP BY cm.channel_id`,
    actor.workspaceId,
    actor.memberId,
  );
  const out = new Map<string, UnreadInfo>();
  for (const r of rows) out.set(r.channel_id, { unread: Number(r.n), mention_unread: 0 });
  for (const r of men) out.set(r.channel_id, { unread: out.get(r.channel_id)?.unread ?? 0, mention_unread: Number(r.n) });
  return out;
}

export async function channelDto(ctx: AppContext, actor: Actor, c: ChannelRow, opts: { membership?: ChannelMemberRow; unread?: UnreadInfo; memberIds?: string[]; names?: Map<string, string> } = {}) {
  const names = opts.names ?? new Map((await listMemberRows(ctx, c.workspace_id)).map((m) => [m.id, m.name]));
  const memberIds = opts.memberIds ?? (await channelMemberIds(ctx, c.id));
  const last = c.last_message_seq
    ? await ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE channel_id = ? AND seq = ? AND deleted_at IS NULL", c.id, c.last_message_seq)
    : undefined;
  return {
    id: c.id,
    kind: c.kind,
    visibility: c.visibility,
    name: c.name,
    title: titleOf(c, actor.memberId, names, memberIds),
    topic: c.topic,
    is_general: !!c.is_general,
    archived: !!c.archived_at,
    member_ids: c.kind === "channel" ? undefined : memberIds,
    member_count: memberIds.length,
    joined: !!opts.membership,
    role: opts.membership?.role ?? null,
    muted: !!opts.membership?.muted,
    unread: opts.unread?.unread ?? 0,
    mention_unread: opts.unread?.mention_unread ?? 0,
    last_message: last ? { sender_name: last.sender_name, snippet: snippet(last.content_text || (last.attachments !== "[]" ? "Attachment" : ""), 100), at: last.created_at } : null,
    last_message_at: c.last_message_at,
    created_at: c.created_at,
  };
}

export async function listChannels(ctx: AppContext, actor: Actor) {
  use(actor);
  await ensureGeneral(ctx, actor.workspaceId, actor.memberId);
  // driven from the member's own rows (ix_tcm_member), then one primary-key lookup per channel
  const rows = await ctx.db.all<ChannelRow & { m_role: ChannelMemberRow["role"]; m_read: number; m_muted: number; m_joined: string }>(
    `SELECT c.*, cm.role AS m_role, cm.last_read_seq AS m_read, cm.muted AS m_muted, cm.joined_at AS m_joined FROM team_channel_members cm
       JOIN team_channels c ON c.id = cm.channel_id
      WHERE cm.workspace_id = ? AND cm.member_id = ? AND c.workspace_id = ? ORDER BY c.last_message_at DESC, c.created_at DESC, c.id`,
    actor.workspaceId,
    actor.memberId,
    actor.workspaceId,
  );
  const unread = await unreadByChannel(ctx, actor);
  const names = new Map((await listMemberRows(ctx, actor.workspaceId)).map((m) => [m.id, m.name]));
  const allMembers = await ctx.db.all<{ channel_id: string; member_id: string }>(
    `SELECT cm.channel_id AS channel_id, cm.member_id AS member_id FROM team_channel_members mine
       JOIN team_channel_members cm ON cm.channel_id = mine.channel_id WHERE mine.workspace_id = ? AND mine.member_id = ?`,
    actor.workspaceId,
    actor.memberId,
  );
  const byChannel = new Map<string, string[]>();
  for (const r of allMembers) byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), r.member_id]);
  const data = [];
  for (const r of rows) {
    const membership: ChannelMemberRow = { channel_id: r.id, member_id: actor.memberId, workspace_id: r.workspace_id, role: r.m_role, last_read_seq: r.m_read, muted: r.m_muted, joined_at: r.m_joined };
    data.push(await channelDto(ctx, actor, r, { membership, unread: unread.get(r.id), memberIds: byChannel.get(r.id) ?? [], names }));
  }
  return { data };
}

/** Public channels the actor has not joined yet. */
export async function browseChannels(ctx: AppContext, actor: Actor) {
  use(actor);
  const rows = await ctx.db.all<ChannelRow & { n: number }>(
    `SELECT c.*, (SELECT COUNT(*) FROM team_channel_members x WHERE x.channel_id = c.id) AS n FROM team_channels c
      WHERE c.workspace_id = ? AND c.kind = 'channel' AND c.visibility = 'public' AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM team_channel_members cm WHERE cm.channel_id = c.id AND cm.member_id = ?) ORDER BY c.slug`,
    actor.workspaceId,
    actor.memberId,
  );
  const names = new Map((await listMemberRows(ctx, actor.workspaceId)).map((m) => [m.id, m.name]));
  return { data: await Promise.all(rows.map((r) => channelDto(ctx, actor, r, { names, memberIds: Array(Number(r.n)).fill("") }))) };
}

export async function getChannel(ctx: AppContext, actor: Actor, id: string) {
  const { channel, membership } = await accessChannel(ctx, actor, id);
  const memberIds = await channelMemberIds(ctx, id);
  const dto = await channelDto(ctx, actor, channel, { membership, unread: (await unreadByChannel(ctx, actor)).get(id), memberIds });
  const rows = await ctx.db.all<ChannelMemberRow>("SELECT * FROM team_channel_members WHERE channel_id = ?", id);
  const names = new Map((await listMemberRows(ctx, actor.workspaceId)).map((m) => [m.id, m]));
  return { ...dto, members: rows.map((r) => ({ id: r.member_id, name: names.get(r.member_id)?.name ?? "Former member", role: r.role, last_read_seq: r.last_read_seq })) };
}

/** Everyone who should hear about something in this channel, as a live list. */
export async function emitToChannel(ctx: AppContext, c: Pick<ChannelRow, "id" | "workspace_id">, event: string, payload: unknown | ((memberId: string) => Promise<unknown> | unknown), opts: { except?: string } = {}): Promise<void> {
  for (const memberId of await channelMemberIds(ctx, c.id)) {
    if (opts.except && memberId === opts.except) continue;
    ctx.bus.toMember(c.workspace_id, memberId, event, typeof payload === "function" ? await (payload as (m: string) => unknown)(memberId) : payload);
  }
}

export async function createChannel(ctx: AppContext, actor: Actor, input: { name: string; visibility?: "public" | "private"; topic?: string; member_ids?: string[] }) {
  use(actor);
  if (!can(actor, "team_chat:manage_channels")) throw forbidden("Only managers can create channels");
  const slug = slugOf(input.name);
  if (!SLUG_RE.test(slug)) throw unprocessable("INVALID_CHANNEL_NAME", "Channel names use letters, numbers, dashes and underscores (up to 40 characters)");
  const members = await validMembers(ctx, actor.workspaceId, input.member_ids ?? []);
  const id = newId("tch");
  const now = nowIso(ctx);
  try {
    await ctx.db.tx(async () => {
      await ctx.db.run(
        "INSERT INTO team_channels(id, workspace_id, kind, visibility, name, slug, topic, created_by, created_at) VALUES (?,?,'channel',?,?,?,?,?,?)",
        id,
        actor.workspaceId,
        input.visibility ?? "public",
        slug,
        slug,
        (input.topic ?? "").slice(0, 250),
        actor.memberId,
        now,
      );
      await ctx.db.run("INSERT INTO team_channel_members(channel_id, member_id, workspace_id, role, joined_at) VALUES (?,?,?,'owner',?)", id, actor.memberId, actor.workspaceId, now);
      for (const m of members) if (m !== actor.memberId) await ctx.db.run("INSERT INTO team_channel_members(channel_id, member_id, workspace_id, role, joined_at) VALUES (?,?,?,'member',?)", id, m, actor.workspaceId, now);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CHANNEL_EXISTS", `There is already a channel called #${slug}`);
    throw e;
  }
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "team.channel_created", target: id, detail: { visibility: input.visibility ?? "public" } });
  const c = (await loadChannel(ctx, actor.workspaceId, id))!;
  await announceChannel(ctx, c, "team:channel:created");
  return await getChannel(ctx, actor, id);
}

async function announceChannel(ctx: AppContext, c: ChannelRow, event: "team:channel:created" | "team:channel:updated") {
  const ids = await channelMemberIds(ctx, c.id);
  const names = new Map((await listMemberRows(ctx, c.workspace_id)).map((m) => [m.id, m]));
  for (const memberId of ids) {
    const row = names.get(memberId);
    if (!row) continue;
    const a = actorFromRow(row);
    ctx.bus.toMember(c.workspace_id, memberId, event, { channel: await channelDto(ctx, a, c, { membership: await membershipOf(ctx, c.id, memberId), memberIds: ids, names: new Map([...names].map(([k, v]) => [k, v.name])) }) });
  }
  // a public channel is browsable by everyone: tell the rest of the workspace it exists (without membership details)
  if (event === "team:channel:created" && c.visibility === "public") {
    for (const [memberId, row] of names) {
      if (ids.includes(memberId)) continue;
      ctx.bus.toMember(c.workspace_id, memberId, "team:channel:created", { channel: await channelDto(ctx, actorFromRow(row), c, { memberIds: ids, names: new Map([...names].map(([k, v]) => [k, v.name])) }) });
    }
  }
}

async function validMembers(ctx: AppContext, ws: string, ids: string[]): Promise<string[]> {
  const live = new Map((await listMemberRows(ctx, ws)).map((m) => [m.id, m]));
  const out: string[] = [];
  for (const id of new Set(ids)) {
    const m = live.get(id);
    if (!m) throw unprocessable("UNKNOWN_MEMBER", "One of the people does not exist in this workspace");
    out.push(id);
  }
  return out;
}

/** A direct message (2 people, or yourself) or group message (3 to 8). The same people always resolve to the same conversation. */
export async function openDm(ctx: AppContext, actor: Actor, memberIds: string[]) {
  use(actor);
  const ids = [...new Set([actor.memberId, ...(await validMembers(ctx, actor.workspaceId, memberIds))])].sort();
  if (ids.length > MAX_DM_MEMBERS) throw unprocessable("TOO_MANY_MEMBERS", `A group message holds up to ${MAX_DM_MEMBERS} people; create a channel for more`);
  const key = ids.join(",");
  let c = await ctx.db.get<ChannelRow>("SELECT * FROM team_channels WHERE workspace_id = ? AND dm_key = ?", actor.workspaceId, key);
  let created = false;
  if (!c) {
    const id = newId("tch");
    const now = nowIso(ctx);
    try {
      await ctx.db.tx(async () => {
        await ctx.db.run("INSERT INTO team_channels(id, workspace_id, kind, visibility, dm_key, created_by, created_at) VALUES (?,?,?,'private',?,?,?)", id, actor.workspaceId, ids.length > 2 ? "group" : "dm", key, actor.memberId, now);
        for (const m of ids) await ctx.db.run("INSERT INTO team_channel_members(channel_id, member_id, workspace_id, role, joined_at) VALUES (?,?,?,'member',?)", id, m, actor.workspaceId, now);
      });
      created = true;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // lost a race to create the same conversation: use the winner
    }
    c = (await ctx.db.get<ChannelRow>("SELECT * FROM team_channels WHERE workspace_id = ? AND dm_key = ?", actor.workspaceId, key))!;
    if (created) await announceChannel(ctx, c, "team:channel:created");
  }
  return { created, channel: await getChannel(ctx, actor, c.id) };
}

export async function updateChannel(ctx: AppContext, actor: Actor, id: string, patch: { name?: string; topic?: string; archived?: boolean }) {
  const { channel, membership } = await accessChannel(ctx, actor, id);
  if (channel.kind !== "channel") throw unprocessable("NOT_A_CHANNEL", "Direct and group messages cannot be renamed or archived");
  const isOwner = membership?.role === "owner";
  const manage = can(actor, "team_chat:manage_channels");
  if (!manage && !(isOwner && patch.name === undefined && patch.archived === undefined)) throw forbidden("Only managers can change this channel");
  if (channel.is_general && (patch.name !== undefined || patch.archived)) throw unprocessable("GENERAL_PROTECTED", "#general cannot be renamed or archived");
  let slug = channel.slug;
  let name = channel.name;
  if (patch.name !== undefined) {
    slug = slugOf(patch.name);
    if (!SLUG_RE.test(slug)) throw unprocessable("INVALID_CHANNEL_NAME", "Channel names use letters, numbers, dashes and underscores (up to 40 characters)");
    name = slug;
  }
  const archivedAt = patch.archived === undefined ? channel.archived_at : patch.archived ? (channel.archived_at ?? nowIso(ctx)) : null;
  try {
    await ctx.db.run("UPDATE team_channels SET name = ?, slug = ?, topic = ?, archived_at = ? WHERE id = ?", name, slug, patch.topic !== undefined ? patch.topic.slice(0, 250) : channel.topic, archivedAt, id);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CHANNEL_EXISTS", `There is already a channel called #${slug}`);
    throw e;
  }
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: patch.archived !== undefined ? (patch.archived ? "team.channel_archived" : "team.channel_unarchived") : "team.channel_updated", target: id });
  const fresh = (await loadChannel(ctx, actor.workspaceId, id))!;
  await announceChannel(ctx, fresh, "team:channel:updated");
  return await getChannel(ctx, actor, id);
}

export async function joinChannel(ctx: AppContext, actor: Actor, id: string) {
  const { channel, membership } = await accessChannel(ctx, actor, id);
  if (membership) return await getChannel(ctx, actor, id);
  if (channel.visibility !== "public" || channel.kind !== "channel") throw notFound("Channel");
  if (channel.archived_at) throw new AppError(409, "CHANNEL_ARCHIVED", "This channel is archived");
  // start reading from the newest message: joining does not make the whole history unread
  await ctx.db.run("INSERT OR IGNORE INTO team_channel_members(channel_id, member_id, workspace_id, role, last_read_seq, joined_at) VALUES (?,?,?,'member',?,?)", id, actor.memberId, actor.workspaceId, channel.last_message_seq, nowIso(ctx));
  await emitToChannel(ctx, channel, "team:channel:members", { channel_id: id, member_id: actor.memberId, joined: true });
  return await getChannel(ctx, actor, id);
}

export async function leaveChannel(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  const { channel, membership } = await accessChannel(ctx, actor, id);
  if (!membership) return;
  if (channel.is_general) throw unprocessable("GENERAL_PROTECTED", "Everyone stays in #general (mute it instead)");
  if (channel.kind !== "channel") throw unprocessable("NOT_A_CHANNEL", "You cannot leave a direct or group message (mute it instead)");
  await ctx.db.run("DELETE FROM team_channel_members WHERE channel_id = ? AND member_id = ?", id, actor.memberId);
  ctx.bus.toMember(actor.workspaceId, actor.memberId, "team:channel:removed", { channel_id: id });
  await emitToChannel(ctx, channel, "team:channel:members", { channel_id: id, member_id: actor.memberId, joined: false });
}

export async function addChannelMembers(ctx: AppContext, actor: Actor, id: string, memberIds: string[]) {
  const { channel, membership } = await accessChannel(ctx, actor, id);
  if (channel.kind !== "channel") throw unprocessable("NOT_A_CHANNEL", "People cannot be added to a direct or group message; start a new group instead");
  if (channel.archived_at) throw new AppError(409, "CHANNEL_ARCHIVED", "This channel is archived");
  const mayInvite = can(actor, "team_chat:manage_channels") || membership?.role === "owner" || (channel.visibility === "public" && !!membership);
  if (!mayInvite) throw forbidden("You cannot add people to this channel");
  const ids = await validMembers(ctx, actor.workspaceId, memberIds);
  for (const m of ids) {
    const res = await ctx.db.run("INSERT OR IGNORE INTO team_channel_members(channel_id, member_id, workspace_id, role, last_read_seq, joined_at) VALUES (?,?,?,'member',?,?)", id, m, actor.workspaceId, channel.last_message_seq, nowIso(ctx));
    if (res.changes) {
      const row = (await listMemberRows(ctx, actor.workspaceId)).find((x) => x.id === m);
      if (row) ctx.bus.toMember(actor.workspaceId, m, "team:channel:created", { channel: await channelDto(ctx, actorFromRow(row), channel, { membership: await membershipOf(ctx, id, m) }) });
    }
  }
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "team.members_added", target: id, detail: { count: ids.length } });
  await emitToChannel(ctx, channel, "team:channel:members", { channel_id: id, member_ids: ids, joined: true });
  return await getChannel(ctx, actor, id);
}

export async function removeChannelMember(ctx: AppContext, actor: Actor, id: string, memberId: string) {
  const { channel, membership } = await accessChannel(ctx, actor, id);
  if (channel.kind !== "channel") throw unprocessable("NOT_A_CHANNEL", "People cannot be removed from a direct or group message");
  if (channel.is_general) throw unprocessable("GENERAL_PROTECTED", "Everyone stays in #general");
  if (memberId === actor.memberId) return await leaveChannel(ctx, actor, id);
  if (!can(actor, "team_chat:manage_channels") && membership?.role !== "owner") throw forbidden("You cannot remove people from this channel");
  const res = await ctx.db.run("DELETE FROM team_channel_members WHERE channel_id = ? AND member_id = ?", id, memberId);
  if (!res.changes) throw notFound("Member");
  ctx.bus.toMember(actor.workspaceId, memberId, "team:channel:removed", { channel_id: id });
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "team.member_removed", target: id, detail: { member_id: memberId } });
  await emitToChannel(ctx, channel, "team:channel:members", { channel_id: id, member_id: memberId, joined: false });
}

export async function setMuted(ctx: AppContext, actor: Actor, id: string, muted: boolean) {
  const { membership } = await accessChannel(ctx, actor, id);
  if (!membership) throw new AppError(403, "NOT_A_MEMBER", "Join the channel first");
  await ctx.db.run("UPDATE team_channel_members SET muted = ? WHERE channel_id = ? AND member_id = ?", muted, id, actor.memberId);
  ctx.bus.toMember(actor.workspaceId, actor.memberId, "team:channel:updated", { channel_id: id, muted });
  return { muted };
}

/* ------------------------------------------------------------------ messages */

const parseAtt = (m: TeamMessageRow) => parseJson<Attachment[]>(m.attachments, []);

interface Extras {
  reactions: Map<string, { emoji: string; member_ids: string[] }[]>;
  replies: Map<string, { count: number; last_at: string | null }>;
  mentions: Map<string, string[]>;
}

async function loadExtras(ctx: AppContext, channelId: string, rows: TeamMessageRow[]): Promise<Extras> {
  const ids = rows.map((r) => r.id);
  const ex: Extras = { reactions: new Map(), replies: new Map(), mentions: new Map() };
  if (!ids.length) return ex;
  const ph = ids.map(() => "?").join(",");
  const rx = await ctx.db.all<{ message_id: string; emoji: string; member_id: string }>(`SELECT message_id, emoji, member_id FROM team_reactions WHERE message_id IN (${ph}) ORDER BY created_at, member_id`, ...ids);
  for (const r of rx) {
    const list = ex.reactions.get(r.message_id) ?? [];
    const e = list.find((x) => x.emoji === r.emoji);
    if (e) e.member_ids.push(r.member_id);
    else list.push({ emoji: r.emoji, member_ids: [r.member_id] });
    ex.reactions.set(r.message_id, list);
  }
  const rp = await ctx.db.all<{ thread_root_id: string; n: number; last_at: string }>(
    `SELECT thread_root_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM team_messages WHERE channel_id = ? AND thread_root_id IN (${ph}) AND deleted_at IS NULL GROUP BY thread_root_id`,
    channelId,
    ...ids,
  );
  for (const r of rp) ex.replies.set(r.thread_root_id, { count: Number(r.n), last_at: r.last_at });
  const mn = await ctx.db.all<{ message_id: string; member_id: string }>(`SELECT message_id, member_id FROM team_mentions WHERE message_id IN (${ph})`, ...ids);
  for (const r of mn) ex.mentions.set(r.message_id, [...(ex.mentions.get(r.message_id) ?? []), r.member_id]);
  return ex;
}

function messageBase(ctx: AppContext, m: TeamMessageRow, ex: Extras) {
  const deleted = !!m.deleted_at;
  const meta = parseJson<{ room_id?: string; mention_all?: boolean; sub_type?: string; call?: { id: string; kind: "voice" | "video"; state: string; joined: number; max: number } }>(m.meta, {});
  return {
    id: m.id,
    channel_id: m.channel_id,
    seq: m.seq,
    thread_root_id: m.thread_root_id,
    client_msg_id: m.client_msg_id,
    sender: { id: m.sender_id, name: m.sender_name },
    kind: m.kind,
    content: deleted ? "" : m.content,
    content_text: deleted ? "" : m.content_text,
    attachments: deleted ? [] : parseAtt(m).map((a) => ({ ...a, url: ctx.storage.signedUrl(a.key, { fileName: a.file_name, contentType: a.content_type, ttlSeconds: ctx.config.SIGNED_URL_TTL_SECONDS }) })),
    mentions: deleted ? [] : ex.mentions.get(m.id) ?? [],
    mention_all: !!meta.mention_all,
    reactions: deleted ? [] : (ex.reactions.get(m.id) ?? []).map((r) => ({ emoji: r.emoji, count: r.member_ids.length, member_ids: r.member_ids })),
    reply_count: ex.replies.get(m.id)?.count ?? 0,
    last_reply_at: ex.replies.get(m.id)?.last_at ?? null,
    pinned: !!m.pinned_at,
    pinned_at: m.pinned_at,
    edited_at: m.edited_at,
    deleted,
    created_at: m.created_at,
    share: null as null | { room_id: string; available: boolean; title?: string; status?: string },
    // the card of a group call: only what the card needs (the call itself is read through gcall events)
    group_call: meta.sub_type === "group_call" && meta.call ? { id: meta.call.id, kind: meta.call.kind, state: meta.call.state, joined: meta.call.joined, max: meta.call.max } : null,
  };
}

/**
 * A shared customer conversation is a link card whose content depends on WHO looks: a member who may open the conversation sees its title and
 * status; everyone else gets `available: false` and nothing else (no name, no snippet, not even whether the id exists).
 */
async function shareFor(ctx: AppContext, viewer: Actor, m: TeamMessageRow): Promise<{ room_id: string; available: boolean; title?: string; status?: string } | null> {
  if (m.kind !== "share" || m.deleted_at) return null;
  const roomId = parseJson<{ room_id?: string }>(m.meta, {}).room_id;
  if (!roomId) return null;
  if (!(await canSeeRoom(ctx, viewer, roomId))) return { room_id: roomId, available: false };
  const info = await contactDisplay(ctx, viewer.workspaceId, roomId);
  return { room_id: roomId, available: true, title: info?.title, status: info?.status };
}

export async function messageDtos(ctx: AppContext, viewer: Actor, channelId: string, rows: TeamMessageRow[]) {
  const ex = await loadExtras(ctx, channelId, rows);
  const out = [];
  for (const m of rows) out.push({ ...messageBase(ctx, m, ex), share: await shareFor(ctx, viewer, m) });
  return out;
}

async function findMessage(ctx: AppContext, ws: string, id: string): Promise<TeamMessageRow | undefined> {
  return ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ? AND workspace_id = ?", id, ws);
}

/** `@[Name](mem_x)` tokens, bare `@handle` of a member's email, and `@channel` / `@here` (everybody in the channel). Only people who can see the channel are kept. */
export async function parseTeamMentions(ctx: AppContext, c: ChannelRow, text: string): Promise<{ ids: string[]; all: boolean }> {
  const members = await listMemberRows(ctx, c.workspace_id);
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION_TOKEN)) found.add(m[2]!);
  for (const m of text.matchAll(/(?:^|[\s(])@([a-z0-9._-]{2,40})\b/gi)) {
    const handle = m[1]!.toLowerCase();
    const hit = members.find((x) => x.email.split("@")[0]!.toLowerCase() === handle);
    if (hit) found.add(hit.id);
  }
  const all = /(?:^|[\s(])@(?:channel|here)\b/i.test(text);
  const inChannel = new Set(await channelMemberIds(ctx, c.id));
  const visible = [...found].filter((id) => members.some((x) => x.id === id) && (c.visibility === "public" || inChannel.has(id)));
  if (all) for (const id of inChannel) if (!visible.includes(id)) visible.push(id);
  return { ids: visible, all };
}

export interface TeamSendInput {
  content?: string;
  thread_root_id?: string | null;
  attachment_ids?: string[];
  client_msg_id?: string;
  share_room_id?: string;
}

export async function sendTeamMessage(ctx: AppContext, actor: Actor, channelId: string, input: TeamSendInput): Promise<{ message: Awaited<ReturnType<typeof messageDtos>>[number]; created: boolean }> {
  const { channel } = await accessChannel(ctx, actor, channelId, { write: true });
  const dup = input.client_msg_id ? await ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE channel_id = ? AND client_msg_id = ?", channelId, input.client_msg_id) : undefined;
  if (dup) return { message: (await messageDtos(ctx, actor, channelId, [dup]))[0]!, created: false };
  await enforceTeamSend(ctx, { workspaceId: actor.workspaceId, memberId: actor.memberId, channelId, clientMsgId: input.client_msg_id });

  const raw = input.content ?? "";
  if (raw.length > MAX_TEAM_CONTENT) throw unprocessable("CONTENT_TOO_LONG", `Messages are limited to ${MAX_TEAM_CONTENT} characters`);
  const content = cleanPlainText(raw).trim();
  const attachments = input.attachment_ids?.length ? await resolveAttachments(ctx, actor.workspaceId, input.attachment_ids) : [];
  if (!content && !attachments.length && !input.share_room_id) throw unprocessable("EMPTY_MESSAGE", "Message is empty");

  let root: TeamMessageRow | undefined;
  if (input.thread_root_id) {
    root = await ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ? AND channel_id = ?", input.thread_root_id, channelId);
    if (!root || root.deleted_at) throw unprocessable("INVALID_THREAD", "That message is not in this channel");
    if (root.thread_root_id) throw unprocessable("INVALID_THREAD", "Reply to the first message of the thread");
  }
  let kind: TeamMessageRow["kind"] = "text";
  const meta: Record<string, unknown> = {};
  if (input.share_room_id) {
    await getVisibleRoom(ctx, actor, input.share_room_id); // 404 unless the sender may open that conversation
    kind = "share";
    meta.room_id = input.share_room_id;
  }
  const mentions = await parseTeamMentions(ctx, channel, content);
  if (mentions.all) meta.mention_all = true;

  const id = newId("tmsg");
  let row: TeamMessageRow;
  try {
    row = await ctx.db.tx(async () => {
      const bump = await ctx.db.get<{ next_seq: number }>("UPDATE team_channels SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq", channelId);
      if (!bump) throw new Error("channel vanished");
      const now = nowIso(ctx);
      await ctx.db.run(
        `INSERT INTO team_messages(id, workspace_id, channel_id, seq, thread_root_id, sender_id, sender_name, kind, content, content_text, attachments, meta, client_msg_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        actor.workspaceId,
        channelId,
        bump.next_seq,
        root?.id ?? null,
        actor.memberId,
        actor.name,
        kind,
        content,
        toSearchText(content),
        JSON.stringify(attachments),
        JSON.stringify(meta),
        input.client_msg_id ?? null,
        now,
      );
      for (const m of mentions.ids) await ctx.db.run("INSERT OR IGNORE INTO team_mentions(message_id, member_id, channel_id, workspace_id, seq) VALUES (?,?,?,?,?)", id, m, channelId, actor.workspaceId, bump.next_seq);
      await ctx.db.run("UPDATE team_channels SET last_message_at = ?, last_message_seq = ? WHERE id = ?", now, bump.next_seq, channelId);
      // writing marks everything up to your own message as read
      await ctx.db.run("UPDATE team_channel_members SET last_read_seq = ? WHERE channel_id = ? AND member_id = ? AND last_read_seq < ?", bump.next_seq, channelId, actor.memberId, bump.next_seq);
      return (await ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ?", id))!;
    });
  } catch (e) {
    if (isUniqueViolation(e) && input.client_msg_id) {
      const winner = await ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE channel_id = ? AND client_msg_id = ?", channelId, input.client_msg_id);
      if (winner) return { message: (await messageDtos(ctx, actor, channelId, [winner]))[0]!, created: false };
    }
    throw e;
  }
  const fresh = (await ctx.db.get<TeamChannelFresh>("SELECT * FROM team_channels WHERE id = ?", channelId))!;
  await emitMessage(ctx, fresh, row, "team:message:new");
  await notifyTeamMessage(ctx, actor, fresh, row, mentions);
  return { message: (await messageDtos(ctx, actor, channelId, [row]))[0]!, created: true };
}
type TeamChannelFresh = ChannelRow;

/**
 * A line the system writes in a team conversation (a call card). It takes a sequence number like any message but is not counted as unread and does not
 * notify anyone: the call's own events do that.
 */
export async function postTeamSystemMessage(ctx: AppContext, channelId: string, ws: string, o: { senderId: string; senderName: string; text: string; meta: Record<string, unknown> }): Promise<TeamMessageRow> {
  const id = newId("tmsg");
  const row = await ctx.db.tx(async () => {
    const bump = await ctx.db.get<{ next_seq: number }>("UPDATE team_channels SET next_seq = next_seq + 1 WHERE id = ? AND workspace_id = ? RETURNING next_seq", channelId, ws);
    if (!bump) throw notFound("Channel");
    const now = nowIso(ctx);
    await ctx.db.run(
      `INSERT INTO team_messages(id, workspace_id, channel_id, seq, sender_id, sender_name, kind, content, content_text, attachments, meta, created_at) VALUES (?,?,?,?,?,?,'system',?,?, '[]', ?, ?)`,
      id, ws, channelId, bump.next_seq, o.senderId, o.senderName, o.text, o.text, JSON.stringify(o.meta), now,
    );
    await ctx.db.run("UPDATE team_channels SET last_message_at = ?, last_message_seq = ? WHERE id = ?", now, bump.next_seq, channelId);
    return (await ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ?", id))!;
  });
  const ch = (await ctx.db.get<ChannelRow>("SELECT * FROM team_channels WHERE id = ?", channelId))!;
  await emitMessage(ctx, ch, row, "team:message:new");
  return row;
}
export async function updateTeamSystemMessage(ctx: AppContext, messageId: string, ws: string, text: string, meta: Record<string, unknown>): Promise<void> {
  await ctx.db.run("UPDATE team_messages SET content = ?, content_text = ?, meta = ? WHERE id = ? AND workspace_id = ? AND kind = 'system'", text, text, JSON.stringify(meta), messageId, ws);
  const row = await ctx.db.get<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ? AND workspace_id = ?", messageId, ws);
  if (!row) return;
  const ch = await ctx.db.get<ChannelRow>("SELECT * FROM team_channels WHERE id = ?", row.channel_id);
  if (ch) await emitMessage(ctx, ch, row, "team:message:updated");
}

/** Each member gets their own copy (a shared conversation card depends on who looks at it). */
async function emitMessage(ctx: AppContext, c: ChannelRow, row: TeamMessageRow, event: "team:message:new" | "team:message:updated") {
  const members = await listMemberRows(ctx, c.workspace_id);
  const ids = await channelMemberIds(ctx, c.id);
  const ex = await loadExtras(ctx, c.id, [row]);
  const base = messageBase(ctx, row, ex);
  for (const memberId of ids) {
    const mem = members.find((x) => x.id === memberId);
    if (!mem) continue;
    const share = row.kind === "share" ? await shareFor(ctx, actorFromRow(mem), row) : null;
    ctx.bus.toMember(c.workspace_id, memberId, event, { channel_id: c.id, message: { ...base, share } });
  }
}

export async function listTeamMessages(ctx: AppContext, actor: Actor, channelId: string, opts: { before?: string; after?: string; limit: number }) {
  const { channel } = await accessChannel(ctx, actor, channelId);
  if (opts.before && opts.after) throw unprocessable("INVALID_CURSOR", "Use either before or after, not both");
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const rdb = ctx.db.read();
  const base = "channel_id = ? AND thread_root_id IS NULL";
  const seqOf = async (id: string) => {
    const r = await rdb.get<{ seq: number }>("SELECT seq FROM team_messages WHERE id = ? AND channel_id = ?", id, channelId);
    if (!r) throw unprocessable("INVALID_CURSOR", "Cursor message not found in this channel");
    return r.seq;
  };
  let rows: TeamMessageRow[];
  let moreOlder: boolean;
  let moreNewer: boolean;
  if (opts.after) {
    const s = await seqOf(opts.after);
    const got = await rdb.all<TeamMessageRow>(`SELECT * FROM team_messages WHERE ${base} AND deleted_at IS NULL AND seq > ? ORDER BY seq ASC LIMIT ?`, channelId, s, limit + 1);
    moreNewer = got.length > limit;
    rows = got.slice(0, limit);
    moreOlder = !!(await rdb.get("SELECT 1 FROM team_messages WHERE channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL AND seq <= ? LIMIT 1", channelId, s));
  } else {
    const upper = opts.before ? await seqOf(opts.before) : null;
    const got =
      upper === null
        ? await rdb.all<TeamMessageRow>(`SELECT * FROM team_messages WHERE ${base} AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?`, channelId, limit + 1)
        : await rdb.all<TeamMessageRow>(`SELECT * FROM team_messages WHERE ${base} AND deleted_at IS NULL AND seq < ? ORDER BY seq DESC LIMIT ?`, channelId, upper, limit + 1);
    moreOlder = got.length > limit;
    rows = got.slice(0, limit).reverse();
    moreNewer = upper !== null ? !!(await rdb.get("SELECT 1 FROM team_messages WHERE channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL AND seq >= ? LIMIT 1", channelId, upper)) : false;
  }
  void channel;
  return {
    data: await messageDtos(ctx, actor, channelId, rows),
    pagination: { has_more_before: moreOlder, has_more_after: moreNewer, before_cursor: rows[0]?.id ?? null, after_cursor: rows[rows.length - 1]?.id ?? null },
  };
}

export async function getThread(ctx: AppContext, actor: Actor, messageId: string) {
  const root = await findMessage(ctx, actor.workspaceId, messageId);
  if (!root) throw notFound("Message");
  await accessChannel(ctx, actor, root.channel_id);
  if (root.thread_root_id) throw unprocessable("INVALID_THREAD", "Open the thread from its first message");
  const replies = await ctx.db.all<TeamMessageRow>("SELECT * FROM team_messages WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL ORDER BY seq LIMIT ?", root.channel_id, root.id, THREAD_PAGE);
  const dtos = await messageDtos(ctx, actor, root.channel_id, [root, ...replies]);
  return { root: dtos[0]!, replies: dtos.slice(1) };
}

export async function editTeamMessage(ctx: AppContext, actor: Actor, messageId: string, contentRaw: string) {
  const m = await findMessage(ctx, actor.workspaceId, messageId);
  if (!m) throw notFound("Message");
  const { channel } = await accessChannel(ctx, actor, m.channel_id, { write: true });
  if (m.deleted_at) throw notFound("Message");
  if (m.sender_id !== actor.memberId) throw forbidden("You can only edit your own messages");
  if (m.kind === "system") throw unprocessable("NOT_EDITABLE", "This message cannot be edited");
  if (contentRaw.length > MAX_TEAM_CONTENT) throw unprocessable("CONTENT_TOO_LONG", `Messages are limited to ${MAX_TEAM_CONTENT} characters`);
  const content = cleanPlainText(contentRaw).trim();
  if (!content && m.attachments === "[]" && m.kind !== "share") throw unprocessable("EMPTY_MESSAGE", "Message is empty");
  const mentions = await parseTeamMentions(ctx, channel, content);
  const before = new Set((await ctx.db.all<{ member_id: string }>("SELECT member_id FROM team_mentions WHERE message_id = ?", m.id)).map((r) => r.member_id));
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE team_messages SET content = ?, content_text = ?, edited_at = ? WHERE id = ?", content, toSearchText(content), nowIso(ctx), m.id);
    await ctx.db.run("DELETE FROM team_mentions WHERE message_id = ?", m.id);
    for (const id of mentions.ids) await ctx.db.run("INSERT OR IGNORE INTO team_mentions(message_id, member_id, channel_id, workspace_id, seq) VALUES (?,?,?,?,?)", m.id, id, m.channel_id, actor.workspaceId, m.seq);
  });
  const row = (await findMessage(ctx, actor.workspaceId, m.id))!;
  await emitMessage(ctx, channel, row, "team:message:updated");
  // only people newly mentioned by the edit are notified
  const added = { ids: mentions.ids.filter((id) => !before.has(id)), all: false };
  if (added.ids.length) await notifyTeamMessage(ctx, actor, channel, row, added, { mentionsOnly: true });
  return (await messageDtos(ctx, actor, m.channel_id, [row]))[0]!;
}

export async function deleteTeamMessage(ctx: AppContext, actor: Actor, messageId: string, opts: { moderate?: boolean } = {}): Promise<void> {
  const m = await findMessage(ctx, actor.workspaceId, messageId);
  if (!m) throw notFound("Message");
  const { channel } = await accessChannel(ctx, actor, m.channel_id);
  if (m.deleted_at) return;
  const own = m.sender_id === actor.memberId;
  if (!own && !(opts.moderate && can(actor, "team_chat:moderate"))) throw forbidden("You can only delete your own messages");
  if (channel.archived_at && own) throw new AppError(409, "CHANNEL_ARCHIVED", "This channel is archived");
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE team_messages SET deleted_at = ?, deleted_by = ?, pinned_at = NULL, pinned_by = NULL WHERE id = ?", nowIso(ctx), actor.memberId, m.id);
    await ctx.db.run("DELETE FROM team_mentions WHERE message_id = ?", m.id);
  });
  if (!own) await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "team.message_moderated", target: m.id, detail: { channel_id: m.channel_id } });
  await emitToChannel(ctx, channel, "team:message:deleted", { channel_id: m.channel_id, message_id: m.id, thread_root_id: m.thread_root_id });
}

export async function toggleReaction(ctx: AppContext, actor: Actor, messageId: string, emoji: string) {
  const m = await findMessage(ctx, actor.workspaceId, messageId);
  if (!m || m.deleted_at) throw notFound("Message");
  const { channel } = await accessChannel(ctx, actor, m.channel_id, { write: true });
  const clean = emoji.trim();
  if (!clean || clean.length > 32 || /[\s<>\u0000-\u001f]/.test(clean)) throw unprocessable("INVALID_EMOJI", "Pick an emoji");
  const has = await ctx.db.get("SELECT 1 FROM team_reactions WHERE message_id = ? AND member_id = ? AND emoji = ?", m.id, actor.memberId, clean);
  if (has) await ctx.db.run("DELETE FROM team_reactions WHERE message_id = ? AND member_id = ? AND emoji = ?", m.id, actor.memberId, clean);
  else {
    const kinds = (await ctx.db.get<{ n: number }>("SELECT COUNT(DISTINCT emoji) AS n FROM team_reactions WHERE message_id = ?", m.id))!.n;
    const exists = await ctx.db.get("SELECT 1 FROM team_reactions WHERE message_id = ? AND emoji = ?", m.id, clean);
    if (!exists && Number(kinds) >= MAX_REACTION_KINDS) throw unprocessable("TOO_MANY_REACTIONS", `A message can carry ${MAX_REACTION_KINDS} different reactions`);
    await ctx.db.run("INSERT OR IGNORE INTO team_reactions(message_id, member_id, emoji, channel_id, workspace_id, created_at) VALUES (?,?,?,?,?,?)", m.id, actor.memberId, clean, m.channel_id, actor.workspaceId, nowIso(ctx));
  }
  const ex = await loadExtras(ctx, m.channel_id, [m]);
  const reactions = (ex.reactions.get(m.id) ?? []).map((r) => ({ emoji: r.emoji, count: r.member_ids.length, member_ids: r.member_ids }));
  await emitToChannel(ctx, channel, "team:reaction", { channel_id: m.channel_id, message_id: m.id, reactions });
  return { added: !has, reactions };
}

export async function setPinned(ctx: AppContext, actor: Actor, messageId: string, pinned: boolean) {
  const m = await findMessage(ctx, actor.workspaceId, messageId);
  if (!m || m.deleted_at) throw notFound("Message");
  const { channel } = await accessChannel(ctx, actor, m.channel_id, { write: true });
  if (m.thread_root_id) throw unprocessable("NOT_PINNABLE", "Pin the first message of a thread instead");
  await ctx.db.run("UPDATE team_messages SET pinned_at = ?, pinned_by = ? WHERE id = ?", pinned ? (m.pinned_at ?? nowIso(ctx)) : null, pinned ? actor.memberId : null, m.id);
  await emitMessage(ctx, channel, (await findMessage(ctx, actor.workspaceId, m.id))!, "team:message:updated");
  return (await messageDtos(ctx, actor, m.channel_id, [(await findMessage(ctx, actor.workspaceId, m.id))!]))[0]!;
}

export async function listPins(ctx: AppContext, actor: Actor, channelId: string) {
  await accessChannel(ctx, actor, channelId);
  const rows = await ctx.db.all<TeamMessageRow>("SELECT * FROM team_messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC LIMIT 50", channelId);
  return { data: await messageDtos(ctx, actor, channelId, rows) };
}

/** Move the read cursor forward (never back) up to a message of the channel. */
export async function markTeamRead(ctx: AppContext, actor: Actor, channelId: string, messageId?: string) {
  const { channel, membership } = await accessChannel(ctx, actor, channelId);
  if (!membership) return { moved: false, last_read_seq: 0 };
  let seq = channel.last_message_seq;
  if (messageId) {
    const m = await ctx.db.get<{ seq: number }>("SELECT seq FROM team_messages WHERE id = ? AND channel_id = ?", messageId, channelId);
    if (!m) throw unprocessable("INVALID_CURSOR", "Message not found in this channel");
    seq = Math.min(m.seq, channel.last_message_seq);
  }
  const res = await ctx.db.run("UPDATE team_channel_members SET last_read_seq = ? WHERE channel_id = ? AND member_id = ? AND last_read_seq < ?", seq, channelId, actor.memberId, seq);
  if (res.changes) {
    const payload = { channel_id: channelId, member_id: actor.memberId, seq };
    if (channel.kind === "channel") ctx.bus.toMember(actor.workspaceId, actor.memberId, "team:read", payload);
    else await emitToChannel(ctx, channel, "team:read", payload);
  }
  return { moved: res.changes > 0, last_read_seq: Math.max(seq, membership.last_read_seq) };
}

/** Messages containing `q` in the channels this actor can see (their own, plus public ones), newest first. */
export async function searchTeam(ctx: AppContext, actor: Actor, q: { q: string; channel_id?: string; limit: number }) {
  use(actor);
  await enforceTeamSearch(ctx, actor);
  const like = `%${q.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const rows = await ctx.db.read().all<TeamMessageRow & { channel_name: string | null; channel_kind: string }>(
    `SELECT m.*, c.name AS channel_name, c.kind AS channel_kind FROM team_messages m JOIN team_channels c ON c.id = m.channel_id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.kind != 'system' AND m.content_text ${ctx.db.ilike} ? ESCAPE '\\'
        AND (c.visibility = 'public' OR EXISTS (SELECT 1 FROM team_channel_members cm WHERE cm.channel_id = c.id AND cm.member_id = ?))
        ${q.channel_id ? "AND m.channel_id = ?" : ""}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    actor.workspaceId,
    like,
    actor.memberId,
    ...(q.channel_id ? [q.channel_id] : []),
    Math.min(q.limit, 50),
  );
  const names = new Map((await listMemberRows(ctx, actor.workspaceId)).map((m) => [m.id, m.name]));
  const out = [];
  for (const r of rows) {
    const dto = (await messageDtos(ctx, actor, r.channel_id, [r]))[0]!;
    const memberIds = r.channel_kind === "channel" ? [] : await channelMemberIds(ctx, r.channel_id);
    out.push({ ...dto, channel: { id: r.channel_id, kind: r.channel_kind, name: r.channel_name, title: r.channel_kind === "channel" ? r.channel_name : memberIds.filter((x) => x !== actor.memberId).map((x) => names.get(x) ?? "Former member").join(", ") || "You" } });
  }
  return { data: out };
}

async function enforceTeamSearch(ctx: AppContext, actor: Actor) {
  const { enforce } = await import("../ratelimit/http.js");
  await enforce(ctx, "team.search", { key: actor.memberId, workspaceId: actor.workspaceId });
}

/* ------------------------------------------------------------------ notifications */

async function notifyTeamMessage(ctx: AppContext, actor: Actor, c: ChannelRow, m: TeamMessageRow, mentions: { ids: string[]; all: boolean }, opts: { mentionsOnly?: boolean } = {}): Promise<void> {
  const members = await listMemberRows(ctx, c.workspace_id);
  const mentioned = new Set(mentions.ids);
  const memberships = await ctx.db.all<ChannelMemberRow>("SELECT * FROM team_channel_members WHERE channel_id = ?", c.id);
  const channelLabel = c.kind === "channel" ? `#${c.name}` : "a direct message";
  const text = snippet(m.content_text || (m.attachments !== "[]" ? "Sent an attachment" : m.kind === "share" ? "Shared a conversation" : ""), 140);
  for (const ms of memberships) {
    if (ms.member_id === actor.memberId) continue;
    const mem = members.find((x) => x.id === ms.member_id);
    if (!mem) continue;
    const isMention = mentioned.has(mem.id);
    const explicit = isMention && !mentions.all; // @name, as opposed to @channel
    const direct = c.kind !== "channel" && !opts.mentionsOnly;
    let type: "team_mention" | "team_dm" | null = null;
    if (isMention) type = prefsOf(mem).mentions ? "team_mention" : null;
    if (!type && direct && prefsOf(mem).team_messages) type = "team_dm";
    if (!type) continue;
    // a muted channel is quiet, except for being mentioned by name
    if (ms.muted && !explicit) continue;
    const title = type === "team_mention" ? `${actor.name} mentioned you in ${channelLabel}` : `${actor.name} sent you a message`;
    const id = newId("ntf");
    const res = await ctx.db.run(
      "INSERT OR IGNORE INTO notifications(id, workspace_id, member_id, type, room_id, message_id, channel_id, title, body, created_at) VALUES (?,?,?,?,NULL,?,?,?,?,?)",
      id,
      c.workspace_id,
      mem.id,
      type,
      m.id,
      c.id,
      title,
      text,
      nowIso(ctx),
    );
    if (!res.changes) continue;
    const { notificationDto, unreadNotificationCount, canEmail } = await import("./notifications.js");
    const row = (await ctx.db.get<Parameters<typeof notificationDto>[0] & { channel_id: string | null }>("SELECT * FROM notifications WHERE id = ?", id))!;
    ctx.bus.toMember(c.workspace_id, mem.id, "notification:new", { notification: notificationDto(row), unread_count: await unreadNotificationCount(ctx, mem.id) });
    // offline, not in do-not-disturb, and wants email: the same rule as for customer conversations
    if (!isDnd(ctx, mem) && (await canEmail(ctx, mem))) await enqueueJob(ctx, "notify_email", { notification_id: id }, { dedupeKey: `notify_email:${id}` });
  }
}

/* ------------------------------------------------------------------ retention */

/** Team chat has its own retention: `team_retention_days` per workspace (0 = keep), and soft-deleted messages are removed for good after 30 days. */
export async function teamRetentionSweep(ctx: AppContext, opts: { now?: Date } = {}): Promise<{ deleted: number }> {
  const now = opts.now ?? ctx.clock();
  let deleted = 0;
  const purgeBefore = new Date(now.getTime() - 30 * 86400_000).toISOString();
  deleted += (await ctx.db.run("DELETE FROM team_messages WHERE deleted_at IS NOT NULL AND deleted_at < ?", purgeBefore)).changes;
  const { getSettings } = await import("./workspaces.js");
  const wss = await ctx.db.all<{ id: string }>("SELECT id FROM workspaces");
  for (const w of wss) {
    const days = (await getSettings(ctx, w.id)).team_retention_days;
    if (!days) continue;
    const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
    deleted += (await ctx.db.run("DELETE FROM team_messages WHERE workspace_id = ? AND created_at < ? AND pinned_at IS NULL", w.id, cutoff)).changes;
  }
  return { deleted };
}

export type { MemberRow };
export { memberScope };
