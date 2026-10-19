import type { AppContext } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { getSettings } from "./workspaces.js";
import { findInbox } from "./inboxes.js";
import { getContact } from "./contacts.js";
import { emitInserted, insertMessage, visitorMessageDtos, type MessageRow } from "./messageStore.js";
import { pageMessages, processContent } from "./messages.js";
import { onContactMessage, postBotMessage } from "./postProcess.js";
import { findOrCreateRoom, markVisitorRead } from "./rooms.js";
import { type RoomRow } from "./roomStore.js";
import type { SessionRow } from "./visitors.js";

export const VISITOR_MAX_CHARS = 4000;

/** Unverified sessions see only rooms they created; verified sessions see every live room of their contact. */
function roomScope(s: SessionRow): { sql: string; params: string[] } {
  return s.verified ? { sql: "r.contact_id = ?", params: [s.contact_id] } : { sql: "r.session_id = ?", params: [s.id] };
}

const fresh = async (ctx: AppContext, s: SessionRow) => (await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", s.id)) ?? s;

export async function visitorRooms(ctx: AppContext, session: SessionRow): Promise<RoomRow[]> {
  const s = await fresh(ctx, session);
  const sc = roomScope(s);
  return await ctx.db.all<RoomRow>(
    `SELECT r.* FROM rooms r WHERE r.workspace_id = ? AND r.archived = 0 AND ${sc.sql} ORDER BY r.created_at`,
    s.workspace_id,
    ...sc.params,
  );
}

export async function getVisitorRoom(ctx: AppContext, session: SessionRow, roomId: string): Promise<RoomRow> {
  const room = (await visitorRooms(ctx, session)).find((r) => r.id === roomId);
  if (!room) throw notFound("Room");
  return room;
}

export const visitorRoomDtos = (ctx: AppContext, rooms: RoomRow[]) => Promise.all(rooms.map((r) => visitorRoomDto(ctx, r)));

export async function visitorRoomDto(ctx: AppContext, room: RoomRow) {
  const unread = (await ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) n FROM messages WHERE room_id = ? AND seq > ? AND sender_type != 'contact' AND kind NOT IN ('note','system') AND deleted_at IS NULL",
    room.id,
    room.visitor_read_seq,
  ))!.n;
  const last = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND kind != 'note' AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1", room.id);
  return {
    id: room.id,
    status: room.status,
    created_at: room.created_at,
    unread_count: unread,
    last_message: last ? { snippet: last.content_text.slice(0, 120), created_at: last.created_at, sender_type: last.sender_type } : null,
  };
}

/** Start (or resume) the visitor's conversation. One room per contact, so a second call returns the first. */
export async function visitorStartRoom(ctx: AppContext, session: SessionRow, input: { inbox_id?: string | null } = {}) {
  const s = await fresh(ctx, session);
  const existing = await ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE workspace_id = ? AND contact_id = ? AND archived = 0", s.workspace_id, s.contact_id);
  if (existing) {
    if (!(await visitorRooms(ctx, s)).some((r) => r.id === existing.id)) {
      throw new AppError(409, "VERIFICATION_REQUIRED", "A conversation for this contact already exists. Verify your identity to continue it.");
    }
    return { room: existing, created: false };
  }
  const widget = (await getSettings(ctx, s.workspace_id)).widget;
  let inboxId = widget.default_inbox_id;
  if (input.inbox_id) {
    const inbox = await findInbox(ctx, s.workspace_id, input.inbox_id);
    if (!inbox || !inbox.live_routing_visibility) throw unprocessable("INBOX_NOT_AVAILABLE", "That inbox is not available for live chat");
    inboxId = inbox.id;
  }
  if (inboxId && !(await findInbox(ctx, s.workspace_id, inboxId))) inboxId = null;
  const res = await findOrCreateRoom(ctx, s.workspace_id, { contactId: s.contact_id, sessionId: s.id, inboxId, roomType: "inbound" });
  if (res.created && widget.welcome_message.trim()) await postBotMessage(ctx, res.room, widget.welcome_message, { welcome: true });
  return res;
}

export async function visitorListMessages(ctx: AppContext, session: SessionRow, roomId: string, opts: { before?: string; after?: string; limit: number }) {
  const room = await getVisitorRoom(ctx, session, roomId);
  const page = await pageMessages(ctx, roomId, { ...opts, hideNotes: true });
  return { data: await visitorMessageDtos(ctx, page.data, room.visitor_read_seq), pagination: page.pagination };
}

export async function visitorSend(
  ctx: AppContext,
  session: SessionRow,
  roomId: string,
  input: { content: string; client_msg_id?: string },
): Promise<{ message: MessageRow; created: boolean; room: RoomRow }> {
  const room = await getVisitorRoom(ctx, session, roomId);
  const findDup = async () =>
    input.client_msg_id ? await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND client_msg_id = ?", roomId, input.client_msg_id) : undefined;
  const dup = await findDup();
  if (dup) return { message: dup, created: false, room };
  const raw = input.content ?? "";
  if (raw.length > VISITOR_MAX_CHARS) throw unprocessable("CONTENT_TOO_LONG", `Messages are limited to ${VISITOR_MAX_CHARS} characters`);
  const { content, text } = processContent("dm", raw, "text");
  if (!text) throw unprocessable("EMPTY_MESSAGE", "Message is empty");
  const contact = await getContact(ctx, room.workspace_id, room.contact_id);
  try {
    const r = await insertMessage(ctx, {
      workspaceId: room.workspace_id,
      roomId,
      senderType: "contact",
      senderId: contact.id,
      senderName: contact.name || "Visitor",
      kind: "text",
      source: "dm",
      content,
      contentText: text,
      clientMsgId: input.client_msg_id ?? null,
    });
    await emitInserted(ctx, r);
    await onContactMessage(ctx, r.room, r.message);
    return { message: r.message, created: true, room };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const winner = await findDup();
      if (winner) return { message: winner, created: false, room };
    }
    throw e;
  }
}

export async function visitorMarkRead(ctx: AppContext, session: SessionRow, roomId: string, messageId: string) {
  const room = await getVisitorRoom(ctx, session, roomId);
  return await markVisitorRead(ctx, room.workspace_id, roomId, messageId);
}
