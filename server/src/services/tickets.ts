import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation, type Param } from "../db/index.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { snippet } from "../util/html.js";
import { recordAudit } from "./audit.js";
import { emitInserted, insertMessage } from "./messageStore.js";
import { getRoomRow, roomVisibility, type RoomRow } from "./roomStore.js";
import { publishRoomUpdated } from "./rooms.js";
import { getSettings } from "./workspaces.js";

/**
 * Tickets: an episode of support inside a room (docs/AI-AGENTS.md, ADR 0027). A room stays one per contact; a ticket opens with the first
 * message of an issue and ends with `resolved` / `closed`. Closing a ticket never closes the room, and the other way round only resolves
 * the live ticket. At most one ticket per room is live (not `closed`): the partial unique index `ux_tickets_room_live` arbitrates races.
 *
 *   new -> bot_handling | waiting_for_human | open -> pending_customer <-> open -> resolved -> closed
 *   a customer message reopens `resolved` (inside `tickets.reopen_hours`) and `pending_customer`; later it opens a new ticket
 */
export const TICKET_STATUSES = ["new", "bot_handling", "waiting_for_human", "open", "pending_customer", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_RESOLUTIONS = ["bot_resolved", "human_resolved", "abandoned", "auto_closed", "merged"] as const;
export type TicketResolution = (typeof TICKET_RESOLUTIONS)[number];
export const PRIORITY_NAMES = ["low", "normal", "high", "urgent"] as const;

export interface TicketRow {
  id: string;
  workspace_id: string;
  room_id: string;
  contact_id: string;
  number: number;
  subject: string;
  subject_set_by: "auto" | "agent";
  status: TicketStatus;
  handler: string | null;
  department_id: string | null;
  priority: 0 | 1 | 2 | 3;
  resolution: TicketResolution | null;
  channel: "dm" | "sms" | "email";
  opened_at: string;
  first_response_at: string | null;
  handoff_at: string | null;
  first_human_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  csat: number | null;
  csat_comment: string | null;
  tags: string;
  summary: string;
  handoff_reason: string | null;
  merged_into_id: string | null;
  last_activity_at: string;
  meta: string;
  created_at: string;
  updated_at: string;
}

export type TicketActor = { type: "contact" } | { type: "member"; id: string } | { type: "bot"; id: string } | { type: "system" };

const SUBJECT_MAX = 120;

/** First line of what the customer wrote, shortened: the subject until an agent or the AI agent improves it. */
export function subjectFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line ? snippet(line, SUBJECT_MAX) : "New conversation";
}

export const handlerOf = (h: string | null): { type: "bot" | "human"; id: string } | null => {
  if (!h) return null;
  const i = h.indexOf(":");
  const type = h.slice(0, i);
  return type === "bot" || type === "human" ? { type, id: h.slice(i + 1) } : null;
};

export function ticketDto(t: TicketRow) {
  return {
    id: t.id,
    number: t.number,
    room_id: t.room_id,
    contact_id: t.contact_id,
    subject: t.subject,
    subject_set_by: t.subject_set_by,
    status: t.status,
    handler: t.handler,
    department_id: t.department_id,
    priority: t.priority,
    resolution: t.resolution,
    channel: t.channel,
    opened_at: t.opened_at,
    first_response_at: t.first_response_at,
    handoff_at: t.handoff_at,
    first_human_response_at: t.first_human_response_at,
    resolved_at: t.resolved_at,
    closed_at: t.closed_at,
    csat: t.csat,
    csat_comment: t.csat_comment,
    tags: parseJson<string[]>(t.tags, []),
    summary: t.summary,
    handoff_reason: t.handoff_reason,
    merged_into_id: t.merged_into_id,
    last_activity_at: t.last_activity_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}
export type TicketDto = ReturnType<typeof ticketDto>;

/** What the room list and the thread header need: small, no free text beyond the subject. */
export const ticketBrief = (t: TicketRow) => ({ id: t.id, number: t.number, status: t.status, handler: t.handler, department_id: t.department_id, priority: t.priority, subject: t.subject });

/** What a visitor may know: the number and whether a rating is due. Never handler ids, departments or tags. */
export const visitorTicketDto = (t: TicketRow) => ({
  id: t.id,
  number: t.number,
  status: t.status,
  resolved: t.status === "resolved" || t.status === "closed",
  csat_pending: (t.status === "resolved" || t.status === "closed") && t.csat === null && t.resolution !== "merged",
});

export const findTicket = (ctx: AppContext, ws: string, id: string) => ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ? AND workspace_id = ?", id, ws);
export const liveTicketOf = (ctx: AppContext, roomId: string) => ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE room_id = ? AND status <> 'closed'", roomId);

/** A ticket the actor may see: the same scope as its room (404 otherwise, existence is not leaked). */
export async function getVisibleTicket(ctx: AppContext, actor: Actor, id: string): Promise<TicketRow> {
  const v = roomVisibility(actor);
  const t = await ctx.db.get<TicketRow>(
    `SELECT t.* FROM tickets t JOIN rooms r ON r.id = t.room_id WHERE t.id = ? AND t.workspace_id = ? AND r.archived = 0 AND ${v.sql}`,
    id,
    actor.workspaceId,
    ...v.params,
  );
  if (!t) throw notFound("Ticket");
  return t;
}

export async function recordTicketEvent(ctx: AppContext, t: Pick<TicketRow, "id" | "workspace_id">, type: string, actor: TicketActor, detail: Record<string, unknown> = {}, at = nowIso(ctx)): Promise<void> {
  await ctx.db.run(
    "INSERT INTO ticket_events(id, workspace_id, ticket_id, type, actor_type, actor_id, detail, created_at) VALUES (?,?,?,?,?,?,?,?)",
    newId("tev"),
    t.workspace_id,
    t.id,
    type,
    actor.type,
    "id" in actor ? actor.id : null,
    JSON.stringify(detail),
    at,
  );
}

async function nextNumber(ctx: AppContext, ws: string): Promise<number> {
  const r = await ctx.db.get<{ next_number: number }>(
    "INSERT INTO ticket_counters(workspace_id, next_number) VALUES (?, 1) ON CONFLICT(workspace_id) DO UPDATE SET next_number = ticket_counters.next_number + 1 RETURNING next_number",
    ws,
  );
  return r!.next_number;
}

export interface OpenTicketInput {
  room: Pick<RoomRow, "id" | "workspace_id" | "contact_id" | "inbox_id" | "priority">;
  channel: "dm" | "sms" | "email";
  subject: string;
  status?: TicketStatus;
  handler?: string | null;
  by: TicketActor;
}

/** Insert a ticket in the caller's transaction. A lost race on the live-ticket index surfaces as a unique violation for the caller to resolve. */
export async function openTicket(ctx: AppContext, i: OpenTicketInput, now: string): Promise<TicketRow> {
  const id = newId("tkt");
  const number = await nextNumber(ctx, i.room.workspace_id);
  const row = await ctx.db.get<TicketRow>(
    `INSERT INTO tickets(id, workspace_id, room_id, contact_id, number, subject, status, handler, department_id, priority, channel, opened_at, last_activity_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    id,
    i.room.workspace_id,
    i.room.id,
    i.room.contact_id,
    number,
    i.subject,
    i.status ?? "new",
    i.handler ?? null,
    i.room.inbox_id,
    i.room.priority === 1 ? 2 : 1,
    i.channel,
    now,
    now,
    now,
    now,
  );
  await recordTicketEvent(ctx, row!, "opened", i.by, { channel: i.channel }, now);
  return row!;
}

/** What `insertMessage` tells us about the message it is about to store. */
export interface TicketMessageFacts {
  senderType: "agent" | "contact" | "bot" | "system";
  senderId?: string | null;
  kind: string;
  source: "dm" | "sms" | "email";
  text: string;
}

export interface TicketAttach {
  /** the ticket the message belongs to (null when it belongs to none: a welcome line before any issue) */
  ticketId: string | null;
  /** tickets whose state changed in this transaction: `publishTickets` sends them to the team and the visitor after commit */
  touched: string[];
}

/**
 * The ticket state machine for one stored message. Runs inside `insertMessage`'s transaction, so the ticket and the message commit together
 * and no message is ever stored with a stale ticket. Customer messages open or reopen tickets; human replies take a ticket over from the
 * AI agent (a bot never talks over a person); bot, note and system lines only attach.
 */
export async function ticketOnMessage(ctx: AppContext, room: RoomRow, m: TicketMessageFacts, now: string): Promise<TicketAttach> {
  const live = await liveTicketOf(ctx, room.id);
  const touched = new Set<string>();
  const touch = (t: TicketRow) => touched.add(t.id);

  if (m.senderType === "system" || m.kind === "note" || m.kind === "system") return { ticketId: live?.id ?? null, touched: [] };

  if (m.senderType === "bot") {
    if (!live) return { ticketId: null, touched: [] };
    if (!live.first_response_at) {
      await ctx.db.run("UPDATE tickets SET first_response_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?", now, now, now, live.id);
      touch(live);
    }
    return { ticketId: live.id, touched: [...touched] };
  }

  if (m.senderType === "contact") {
    let t = live;
    if (t?.status === "resolved") {
      const hours = (await getSettings(ctx, room.workspace_id)).tickets.reopen_hours;
      if (hours > 0 && Date.parse(now) - Date.parse(t.resolved_at ?? t.updated_at) <= hours * 3600_000) {
        const h = handlerOf(t.handler);
        const status: TicketStatus = h?.type === "human" ? "open" : h?.type === "bot" ? "bot_handling" : "new";
        t = (await ctx.db.get<TicketRow>(
          "UPDATE tickets SET status = ?, resolution = NULL, resolved_at = NULL, csat = NULL, csat_comment = NULL, last_activity_at = ?, updated_at = ? WHERE id = ? RETURNING *",
          status,
          now,
          now,
          t.id,
        ))!;
        await recordTicketEvent(ctx, t, "reopened", { type: "contact" }, { reason: "customer_message", status }, now);
        touch(t);
        return { ticketId: t.id, touched: [...touched] };
      }
      await closeRow(ctx, t, null, { type: "system" }, now);
      t = undefined;
    }
    if (!t) {
      try {
        // a savepoint, so that losing the race does not abort the surrounding transaction on PostgreSQL
        const opened = await ctx.db.tx(() => openTicket(ctx, { room, channel: m.source, subject: subjectFrom(m.text), by: { type: "contact" } }, now));
        touch(opened);
        return { ticketId: opened.id, touched: [...touched] };
      } catch (e) {
        // two first messages raced: the other transaction's ticket is the one to join
        if (!isUniqueViolation(e)) throw e;
        const winner = await liveTicketOf(ctx, room.id);
        if (!winner) throw e;
        return { ticketId: winner.id, touched: [] };
      }
    }
    const status: TicketStatus = t.status === "pending_customer" ? "open" : t.status;
    // a customer message re-arms the idle clock; the subject of an untouched ticket follows the first real message
    await ctx.db.run("UPDATE tickets SET status = ?, last_activity_at = ?, updated_at = ? WHERE id = ?", status, now, now, t.id);
    if (status !== t.status) {
      await recordTicketEvent(ctx, t, "customer_replied", { type: "contact" }, { from: t.status }, now);
      touch(t);
    }
    return { ticketId: t.id, touched: [...touched] };
  }

  // agent message (a person)
  const agentId = m.senderId ?? null;
  if (!live) {
    try {
      const opened = await ctx.db.tx(async () => {
        const o = await openTicket(ctx, { room, channel: m.source, subject: subjectFrom(m.text), status: "open", handler: agentId ? `human:${agentId}` : null, by: { type: "member", id: agentId ?? "" } }, now);
        await ctx.db.run("UPDATE tickets SET first_response_at = ?, first_human_response_at = ? WHERE id = ?", now, now, o.id);
        return o;
      });
      touch(opened);
      return { ticketId: opened.id, touched: [...touched] };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const winner = await liveTicketOf(ctx, room.id);
      if (!winner) throw e;
      return { ticketId: winner.id, touched: [] };
    }
  }
  let status = live.status;
  let handler = live.handler;
  if (status === "new" || status === "bot_handling" || status === "waiting_for_human") {
    const wasBot = status === "bot_handling" || handlerOf(live.handler)?.type === "bot";
    status = "open";
    handler = agentId ? `human:${agentId}` : live.handler;
    await recordTicketEvent(ctx, live, wasBot ? "taken_over" : "accepted", agentId ? { type: "member", id: agentId } : { type: "system" }, { from: live.status, by_reply: true }, now);
  } else if (status === "resolved") {
    status = "open";
    await recordTicketEvent(ctx, live, "reopened", agentId ? { type: "member", id: agentId } : { type: "system" }, { reason: "agent_message" }, now);
  } else if (!handler && agentId) handler = `human:${agentId}`;
  await ctx.db.run(
    `UPDATE tickets SET status = ?, handler = ?, resolution = CASE WHEN ? = 'resolved' THEN resolution ELSE NULL END, resolved_at = CASE WHEN ? = 'resolved' THEN resolved_at ELSE NULL END,
       first_response_at = COALESCE(first_response_at, ?), first_human_response_at = COALESCE(first_human_response_at, ?), last_activity_at = ?, updated_at = ? WHERE id = ?`,
    status,
    handler,
    status,
    status,
    now,
    now,
    now,
    now,
    live.id,
  );
  if (status !== live.status || handler !== live.handler || !live.first_human_response_at) touch(live);
  return { ticketId: live.id, touched: [...touched] };
}

/** Tell the team (and the visitor) a ticket changed. Called after commit. */
export async function publishTickets(ctx: AppContext, ids: string[]): Promise<void> {
  for (const id of new Set(ids)) {
    const t = await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", id);
    if (!t) continue;
    ctx.bus.toRoom(t.workspace_id, t.room_id, "ticket:updated", { ticket: ticketDto(t) }, { visitor: { room_id: t.room_id, ticket: visitorTicketDto(t) } });
  }
}

/* ---------- transitions ---------- */

async function closeRow(ctx: AppContext, t: TicketRow, resolution: TicketResolution | null, by: TicketActor, now: string): Promise<TicketRow> {
  const res = resolution ?? t.resolution ?? (t.first_human_response_at ? "human_resolved" : t.first_response_at ? "abandoned" : "auto_closed");
  const row = await ctx.db.get<TicketRow>(
    "UPDATE tickets SET status = 'closed', resolution = ?, resolved_at = COALESCE(resolved_at, ?), closed_at = ?, updated_at = ? WHERE id = ? AND status <> 'closed' RETURNING *",
    res,
    now,
    now,
    now,
    t.id,
  );
  if (!row) return t;
  await recordTicketEvent(ctx, row, "closed", by, { resolution: res }, now);
  return row;
}

export interface ResolveOptions {
  resolution?: TicketResolution;
  /** do not post the closing message / rating card (the customer just confirmed it themselves) */
  silent?: boolean;
  reason?: string;
}

/** Mark the live ticket of a room resolved. Idempotent: a ticket that is already resolved or closed is returned unchanged. */
export async function resolveTicketRow(ctx: AppContext, ticketId: string, by: TicketActor, opts: ResolveOptions = {}): Promise<TicketRow | undefined> {
  const now = nowIso(ctx);
  const t = await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", ticketId);
  if (!t || t.status === "resolved" || t.status === "closed") return t;
  const resolution: TicketResolution = opts.resolution ?? (by.type === "bot" ? "bot_resolved" : by.type === "member" ? "human_resolved" : "abandoned");
  const row = await ctx.db.get<TicketRow>(
    "UPDATE tickets SET status = 'resolved', resolution = ?, resolved_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('resolved','closed') RETURNING *",
    resolution,
    now,
    now,
    now,
    t.id,
  );
  if (!row) return t;
  await recordTicketEvent(ctx, row, "resolved", by, { resolution, reason: opts.reason ?? null }, now);
  return row;
}

/** Everything around a resolved ticket that the customer sees: the closing line with the rating card. */
export async function announceResolved(ctx: AppContext, t: TicketRow): Promise<void> {
  const s = (await getSettings(ctx, t.workspace_id)).tickets;
  if (s.closing_message.trim() || s.csat_prompt) {
    const r = await insertMessage(ctx, {
      workspaceId: t.workspace_id,
      roomId: t.room_id,
      senderType: "system",
      kind: "system",
      source: "dm",
      content: s.closing_message,
      contentText: s.closing_message,
      meta: { sub_type: "ticket_resolved", ticket_id: t.id, ...(s.csat_prompt ? { card: { type: "csat", ticket_id: t.id, ticket_number: t.number } } : {}) },
    });
    await emitInserted(ctx, r);
  }
}

export async function resolveTicket(ctx: AppContext, actor: Actor, id: string, opts: ResolveOptions = {}): Promise<TicketRow> {
  const t = await getVisibleTicket(ctx, actor, id);
  if (t.status === "closed") throw new AppError(409, "TICKET_CLOSED", "This ticket is already closed");
  if (t.status === "resolved") return t;
  const row = (await resolveTicketRow(ctx, t.id, { type: "member", id: actor.memberId }, opts))!;
  if (!opts.silent) await announceResolved(ctx, row);
  await publishTickets(ctx, [row.id]);
  await publishRoom(ctx, row);
  return row;
}

export async function closeTicket(ctx: AppContext, actor: Actor, id: string): Promise<TicketRow> {
  const t = await getVisibleTicket(ctx, actor, id);
  if (t.status === "closed") return t;
  const resolved = t.status === "resolved" ? t : await resolveTicketRow(ctx, t.id, { type: "member", id: actor.memberId });
  const row = await closeRow(ctx, resolved!, null, { type: "member", id: actor.memberId }, nowIso(ctx));
  await publishTickets(ctx, [row.id]);
  await publishRoom(ctx, row);
  return row;
}

export async function reopenTicket(ctx: AppContext, actor: Actor, id: string): Promise<TicketRow> {
  const t = await getVisibleTicket(ctx, actor, id);
  if (t.status !== "resolved" && t.status !== "closed") return t;
  if (t.merged_into_id) throw unprocessable("TICKET_MERGED", "A merged ticket cannot be reopened");
  const now = nowIso(ctx);
  let row: TicketRow | undefined;
  try {
    row = await ctx.db.get<TicketRow>(
      "UPDATE tickets SET status = 'open', handler = COALESCE(handler, ?), resolution = NULL, resolved_at = NULL, closed_at = NULL, last_activity_at = ?, updated_at = ? WHERE id = ? AND status IN ('resolved','closed') RETURNING *",
      `human:${actor.memberId}`,
      now,
      now,
      t.id,
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "TICKET_LIVE_EXISTS", "This conversation already has a newer open ticket");
    throw e;
  }
  if (!row) return t;
  await recordTicketEvent(ctx, row, "reopened", { type: "member", id: actor.memberId }, { reason: "agent_action", from: t.status }, now);
  await publishTickets(ctx, [row.id]);
  await publishRoom(ctx, row);
  return row;
}

export interface TicketPatch {
  subject?: string;
  priority?: 0 | 1 | 2 | 3;
  tags?: string[];
  status?: "open" | "pending_customer";
  summary?: string;
}

export async function updateTicket(ctx: AppContext, actor: Actor, id: string, patch: TicketPatch): Promise<TicketRow> {
  const t = await getVisibleTicket(ctx, actor, id);
  if (t.status === "closed") throw new AppError(409, "TICKET_CLOSED", "A closed ticket cannot be edited");
  const now = nowIso(ctx);
  const sets: string[] = [];
  const args: Param[] = [];
  const changed: Record<string, unknown> = {};
  if (patch.subject !== undefined && patch.subject.trim() !== t.subject) {
    sets.push("subject = ?", "subject_set_by = 'agent'");
    args.push(patch.subject.trim() || t.subject);
    changed.subject = true;
  }
  if (patch.priority !== undefined && patch.priority !== t.priority) {
    sets.push("priority = ?");
    args.push(patch.priority);
    changed.priority = patch.priority;
  }
  if (patch.tags) {
    const tags = [...new Set(patch.tags.map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
    sets.push("tags = ?");
    args.push(JSON.stringify(tags));
    changed.tags = tags;
  }
  if (patch.summary !== undefined) {
    sets.push("summary = ?");
    args.push(patch.summary.slice(0, 2000));
  }
  if (patch.status && patch.status !== t.status) {
    if (t.status === "resolved") throw unprocessable("TICKET_RESOLVED", "Reopen the ticket first");
    sets.push("status = ?");
    args.push(patch.status);
    changed.status = patch.status;
  }
  if (!sets.length) return t;
  const row = (await ctx.db.get<TicketRow>(`UPDATE tickets SET ${sets.join(", ")}, last_activity_at = ?, updated_at = ? WHERE id = ? RETURNING *`, ...args, now, now, t.id))!;
  await recordTicketEvent(ctx, row, "updated", { type: "member", id: actor.memberId }, changed, now);
  await publishTickets(ctx, [row.id]);
  await publishRoom(ctx, row);
  return row;
}

/** The inbox list shows the ticket of a room: send the fresh room card (not the whole ticket) to everyone who sees it. */
async function publishRoom(ctx: AppContext, t: Pick<TicketRow, "workspace_id" | "room_id">): Promise<void> {
  await publishRoomUpdated(ctx, await getRoomRow(ctx, t.workspace_id, t.room_id));
}

/** The room was closed by a person: its live ticket is resolved with them as the resolver. */
export async function onRoomClosed(ctx: AppContext, room: Pick<RoomRow, "id" | "workspace_id">, by: TicketActor): Promise<void> {
  const live = await liveTicketOf(ctx, room.id);
  if (!live || live.status === "resolved") return;
  const row = await resolveTicketRow(ctx, live.id, by, { reason: "room_closed" });
  if (row) await publishTickets(ctx, [row.id]);
}

/* ---------- reading ---------- */

export interface TicketFilters {
  /** `live` (not closed, the default), `all`, or a comma list of statuses */
  status?: string;
  handler?: string;
  department_id?: string;
  priority_min?: number;
  contact_id?: string;
  room_id?: string;
  q?: string;
  sort?: "activity" | "opened";
  cursor?: string;
  limit: number;
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;

/** SQL conditions on `t` for a ticket filter (shared by lists, counts and bulk selections). */
export function ticketConditions(ctx: AppContext, actor: Pick<Actor, "memberId">, f: Omit<TicketFilters, "limit" | "cursor" | "sort">): { where: string[]; params: Param[] } {
  const where: string[] = [];
  const params: Param[] = [];
  const status = f.status ?? "live";
  if (status === "live") where.push("t.status <> 'closed'");
  else if (status !== "all") {
    const list = status.split(",").filter((s): s is TicketStatus => (TICKET_STATUSES as readonly string[]).includes(s));
    if (!list.length) throw unprocessable("INVALID_STATUS", "Unknown ticket status");
    where.push(`t.status IN (${list.map(() => "?").join(",")})`);
    params.push(...list);
  }
  const h = f.handler;
  if (h === "bot") where.push("t.handler LIKE 'bot:%'");
  else if (h === "human") where.push("t.handler LIKE 'human:%'");
  else if (h === "unassigned") where.push("t.handler IS NULL");
  else if (h === "me") (where.push("t.handler = ?"), params.push(`human:${actor.memberId}`));
  else if (h && /^(bot|human):[A-Za-z0-9_-]{1,64}$/.test(h)) (where.push("t.handler = ?"), params.push(h));
  else if (h) throw unprocessable("INVALID_HANDLER", "handler is bot, human, unassigned, me, bot:<id> or human:<id>");
  if (f.department_id) (where.push("t.department_id = ?"), params.push(f.department_id));
  if (f.priority_min !== undefined) (where.push("t.priority >= ?"), params.push(f.priority_min));
  if (f.contact_id) (where.push("t.contact_id = ?"), params.push(f.contact_id));
  if (f.room_id) (where.push("t.room_id = ?"), params.push(f.room_id));
  if (f.q?.trim()) {
    const q = f.q.trim().replace(/^#/, "");
    if (/^\d{1,9}$/.test(q)) (where.push("(t.number = ? OR t.subject " + ctx.db.ilike + " ? ESCAPE '\\')"), params.push(Number(q), like(q)));
    else (where.push(`t.subject ${ctx.db.ilike} ? ESCAPE '\\'`), params.push(like(q)));
  }
  return { where, params };
}

export async function listTickets(ctx: AppContext, actor: Actor, f: TicketFilters) {
  const vis = roomVisibility(actor);
  const { where, params } = ticketConditions(ctx, actor, f);
  const col = f.sort === "opened" ? "t.opened_at" : "t.last_activity_at";
  const cur = decodeCursor(f.cursor, 2);
  const keyset = cur ? ` AND (${col}, t.id) < (?, ?)` : "";
  const rows = await ctx.db.read().all<TicketRow>(
    `SELECT t.* FROM tickets t JOIN rooms r ON r.id = t.room_id
     WHERE t.workspace_id = ? AND r.archived = 0 AND ${vis.sql}${where.length ? " AND " + where.join(" AND ") : ""}${keyset}
     ORDER BY ${col} DESC, t.id DESC LIMIT ?`,
    actor.workspaceId,
    ...vis.params,
    ...params,
    ...(cur ?? []),
    f.limit + 1,
  );
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  const contacts = await contactNames(ctx, page.map((t) => t.contact_id));
  return {
    data: page.map((t) => ({ ...ticketDto(t), contact: contacts.get(t.contact_id) ?? null })),
    pagination: { limit: f.limit, has_more: rows.length > f.limit, next_cursor: rows.length > f.limit && last ? encodeCursor([f.sort === "opened" ? last.opened_at : last.last_activity_at, last.id]) : null },
  };
}

async function contactNames(ctx: AppContext, ids: string[]): Promise<Map<string, { id: string; name: string; email: string | null }>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = await ctx.db.read().all<{ id: string; name: string; email: string | null }>(`SELECT id, name, email FROM contacts WHERE id IN (${uniq.map(() => "?").join(",")})`, ...uniq);
  return new Map(rows.map((r) => [r.id, r]));
}

export async function ticketCounts(ctx: AppContext, actor: Actor): Promise<Record<TicketStatus | "total_live", number>> {
  const vis = roomVisibility(actor);
  const rows = await ctx.db.read().all<{ status: TicketStatus; n: number }>(
    `SELECT t.status AS status, COUNT(*) AS n FROM tickets t JOIN rooms r ON r.id = t.room_id WHERE t.workspace_id = ? AND r.archived = 0 AND ${vis.sql} AND t.status <> 'closed' GROUP BY t.status`,
    actor.workspaceId,
    ...vis.params,
  );
  const out = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<TicketStatus | "total_live", number>;
  out.total_live = 0;
  for (const r of rows) {
    out[r.status] = Number(r.n);
    out.total_live += Number(r.n);
  }
  return out;
}

export async function getTicketDetail(ctx: AppContext, actor: Actor, id: string) {
  const t = await getVisibleTicket(ctx, actor, id);
  const events = await ctx.db.all<{ id: string; type: string; actor_type: string; actor_id: string | null; detail: string; created_at: string }>(
    "SELECT id, type, actor_type, actor_id, detail, created_at FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, id",
    t.id,
  );
  return { ...ticketDto(t), events: events.map((e) => ({ ...e, detail: parseJson<Record<string, unknown>>(e.detail, {}) })) };
}

/** History of one conversation: every ticket of the room, newest first (the contact panel). */
export async function ticketsOfRoom(ctx: AppContext, actor: Actor, roomId: string) {
  const vis = roomVisibility(actor);
  const rows = await ctx.db.all<TicketRow>(
    `SELECT t.* FROM tickets t JOIN rooms r ON r.id = t.room_id WHERE t.room_id = ? AND t.workspace_id = ? AND r.archived = 0 AND ${vis.sql} ORDER BY t.opened_at DESC, t.id DESC LIMIT 100`,
    roomId,
    actor.workspaceId,
    ...vis.params,
  );
  return rows.map(ticketDto);
}

/** History of one contact across rooms (a contact has one live room, but archived rooms keep their tickets). */
export async function ticketsOfContact(ctx: AppContext, actor: Actor, contactId: string) {
  const vis = roomVisibility(actor);
  const rows = await ctx.db.all<TicketRow>(
    `SELECT t.* FROM tickets t JOIN rooms r ON r.id = t.room_id WHERE t.contact_id = ? AND t.workspace_id = ? AND r.archived = 0 AND ${vis.sql} ORDER BY t.opened_at DESC, t.id DESC LIMIT 100`,
    contactId,
    actor.workspaceId,
    ...vis.params,
  );
  return rows.map(ticketDto);
}

/** The ticket cards of many rooms in one query (room list, thread header). */
export async function liveTicketsByRoom(ctx: AppContext, roomIds: string[]): Promise<Map<string, ReturnType<typeof ticketBrief>>> {
  if (!roomIds.length) return new Map();
  const rows = await ctx.db.read().all<TicketRow>(`SELECT * FROM tickets WHERE room_id IN (${roomIds.map(() => "?").join(",")}) AND status <> 'closed'`, ...roomIds);
  return new Map(rows.map((t) => [t.room_id, ticketBrief(t)]));
}

/* ---------- bulk, merge ---------- */

export async function bulkTickets(ctx: AppContext, actor: Actor, input: { ticket_ids: string[]; action: "resolve" | "close" }) {
  const results: ({ ticket_id: string; ok: true } | { ticket_id: string; ok: false; error: { code: string; message: string } })[] = [];
  for (const id of input.ticket_ids) {
    try {
      if (input.action === "close") await closeTicket(ctx, actor, id);
      else await resolveTicket(ctx, actor, id);
      results.push({ ticket_id: id, ok: true });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      results.push({ ticket_id: id, ok: false, error: { code: e.code, message: e.message } });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ticket.bulk", detail: { action: input.action, requested: input.ticket_ids.length, succeeded } });
  return { results, succeeded, failed: results.length - succeeded };
}

/** Merge a duplicate into another ticket of the SAME conversation: its messages move over and it closes as `merged`. */
export async function mergeTickets(ctx: AppContext, actor: Actor, sourceId: string, intoId: string): Promise<TicketRow> {
  if (sourceId === intoId) throw unprocessable("MERGE_SAME", "A ticket cannot be merged into itself");
  const source = await getVisibleTicket(ctx, actor, sourceId);
  const target = await getVisibleTicket(ctx, actor, intoId);
  if (source.room_id !== target.room_id) throw unprocessable("MERGE_OTHER_ROOM", "Only tickets of the same conversation can be merged");
  if (target.status === "closed" && target.merged_into_id) throw unprocessable("MERGE_TARGET_MERGED", "The target ticket was itself merged");
  if (source.merged_into_id) throw unprocessable("MERGE_SOURCE_MERGED", "This ticket was already merged");
  const now = nowIso(ctx);
  const by = { type: "member", id: actor.memberId } as const;
  const row = await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE messages SET ticket_id = ? WHERE room_id = ? AND ticket_id = ?", target.id, source.room_id, source.id);
    const closed = await ctx.db.get<TicketRow>(
      "UPDATE tickets SET status = 'closed', resolution = 'merged', merged_into_id = ?, resolved_at = COALESCE(resolved_at, ?), closed_at = ?, updated_at = ? WHERE id = ? RETURNING *",
      target.id,
      now,
      now,
      now,
      source.id,
    );
    // the earlier opening and the earlier first response survive on the target
    const firstResponses = [source.first_response_at, target.first_response_at].filter((x): x is string => !!x).sort();
    await ctx.db.run(
      "UPDATE tickets SET opened_at = ?, first_response_at = ?, updated_at = ? WHERE id = ?",
      [source.opened_at, target.opened_at].sort()[0]!,
      firstResponses[0] ?? null,
      now,
      target.id,
    );
    await recordTicketEvent(ctx, closed!, "merged", by, { into: target.id, into_number: target.number }, now);
    await recordTicketEvent(ctx, target, "merged_in", by, { from: source.id, from_number: source.number }, now);
    return closed!;
  });
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ticket.merged", target: source.id, detail: { into: target.id } });
  await publishTickets(ctx, [source.id, target.id]);
  await publishRoom(ctx, row);
  return row;
}

/* ---------- customer rating ---------- */

/** The visitor rates the latest ended ticket of their room (once). Returns false when there is nothing to rate. */
export async function rateTicket(ctx: AppContext, room: Pick<RoomRow, "id" | "workspace_id">, score: number, comment?: string, ticketId?: string): Promise<TicketRow | null> {
  const cutoff = new Date(ctx.clock().getTime() - 7 * 86400_000).toISOString();
  const cand = ticketId
    ? await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ? AND room_id = ?", ticketId, room.id)
    : await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE room_id = ? AND resolved_at IS NOT NULL AND csat IS NULL AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 1", room.id, cutoff);
  if (!cand || cand.csat !== null || cand.resolved_at === null || cand.resolution === "merged") return null;
  const row = await ctx.db.get<TicketRow>(
    "UPDATE tickets SET csat = ?, csat_comment = ?, updated_at = ? WHERE id = ? AND csat IS NULL RETURNING *",
    score,
    comment?.slice(0, 500) ?? null,
    nowIso(ctx),
    cand.id,
  );
  if (!row) return null;
  await recordTicketEvent(ctx, row, "rated", { type: "contact" }, { score });
  await publishTickets(ctx, [row.id]);
  return row;
}

/** Raise (never lower) the priority of the live ticket of a room, e.g. after triage found it urgent. */
export async function raiseTicketPriority(ctx: AppContext, roomId: string, priority: 0 | 1 | 2 | 3): Promise<void> {
  const res = await ctx.db.get<{ id: string }>("UPDATE tickets SET priority = ?, updated_at = ? WHERE room_id = ? AND status <> 'closed' AND priority < ? RETURNING id", priority, nowIso(ctx), roomId, priority);
  if (res) await publishTickets(ctx, [res.id]);
}

/* ---------- time-based lifecycle ---------- */

/**
 * Scheduler pass. Settings are per workspace, so candidates are read with the smallest possible age and judged against each workspace's own
 * setting: a bot ticket that went quiet is resolved as abandoned, a ticket waiting on the customer likewise, and resolved tickets are
 * closed once the reopen window is over. Bounded per pass; the next pass continues where this one stopped.
 */
export async function ticketSweep(ctx: AppContext, opts: { limit?: number } = {}): Promise<{ resolved: number; closed: number }> {
  const limit = opts.limit ?? 200;
  const now = ctx.clock();
  const nowS = now.toISOString();
  const out = { resolved: 0, closed: 0 };
  const idle = await ctx.db.all<TicketRow>(
    "SELECT * FROM tickets WHERE status IN ('bot_handling','pending_customer') AND last_activity_at < ? ORDER BY last_activity_at LIMIT ?",
    new Date(now.getTime() - 5 * 60_000).toISOString(),
    limit,
  );
  for (const t of idle) {
    const s = (await getSettings(ctx, t.workspace_id)).tickets;
    const minutes = t.status === "bot_handling" ? s.bot_idle_minutes : s.pending_idle_hours * 60;
    if (!minutes || Date.parse(nowS) - Date.parse(t.last_activity_at) < minutes * 60_000) continue;
    const row = await resolveTicketRow(ctx, t.id, { type: "system" }, { resolution: "abandoned", reason: "idle" });
    if (row && row.status === "resolved") {
      out.resolved++;
      await announceResolved(ctx, row);
      await publishTickets(ctx, [row.id]);
    }
  }
  const done = await ctx.db.all<TicketRow>("SELECT * FROM tickets WHERE status = 'resolved' AND resolved_at < ? ORDER BY resolved_at LIMIT ?", new Date(now.getTime() - 3600_000).toISOString(), limit);
  for (const t of done) {
    const s = (await getSettings(ctx, t.workspace_id)).tickets;
    if (Date.parse(nowS) - Date.parse(t.resolved_at!) < s.close_resolved_hours * 3600_000) continue;
    const row = await closeRow(ctx, t, null, { type: "system" }, nowS);
    if (row.status === "closed") {
      out.closed++;
      await publishTickets(ctx, [row.id]);
    }
  }
  return out;
}

/** Retention / GDPR: ticket rows of a workspace that ended before `before` (or all of them), with their events. Returns the number deleted. */
export async function purgeTickets(ctx: AppContext, workspaceId: string, before?: Date): Promise<number> {
  const cutoff = before?.toISOString();
  const cond = cutoff ? "workspace_id = ? AND status = 'closed' AND closed_at < ?" : "workspace_id = ?";
  const args: Param[] = cutoff ? [workspaceId, cutoff] : [workspaceId];
  await ctx.db.run(`DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE ${cond})`, ...args);
  return (await ctx.db.run(`DELETE FROM tickets WHERE ${cond}`, ...args)).changes;
}
