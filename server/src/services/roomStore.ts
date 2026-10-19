import type { AppContext } from "../context.js";
import type { Param } from "../db/index.js";
import { seesAll, type Actor } from "../domain/types.js";
import { notFound } from "../errors.js";

export interface RoomRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  inbox_id: string | null;
  session_id: string | null;
  room_type: "inbound" | "outbound";
  status: "open" | "closed";
  archived: number;
  priority: 0 | 1;
  snooze_until: string | null;
  snoozed_by: string | null;
  subject: string | null;
  next_seq: number;
  last_message_id: string | null;
  last_message_at: string | null;
  last_message_seq: number;
  last_contact_message_at: string | null;
  visitor_read_seq: number;
  bot_paused: number;
  meta: string;
  digest_seq: number;
  created_at: string;
  updated_at: string;
}

export function findRoomRow(ctx: AppContext, workspaceId: string, roomId: string): RoomRow | undefined {
  return ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ? AND workspace_id = ? AND archived = 0", roomId, workspaceId);
}

export function getRoomRow(ctx: AppContext, workspaceId: string, roomId: string): RoomRow {
  const r = findRoomRow(ctx, workspaceId, roomId);
  if (!r) throw notFound("Room");
  return r;
}

/**
 * The single definition of "which rooms may this seat see".
 * owner/manager: all. agent: rooms assigned to them, plus rooms of inboxes they belong to when inbox_visibility=assigned_inbox.
 */
export function roomVisibility(actor: Pick<Actor, "role" | "memberId" | "inboxVisibility">, alias = "r"): { sql: string; params: Param[] } {
  if (seesAll(actor)) return { sql: "1=1", params: [] };
  const assigned = `EXISTS (SELECT 1 FROM room_assignees ra WHERE ra.room_id = ${alias}.id AND ra.member_id = ?)`;
  if (actor.inboxVisibility === "assigned_inbox") {
    return {
      sql: `(${assigned} OR ${alias}.inbox_id IN (SELECT inbox_id FROM inbox_members WHERE member_id = ?))`,
      params: [actor.memberId, actor.memberId],
    };
  }
  return { sql: assigned, params: [actor.memberId] };
}

export function canSeeRoom(ctx: AppContext, actor: Pick<Actor, "role" | "memberId" | "inboxVisibility" | "workspaceId">, roomId: string): boolean {
  const v = roomVisibility(actor);
  return !!ctx.db.get(`SELECT 1 FROM rooms r WHERE r.id = ? AND r.workspace_id = ? AND r.archived = 0 AND ${v.sql}`, roomId, actor.workspaceId, ...v.params);
}

/** 404 (not 403) for rooms outside the seat's scope, so existence is never leaked. */
export function getVisibleRoom(ctx: AppContext, actor: Actor, roomId: string): RoomRow {
  const v = roomVisibility(actor);
  const row = ctx.db.get<RoomRow>(`SELECT r.* FROM rooms r WHERE r.id = ? AND r.workspace_id = ? AND r.archived = 0 AND ${v.sql}`, roomId, actor.workspaceId, ...v.params);
  if (!row) throw notFound("Room");
  return row;
}

export const assigneeIds = (ctx: AppContext, roomId: string): string[] =>
  ctx.db.all<{ member_id: string }>("SELECT member_id FROM room_assignees WHERE room_id = ? ORDER BY added_at, member_id", roomId).map((r) => r.member_id);
