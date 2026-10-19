import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation, type Param } from "../db/index.js";
import { seesAll, type Actor } from "../domain/types.js";
import { AppError, forbidden, notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { addFollower, contactBrief, findContact, getContact, normalizeTags, type ContactInput, type ContactRow, findOrCreateContact } from "./contacts.js";
import { findInbox, nextRoundRobinAssignee } from "./inboxes.js";
import { findMember } from "./members.js";
import {
  emitMessage,
  lastMessageBrief,
  postSystemMessage,
  type MessageRow,
} from "./messageStore.js";
import { assigneeIds, canSeeRoom, getRoomRow, getVisibleRoom, roomVisibility, type RoomRow } from "./roomStore.js";

export type RoomSort = "newest" | "oldest" | "waiting_longest" | "priority_first";
export type RoomStatusFilter = "open" | "closed" | "snoozed" | "all";

export interface RoomFilters {
  status?: RoomStatusFilter;
  assigned_to_me?: boolean;
  unassigned?: boolean;
  mentions?: boolean;
  priority?: boolean;
  favorites?: boolean;
  inbox_id?: string;
  contact_id?: string;
  search?: string;
  sort?: RoomSort;
  page: number;
  limit: number;
}

/** Computed from the seat's read cursor; never stored. Excludes notes, system lines, the viewer's own messages. */
const unreadSql = `(SELECT COUNT(*) FROM messages um WHERE um.room_id = r.id AND um.seq > COALESCE(rr.last_read_seq, 0)
    AND um.deleted_at IS NULL AND um.kind NOT IN ('note','system') AND um.sender_type != 'system'
    AND NOT (um.sender_type = 'agent' AND um.sender_id = ?)
    AND (NOT EXISTS (SELECT 1 FROM room_assignees ua WHERE ua.room_id = r.id)
         OR EXISTS (SELECT 1 FROM room_assignees ub WHERE ub.room_id = r.id AND ub.member_id = ?)))`;

const waitingSql = `(SELECT MIN(wm.created_at) FROM messages wm WHERE wm.room_id = r.id AND wm.sender_type = 'contact' AND wm.deleted_at IS NULL
    AND wm.seq > COALESCE((SELECT MAX(wa.seq) FROM messages wa WHERE wa.room_id = r.id AND wa.sender_type = 'agent' AND wa.kind != 'note' AND wa.deleted_at IS NULL), 0))`;

const activity = "COALESCE(r.last_message_at, r.created_at)";

type ListRow = RoomRow & { unread_count: number; favorite: number; waiting_since: string | null };

export function unreadCount(ctx: AppContext, roomId: string, memberId: string): number {
  return ctx.db.get<{ n: number }>(
    `SELECT ${unreadSql} AS n FROM rooms r LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.member_id = ? WHERE r.id = ?`,
    memberId, memberId, memberId, roomId,
  )?.n ?? 0;
}

function hydrate(ctx: AppContext, rows: (RoomRow & Partial<ListRow>)[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const assignees = new Map<string, string[]>();
  for (const a of ctx.db.all<{ room_id: string; member_id: string }>(`SELECT room_id, member_id FROM room_assignees WHERE room_id IN (${marks}) ORDER BY added_at, member_id`, ...ids)) {
    assignees.set(a.room_id, [...(assignees.get(a.room_id) ?? []), a.member_id]);
  }
  const contacts = new Map(
    ctx.db.all<ContactRow>(`SELECT * FROM contacts WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.contact_id)).map((c) => [c.id, c]),
  );
  const lastIds = rows.map((r) => r.last_message_id).filter((v): v is string => !!v);
  const lasts = new Map(
    lastIds.length ? ctx.db.all<MessageRow>(`SELECT * FROM messages WHERE id IN (${lastIds.map(() => "?").join(",")})`, ...lastIds).map((m) => [m.id, m]) : [],
  );
  return rows.map((r) => {
    const last = r.last_message_id ? lasts.get(r.last_message_id) : undefined;
    const c = contacts.get(r.contact_id);
    return {
      id: r.id,
      contact: c ? contactBrief(c) : null,
      contact_id: r.contact_id,
      inbox_id: r.inbox_id,
      assignee_ids: assignees.get(r.id) ?? [],
      status: r.status,
      priority: r.priority,
      snooze_until: r.snooze_until,
      snoozed_by: r.snoozed_by,
      subject: r.subject,
      room_type: r.room_type,
      verified_session: !!r.session_id,
      last_message: last && !last.deleted_at ? lastMessageBrief(last) : null,
      last_message_at: r.last_message_at,
      last_contact_message_at: r.last_contact_message_at,
      waiting_since: r.waiting_since ?? null,
      unread_count: r.unread_count ?? 0,
      favorite: !!r.favorite,
      bot_paused: !!r.bot_paused,
      triage: parseJson<Record<string, unknown>>(r.meta, {}),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
}

export type RoomDto = ReturnType<typeof hydrate>[number];

/** Viewer-independent snapshot used in socket broadcasts (no unread count / favorite). */
export function roomBaseDto(ctx: AppContext, room: RoomRow): RoomDto {
  return hydrate(ctx, [room])[0]!;
}

function selectRooms(ctx: AppContext, actor: Actor, where: string[], params: Param[], orderBy: string, limit: number, offset: number): ListRow[] {
  const vis = roomVisibility(actor);
  return ctx.db.all<ListRow>(
    `SELECT r.*, ${unreadSql} AS unread_count,
       EXISTS (SELECT 1 FROM room_favorites f WHERE f.room_id = r.id AND f.member_id = ?) AS favorite,
       ${waitingSql} AS waiting_since
     FROM rooms r JOIN contacts c ON c.id = r.contact_id
     LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.member_id = ?
     WHERE r.workspace_id = ? AND r.archived = 0 AND ${vis.sql} ${where.length ? "AND " + where.join(" AND ") : ""}
     ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    actor.memberId, actor.memberId, actor.memberId, actor.memberId, actor.workspaceId, ...vis.params, ...params, limit, offset,
  );
}

const ORDER: Record<RoomSort, string> = {
  newest: `${activity} DESC, r.id DESC`,
  oldest: `${activity} ASC, r.id ASC`,
  priority_first: `r.priority DESC, ${activity} DESC, r.id DESC`,
  // customers waiting longest for a reply first; rooms nobody is waiting on sink to the bottom
  waiting_longest: `(waiting_since IS NULL) ASC, waiting_since ASC, ${activity} DESC, r.id DESC`,
};

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;

export function listRooms(ctx: AppContext, actor: Actor, f: RoomFilters) {
  const where: string[] = [];
  const params: Param[] = [];
  const now = nowIso(ctx);
  const status = f.status ?? "open";
  if (status === "open") {
    where.push("r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?)");
    params.push(now);
  } else if (status === "closed") where.push("r.status = 'closed'");
  else if (status === "snoozed") {
    where.push("r.status = 'open' AND r.snooze_until > ?");
    params.push(now);
  }
  if (f.assigned_to_me) {
    where.push("EXISTS (SELECT 1 FROM room_assignees fa WHERE fa.room_id = r.id AND fa.member_id = ?)");
    params.push(actor.memberId);
  }
  if (f.unassigned) where.push("NOT EXISTS (SELECT 1 FROM room_assignees fu WHERE fu.room_id = r.id)");
  if (f.mentions) {
    where.push("EXISTS (SELECT 1 FROM message_mentions mm JOIN messages mmm ON mmm.id = mm.message_id WHERE mm.room_id = r.id AND mm.member_id = ? AND mmm.deleted_at IS NULL)");
    params.push(actor.memberId);
  }
  if (f.priority) where.push("r.priority = 1");
  if (f.favorites) {
    where.push("EXISTS (SELECT 1 FROM room_favorites ff WHERE ff.room_id = r.id AND ff.member_id = ?)");
    params.push(actor.memberId);
  }
  if (f.inbox_id) {
    where.push("r.inbox_id = ?");
    params.push(f.inbox_id);
  }
  if (f.contact_id) {
    where.push("r.contact_id = ?");
    params.push(f.contact_id);
  }
  if (f.search?.trim()) {
    const l = like(f.search.trim());
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR r.subject LIKE ? ESCAPE '\\')");
    params.push(l, l, l, l);
  }
  const rows = selectRooms(ctx, actor, where, params, ORDER[f.sort ?? "newest"], f.limit + 1, (f.page - 1) * f.limit);
  const hasMore = rows.length > f.limit;
  return { data: hydrate(ctx, rows.slice(0, f.limit)), pagination: { page: f.page, limit: f.limit, has_more: hasMore } };
}

export function getRoomDto(ctx: AppContext, actor: Actor, roomId: string): RoomDto {
  getVisibleRoom(ctx, actor, roomId);
  const rows = selectRooms(ctx, actor, ["r.id = ?"], [roomId], "r.id", 1, 0);
  if (!rows[0]) throw notFound("Room");
  return hydrate(ctx, rows)[0]!;
}

/** Re-point socket membership, then tell everyone who can see the room. `lost` seats get room:deleted. */
export function publishRoomUpdated(ctx: AppContext, room: RoomRow, opts: { lost?: string[]; created?: boolean; newlyVisible?: string[] } = {}): void {
  const fresh = getRoomRow(ctx, room.workspace_id, room.id);
  const dto = roomBaseDto(ctx, fresh);
  for (const m of opts.lost ?? []) ctx.bus.toMember(fresh.workspace_id, m, "room:deleted", { room_id: fresh.id });
  ctx.bus.refreshRoomAccess(fresh.workspace_id, fresh.id);
  for (const m of opts.newlyVisible ?? []) ctx.bus.toMember(fresh.workspace_id, m, "room:new", { room: dto });
  if (opts.created) {
    ctx.bus.toRoom(fresh.workspace_id, fresh.id, "room:new", { room: dto });
  } else {
    ctx.bus.toRoom(fresh.workspace_id, fresh.id, "room:updated", { room: dto }, { visitor: { room: { id: fresh.id, status: fresh.status } } });
  }
}

export interface CreateRoomInput {
  contactId: string;
  inboxId?: string | null;
  sessionId?: string | null;
  roomType?: "inbound" | "outbound";
  subject?: string | null;
}

/**
 * One live room per contact. The partial unique index is the arbiter: concurrent creators all converge
 * on the same row (the loser of the race re-reads the winner's room).
 */
export function findOrCreateRoom(ctx: AppContext, ws: string, input: CreateRoomInput): { room: RoomRow; created: boolean } {
  const existing = () => ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE workspace_id = ? AND contact_id = ? AND archived = 0", ws, input.contactId);
  const found = existing();
  if (found) return { room: found, created: false };
  if (input.inboxId && !findInbox(ctx, ws, input.inboxId)) throw unprocessable("UNKNOWN_INBOX", "Inbox does not exist");
  const id = newId("room");
  const now = nowIso(ctx);
  try {
    ctx.db.tx(() => {
      ctx.db.run(
        "INSERT INTO rooms(id, workspace_id, contact_id, inbox_id, session_id, room_type, subject, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id, ws, input.contactId, input.inboxId ?? null, input.sessionId ?? null, input.roomType ?? "inbound", input.subject ?? null, now, now,
      );
      if (input.inboxId) {
        const pick = nextRoundRobinAssignee(ctx, input.inboxId);
        if (pick) {
          ctx.db.run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES (?,?,?)", id, pick, now);
          addFollower(ctx, input.contactId, pick);
        }
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const w = existing();
      if (w) return { room: w, created: false };
    }
    throw e;
  }
  const room = getRoomRow(ctx, ws, id);
  postSystemMessage(ctx, id, ws, "Conversation started", { sub_type: "create" });
  publishRoomUpdated(ctx, room, { created: true });
  return { room: getRoomRow(ctx, ws, id), created: true };
}

/** Agent-initiated conversation ("new conversation" dialog). */
export function startConversation(
  ctx: AppContext,
  actor: Actor,
  input: { contact_id?: string; contact?: ContactInput; inbox_id?: string | null; subject?: string | null },
): { room: RoomRow; created: boolean } {
  let contact: ContactRow;
  if (input.contact_id) contact = getContact(ctx, actor.workspaceId, input.contact_id);
  else if (input.contact) contact = findOrCreateContact(ctx, actor.workspaceId, { ...input.contact, source: "agent" }).contact;
  else throw unprocessable("CONTACT_REQUIRED", "Provide contact_id or contact details");
  const res = findOrCreateRoom(ctx, actor.workspaceId, { contactId: contact.id, inboxId: input.inbox_id, roomType: "outbound", subject: input.subject });
  if (!res.created && !canSeeRoom(ctx, actor, res.room.id)) {
    throw forbidden("A conversation with this contact already exists and is outside your scope", "ROOM_NOT_ACCESSIBLE");
  }
  if (res.created && !seesAll(actor) && !assigneeIds(ctx, res.room.id).length) {
    setAssignees(ctx, res.room, [actor.memberId], actor.name);
  }
  return { room: getRoomRow(ctx, actor.workspaceId, res.room.id), created: res.created };
}

export function setAssignees(ctx: AppContext, room: RoomRow, memberIds: string[], byName: string): RoomRow {
  const ws = room.workspace_id;
  const next = [...new Set(memberIds)];
  for (const m of next) if (!findMember(ctx, ws, m)) throw unprocessable("UNKNOWN_MEMBER", `Member ${m} is not part of this workspace`);
  const prev = assigneeIds(ctx, room.id);
  const added = next.filter((m) => !prev.includes(m));
  const removed = prev.filter((m) => !next.includes(m));
  if (!added.length && !removed.length) return room;
  const now = nowIso(ctx);
  ctx.db.tx(() => {
    for (const m of removed) ctx.db.run("DELETE FROM room_assignees WHERE room_id = ? AND member_id = ?", room.id, m);
    for (const m of added) {
      ctx.db.run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES (?,?,?)", room.id, m, now);
      addFollower(ctx, room.contact_id, m);
    }
    ctx.db.run("UPDATE rooms SET updated_at = ? WHERE id = ?", now, room.id);
  });
  const names = next.map((m) => findMember(ctx, ws, m)?.name ?? "Someone");
  postSystemMessage(ctx, room.id, ws, next.length ? `${byName} assigned this conversation to ${names.join(", ")}` : `${byName} unassigned this conversation`, {
    sub_type: "assignee", assignee_ids: next, actor_name: byName,
  });
  const fresh = getRoomRow(ctx, ws, room.id);
  const lost = removed.filter((m) => {
    const mem = findMember(ctx, ws, m);
    return mem && !canSeeRoom(ctx, { role: mem.role, memberId: mem.id, inboxVisibility: mem.inbox_visibility, workspaceId: ws }, room.id);
  });
  publishRoomUpdated(ctx, fresh, { lost, newlyVisible: added });
  return fresh;
}

export function assignRoom(ctx: AppContext, actor: Actor, roomId: string, input: { member_ids?: string[]; inbox_id?: string | null; auto?: boolean }): RoomRow {
  let room = getVisibleRoom(ctx, actor, roomId);
  const mgr = seesAll(actor);
  if (input.inbox_id !== undefined && input.inbox_id !== room.inbox_id) {
    if (!mgr) throw forbidden("Only managers can move a conversation to another inbox");
    if (input.inbox_id && !findInbox(ctx, actor.workspaceId, input.inbox_id)) throw unprocessable("UNKNOWN_INBOX", "Inbox does not exist");
    ctx.db.run("UPDATE rooms SET inbox_id = ?, updated_at = ? WHERE id = ?", input.inbox_id, nowIso(ctx), roomId);
    room = getRoomRow(ctx, actor.workspaceId, roomId);
  }
  let ids = input.member_ids;
  if (input.auto) {
    if (!room.inbox_id) throw unprocessable("NO_INBOX", "Room has no inbox to route from");
    const pick = ctx.db.tx(() => nextRoundRobinAssignee(ctx, room.inbox_id!));
    if (!pick) throw unprocessable("NO_ELIGIBLE_MEMBER", "The inbox has no eligible members or is not round-robin");
    ids = [pick];
  }
  if (ids) {
    if (!mgr) {
      const cur = assigneeIds(ctx, roomId);
      const selfOnly = ids.length === 1 && ids[0] === actor.memberId;
      const selfLeaving = ids.length === cur.filter((m) => m !== actor.memberId).length && ids.every((m) => cur.includes(m));
      if (!(selfOnly || selfLeaving)) throw forbidden("Agents can only assign conversations to themselves or unassign themselves");
    }
    room = setAssignees(ctx, room, ids, actor.name);
  } else {
    publishRoomUpdated(ctx, room);
  }
  return room;
}

/** Used when a seat is removed: reroute round-robin inboxes, otherwise leave unassigned. */
export function rerouteRoom(ctx: AppContext, roomId: string): void {
  const room = ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ? AND archived = 0", roomId);
  if (!room) return;
  let pick: string | null = null;
  if (room.inbox_id && !assigneeIds(ctx, roomId).length) pick = ctx.db.tx(() => nextRoundRobinAssignee(ctx, room.inbox_id!));
  if (pick) setAssignees(ctx, room, [pick], "Round robin");
  else publishRoomUpdated(ctx, room);
}

export function setStatus(ctx: AppContext, actor: Actor, roomId: string, status: "open" | "closed"): RoomRow {
  const room = getVisibleRoom(ctx, actor, roomId);
  if (room.status === status) return room;
  ctx.db.tx(() => {
    ctx.db.run("UPDATE rooms SET status = ?, snooze_until = CASE WHEN ? = 'closed' THEN NULL ELSE snooze_until END, snoozed_by = CASE WHEN ? = 'closed' THEN NULL ELSE snoozed_by END, updated_at = ? WHERE id = ?", status, status, status, nowIso(ctx), roomId);
    // closing releases the SMS sender numbers pinned to this conversation
    if (status === "closed") ctx.db.run("DELETE FROM message_locks WHERE room_id = ? AND type = 'sms'", roomId);
  });
  postSystemMessage(ctx, roomId, actor.workspaceId, `${actor.name} ${status === "closed" ? "closed" : "reopened"} the conversation`, {
    sub_type: "status", status, actor_id: actor.memberId, reason: "agent_action",
  });
  const fresh = getRoomRow(ctx, actor.workspaceId, roomId);
  publishRoomUpdated(ctx, fresh);
  return fresh;
}

export function setPriority(ctx: AppContext, actor: Actor, roomId: string, priority: 0 | 1): RoomRow {
  const room = getVisibleRoom(ctx, actor, roomId);
  if (room.priority === priority) return room;
  ctx.db.run("UPDATE rooms SET priority = ?, updated_at = ? WHERE id = ?", priority, nowIso(ctx), roomId);
  const fresh = getRoomRow(ctx, actor.workspaceId, roomId);
  publishRoomUpdated(ctx, fresh);
  return fresh;
}

export function setSubject(ctx: AppContext, actor: Actor, roomId: string, subject: string | null): RoomRow {
  getVisibleRoom(ctx, actor, roomId);
  ctx.db.run("UPDATE rooms SET subject = ?, updated_at = ? WHERE id = ?", subject, nowIso(ctx), roomId);
  const fresh = getRoomRow(ctx, actor.workspaceId, roomId);
  publishRoomUpdated(ctx, fresh);
  return fresh;
}

export function snoozeRoom(ctx: AppContext, actor: Actor, roomId: string, until: string): RoomRow {
  const room = getVisibleRoom(ctx, actor, roomId);
  const t = Date.parse(until);
  const now = ctx.clock().getTime();
  // validate first: nothing is written for a bad time
  if (Number.isNaN(t)) throw unprocessable("INVALID_SNOOZE", "Snooze time is not a valid date");
  if (t <= now) throw unprocessable("INVALID_SNOOZE", "Snooze time must be in the future");
  if (t - now > 366 * 86400_000) throw unprocessable("INVALID_SNOOZE", "Snooze time must be within a year");
  if (room.status === "closed") throw unprocessable("ROOM_CLOSED", "Closed conversations cannot be snoozed");
  const iso = new Date(t).toISOString();
  ctx.db.run("UPDATE rooms SET snooze_until = ?, snoozed_by = ?, updated_at = ? WHERE id = ?", iso, actor.memberId, nowIso(ctx), roomId);
  postSystemMessage(ctx, roomId, actor.workspaceId, `${actor.name} snoozed this conversation until ${iso}`, { sub_type: "snooze", until: iso, actor_id: actor.memberId });
  const fresh = getRoomRow(ctx, actor.workspaceId, roomId);
  publishRoomUpdated(ctx, fresh);
  return fresh;
}

export function unsnoozeRoom(ctx: AppContext, actor: Actor, roomId: string): RoomRow {
  const room = getVisibleRoom(ctx, actor, roomId);
  if (!room.snooze_until) return room;
  ctx.db.run("UPDATE rooms SET snooze_until = NULL, snoozed_by = NULL, updated_at = ? WHERE id = ?", nowIso(ctx), roomId);
  const fresh = getRoomRow(ctx, actor.workspaceId, roomId);
  publishRoomUpdated(ctx, fresh);
  return fresh;
}

/** Scheduler entry point. The conditional UPDATE makes a double run (or two workers) wake each room once. */
export function wakeDueRooms(ctx: AppContext, onWake?: (room: RoomRow, snoozedBy: string | null) => void): number {
  const now = nowIso(ctx);
  const due = ctx.db.all<RoomRow>("SELECT * FROM rooms WHERE snooze_until IS NOT NULL AND snooze_until <= ? AND archived = 0 ORDER BY snooze_until LIMIT 200", now);
  let woken = 0;
  for (const r of due) {
    const res = ctx.db.run("UPDATE rooms SET snooze_until = NULL, snoozed_by = NULL, updated_at = ? WHERE id = ? AND snooze_until = ?", now, r.id, r.snooze_until);
    if (res.changes === 0) continue;
    woken++;
    postSystemMessage(ctx, r.id, r.workspace_id, "Snooze ended", { sub_type: "snooze_ended" });
    const fresh = getRoomRow(ctx, r.workspace_id, r.id);
    ctx.bus.toRoom(r.workspace_id, r.id, "room:updated", { room: roomBaseDto(ctx, fresh), reason: "snooze_ended" }, { visitor: { room: { id: r.id, status: fresh.status } } });
    onWake?.(fresh, r.snoozed_by);
  }
  return woken;
}

export function setFavorite(ctx: AppContext, actor: Actor, roomId: string, on: boolean): { favorite: boolean } {
  getVisibleRoom(ctx, actor, roomId);
  if (on) ctx.db.run("INSERT OR IGNORE INTO room_favorites(room_id, member_id, created_at) VALUES (?,?,?)", roomId, actor.memberId, nowIso(ctx));
  else ctx.db.run("DELETE FROM room_favorites WHERE room_id = ? AND member_id = ?", roomId, actor.memberId);
  return { favorite: on };
}

export function archiveRoom(ctx: AppContext, actor: Actor, roomId: string): void {
  if (!seesAll(actor)) throw forbidden("Only managers can delete conversations");
  const room = getVisibleRoom(ctx, actor, roomId);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE rooms SET archived = 1, updated_at = ? WHERE id = ?", nowIso(ctx), roomId);
    ctx.db.run("DELETE FROM message_locks WHERE room_id = ?", roomId);
  });
  ctx.bus.toRoom(room.workspace_id, roomId, "room:deleted", { room_id: roomId }, { visitor: { room_id: roomId } });
}

/**
 * Move a seat's read cursor up to a message. One UPSERT, no message loading; the cursor only moves forward,
 * so a stale or out-of-order request is a no-op.
 */
export function markRead(ctx: AppContext, actor: Actor, roomId: string, messageId: string) {
  const room = getVisibleRoom(ctx, actor, roomId);
  const target = ctx.db.get<{ seq: number; id: string }>("SELECT seq, id FROM messages WHERE id = ? AND room_id = ?", messageId, roomId);
  if (!target) throw notFound("Message");
  const seq = Math.min(target.seq, room.last_message_seq);
  const now = nowIso(ctx);
  const res = ctx.db.run(
    `INSERT INTO room_reads(room_id, member_id, last_read_seq, last_read_message_id, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(room_id, member_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
     WHERE excluded.last_read_seq > room_reads.last_read_seq`,
    roomId, actor.memberId, seq, target.id, now,
  );
  const cursor = ctx.db.get<{ last_read_seq: number; last_read_message_id: string | null }>("SELECT last_read_seq, last_read_message_id FROM room_reads WHERE room_id = ? AND member_id = ?", roomId, actor.memberId)!;
  const unread = unreadCount(ctx, roomId, actor.memberId);
  if (res.changes > 0) {
    const receipt = { room_id: roomId, reader: { type: "agent", id: actor.memberId }, up_to_seq: cursor.last_read_seq, up_to_message_id: cursor.last_read_message_id, at: now };
    ctx.bus.toRoom(actor.workspaceId, roomId, "message:receipt", receipt, { visitor: { ...receipt, reader: { type: "agent" } } });
    ctx.bus.toMember(actor.workspaceId, actor.memberId, "room:unread", { room_id: roomId, unread_count: unread });
  }
  return { room_id: roomId, last_read_seq: cursor.last_read_seq, last_read_message_id: cursor.last_read_message_id, unread_count: unread, moved: res.changes > 0 };
}

export function markVisitorRead(ctx: AppContext, workspaceId: string, roomId: string, messageId: string) {
  const target = ctx.db.get<{ seq: number; id: string }>("SELECT seq, id FROM messages WHERE id = ? AND room_id = ? AND workspace_id = ? AND kind != 'note'", messageId, roomId, workspaceId);
  if (!target) throw notFound("Message");
  const res = ctx.db.run("UPDATE rooms SET visitor_read_seq = ? WHERE id = ? AND visitor_read_seq < ?", target.seq, roomId, target.seq);
  if (res.changes > 0) {
    const receipt = { room_id: roomId, reader: { type: "contact" }, up_to_seq: target.seq, up_to_message_id: target.id, at: nowIso(ctx) };
    ctx.bus.toRoom(workspaceId, roomId, "message:receipt", receipt);
  }
  return { moved: res.changes > 0, up_to_seq: target.seq };
}

/** Email-open webhook: mark an outgoing message as read by the contact. */
export function markOpened(ctx: AppContext, workspaceId: string, message: MessageRow): void {
  if (message.opened_at) return;
  ctx.db.run("UPDATE messages SET opened_at = ? WHERE id = ?", nowIso(ctx), message.id);
  const room = getRoomRow(ctx, workspaceId, message.room_id);
  const fresh = ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", message.id)!;
  emitMessage(ctx, room, fresh, "message:updated");
  ctx.bus.toRoom(workspaceId, room.id, "message:receipt", { room_id: room.id, reader: { type: "contact" }, up_to_seq: message.seq, up_to_message_id: message.id, at: nowIso(ctx), channel: "email_open" });
}

export interface Counts {
  open: number;
  closed: number;
  snoozed: number;
  priority: number;
  unassigned: number;
  assigned: number;
  mentions: number;
}

export function roomCounts(ctx: AppContext, actor: Actor) {
  const vis = roomVisibility(actor);
  const now = nowIso(ctx);
  const base = `FROM rooms r WHERE r.workspace_id = ? AND r.archived = 0 AND ${vis.sql}`;
  const row = ctx.db.get<Counts>(
    `SELECT
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?)), 0) AS open,
      COALESCE(SUM(r.status = 'closed'), 0) AS closed,
      COALESCE(SUM(r.status = 'open' AND r.snooze_until > ?), 0) AS snoozed,
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND r.priority = 1), 0) AS priority,
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND NOT EXISTS (SELECT 1 FROM room_assignees x WHERE x.room_id = r.id)), 0) AS unassigned,
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND EXISTS (SELECT 1 FROM room_assignees y WHERE y.room_id = r.id AND y.member_id = ?)), 0) AS assigned,
      COALESCE(SUM(EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.room_id = r.id AND mm.member_id = ?)), 0) AS mentions
     ${base}`,
    now, now, now, now, now, actor.memberId, actor.memberId, actor.workspaceId, ...vis.params,
  )!;
  const perInbox = ctx.db.all<{ inbox_id: string; open: number; priority: number; unassigned: number; assigned: number }>(
    `SELECT r.inbox_id AS inbox_id,
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?)), 0) AS open,
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND r.priority = 1), 0) AS priority,
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND NOT EXISTS (SELECT 1 FROM room_assignees x WHERE x.room_id = r.id)), 0) AS unassigned,
      COALESCE(SUM(r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND EXISTS (SELECT 1 FROM room_assignees y WHERE y.room_id = r.id AND y.member_id = ?)), 0) AS assigned
     ${base} AND r.inbox_id IS NOT NULL GROUP BY r.inbox_id`,
    now, now, now, now, actor.memberId, actor.workspaceId, ...vis.params,
  );
  const totalUnread = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM (SELECT r.id, ${unreadSql} AS u FROM rooms r LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.member_id = ?
      WHERE r.workspace_id = ? AND r.archived = 0 AND ${vis.sql} AND r.status = 'open') WHERE u > 0`,
    actor.memberId, actor.memberId, actor.memberId, actor.workspaceId, ...vis.params,
  )!.n;
  return { total: row, inboxes: perInbox, unread_rooms: totalUnread };
}

export type BulkAction = "close" | "reopen" | "assign" | "priority" | "tag";
export interface BulkInput {
  room_ids: string[];
  action: BulkAction;
  member_ids?: string[];
  priority?: 0 | 1;
  tags?: string[];
}

export function bulkRooms(ctx: AppContext, actor: Actor, input: BulkInput) {
  const results = input.room_ids.map((roomId) => {
    try {
      switch (input.action) {
        case "close": setStatus(ctx, actor, roomId, "closed"); break;
        case "reopen": setStatus(ctx, actor, roomId, "open"); break;
        case "assign":
          if (!input.member_ids) throw unprocessable("MEMBER_IDS_REQUIRED", "member_ids required");
          assignRoom(ctx, actor, roomId, { member_ids: input.member_ids });
          break;
        case "priority":
          if (input.priority === undefined) throw unprocessable("PRIORITY_REQUIRED", "priority required");
          setPriority(ctx, actor, roomId, input.priority);
          break;
        case "tag": {
          const room = getVisibleRoom(ctx, actor, roomId);
          const c = findContact(ctx, actor.workspaceId, room.contact_id);
          if (!c) throw notFound("Contact");
          const merged = normalizeTags([...parseJson<string[]>(c.tags, []), ...(input.tags ?? [])]);
          ctx.db.run("UPDATE contacts SET tags = ?, updated_at = ? WHERE id = ?", JSON.stringify(merged), nowIso(ctx), c.id);
          break;
        }
      }
      return { room_id: roomId, ok: true as const };
    } catch (e) {
      if (e instanceof AppError) return { room_id: roomId, ok: false as const, error: { code: e.code, message: e.message } };
      throw e;
    }
  });
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

