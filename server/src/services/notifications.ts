import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { seesAll, type Actor, type NotificationPrefs } from "../domain/types.js";
import { notFound } from "../errors.js";
import { enqueueJob } from "../jobs/queue.js";
import { newId } from "../util/ids.js";
import { snippet } from "../util/html.js";
import { getContact } from "./contacts.js";
import { memberIds } from "./inboxes.js";
import { isDnd, listMemberRows, memberScope, prefsOf, type MemberRow } from "./members.js";
import type { MessageRow } from "./messageStore.js";
import { assigneeIds, type RoomRow } from "./roomStore.js";
import { notifyPush } from "../push/service.js";

export type Tier = "assigned_to_you" | "assigned_to_your_team" | "unassigned";
const TIER_ORDER: Tier[] = ["assigned_to_you", "assigned_to_your_team", "unassigned"];

export interface Recipient {
  member: MemberRow;
  tier: Tier;
}

const isSnoozed = (ctx: AppContext, room: RoomRow) => !!room.snooze_until && room.snooze_until > nowIso(ctx);

/**
 * Who should hear about a new contact message. Each seat gets at most one tier (the most specific):
 *  assigned_to_you  - the seat is an assignee
 *  assigned_to_your_team - the seat belongs to the room's inbox
 *  unassigned       - owners/managers, only while nobody is assigned
 * Per-seat preferences can switch a tier off. Snoozed rooms notify nobody.
 */
export async function selectRecipients(ctx: AppContext, room: RoomRow, opts: { excludeMemberId?: string | null } = {}): Promise<Recipient[]> {
  if (isSnoozed(ctx, room)) return [];
  const members = (await listMemberRows(ctx, room.workspace_id)).filter((m) => m.live_seat && m.availability !== "inactive" && m.id !== opts.excludeMemberId);
  const assignees = new Set(await assigneeIds(ctx, room.id));
  const team = new Set(room.inbox_id ? await memberIds(ctx, room.inbox_id) : []);
  const chosen = new Map<string, Recipient>();
  for (const m of members) {
    let tier: Tier | null = null;
    if (assignees.has(m.id)) tier = "assigned_to_you";
    else if (team.has(m.id)) tier = "assigned_to_your_team";
    else if (!assignees.size && seesAll({ role: m.role })) tier = "unassigned";
    if (!tier) continue;
    if (!prefsOf(m)[tier]) continue;
    const prev = chosen.get(m.id);
    if (!prev || TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(prev.tier)) chosen.set(m.id, { member: m, tier });
  }
  return [...chosen.values()];
}

export const canEmail = async (ctx: AppContext, m: MemberRow): Promise<boolean> =>
  prefsOf(m).email && !isDnd(ctx, m) && !(await ctx.presence.isOnline(memberScope(m.workspace_id), m.id));

interface NotificationRow {
  id: string;
  type: string;
  room_id: string | null;
  message_id: string | null;
  /** set on team chat notifications: the channel to open instead of a conversation */
  channel_id?: string | null;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

/** Only what the client needs: no workspace/seat ids, no email bookkeeping. */
export const notificationDto = (n: NotificationRow) => ({
  id: n.id,
  type: n.type,
  room_id: n.room_id,
  message_id: n.message_id,
  channel_id: n.channel_id ?? null,
  title: n.title,
  body: n.body,
  read_at: n.read_at,
  created_at: n.created_at,
});

async function create(ctx: AppContext, m: MemberRow, n: { type: string; room: RoomRow; message: MessageRow; title: string; body: string }): Promise<string | null> {
  const id = newId("ntf");
  const res = await ctx.db.run(
    "INSERT OR IGNORE INTO notifications(id, workspace_id, member_id, type, room_id, message_id, title, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id,
    m.workspace_id,
    m.id,
    n.type,
    n.room.id,
    n.message.id,
    n.title,
    n.body,
    nowIso(ctx),
  );
  if (!res.changes) return null;
  ctx.bus.toMember(m.workspace_id, m.id, "notification:new", {
    notification: notificationDto((await ctx.db.get<NotificationRow>("SELECT * FROM notifications WHERE id = ?", id))!),
    unread_count: await unreadNotificationCount(ctx, m.id),
  });
  return id;
}

/** In-app feed entry for every selected seat; an offline-email job for assignees who are away from the app. */
export async function notifyContactMessage(ctx: AppContext, room: RoomRow, message: MessageRow): Promise<void> {
  const contact = await getContact(ctx, room.workspace_id, room.contact_id);
  const who = contact.name || contact.email || contact.phone || "A contact";
  for (const r of await selectRecipients(ctx, room)) {
    const id = await create(ctx, r.member, { type: "message", room, message, title: `New message from ${who}`, body: snippet(message.content_text, 140) });
    if (id && r.tier === "assigned_to_you" && (await canEmail(ctx, r.member))) {
      await enqueueJob(ctx, "notify_email", { notification_id: id }, { dedupeKey: `notify_email:${id}` });
    }
    // push to the assignee's devices when the app is closed; the text only when the workspace allows previews
    if (id && r.tier === "assigned_to_you") await notifyPush(ctx, r.member, "message", { title: "New customer message", body: "A customer wrote in a conversation assigned to you.", url: `/inbox/${room.id}`, tag: `msg-${room.id}`, key: message.id, preview: `${who}: ${snippet(message.content_text, 120)}` });
  }
}

export async function notifyMentions(ctx: AppContext, room: RoomRow, message: MessageRow, actor: Actor, memberIds_: string[]): Promise<void> {
  const members = await listMemberRows(ctx, room.workspace_id);
  for (const id of memberIds_) {
    const m = members.find((x) => x.id === id);
    if (!m || m.id === actor.memberId || !prefsOf(m).mentions) continue;
    const nid = await create(ctx, m, { type: "mention", room, message, title: `${actor.name} mentioned you`, body: snippet(message.content_text, 140) });
    if (nid && (await canEmail(ctx, m))) await enqueueJob(ctx, "notify_email", { notification_id: nid }, { dedupeKey: `notify_email:${nid}` });
  }
}

/** In-app entry about a ticket (assigned to you, waiting for a person, a missed service level) and, when asked, the usual offline email. */
export async function notifyTicket(ctx: AppContext, m: MemberRow, n: { type: string; room: RoomRow; title: string; body: string; email: boolean }): Promise<void> {
  const id = newId("ntf");
  await ctx.db.run(
    "INSERT INTO notifications(id, workspace_id, member_id, type, room_id, message_id, title, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id,
    m.workspace_id,
    m.id,
    n.type,
    n.room.id,
    null,
    n.title,
    n.body,
    nowIso(ctx),
  );
  ctx.bus.toMember(m.workspace_id, m.id, "notification:new", {
    notification: notificationDto((await ctx.db.get<NotificationRow>("SELECT * FROM notifications WHERE id = ?", id))!),
    unread_count: await unreadNotificationCount(ctx, m.id),
  });
  if (n.email && (await canEmail(ctx, m))) await enqueueJob(ctx, "notify_email", { notification_id: id }, { dedupeKey: `notify_email:${id}` });
  if (n.type === "ticket_assigned") await notifyPush(ctx, m, "assigned", { title: "Assigned to you", body: "A conversation was assigned to you.", url: `/inbox/${n.room.id}`, tag: `assigned-${n.room.id}`, key: id, preview: n.title });
}

/** Tell the seat that snoozed a room that it is back. */
export async function notifySnoozeEnded(ctx: AppContext, room: RoomRow, snoozedBy: string | null): Promise<void> {
  if (!snoozedBy) return;
  const m = (await listMemberRows(ctx, room.workspace_id)).find((x) => x.id === snoozedBy);
  const last = room.last_message_id ? await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND id = ?", room.id, room.last_message_id) : undefined;
  if (!m || !last) return;
  await create(ctx, m, { type: "snooze_ended", room, message: last, title: "Snoozed conversation is back", body: snippet(last.content_text, 140) });
}

/** Job handler: re-check presence/DND at send time, then email. */
export async function sendNotificationEmail(ctx: AppContext, payload: { notification_id: string }): Promise<void> {
  const n = await ctx.db.get<{ id: string; workspace_id: string; member_id: string; title: string; body: string; room_id: string | null; channel_id: string | null; emailed_at: string | null }>(
    "SELECT * FROM notifications WHERE id = ?",
    payload.notification_id,
  );
  if (!n || n.emailed_at) return;
  const m = (await listMemberRows(ctx, n.workspace_id)).find((x) => x.id === n.member_id);
  if (!m || !(await canEmail(ctx, m))) return;
  const room = n.room_id ? await ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ?", n.room_id) : undefined;
  if (room && isSnoozed(ctx, room)) return;
  const link = n.channel_id ? `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/team/${n.channel_id}` : `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/inbox/${n.room_id ?? ""}`;
  await ctx.email.send({
    from: { address: ctx.config.SYSTEM_EMAIL_FROM, name: "Conversations" },
    to: m.email,
    subject: n.title,
    text: `${n.body}\n\n${n.channel_id ? "Open the chat" : "Open the conversation"}: ${link}`,
    html: `<p>${escape(n.body)}</p><p><a href="${link}">${n.channel_id ? "Open the chat" : "Open the conversation"}</a></p>`,
    messageId: `<${newId("n")}@${ctx.config.SYSTEM_EMAIL_FROM.split("@")[1] ?? "localhost"}>`,
  });
  await ctx.db.run("UPDATE notifications SET emailed_at = ? WHERE id = ?", nowIso(ctx), n.id);
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const unreadNotificationCount = async (ctx: AppContext, memberId: string): Promise<number> =>
  (await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE member_id = ? AND read_at IS NULL", memberId))!.n;

export async function listNotifications(ctx: AppContext, actor: Actor, q: { unread_only?: boolean; limit: number; before?: string }) {
  const rows = await ctx.db.read().all<NotificationRow>(
    `SELECT * FROM notifications WHERE member_id = ? ${q.unread_only ? "AND read_at IS NULL" : ""} ${q.before ? "AND created_at < ?" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    actor.memberId,
    ...(q.before ? [q.before] : []),
    q.limit,
  );
  return { data: rows.map(notificationDto), unread_count: await unreadNotificationCount(ctx, actor.memberId) };
}

export async function markNotificationRead(ctx: AppContext, actor: Actor, id: string) {
  const res = await ctx.db.run("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND member_id = ?", nowIso(ctx), id, actor.memberId);
  if (!res.changes) throw notFound("Notification");
  const unread = await unreadNotificationCount(ctx, actor.memberId);
  ctx.bus.toMember(actor.workspaceId, actor.memberId, "notification:read", { id, unread_count: unread });
  return { unread_count: unread };
}

export async function markAllNotificationsRead(ctx: AppContext, actor: Actor) {
  await ctx.db.run("UPDATE notifications SET read_at = ? WHERE member_id = ? AND read_at IS NULL", nowIso(ctx), actor.memberId);
  ctx.bus.toMember(actor.workspaceId, actor.memberId, "notification:read", { all: true, unread_count: 0 });
  return { unread_count: 0 };
}

export type { NotificationPrefs };
