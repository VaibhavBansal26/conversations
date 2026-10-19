import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import { seesAll, type Actor, type MessageKind, type MessageSource } from "../domain/types.js";
import { AppError, forbidden, notFound, unprocessable } from "../errors.js";
import { buildThread, chooseEmailSender, chooseSmsNumber, deriveSubject, isE164, lockChannel, SMS_MAX_CHARS } from "../channels/rules.js";
import { cleanPlainText, htmlToText, sanitizeHtml, textToHtml } from "../util/html.js";
import { resolveAttachments } from "./attachments.js";
import { getContact } from "./contacts.js";
import { deliverMessage, retryDelivery } from "./delivery.js";
import { listMemberRows } from "./members.js";
import {
  emitInserted,
  emitMessage,
  findMessageRow,
  insertMessage,
  messageDto,
  messageDtos,
  loadRefs,
  refreshLastMessage,
  type InsertResult,
  type MessageRow,
} from "./messageStore.js";
import { onAgentMessage } from "./postProcess.js";
import { assigneeIds, canSeeRoom, getRoomRow, getVisibleRoom, roomVisibility, type RoomRow } from "./roomStore.js";
import { setAssignees } from "./rooms.js";
import { getSettings, verifyBalance } from "./workspaces.js";

export interface SendInput {
  kind: MessageKind;
  source: MessageSource;
  content?: string;
  format?: "text" | "html";
  subject?: string;
  from?: string;
  ref_message_id?: string;
  attachment_ids?: string[];
  client_msg_id?: string;
}

export const MAX_CONTENT_CHARS = 20000;

const SMS_KINDS: MessageKind[] = ["text", "ref"];
const EMAIL_KINDS: MessageKind[] = ["text", "ref", "image", "attachment", "gif", "voice"];
const ATTACH_KINDS: MessageKind[] = ["image", "attachment", "voice"];

function checkMatrix(input: SendInput): void {
  if (input.kind === "system") throw unprocessable("KIND_NOT_ALLOWED", "System messages cannot be created through the API");
  if (input.kind === "note" && input.source !== "dm") throw unprocessable("NOTE_SOURCE", "Internal notes are always dm");
  if (input.source === "sms" && !SMS_KINDS.includes(input.kind)) throw unprocessable("SMS_KIND_NOT_ALLOWED", "SMS supports text and quoted replies only");
  if (input.source === "email" && !EMAIL_KINDS.includes(input.kind)) throw unprocessable("EMAIL_KIND_NOT_ALLOWED", "This message kind cannot be sent by email");
  if (ATTACH_KINDS.includes(input.kind) && !input.attachment_ids?.length) throw unprocessable("ATTACHMENT_REQUIRED", `A ${input.kind} message needs an attachment`);
  if (!ATTACH_KINDS.includes(input.kind) && input.attachment_ids?.length)
    throw unprocessable("ATTACHMENT_NOT_ALLOWED", "Attachments are only allowed on image, voice and attachment messages");
  if (input.kind === "ref" && !input.ref_message_id) throw unprocessable("REF_REQUIRED", "ref_message_id is required for quoted replies");
}

/** Plain text for SMS; allow-list sanitised HTML for dm/email. `text` is always the searchable plain rendering. */
export function processContent(source: MessageSource, raw: string, format: "text" | "html" = "text"): { content: string; text: string } {
  if (raw.length > MAX_CONTENT_CHARS) throw unprocessable("CONTENT_TOO_LONG", `Content is limited to ${MAX_CONTENT_CHARS} characters`);
  if (source === "sms") {
    const text = cleanPlainText(format === "html" ? htmlToText(raw) : raw).trim();
    return { content: text, text };
  }
  if (format === "html") {
    const content = sanitizeHtml(raw).trim();
    return { content, text: htmlToText(content) };
  }
  const clean = cleanPlainText(raw).trim();
  return { content: textToHtml(clean), text: clean };
}

/** `@[Name](mem_xxx)` tokens plus bare `@localpart` of a member's email. Only seats that can see the room are kept. */
export async function parseMentions(ctx: AppContext, ws: string, room: RoomRow, text: string): Promise<string[]> {
  const members = await listMemberRows(ctx, ws);
  const found = new Set<string>();
  for (const m of text.matchAll(/@\[[^\]]*\]\((mem_[0-9a-f]{24})\)/g)) found.add(m[1]!);
  for (const m of text.matchAll(/(?:^|[\s(])@([a-z0-9._-]{2,40})\b/gi)) {
    const handle = m[1]!.toLowerCase();
    const hit = members.find((x) => x.email.split("@")[0]!.toLowerCase() === handle);
    if (hit) found.add(hit.id);
  }
  const visible: string[] = [];
  for (const id of found) {
    const m = members.find((x) => x.id === id);
    if (m && (await canSeeRoom(ctx, { role: m.role, memberId: m.id, inboxVisibility: m.inbox_visibility, workspaceId: ws }, room.id))) visible.push(id);
  }
  return visible;
}

async function existingByQid(ctx: AppContext, roomId: string, qid: string | undefined): Promise<MessageRow | undefined> {
  return qid ? await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND client_msg_id = ?", roomId, qid) : undefined;
}

async function validateRef(ctx: AppContext, room: RoomRow, refId: string | undefined): Promise<void> {
  if (!refId) return;
  if (!(await ctx.db.get("SELECT 1 FROM messages WHERE id = ? AND room_id = ? AND deleted_at IS NULL", refId, room.id)))
    throw unprocessable("INVALID_REF", "Quoted message not found in this conversation");
}

export interface SendResult {
  message: MessageRow;
  /** false when an identical client_msg_id had already been stored (idempotent replay) */
  created: boolean;
}

/**
 * Agent -> contact (or internal note). Order of operations is the contract:
 *  1. scope check, 2. idempotency lookup, 3. channel validation (no side effects), 4. one transaction that stores the message
 *  (+ channel lock, reopen/unsnooze), 5. provider send; on failure the message is kept with delivery=failed.
 * Steps 1-4 are synchronous, so two concurrent sends with the same client_msg_id cannot interleave: the second sees the first.
 */
export async function sendAgentMessage(ctx: AppContext, actor: Actor, roomId: string, input: SendInput): Promise<SendResult> {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const dup = await existingByQid(ctx, roomId, input.client_msg_id);
  if (dup) return { message: dup, created: false };
  checkMatrix(input);
  await validateRef(ctx, room, input.ref_message_id);
  const attachments = input.attachment_ids?.length ? await resolveAttachments(ctx, actor.workspaceId, input.attachment_ids) : [];
  const { content, text } = processContent(input.source, input.content ?? "", input.format);
  if (!text && !attachments.length && input.kind !== "gif") throw unprocessable("EMPTY_MESSAGE", "Message is empty");
  if (input.kind === "gif" && !/^https:\/\/\S+$/i.test(text)) throw unprocessable("INVALID_GIF", "A gif message needs an https URL as its content");

  const external = input.kind !== "note" && input.source !== "dm";
  const contact = await getContact(ctx, actor.workspaceId, room.contact_id);
  let route: { from: string; to: string; subject?: string; rfc?: string; inReplyTo?: string | null; references?: string[] } | null = null;

  if (external && input.source === "sms") {
    if (!contact.phone) throw unprocessable("CONTACT_PHONE_REQUIRED", "Add a phone number to this contact to send SMS");
    if (!isE164(contact.phone)) throw unprocessable("INVALID_PHONE", "The contact's phone number is not valid");
    if (contact.sms_opt_out) throw unprocessable("CONTACT_OPTED_OUT", "This contact has opted out of SMS");
    if (text.length > SMS_MAX_CHARS) throw unprocessable("SMS_TOO_LONG", "SMS messages must be shorter than 1600 characters");
    await verifyBalance(ctx, actor.workspaceId, "sms");
    route = { from: (await chooseSmsNumber(ctx, actor.workspaceId, roomId, contact.phone)).from, to: contact.phone };
  } else if (external && input.source === "email") {
    if (!contact.email) throw unprocessable("CONTACT_EMAIL_REQUIRED", "Add an email address to this contact to send email");
    await verifyBalance(ctx, actor.workspaceId, "email");
    const sender = await chooseEmailSender(ctx, actor.workspaceId, input.from);
    const firstContact = await ctx.db.get<{ content_text: string }>(
      "SELECT content_text FROM messages WHERE room_id = ? AND sender_type = 'contact' AND deleted_at IS NULL ORDER BY seq LIMIT 1",
      roomId,
    );
    const subject = input.subject?.trim() || deriveSubject(room.subject, firstContact?.content_text);
    const thread = await buildThread(ctx, roomId, sender.address);
    route = { from: sender.address, to: contact.email, subject, rfc: thread.messageId, inReplyTo: thread.inReplyTo, references: thread.references };
  }

  const mentions = input.kind === "note" ? await parseMentions(ctx, actor.workspaceId, room, text) : [];
  let result: InsertResult;
  try {
    result = await ctx.db.tx(async () => {
      if (route && external) await lockChannel(ctx, actor.workspaceId, roomId, input.source === "sms" ? "sms" : "email", route.from, route.to);
      const r = await insertMessage(ctx, {
        workspaceId: actor.workspaceId,
        roomId,
        senderType: "agent",
        senderId: actor.memberId,
        senderName: actor.name,
        kind: input.kind,
        source: input.source,
        content,
        contentText: text,
        subject: route?.subject ?? null,
        refMessageId: input.ref_message_id,
        attachments,
        clientMsgId: input.client_msg_id ?? null,
        delivery: external ? "pending" : "sent",
        mentions,
        rfcMessageId: route?.rfc ?? null,
        inReplyTo: route?.inReplyTo ?? null,
        referencesHdr: route?.references?.join(" ") ?? null,
        fromAddr: route?.from ?? null,
        toAddr: route?.to ?? null,
      });
      if (input.source === "email" && route?.subject && !room.subject) await ctx.db.run("UPDATE rooms SET subject = ? WHERE id = ?", route.subject, roomId);
      return r;
    });
  } catch (e) {
    // lost a race on (room_id, client_msg_id): hand back the winner
    if (isUniqueViolation(e)) {
      const winner = await existingByQid(ctx, roomId, input.client_msg_id);
      if (winner) return { message: winner, created: false };
    }
    throw e;
  }

  await emitInserted(ctx, result);
  if (input.kind !== "note" && !(await assigneeIds(ctx, roomId)).length) {
    // replying to an unassigned conversation takes ownership of it
    await setAssignees(ctx, await getRoomRow(ctx, actor.workspaceId, roomId), [actor.memberId], actor.name);
  }
  await onAgentMessage(ctx, await getRoomRow(ctx, actor.workspaceId, roomId), result.message, actor, mentions);
  const message = external ? await deliverMessage(ctx, result.message.id) : result.message;
  return { message, created: true };
}

export async function viewMessage(ctx: AppContext, m: MessageRow) {
  const room = await getRoomRow(ctx, m.workspace_id, m.room_id);
  return messageDto(ctx, m, { visitorReadSeq: room.visitor_read_seq, refs: await loadRefs(ctx, [m]) });
}

export interface ListOptions {
  before?: string;
  after?: string;
  limit: number;
}

export interface MessagePage {
  data: MessageRow[];
  pagination: { has_more_before: boolean; has_more_after: boolean; before_cursor: string | null; after_cursor: string | null };
}

/**
 * Cursor pagination by per-room `seq` (monotonic, so equal timestamps never reorder or skip).
 * No cursor = newest page. `before` pages toward older, `after` toward newer. Pages are returned oldest-first.
 */
export async function pageMessages(ctx: AppContext, roomId: string, opts: ListOptions & { hideNotes?: boolean }): Promise<MessagePage> {
  if (opts.before && opts.after) throw unprocessable("INVALID_CURSOR", "Use either before or after, not both");
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const base = `room_id = ? AND deleted_at IS NULL ${opts.hideNotes ? "AND kind != 'note'" : ""}`;
  const seqOf = async (id: string) => {
    const r = await ctx.db.get<{ seq: number }>("SELECT seq FROM messages WHERE id = ? AND room_id = ?", id, roomId);
    if (!r) throw unprocessable("INVALID_CURSOR", "Cursor message not found in this conversation");
    return r.seq;
  };
  let rows: MessageRow[];
  let moreOlder: boolean;
  let moreNewer: boolean;
  if (opts.after) {
    const s = await seqOf(opts.after);
    const got = await ctx.db.all<MessageRow>(`SELECT * FROM messages WHERE ${base} AND seq > ? ORDER BY seq ASC LIMIT ?`, roomId, s, limit + 1);
    moreNewer = got.length > limit;
    rows = got.slice(0, limit);
    moreOlder = !!(await ctx.db.get(`SELECT 1 FROM messages WHERE ${base} AND seq <= ? LIMIT 1`, roomId, s));
  } else {
    const upper = opts.before ? await seqOf(opts.before) : Number.MAX_SAFE_INTEGER;
    const got = await ctx.db.all<MessageRow>(`SELECT * FROM messages WHERE ${base} AND seq < ? ORDER BY seq DESC LIMIT ?`, roomId, upper, limit + 1);
    moreOlder = got.length > limit;
    rows = got.slice(0, limit).reverse();
    moreNewer = opts.before ? !!(await ctx.db.get(`SELECT 1 FROM messages WHERE ${base} AND seq >= ? LIMIT 1`, roomId, upper)) : false;
  }
  return {
    data: rows,
    pagination: {
      has_more_before: moreOlder,
      has_more_after: moreNewer,
      before_cursor: rows[0]?.id ?? null,
      after_cursor: rows[rows.length - 1]?.id ?? null,
    },
  };
}

export async function listMessagesForAgent(ctx: AppContext, actor: Actor, roomId: string, opts: ListOptions) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const page = await pageMessages(ctx, roomId, opts);
  return { data: await messageDtos(ctx, page.data, { visitorReadSeq: room.visitor_read_seq }), pagination: page.pagination };
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;

/** Literal substring search (wildcards and quotes in the query are data, not syntax) within the seat's scope. */
export async function searchMessages(ctx: AppContext, actor: Actor, q: { q: string; room_id?: string; limit: number }) {
  const vis = roomVisibility(actor);
  const rows = await ctx.db.all<MessageRow & { contact_name: string }>(
    `SELECT m.*, c.name AS contact_name FROM messages m JOIN rooms r ON r.id = m.room_id JOIN contacts c ON c.id = r.contact_id
     WHERE m.workspace_id = ? AND r.archived = 0 AND ${vis.sql} AND m.deleted_at IS NULL AND m.kind != 'system'
       AND m.content_text ${ctx.db.ilike} ? ESCAPE '\\' ${q.room_id ? "AND m.room_id = ?" : ""}
     ORDER BY m.created_at DESC, m.seq DESC LIMIT ?`,
    actor.workspaceId,
    ...vis.params,
    like(q.q),
    ...(q.room_id ? [q.room_id] : []),
    Math.min(q.limit, 50),
  );
  const dtos = await messageDtos(ctx, rows, { quotes: false });
  return dtos.map((d, i) => ({ ...d, contact_name: rows[i]!.contact_name }));
}

async function ownMessageOrThrow(ctx: AppContext, actor: Actor, id: string): Promise<{ msg: MessageRow; room: RoomRow }> {
  const msg = await findMessageRow(ctx, actor.workspaceId, id);
  if (!msg || msg.deleted_at) throw notFound("Message");
  const room = await getVisibleRoom(ctx, actor, msg.room_id);
  return { msg, room };
}

export async function editMessage(ctx: AppContext, actor: Actor, id: string, input: { content: string; format?: "text" | "html" }): Promise<MessageRow> {
  const { msg, room } = await ownMessageOrThrow(ctx, actor, id);
  if (msg.sender_type !== "agent" || msg.sender_id !== actor.memberId) throw forbidden("You can only edit your own messages");
  if (msg.source !== "dm" || !(msg.kind === "text" || msg.kind === "note" || msg.kind === "ref")) {
    throw unprocessable("NOT_EDITABLE", "Only chat messages and notes can be edited; sent SMS and email cannot be recalled");
  }
  const windowSec = (await getSettings(ctx, actor.workspaceId)).edit_window_seconds;
  if (windowSec <= 0) throw new AppError(403, "EDIT_DISABLED", "Editing messages is disabled for this workspace");
  if (ctx.clock().getTime() - Date.parse(msg.created_at) > windowSec * 1000)
    throw new AppError(403, "EDIT_WINDOW_EXPIRED", "The edit window for this message has passed");
  const { content, text } = processContent("dm", input.content, input.format);
  if (!text) throw unprocessable("EMPTY_MESSAGE", "Message is empty");
  await ctx.db.run("UPDATE messages SET content = ?, content_text = ?, edited_at = ? WHERE id = ?", content, text, nowIso(ctx), id);
  const fresh = (await findMessageRow(ctx, actor.workspaceId, id))!;
  await emitMessage(ctx, await getRoomRow(ctx, room.workspace_id, room.id), fresh, "message:updated");
  return fresh;
}

export async function deleteMessage(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  const { msg, room } = await ownMessageOrThrow(ctx, actor, id);
  if (msg.kind === "system") throw forbidden("System messages cannot be deleted");
  const own = msg.sender_type === "agent" && msg.sender_id === actor.memberId;
  if (!own && !seesAll(actor)) throw forbidden("You can only delete your own messages");
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?", nowIso(ctx), actor.memberId, id);
    await ctx.db.run("DELETE FROM message_mentions WHERE message_id = ?", id);
    if (room.last_message_id === id) await refreshLastMessage(ctx, room.id);
  });
  const payload = { message_id: id, room_id: room.id };
  ctx.bus.toRoom(room.workspace_id, room.id, "message:deleted", payload, msg.kind === "note" ? undefined : { visitor: payload });
}

export async function retryMessage(ctx: AppContext, actor: Actor, id: string): Promise<MessageRow> {
  const { msg } = await ownMessageOrThrow(ctx, actor, id);
  if (msg.delivery !== "failed") throw new AppError(409, "NOT_FAILED", "Only failed messages can be retried");
  return (await retryDelivery(ctx, id))!;
}
