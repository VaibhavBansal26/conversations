import { metricsAssignee, metricsCreated, metricsSnoozed, metricsStatus, metricsUnsnoozed } from "./roomMetrics.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation, type Param } from "../db/index.js";
import { can } from "../authz/permissions.js";
import { seesAll, type Actor } from "../domain/types.js";
import { AppError, forbidden, notFound, unprocessable } from "../errors.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";
import { enqueueJob } from "../jobs/queue.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { addFollower, contactBrief, findContact, getContact, normalizeTags, type ContactInput, type ContactRow, findOrCreateContact } from "./contacts.js";
import { findInbox, nextRoundRobinAssignee } from "./inboxes.js";
import { findMember } from "./members.js";
import { closedMarker, emitMessage, lastBriefOf, lastMessageBrief, postSystemMessage, type MessageRow } from "./messageStore.js";
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
  /** keyset cursor from a previous page (newest / oldest / priority_first); preferred over `page` */
  cursor?: string;
  /** offset paging: only for waiting_longest (a computed sort) and legacy callers */
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

const activity = "r.last_message_at";

type ListRow = RoomRow & { unread_count: number; favorite: number; waiting_since: string | null };

export async function unreadCount(ctx: AppContext, roomId: string, memberId: string): Promise<number> {
  return (
    (
      await ctx.db.get<{ n: number }>(
        `SELECT ${unreadSql} AS n FROM rooms r LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.member_id = ? WHERE r.id = ?`,
        memberId,
        memberId,
        memberId,
        roomId,
      )
    )?.n ?? 0
  );
}

async function hydrate(ctx: AppContext, rows: (RoomRow & Partial<ListRow>)[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const assignees = new Map<string, string[]>();
  for (const a of await ctx.db.read().all<{ room_id: string; member_id: string }>(
    `SELECT room_id, member_id FROM room_assignees WHERE room_id IN (${marks}) ORDER BY added_at, member_id`,
    ...ids,
  )) {
    assignees.set(a.room_id, [...(assignees.get(a.room_id) ?? []), a.member_id]);
  }
  const contacts = new Map(
    (await ctx.db.read().all<ContactRow>(`SELECT * FROM contacts WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.contact_id))).map((c) => [c.id, c]),
  );
  // "last message" cards come from the denormalised column; only rooms that predate it fall back to the messages table (and are filled in)
  const briefs = new Map<string, ReturnType<typeof lastMessageBrief> | null>();
  await Promise.all(rows.map(async (r) => void briefs.set(r.id, await lastBriefOf(ctx, r))));
  return rows.map((r) => {
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
      last_message: briefs.get(r.id) ?? null,
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

export type RoomDto = Awaited<ReturnType<typeof hydrate>>[number];

/** Viewer-independent snapshot used in socket broadcasts (no unread count / favorite). */
export async function roomBaseDto(ctx: AppContext, room: RoomRow): Promise<RoomDto> {
  return (await hydrate(ctx, [room]))[0]!;
}

const WAITING_ORDER = "(t.waiting_since IS NULL) ASC, t.waiting_since ASC, t.last_message_at DESC, t.id DESC";

async function selectRooms(ctx: AppContext, actor: Actor, where: string[], params: Param[], sort: RoomSort | "id", limit: number, offset: number): Promise<ListRow[]> {
  const vis = roomVisibility(actor);
  const inner = `SELECT r.*, ${unreadSql} AS unread_count,
       CASE WHEN EXISTS (SELECT 1 FROM room_favorites f WHERE f.room_id = r.id AND f.member_id = ?) THEN 1 ELSE 0 END AS favorite,
       ${waitingSql} AS waiting_since
     FROM rooms r JOIN contacts c ON c.id = r.contact_id
     LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.member_id = ?
     WHERE r.workspace_id = ? AND r.archived = 0 AND ${vis.sql} ${where.length ? "AND " + where.join(" AND ") : ""}`;
  const args = [actor.memberId, actor.memberId, actor.memberId, actor.memberId, actor.workspaceId, ...vis.params, ...params, limit, offset];
  // waiting_longest orders by a computed column, which needs a derived table (portable across SQLite and PostgreSQL)
  if (sort === "waiting_longest") return await ctx.db.read().all<ListRow>(`SELECT t.* FROM (${inner}) t ORDER BY ${WAITING_ORDER} LIMIT ? OFFSET ?`, ...args);
  return await ctx.db.read().all<ListRow>(`${inner} ORDER BY ${sort === "id" ? "r.id" : ORDER[sort]} LIMIT ? OFFSET ?`, ...args);
}

const ORDER: Record<Exclude<RoomSort, "waiting_longest">, string> = {
  newest: `${activity} DESC, r.id DESC`,
  oldest: `${activity} ASC, r.id ASC`,
  priority_first: `r.priority DESC, ${activity} DESC, r.id DESC`,
};

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;

export async function listRooms(ctx: AppContext, actor: Actor, f: RoomFilters) {
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
    where.push(
      "EXISTS (SELECT 1 FROM message_mentions mm JOIN messages mmm ON mmm.id = mm.message_id WHERE mm.room_id = r.id AND mm.member_id = ? AND mmm.deleted_at IS NULL)",
    );
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
    const op = ctx.db.ilike;
    where.push(`(c.name ${op} ? ESCAPE '\\' OR c.email ${op} ? ESCAPE '\\' OR c.phone ${op} ? ESCAPE '\\' OR r.subject ${op} ? ESCAPE '\\')`);
    params.push(l, l, l, l);
  }
  const sort = f.sort ?? "newest";
  const keyset = sort !== "waiting_longest";
  let offset = (f.page - 1) * f.limit;
  if (keyset && f.cursor) {
    // (activity, id) compared as a row value: the database seeks straight to the next page in the list index
    const op = sort === "oldest" ? ">" : "<";
    if (sort === "priority_first") {
      const c = decodeCursor(f.cursor, 3);
      where.push(`(r.priority, r.last_message_at, r.id) ${op} (?, ?, ?)`);
      params.push(...(c as [number, string, string]));
    } else {
      const c = decodeCursor(f.cursor, 2);
      where.push(`(r.last_message_at, r.id) ${op} (?, ?)`);
      params.push(...(c as [string, string]));
    }
    offset = 0;
  }
  const rows = await selectRooms(ctx, actor, where, params, sort, f.limit + 1, offset);
  const hasMore = rows.length > f.limit;
  const pageRows = rows.slice(0, f.limit);
  const last = pageRows[pageRows.length - 1];
  const next_cursor = keyset && hasMore && last ? encodeCursor(sort === "priority_first" ? [last.priority, last.last_message_at!, last.id] : [last.last_message_at!, last.id]) : null;
  return { data: await hydrate(ctx, pageRows), pagination: { page: f.page, limit: f.limit, has_more: hasMore, next_cursor } };
}

export async function getRoomDto(ctx: AppContext, actor: Actor, roomId: string): Promise<RoomDto> {
  await getVisibleRoom(ctx, actor, roomId);
  const rows = await selectRooms(ctx, actor, ["r.id = ?"], [roomId], "id", 1, 0);
  if (!rows[0]) throw notFound("Room");
  return (await hydrate(ctx, rows))[0]!;
}

/** Re-point socket membership, then tell everyone who can see the room. `lost` seats get room:deleted. */
export async function publishRoomUpdated(ctx: AppContext, room: RoomRow, opts: { lost?: string[]; created?: boolean; newlyVisible?: string[] } = {}): Promise<void> {
  await ctx.cache.invalidate(`counts:${room.workspace_id}:*`);
  const fresh = await getRoomRow(ctx, room.workspace_id, room.id);
  const dto = await roomBaseDto(ctx, fresh);
  for (const m of opts.lost ?? []) ctx.bus.toMember(fresh.workspace_id, m, "room:deleted", { room_id: fresh.id });
  await ctx.bus.refreshRoomAccess(fresh.workspace_id, fresh.id);
  for (const m of opts.newlyVisible ?? []) ctx.bus.toMember(fresh.workspace_id, m, "room:new", { room: dto });
  if (opts.created) {
    ctx.bus.toRoom(fresh.workspace_id, fresh.id, "room:new", { room: dto });
  } else {
    ctx.bus.toRoom(fresh.workspace_id, fresh.id, "room:updated", { room: dto }, { visitor: { room: { id: fresh.id, status: fresh.status, closed_marker: await closedMarker(ctx, fresh) } } });
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
export async function findOrCreateRoom(ctx: AppContext, ws: string, input: CreateRoomInput): Promise<{ room: RoomRow; created: boolean }> {
  const existing = () => ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE workspace_id = ? AND contact_id = ? AND archived = 0", ws, input.contactId);
  const found = await existing();
  if (found) return { room: found, created: false };
  if (input.inboxId && !(await findInbox(ctx, ws, input.inboxId))) throw unprocessable("UNKNOWN_INBOX", "Inbox does not exist");
  const id = newId("room");
  const now = nowIso(ctx);
  let assignedTo: string | null = null;
  try {
    await ctx.db.tx(async () => {
      await ctx.db.run(
        "INSERT INTO rooms(id, workspace_id, contact_id, inbox_id, session_id, room_type, subject, last_message_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id,
        ws,
        input.contactId,
        input.inboxId ?? null,
        input.sessionId ?? null,
        input.roomType ?? "inbound",
        input.subject ?? null,
        now,
        now,
        now,
      );
      if (input.inboxId) {
        const pick = await nextRoundRobinAssignee(ctx, input.inboxId);
        if (pick) {
          await ctx.db.run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES (?,?,?)", id, pick, now);
          await addFollower(ctx, input.contactId, pick);
          assignedTo = pick;
        }
      }
      await metricsCreated(ctx, { id, workspace_id: ws, inbox_id: input.inboxId ?? null, contact_id: input.contactId, created_at: now } as RoomRow);
      if (assignedTo) await metricsAssignee(ctx, id, assignedTo);
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const w = await existing();
      if (w) return { room: w, created: false };
    }
    throw e;
  }
  const room = await getRoomRow(ctx, ws, id);
  await postSystemMessage(ctx, id, ws, "Conversation started", { sub_type: "create" });
  await publishRoomUpdated(ctx, room, { created: true });
  return { room: await getRoomRow(ctx, ws, id), created: true };
}

/** Agent-initiated conversation ("new conversation" dialog). */
export async function startConversation(
  ctx: AppContext,
  actor: Actor,
  input: { contact_id?: string; contact?: ContactInput; inbox_id?: string | null; subject?: string | null },
): Promise<{ room: RoomRow; created: boolean }> {
  let contact: ContactRow;
  if (input.contact_id) contact = await getContact(ctx, actor.workspaceId, input.contact_id);
  else if (input.contact) contact = (await findOrCreateContact(ctx, actor.workspaceId, { ...input.contact, source: "agent" })).contact;
  else throw unprocessable("CONTACT_REQUIRED", "Provide contact_id or contact details");
  const res = await findOrCreateRoom(ctx, actor.workspaceId, { contactId: contact.id, inboxId: input.inbox_id, roomType: "outbound", subject: input.subject });
  if (!res.created && !(await canSeeRoom(ctx, actor, res.room.id))) {
    throw forbidden("A conversation with this contact already exists and is outside your scope", "ROOM_NOT_ACCESSIBLE");
  }
  if (res.created && !seesAll(actor) && !(await assigneeIds(ctx, res.room.id)).length) {
    await setAssignees(ctx, res.room, [actor.memberId], actor.name);
  }
  return { room: await getRoomRow(ctx, actor.workspaceId, res.room.id), created: res.created };
}

export async function setAssignees(ctx: AppContext, room: RoomRow, memberIds: string[], byName: string): Promise<RoomRow> {
  const ws = room.workspace_id;
  const next = [...new Set(memberIds)];
  for (const m of next) if (!(await findMember(ctx, ws, m))) throw unprocessable("UNKNOWN_MEMBER", `Member ${m} is not part of this workspace`);
  const prev = await assigneeIds(ctx, room.id);
  const added = next.filter((m) => !prev.includes(m));
  const removed = prev.filter((m) => !next.includes(m));
  if (!added.length && !removed.length) return room;
  const now = nowIso(ctx);
  await ctx.db.tx(async () => {
    for (const m of removed) await ctx.db.run("DELETE FROM room_assignees WHERE room_id = ? AND member_id = ?", room.id, m);
    for (const m of added) {
      await ctx.db.run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES (?,?,?)", room.id, m, now);
      await addFollower(ctx, room.contact_id, m);
    }
    await ctx.db.run("UPDATE rooms SET updated_at = ? WHERE id = ?", now, room.id);
    await metricsAssignee(ctx, room.id, next[0] ?? null);
  });
  const names = await Promise.all(next.map(async (m) => (await findMember(ctx, ws, m))?.name ?? "Someone"));
  await postSystemMessage(ctx, room.id, ws, next.length ? `${byName} assigned this conversation to ${names.join(", ")}` : `${byName} unassigned this conversation`, {
    sub_type: "assignee",
    assignee_ids: next,
    actor_name: byName,
  });
  const fresh = await getRoomRow(ctx, ws, room.id);
  const lost: string[] = [];
  for (const m of removed) {
    const mem = await findMember(ctx, ws, m);
    if (mem && !(await canSeeRoom(ctx, { role: mem.role, memberId: mem.id, inboxVisibility: mem.inbox_visibility, workspaceId: ws }, room.id))) lost.push(m);
  }
  await publishRoomUpdated(ctx, fresh, { lost, newlyVisible: added });
  return fresh;
}

export async function assignRoom(
  ctx: AppContext,
  actor: Actor,
  roomId: string,
  input: { member_ids?: string[]; inbox_id?: string | null; auto?: boolean },
): Promise<RoomRow> {
  let room = await getVisibleRoom(ctx, actor, roomId);
  // managers may assign anyone and move rooms between inboxes; a custom role needs the permission too
  const mgr = seesAll(actor) && can(actor, "conversations:assign");
  if (input.inbox_id !== undefined && input.inbox_id !== room.inbox_id) {
    if (!mgr) throw forbidden("Only managers can move a conversation to another inbox");
    if (input.inbox_id && !(await findInbox(ctx, actor.workspaceId, input.inbox_id))) throw unprocessable("UNKNOWN_INBOX", "Inbox does not exist");
    await ctx.db.run("UPDATE rooms SET inbox_id = ?, updated_at = ? WHERE id = ?", input.inbox_id, nowIso(ctx), roomId);
    room = await getRoomRow(ctx, actor.workspaceId, roomId);
  }
  let ids = input.member_ids;
  if (input.auto) {
    if (!room.inbox_id) throw unprocessable("NO_INBOX", "Room has no inbox to route from");
    const pick = await ctx.db.tx(() => nextRoundRobinAssignee(ctx, room.inbox_id!));
    if (!pick) throw unprocessable("NO_ELIGIBLE_MEMBER", "The inbox has no eligible members or is not round-robin");
    ids = [pick];
  }
  if (ids) {
    if (!mgr) {
      const cur = await assigneeIds(ctx, roomId);
      const selfOnly = ids.length === 1 && ids[0] === actor.memberId;
      const selfLeaving = ids.length === cur.filter((m) => m !== actor.memberId).length && ids.every((m) => cur.includes(m));
      if (!(selfOnly || selfLeaving)) throw forbidden("Agents can only assign conversations to themselves or unassign themselves");
    }
    room = await setAssignees(ctx, room, ids, actor.name);
  } else {
    await publishRoomUpdated(ctx, room);
  }
  return room;
}

/** Used when a seat is removed: reroute round-robin inboxes, otherwise leave unassigned. */
export async function rerouteRoom(ctx: AppContext, roomId: string): Promise<void> {
  const room = await ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ? AND archived = 0", roomId);
  if (!room) return;
  let pick: string | null = null;
  if (room.inbox_id && !(await assigneeIds(ctx, roomId)).length) pick = await ctx.db.tx(() => nextRoundRobinAssignee(ctx, room.inbox_id!));
  if (pick) await setAssignees(ctx, room, [pick], "Round robin");
  else await publishRoomUpdated(ctx, room);
}

export async function setStatus(ctx: AppContext, actor: Actor, roomId: string, status: "open" | "closed"): Promise<RoomRow> {
  const room = await getVisibleRoom(ctx, actor, roomId);
  if (room.status === status) return room;
  await ctx.db.tx(async () => {
    await ctx.db.run(
      "UPDATE rooms SET status = ?, snooze_until = CASE WHEN ? = 'closed' THEN NULL ELSE snooze_until END, snoozed_by = CASE WHEN ? = 'closed' THEN NULL ELSE snoozed_by END, updated_at = ? WHERE id = ?",
      status,
      status,
      status,
      nowIso(ctx),
      roomId,
    );
    // closing releases the SMS sender numbers pinned to this conversation
    if (status === "closed") await ctx.db.run("DELETE FROM message_locks WHERE room_id = ? AND type = 'sms'", roomId);
    await metricsStatus(ctx, room, status);
  });
  await postSystemMessage(ctx, roomId, actor.workspaceId, `${actor.name} ${status === "closed" ? "closed" : "reopened"} the conversation`, {
    sub_type: "status",
    status,
    actor_id: actor.memberId,
    reason: "agent_action",
  });
  const fresh = await getRoomRow(ctx, actor.workspaceId, roomId);
  await publishRoomUpdated(ctx, fresh);
  return fresh;
}

export async function setPriority(ctx: AppContext, actor: Actor, roomId: string, priority: 0 | 1): Promise<RoomRow> {
  const room = await getVisibleRoom(ctx, actor, roomId);
  if (room.priority === priority) return room;
  await ctx.db.run("UPDATE rooms SET priority = ?, updated_at = ? WHERE id = ?", priority, nowIso(ctx), roomId);
  const fresh = await getRoomRow(ctx, actor.workspaceId, roomId);
  await publishRoomUpdated(ctx, fresh);
  return fresh;
}

export async function setSubject(ctx: AppContext, actor: Actor, roomId: string, subject: string | null): Promise<RoomRow> {
  await getVisibleRoom(ctx, actor, roomId);
  await ctx.db.run("UPDATE rooms SET subject = ?, updated_at = ? WHERE id = ?", subject, nowIso(ctx), roomId);
  const fresh = await getRoomRow(ctx, actor.workspaceId, roomId);
  await publishRoomUpdated(ctx, fresh);
  return fresh;
}

export async function snoozeRoom(ctx: AppContext, actor: Actor, roomId: string, until: string): Promise<RoomRow> {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const t = Date.parse(until);
  const now = ctx.clock().getTime();
  // validate first: nothing is written for a bad time
  if (Number.isNaN(t)) throw unprocessable("INVALID_SNOOZE", "Snooze time is not a valid date");
  if (t <= now) throw unprocessable("INVALID_SNOOZE", "Snooze time must be in the future");
  if (t - now > 366 * 86400_000) throw unprocessable("INVALID_SNOOZE", "Snooze time must be within a year");
  if (room.status === "closed") throw unprocessable("ROOM_CLOSED", "Closed conversations cannot be snoozed");
  const iso = new Date(t).toISOString();
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE rooms SET snooze_until = ?, snoozed_by = ?, updated_at = ? WHERE id = ?", iso, actor.memberId, nowIso(ctx), roomId);
    await metricsSnoozed(ctx, roomId);
  });
  // wake-up is a delayed job (exact timing, no polling); the periodic sweep only exists as a safety net
  await enqueueJob(ctx, "wake_room", { room_id: roomId, until: iso }, { runAt: new Date(t), dedupeKey: `wake:${roomId}:${iso}` });
  await postSystemMessage(ctx, roomId, actor.workspaceId, `${actor.name} snoozed this conversation until ${iso}`, {
    sub_type: "snooze",
    until: iso,
    actor_id: actor.memberId,
  });
  const fresh = await getRoomRow(ctx, actor.workspaceId, roomId);
  await publishRoomUpdated(ctx, fresh);
  return fresh;
}

export async function unsnoozeRoom(ctx: AppContext, actor: Actor, roomId: string): Promise<RoomRow> {
  const room = await getVisibleRoom(ctx, actor, roomId);
  if (!room.snooze_until) return room;
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE rooms SET snooze_until = NULL, snoozed_by = NULL, updated_at = ? WHERE id = ?", nowIso(ctx), roomId);
    await metricsUnsnoozed(ctx, actor.workspaceId, roomId);
  });
  const fresh = await getRoomRow(ctx, actor.workspaceId, roomId);
  await publishRoomUpdated(ctx, fresh);
  return fresh;
}

export type WakeHook = (room: RoomRow, snoozedBy: string | null) => Promise<void> | void;

/** Wake one snoozed room. The conditional UPDATE makes duplicate triggers (a delayed job and the sweep, or two nodes) wake it exactly once. */
export async function wakeRoom(ctx: AppContext, r: RoomRow, onWake?: WakeHook): Promise<boolean> {
  const now = nowIso(ctx);
  const res = await ctx.db.run("UPDATE rooms SET snooze_until = NULL, snoozed_by = NULL, updated_at = ? WHERE id = ? AND snooze_until = ?", now, r.id, r.snooze_until);
  if (res.changes === 0) return false;
  await metricsUnsnoozed(ctx, r.workspace_id, r.id, now);
  await postSystemMessage(ctx, r.id, r.workspace_id, "Snooze ended", { sub_type: "snooze_ended" });
  const fresh = await getRoomRow(ctx, r.workspace_id, r.id);
  ctx.bus.toRoom(r.workspace_id, r.id, "room:updated", { room: await roomBaseDto(ctx, fresh), reason: "snooze_ended" }, { visitor: { room: { id: r.id, status: fresh.status } } });
  await onWake?.(fresh, r.snoozed_by);
  return true;
}

/** Safety-net sweep for snoozes whose delayed job was lost; the normal path is the per-room delayed job scheduled by snoozeRoom. */
export async function wakeDueRooms(ctx: AppContext, onWake?: WakeHook): Promise<number> {
  const due = await ctx.db.all<RoomRow>("SELECT * FROM rooms WHERE snooze_until IS NOT NULL AND snooze_until <= ? AND archived = 0 ORDER BY snooze_until LIMIT 200", nowIso(ctx));
  let woken = 0;
  for (const r of due) if (await wakeRoom(ctx, r, onWake)) woken++;
  return woken;
}

export async function setFavorite(ctx: AppContext, actor: Actor, roomId: string, on: boolean): Promise<{ favorite: boolean }> {
  await getVisibleRoom(ctx, actor, roomId);
  if (on) await ctx.db.run("INSERT OR IGNORE INTO room_favorites(room_id, member_id, created_at) VALUES (?,?,?)", roomId, actor.memberId, nowIso(ctx));
  else await ctx.db.run("DELETE FROM room_favorites WHERE room_id = ? AND member_id = ?", roomId, actor.memberId);
  return { favorite: on };
}

export async function archiveRoom(ctx: AppContext, actor: Actor, roomId: string): Promise<void> {
  if (!seesAll(actor) || !can(actor, "conversations:delete")) throw forbidden("Only managers can delete conversations");
  const room = await getVisibleRoom(ctx, actor, roomId);
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE rooms SET archived = 1, updated_at = ? WHERE id = ?", nowIso(ctx), roomId);
    await ctx.db.run("DELETE FROM message_locks WHERE room_id = ?", roomId);
  });
  ctx.bus.toRoom(room.workspace_id, roomId, "room:deleted", { room_id: roomId }, { visitor: { room_id: roomId } });
}

/**
 * Move a seat's read cursor up to a message. One UPSERT, no message loading; the cursor only moves forward,
 * so a stale or out-of-order request is a no-op.
 */
export async function markRead(ctx: AppContext, actor: Actor, roomId: string, messageId: string) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const target = await ctx.db.get<{ seq: number; id: string }>("SELECT seq, id FROM messages WHERE id = ? AND room_id = ?", messageId, roomId);
  if (!target) throw notFound("Message");
  const seq = Math.min(target.seq, room.last_message_seq);
  const now = nowIso(ctx);
  const res = await ctx.db.run(
    `INSERT INTO room_reads(room_id, member_id, last_read_seq, last_read_message_id, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(room_id, member_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
     WHERE excluded.last_read_seq > room_reads.last_read_seq`,
    roomId,
    actor.memberId,
    seq,
    target.id,
    now,
  );
  const cursor = (await ctx.db.get<{ last_read_seq: number; last_read_message_id: string | null }>(
    "SELECT last_read_seq, last_read_message_id FROM room_reads WHERE room_id = ? AND member_id = ?",
    roomId,
    actor.memberId,
  ))!;
  const unread = await unreadCount(ctx, roomId, actor.memberId);
  if (res.changes > 0) {
    const receipt = {
      room_id: roomId,
      reader: { type: "agent", id: actor.memberId },
      up_to_seq: cursor.last_read_seq,
      up_to_message_id: cursor.last_read_message_id,
      at: now,
    };
    ctx.bus.toRoom(actor.workspaceId, roomId, "message:receipt", receipt, { visitor: { ...receipt, reader: { type: "agent" } } });
    ctx.bus.toMember(actor.workspaceId, actor.memberId, "room:unread", { room_id: roomId, unread_count: unread });
  }
  return { room_id: roomId, last_read_seq: cursor.last_read_seq, last_read_message_id: cursor.last_read_message_id, unread_count: unread, moved: res.changes > 0 };
}

export async function markVisitorRead(ctx: AppContext, workspaceId: string, roomId: string, messageId: string) {
  const target = await ctx.db.get<{ seq: number; id: string }>(
    "SELECT seq, id FROM messages WHERE id = ? AND room_id = ? AND workspace_id = ? AND kind != 'note'",
    messageId,
    roomId,
    workspaceId,
  );
  if (!target) throw notFound("Message");
  const res = await ctx.db.run("UPDATE rooms SET visitor_read_seq = ? WHERE id = ? AND visitor_read_seq < ?", target.seq, roomId, target.seq);
  if (res.changes > 0) {
    const receipt = { room_id: roomId, reader: { type: "contact" }, up_to_seq: target.seq, up_to_message_id: target.id, at: nowIso(ctx) };
    ctx.bus.toRoom(workspaceId, roomId, "message:receipt", receipt);
  }
  return { moved: res.changes > 0, up_to_seq: target.seq };
}

/** Email-open webhook: mark an outgoing message as read by the contact. */
export async function markOpened(ctx: AppContext, workspaceId: string, message: MessageRow): Promise<void> {
  if (message.opened_at) return;
  await ctx.db.run("UPDATE messages SET opened_at = ? WHERE room_id = ? AND id = ?", nowIso(ctx), message.room_id, message.id);
  const room = await getRoomRow(ctx, workspaceId, message.room_id);
  const fresh = (await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND id = ?", message.room_id, message.id))!;
  await emitMessage(ctx, room, fresh, "message:updated");
  ctx.bus.toRoom(workspaceId, room.id, "message:receipt", {
    room_id: room.id,
    reader: { type: "contact" },
    up_to_seq: message.seq,
    up_to_message_id: message.id,
    at: nowIso(ctx),
    channel: "email_open",
  });
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

/** Inbox counts are polled by every open tab; computed once per seat per cache window and dropped whenever a room or message in the workspace changes. */
export function roomCounts(ctx: AppContext, actor: Actor) {
  return ctx.cache.wrap(`counts:${actor.workspaceId}:${actor.memberId}`, () => computeRoomCounts(ctx, actor));
}

async function computeRoomCounts(ctx: AppContext, actor: Actor) {
  const vis = roomVisibility(actor);
  const now = nowIso(ctx);
  const base = `FROM rooms r WHERE r.workspace_id = ? AND r.archived = 0 AND ${vis.sql}`;
  const row = (await ctx.db.read().get<Counts>(
    `SELECT
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) THEN 1 ELSE 0 END), 0) AS open,
      COALESCE(SUM(CASE WHEN r.status = 'closed' THEN 1 ELSE 0 END), 0) AS closed,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND r.snooze_until > ? THEN 1 ELSE 0 END), 0) AS snoozed,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND r.priority = 1 THEN 1 ELSE 0 END), 0) AS priority,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND NOT EXISTS (SELECT 1 FROM room_assignees x WHERE x.room_id = r.id) THEN 1 ELSE 0 END), 0) AS unassigned,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND EXISTS (SELECT 1 FROM room_assignees y WHERE y.room_id = r.id AND y.member_id = ?) THEN 1 ELSE 0 END), 0) AS assigned,
      COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.room_id = r.id AND mm.member_id = ?) THEN 1 ELSE 0 END), 0) AS mentions
     ${base}`,
    now,
    now,
    now,
    now,
    now,
    actor.memberId,
    actor.memberId,
    actor.workspaceId,
    ...vis.params,
  ))!;
  const perInbox = await ctx.db.read().all<{ inbox_id: string; open: number; priority: number; unassigned: number; assigned: number }>(
    `SELECT r.inbox_id AS inbox_id,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) THEN 1 ELSE 0 END), 0) AS open,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND r.priority = 1 THEN 1 ELSE 0 END), 0) AS priority,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND NOT EXISTS (SELECT 1 FROM room_assignees x WHERE x.room_id = r.id) THEN 1 ELSE 0 END), 0) AS unassigned,
      COALESCE(SUM(CASE WHEN r.status = 'open' AND (r.snooze_until IS NULL OR r.snooze_until <= ?) AND EXISTS (SELECT 1 FROM room_assignees y WHERE y.room_id = r.id AND y.member_id = ?) THEN 1 ELSE 0 END), 0) AS assigned
     ${base} AND r.inbox_id IS NOT NULL GROUP BY r.inbox_id`,
    now,
    now,
    now,
    now,
    actor.memberId,
    actor.workspaceId,
    ...vis.params,
  );
  const totalUnread = (await ctx.db.read().get<{ n: number }>(
    `SELECT COUNT(*) n FROM (SELECT r.id, ${unreadSql} AS u FROM rooms r LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.member_id = ?
      WHERE r.workspace_id = ? AND r.archived = 0 AND ${vis.sql} AND r.status = 'open') x WHERE u > 0`,
    actor.memberId,
    actor.memberId,
    actor.memberId,
    actor.workspaceId,
    ...vis.params,
  ))!.n;
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

export async function bulkRooms(ctx: AppContext, actor: Actor, input: BulkInput) {
  const results: ({ room_id: string; ok: true } | { room_id: string; ok: false; error: { code: string; message: string } })[] = [];
  for (const roomId of input.room_ids) {
    try {
      switch (input.action) {
        case "close":
          await setStatus(ctx, actor, roomId, "closed");
          break;
        case "reopen":
          await setStatus(ctx, actor, roomId, "open");
          break;
        case "assign":
          if (!input.member_ids) throw unprocessable("MEMBER_IDS_REQUIRED", "member_ids required");
          await assignRoom(ctx, actor, roomId, { member_ids: input.member_ids });
          break;
        case "priority":
          if (input.priority === undefined) throw unprocessable("PRIORITY_REQUIRED", "priority required");
          await setPriority(ctx, actor, roomId, input.priority);
          break;
        case "tag": {
          const room = await getVisibleRoom(ctx, actor, roomId);
          const c = await findContact(ctx, actor.workspaceId, room.contact_id);
          if (!c) throw notFound("Contact");
          const merged = normalizeTags([...parseJson<string[]>(c.tags, []), ...(input.tags ?? [])]);
          await ctx.db.run("UPDATE contacts SET tags = ?, updated_at = ? WHERE id = ?", JSON.stringify(merged), nowIso(ctx), c.id);
          break;
        }
      }
      results.push({ room_id: roomId, ok: true });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      results.push({ room_id: roomId, ok: false, error: { code: e.code, message: e.message } });
    }
  }
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
