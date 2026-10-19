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
export function selectRecipients(ctx: AppContext, room: RoomRow, opts: { excludeMemberId?: string | null } = {}): Recipient[] {
  if (isSnoozed(ctx, room)) return [];
  const members = listMemberRows(ctx, room.workspace_id).filter((m) => m.live_seat && m.availability !== "inactive" && m.id !== opts.excludeMemberId);
  const assignees = new Set(assigneeIds(ctx, room.id));
  const team = new Set(room.inbox_id ? memberIds(ctx, room.inbox_id) : []);
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

export const canEmail = (ctx: AppContext, m: MemberRow): boolean =>
  prefsOf(m).email && !isDnd(ctx, m) && !ctx.presence.isOnline(memberScope(m.workspace_id), m.id);

interface NotificationRow {
  id: string;
  type: string;
  room_id: string | null;
  message_id: string | null;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

/** Only what the client needs: no workspace/seat ids, no email bookkeeping. */
export const notificationDto = (n: NotificationRow) => ({
  id: n.id, type: n.type, room_id: n.room_id, message_id: n.message_id, title: n.title, body: n.body, read_at: n.read_at, created_at: n.created_at,
});

function create(ctx: AppContext, m: MemberRow, n: { type: string; room: RoomRow; message: MessageRow; title: string; body: string }): string | null {
  const id = newId("ntf");
  const res = ctx.db.run(
    "INSERT OR IGNORE INTO notifications(id, workspace_id, member_id, type, room_id, message_id, title, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, m.workspace_id, m.id, n.type, n.room.id, n.message.id, n.title, n.body, nowIso(ctx),
  );
  if (!res.changes) return null;
  ctx.bus.toMember(m.workspace_id, m.id, "notification:new", {
    notification: notificationDto(ctx.db.get<NotificationRow>("SELECT * FROM notifications WHERE id = ?", id)!),
    unread_count: unreadNotificationCount(ctx, m.id),
  });
  return id;
}

/** In-app feed entry for every selected seat; an offline-email job for assignees who are away from the app. */
export function notifyContactMessage(ctx: AppContext, room: RoomRow, message: MessageRow): void {
  const contact = getContact(ctx, room.workspace_id, room.contact_id);
  const who = contact.name || contact.email || contact.phone || "A contact";
  for (const r of selectRecipients(ctx, room)) {
    const id = create(ctx, r.member, { type: "message", room, message, title: `New message from ${who}`, body: snippet(message.content_text, 140) });
    if (id && r.tier === "assigned_to_you" && canEmail(ctx, r.member)) {
      enqueueJob(ctx, "notify_email", { notification_id: id }, { dedupeKey: `notify_email:${id}` });
    }
  }
}

export function notifyMentions(ctx: AppContext, room: RoomRow, message: MessageRow, actor: Actor, memberIds_: string[]): void {
  const members = listMemberRows(ctx, room.workspace_id);
  for (const id of memberIds_) {
    const m = members.find((x) => x.id === id);
    if (!m || m.id === actor.memberId || !prefsOf(m).mentions) continue;
    const nid = create(ctx, m, { type: "mention", room, message, title: `${actor.name} mentioned you`, body: snippet(message.content_text, 140) });
    if (nid && canEmail(ctx, m)) enqueueJob(ctx, "notify_email", { notification_id: nid }, { dedupeKey: `notify_email:${nid}` });
  }
}

/** Tell the seat that snoozed a room that it is back. */
export function notifySnoozeEnded(ctx: AppContext, room: RoomRow, snoozedBy: string | null): void {
  if (!snoozedBy) return;
  const m = listMemberRows(ctx, room.workspace_id).find((x) => x.id === snoozedBy);
  const last = room.last_message_id ? ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", room.last_message_id) : undefined;
  if (!m || !last) return;
  create(ctx, m, { type: "snooze_ended", room, message: last, title: "Snoozed conversation is back", body: snippet(last.content_text, 140) });
}

/** Job handler: re-check presence/DND at send time, then email. */
export async function sendNotificationEmail(ctx: AppContext, payload: { notification_id: string }): Promise<void> {
  const n = ctx.db.get<{ id: string; workspace_id: string; member_id: string; title: string; body: string; room_id: string | null; emailed_at: string | null }>(
    "SELECT * FROM notifications WHERE id = ?", payload.notification_id,
  );
  if (!n || n.emailed_at) return;
  const m = listMemberRows(ctx, n.workspace_id).find((x) => x.id === n.member_id);
  if (!m || !canEmail(ctx, m)) return;
  const room = n.room_id ? ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ?", n.room_id) : undefined;
  if (room && isSnoozed(ctx, room)) return;
  const link = `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/inbox/${n.room_id ?? ""}`;
  await ctx.email.send({
    from: { address: ctx.config.SYSTEM_EMAIL_FROM, name: "Conversations" },
    to: m.email,
    subject: n.title,
    text: `${n.body}\n\nOpen the conversation: ${link}`,
    html: `<p>${escape(n.body)}</p><p><a href="${link}">Open the conversation</a></p>`,
    messageId: `<${newId("n")}@${ctx.config.SYSTEM_EMAIL_FROM.split("@")[1] ?? "localhost"}>`,
  });
  ctx.db.run("UPDATE notifications SET emailed_at = ? WHERE id = ?", nowIso(ctx), n.id);
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const unreadNotificationCount = (ctx: AppContext, memberId: string): number =>
  ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE member_id = ? AND read_at IS NULL", memberId)!.n;

export function listNotifications(ctx: AppContext, actor: Actor, q: { unread_only?: boolean; limit: number; before?: string }) {
  const rows = ctx.db.all<NotificationRow>(
    `SELECT * FROM notifications WHERE member_id = ? ${q.unread_only ? "AND read_at IS NULL" : ""} ${q.before ? "AND created_at < ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    actor.memberId, ...(q.before ? [q.before] : []), q.limit,
  );
  return { data: rows.map(notificationDto), unread_count: unreadNotificationCount(ctx, actor.memberId) };
}

export function markNotificationRead(ctx: AppContext, actor: Actor, id: string) {
  const res = ctx.db.run("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND member_id = ?", nowIso(ctx), id, actor.memberId);
  if (!res.changes) throw notFound("Notification");
  const unread = unreadNotificationCount(ctx, actor.memberId);
  ctx.bus.toMember(actor.workspaceId, actor.memberId, "notification:read", { id, unread_count: unread });
  return { unread_count: unread };
}

export function markAllNotificationsRead(ctx: AppContext, actor: Actor) {
  ctx.db.run("UPDATE notifications SET read_at = ? WHERE member_id = ? AND read_at IS NULL", nowIso(ctx), actor.memberId);
  ctx.bus.toMember(actor.workspaceId, actor.memberId, "notification:read", { all: true, unread_count: 0 });
  return { unread_count: 0 };
}

export type { NotificationPrefs };
