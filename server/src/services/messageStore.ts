import { metricsMessage, metricsUnsnoozed } from "./roomMetrics.js";
import { putRef } from "./messageRefs.js";
import { TOPIC_MESSAGES, writeOutbox, type MessageEvent } from "../events/outbox.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Attachment, Delivery, MessageKind, MessageSource, SenderType } from "../domain/types.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { snippet } from "../util/html.js";
import { type RoomRow, getRoomRow } from "./roomStore.js";
import { publishTickets, ticketOnMessage } from "./tickets.js";

export interface MessageRow {
  id: string;
  workspace_id: string;
  room_id: string;
  seq: number;
  client_msg_id: string | null;
  sender_type: SenderType;
  sender_id: string | null;
  sender_name: string;
  kind: MessageKind;
  source: MessageSource;
  content: string;
  content_text: string;
  subject: string | null;
  ref_message_id: string | null;
  attachments: string;
  meta: string;
  delivery: Delivery;
  failure_reason: string | null;
  provider_message_id: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  from_addr: string | null;
  to_addr: string | null;
  retry_count: number;
  delivered_at: string | null;
  opened_at: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  /** the ticket (episode of support) the message belongs to; NULL for messages written before tickets existed or outside any issue */
  ticket_id: string | null;
  created_at: string;
}

export interface NewMessage {
  workspaceId: string;
  roomId: string;
  senderType: SenderType;
  senderId?: string | null;
  senderName?: string;
  kind: MessageKind;
  source: MessageSource;
  content: string;
  contentText?: string;
  subject?: string | null;
  refMessageId?: string | null;
  attachments?: Attachment[];
  meta?: Record<string, unknown>;
  clientMsgId?: string | null;
  delivery?: Delivery;
  providerMessageId?: string | null;
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  referencesHdr?: string | null;
  fromAddr?: string | null;
  toAddr?: string | null;
  mentions?: string[];
  /** set by `insertMessage` from the ticket state machine; callers do not pass it */
  ticketId?: string | null;
}

export interface InsertResult {
  message: MessageRow;
  room: RoomRow;
  reopened: boolean;
  unsnoozed: boolean;
  /** system rows written alongside (status change), already persisted */
  extra: MessageRow[];
  /** tickets whose state this message changed (opened, reopened, taken over): published after commit by `emitInserted` */
  tickets: string[];
  /** a person who just joined a ticket by replying (the visitor is told by `emitInserted`) */
  joined: string | null;
}

async function rawInsert(ctx: AppContext, m: NewMessage, now: string): Promise<MessageRow> {
  const bump = await ctx.db.get<{ next_seq: number }>("UPDATE rooms SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq", m.roomId);
  if (!bump) throw new Error("room vanished");
  const id = newId("msg");
  // the idempotency claim commits or rolls back with the message; a duplicate client_msg_id fails here as a unique violation
  if (m.clientMsgId) await ctx.db.run("INSERT INTO message_qids(room_id, client_msg_id, message_id, created_at) VALUES (?,?,?,?)", m.roomId, m.clientMsgId, id, now);
  const row = await ctx.db.get<MessageRow>(
    `INSERT INTO messages(id, workspace_id, room_id, seq, client_msg_id, sender_type, sender_id, sender_name, kind, source, content, content_text, subject,
       ref_message_id, attachments, meta, delivery, provider_message_id, rfc_message_id, in_reply_to, references_hdr, from_addr, to_addr, ticket_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    id,
    m.workspaceId,
    m.roomId,
    bump.next_seq,
    m.clientMsgId ?? null,
    m.senderType,
    m.senderId ?? null,
    m.senderName ?? "",
    m.kind,
    m.source,
    m.content,
    m.contentText ?? m.content,
    m.subject ?? null,
    m.refMessageId ?? null,
    JSON.stringify(m.attachments ?? []),
    JSON.stringify(m.meta ?? {}),
    m.delivery ?? "sent",
    m.providerMessageId ?? null,
    m.rfcMessageId ?? null,
    m.inReplyTo ?? null,
    m.referencesHdr ?? null,
    m.fromAddr ?? null,
    m.toAddr ?? null,
    m.ticketId ?? null,
    now,
  );
  const mentioned = [...new Set(m.mentions ?? [])];
  if (mentioned.length) {
    // one statement however many people are mentioned
    await ctx.db.run(
      `INSERT OR IGNORE INTO message_mentions(message_id, room_id, workspace_id, member_id) VALUES ${mentioned.map(() => "(?,?,?,?)").join(",")}`,
      ...mentioned.flatMap((member) => [id, m.roomId, m.workspaceId, member]),
    );
  }
  // locators for lookups that do not know the room (provider callbacks, email threading, external-message jobs)
  const loc = { id, workspace_id: m.workspaceId, room_id: m.roomId };
  if (m.providerMessageId) await putRef(ctx, "provider", m.providerMessageId, loc);
  if (m.rfcMessageId) await putRef(ctx, "rfc", m.rfcMessageId, loc);
  if (m.source !== "dm") await putRef(ctx, "id", id, loc);
  // the event commits with the message (insertMessage wraps this in its transaction); a relay publishes it after commit
  await writeOutbox(ctx, TOPIC_MESSAGES, m.roomId, {
    type: "message.created",
    workspace_id: m.workspaceId,
    room_id: m.roomId,
    message_id: id,
    seq: bump.next_seq,
    sender_type: m.senderType,
    kind: m.kind,
    source: m.source,
    ticket_id: m.ticketId ?? null,
    created_at: now,
  } satisfies MessageEvent);
  return row!;
}

/**
 * Persists a message and applies the room state rules in one transaction:
 *  - a contact or agent message (notes included) reopens a closed room,
 *  - any non-system message clears a snooze,
 *  - system messages never change state.
 * Callers that need idempotency check `client_msg_id` first and rely on the unique index as the backstop.
 */
export async function insertMessage(ctx: AppContext, m: NewMessage): Promise<InsertResult> {
  return await ctx.db.tx(async () => {
    const now = nowIso(ctx);
    const before = await getRoomRow(ctx, m.workspaceId, m.roomId);
    const extra: MessageRow[] = [];
    // the ticket state machine runs in this transaction: the message is stored with the ticket it belongs to, or opens one
    const attach = await ticketOnMessage(ctx, before, { senderType: m.senderType, senderId: m.senderId, kind: m.kind, source: m.source, text: m.contentText ?? m.content }, now);
    const reopens = (m.senderType === "contact" || m.senderType === "agent") && before.status === "closed";
    if (reopens) {
      const reason = m.senderType === "contact" ? "contact_message" : m.kind === "note" ? "note" : "agent_message";
      extra.push(
        await rawInsert(
          ctx,
          {
            workspaceId: m.workspaceId,
            roomId: m.roomId,
            senderType: "system",
            kind: "system",
            source: "dm",
            content: "Conversation reopened",
            meta: { sub_type: "status", status: "open", reason, actor_id: m.senderId ?? null },
            ticketId: attach.ticketId,
          },
          now,
        ),
      );
    }
    const message = await rawInsert(ctx, { ...m, ticketId: attach.ticketId }, now);
    const unsnoozed = m.senderType !== "system" && before.snooze_until !== null;
    // status/assignment lines are not "the last message" shown in lists
    const isSystem = m.senderType === "system";
    await ctx.db.run(
      `UPDATE rooms SET last_message_id = CASE WHEN ? = 1 THEN last_message_id ELSE ? END, last_message_at = CASE WHEN ? = 1 THEN last_message_at ELSE ? END,
         last_message_seq = CASE WHEN ? = 1 THEN last_message_seq ELSE ? END, last_brief = CASE WHEN ? = 1 THEN last_brief ELSE ? END, updated_at = ?,
         last_contact_message_at = CASE WHEN ? = 'contact' THEN ? ELSE last_contact_message_at END,
         digest_due = CASE WHEN ? = 'contact' THEN 1 ELSE digest_due END,
         status = CASE WHEN ? = 1 THEN 'open' ELSE status END,
         snooze_until = CASE WHEN ? = 1 THEN NULL ELSE snooze_until END,
         snoozed_by = CASE WHEN ? = 1 THEN NULL ELSE snoozed_by END
       WHERE id = ?`,
      isSystem,
      message.id,
      isSystem,
      now,
      isSystem,
      message.seq,
      isSystem,
      JSON.stringify(lastMessageBrief(message)),
      now,
      m.senderType,
      now,
      m.senderType,
      reopens,
      unsnoozed,
      unsnoozed,
      m.roomId,
    );
    if (unsnoozed) await metricsUnsnoozed(ctx, m.workspaceId, m.roomId, now);
    await metricsMessage(ctx, before, message, reopens, now);
    return { message, room: await getRoomRow(ctx, m.workspaceId, m.roomId), reopened: reopens, unsnoozed, extra, tickets: attach.touched, joined: attach.joined ?? null };
  });
}

/** `roomId` (when the caller knows it) keeps the query on one hash partition; without it the lookup probes every partition. */
export const findMessageRow = (ctx: AppContext, workspaceId: string, id: string, roomId?: string) =>
  roomId
    ? ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND id = ? AND workspace_id = ?", roomId, id, workspaceId)
    : ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND workspace_id = ?", id, workspaceId);

/** Quoted messages referenced by `rows`, fetched in one query (no per-message lookups). */
export type RefMap = Map<string, MessageRow>;

export async function loadRefs(ctx: AppContext, rows: MessageRow[]): Promise<RefMap> {
  const ids = [...new Set(rows.map((r) => r.ref_message_id).filter((v): v is string => !!v))];
  if (!ids.length) return new Map();
  // quoted messages live in the same room as the quoting one: stay on the rooms' partitions
  const rooms = [...new Set(rows.map((r) => r.room_id))];
  const found = await ctx.db.all<MessageRow>(`SELECT * FROM messages WHERE room_id IN (${rooms.map(() => "?").join(",")}) AND id IN (${ids.map(() => "?").join(",")})`, ...rooms, ...ids);
  return new Map(found.map((r) => [r.id, r]));
}

export interface DtoOptions {
  visitorReadSeq?: number;
  /** prefetched quoted messages (see loadRefs); when absent no quote is rendered */
  refs?: RefMap;
}

export function messageDto(ctx: AppContext, m: MessageRow, opts: DtoOptions = {}) {
  const attachments = parseJson<Attachment[]>(m.attachments, []).map((a) => ({
    ...a,
    url: ctx.storage.signedUrl(a.key, { fileName: a.file_name, contentType: a.content_type, ttlSeconds: ctx.config.SIGNED_URL_TTL_SECONDS }),
  }));
  let ref: unknown = null;
  const r = m.ref_message_id ? opts.refs?.get(m.ref_message_id) : undefined;
  if (r && r.workspace_id === m.workspace_id) {
    ref = {
      id: r.id,
      sender_name: r.sender_name,
      sender_type: r.sender_type,
      kind: r.kind,
      snippet: r.deleted_at ? "" : snippet(r.content_text, 140),
      deleted: !!r.deleted_at,
    };
  }
  const deleted = !!m.deleted_at;
  return {
    id: m.id,
    room_id: m.room_id,
    ticket_id: m.ticket_id ?? null,
    seq: m.seq,
    client_msg_id: m.client_msg_id,
    sender: { type: m.sender_type, id: m.sender_id, name: m.sender_name },
    kind: m.kind,
    source: m.source,
    content: deleted ? "" : m.content,
    content_text: deleted ? "" : m.content_text,
    subject: m.subject,
    ref,
    attachments: deleted ? [] : attachments,
    meta: deleted ? {} : publicMeta(m),
    delivery: m.delivery,
    failure_reason: m.failure_reason,
    delivered_at: m.delivered_at,
    opened_at: m.opened_at,
    read: opts.visitorReadSeq !== undefined && m.sender_type !== "contact" ? m.seq <= opts.visitorReadSeq || !!m.opened_at : !!m.opened_at,
    edited_at: m.edited_at,
    deleted,
    created_at: m.created_at,
  };
}

export async function messageDtos(ctx: AppContext, rows: MessageRow[], opts: { visitorReadSeq?: number; quotes?: boolean } = {}) {
  const refs = opts.quotes === false ? undefined : await loadRefs(ctx, rows);
  return rows.map((m) => messageDto(ctx, m, { visitorReadSeq: opts.visitorReadSeq, refs }));
}

function publicMeta(m: MessageRow) {
  const meta = parseJson<Record<string, unknown>>(m.meta, {});
  return meta;
}

/**
 * System lines a visitor may see, by `meta.sub_type` (an allow-list: a new kind of system line is internal until it is added here).
 * "Conversation started" and payment confirmations are about the customer; assignment, status, priority, snooze, SMS consent and
 * reopen/close markers describe the team's work and name agents, so they stay in the team views.
 */
export const VISITOR_SYSTEM_SUBTYPES = ["create", "payment", "ticket_resolved", "agent_joined", "handed_back", "call", "call_request"] as const;
/** SQL predicate over `messages` columns for what a visitor may be shown (notes and internal system lines excluded). meta is compact JSON written by this server. */
export const VISITOR_VISIBLE_SQL = `kind != 'note' AND (kind != 'system' OR ${VISITOR_SYSTEM_SUBTYPES.map((s) => `meta LIKE '%"sub_type":"${s}"%'`).join(" OR ")})`;
export function visibleToVisitor(m: Pick<MessageRow, "kind" | "meta">): boolean {
  if (m.kind === "note") return false;
  if (m.kind !== "system") return true;
  const sub = parseJson<{ sub_type?: string }>(m.meta, {}).sub_type;
  return !!sub && (VISITOR_SYSTEM_SUBTYPES as readonly string[]).includes(sub);
}

/**
 * The widget offers a satisfaction rating once the team closed the conversation and nothing real was said after. That used to be read
 * from the close marker line in the message list; the line is internal now, so the server states it: the marker's id and seq, or null.
 */
export async function closedMarker(ctx: AppContext, room: { id: string; status: string }): Promise<{ id: string; seq: number } | null> {
  if (room.status !== "closed") return null;
  const rows = await ctx.db.all<{ id: string; seq: number; kind: string; sender_type: string; meta: string }>(
    "SELECT id, seq, kind, sender_type, meta FROM messages WHERE room_id = ? AND deleted_at IS NULL AND kind != 'note' ORDER BY seq DESC LIMIT 30",
    room.id,
  );
  for (const m of rows) {
    if (m.sender_type === "system") {
      const meta = parseJson<{ sub_type?: string; status?: string }>(m.meta, {});
      if (meta.sub_type === "status") return meta.status === "closed" ? { id: m.id, seq: m.seq } : null;
      continue;
    }
    return null;
  }
  return null;
}

/** Fields the visitor widget may see: notes never reach it, internal meta (triage) is stripped. */
export function visitorMessageDto(ctx: AppContext, m: MessageRow, visitorReadSeq: number, refs?: RefMap) {
  const dto = messageDto(ctx, m, { visitorReadSeq, refs });
  const { sub_type, ai, status, card, agent, sources, call, kind } = dto.meta as Record<string, unknown>;
  // `agent` names the AI agent and its disclosure label; `sources` are the help-centre links under its answer
  return { ...dto, subject: m.source === "email" ? dto.subject : null, from_addr: undefined, meta: { sub_type, ai, status, ...(card ? { card } : {}), ...(agent ? { agent } : {}), ...(sources ? { sources } : {}), ...(call ? { call } : {}), ...(sub_type === "call_request" && kind ? { kind } : {}) }, failure_reason: null };
}

export async function visitorMessageDtos(ctx: AppContext, rows: MessageRow[], visitorReadSeq: number) {
  const refs = await loadRefs(ctx, rows);
  return rows.map((m) => visitorMessageDto(ctx, m, visitorReadSeq, refs));
}

export async function roomPatch(ctx: AppContext, room: RoomRow) {
  return {
    id: room.id,
    status: room.status,
    priority: room.priority,
    snooze_until: room.snooze_until,
    last_message_at: room.last_message_at,
    last_contact_message_at: room.last_contact_message_at,
    updated_at: room.updated_at,
    last_message: await lastBriefOf(ctx, room),
  };
}

/**
 * The room's "last message" card straight from the denormalised column (no messages-table access). Rooms that predate the column are
 * filled in on first read.
 */
export async function lastBriefOf(ctx: AppContext, room: Pick<RoomRow, "id" | "last_message_id" | "last_brief">): Promise<ReturnType<typeof lastMessageBrief> | null> {
  if (room.last_brief) return JSON.parse(room.last_brief);
  if (!room.last_message_id) return null;
  const m = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND id = ?", room.id, room.last_message_id);
  const brief = m && !m.deleted_at ? lastMessageBrief(m) : null;
  if (brief) await ctx.db.run("UPDATE rooms SET last_brief = ? WHERE id = ? AND last_brief IS NULL", JSON.stringify(brief), room.id);
  return brief;
}

export const lastMessageBrief = (m: MessageRow) => ({
  id: m.id,
  kind: m.kind,
  source: m.source,
  sender_type: m.sender_type,
  sender_name: m.sender_name,
  snippet: snippet(m.content_text || (m.attachments !== "[]" ? "Attachment" : ""), 120),
  created_at: m.created_at,
});

/** Broadcast a stored message: notes and internal system lines stay on the team channel; customer-facing messages also reach the visitor. */
export async function emitMessage(ctx: AppContext, room: RoomRow, m: MessageRow, event: "message:new" | "message:updated" = "message:new"): Promise<void> {
  await ctx.cache.invalidate(`counts:${room.workspace_id}:*`);
  const refs = await loadRefs(ctx, [m]);
  const payload = { message: messageDto(ctx, m, { visitorReadSeq: room.visitor_read_seq, refs }), room: await roomPatch(ctx, room) };
  const visitor = !visibleToVisitor(m) ? undefined : { message: visitorMessageDto(ctx, m, room.visitor_read_seq, refs), room: { id: room.id, status: room.status } };
  ctx.bus.toRoom(room.workspace_id, room.id, event, payload, visitor === undefined ? undefined : { visitor });
}

/** Insert + broadcast a system line ("Assigned to X", "Snooze ended"). */
export async function postSystemMessage(ctx: AppContext, roomId: string, workspaceId: string, text: string, meta: Record<string, unknown> = {}): Promise<MessageRow> {
  const r = await insertMessage(ctx, { workspaceId, roomId, senderType: "system", kind: "system", source: "dm", content: text, meta });
  await emitMessage(ctx, r.room, r.message);
  return r.message;
}

/** After a delete, point the room's "last message" at the newest surviving message. */
export async function refreshLastMessage(ctx: AppContext, roomId: string): Promise<void> {
  const last = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND kind != 'system' ORDER BY seq DESC LIMIT 1", roomId);
  await ctx.db.run(
    "UPDATE rooms SET last_message_id = ?, last_message_at = COALESCE(?, created_at), last_message_seq = ?, last_brief = ? WHERE id = ?",
    last?.id ?? null,
    last?.created_at ?? null,
    last?.seq ?? 0,
    last ? JSON.stringify(lastMessageBrief(last)) : null,
    roomId,
  );
}

/** Emit everything an insert produced, in order: status line(s) first, then the message itself. */
export async function emitInserted(ctx: AppContext, r: InsertResult): Promise<void> {
  for (const e of r.extra) await emitMessage(ctx, r.room, e);
  await emitMessage(ctx, r.room, r.message);
  if (r.tickets.length) await publishTickets(ctx, r.tickets);
  if (r.joined) await postSystemMessage(ctx, r.room.id, r.room.workspace_id, `${r.message.sender_name || "A team member"} joined the conversation`, { sub_type: "agent_joined", actor_id: r.joined });
}
