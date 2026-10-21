import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { parseJson } from "../util/json.js";
import { emitMessage, type MessageRow } from "../services/messageStore.js";
import { getRoomRow } from "../services/roomStore.js";
import { handoffTicket } from "../services/routing.js";
import { announceResolved, liveTicketOf, publishTickets, resolveTicketRow, visitorTicketDto, type TicketRow } from "../services/tickets.js";
import type { SessionRow } from "../services/visitors.js";
import { getVisitorRoom, visitorSend } from "../services/visitorChat.js";
import { handleAgentTurn } from "./pipeline.js";
import { requestCall } from "../calls/service.js";

interface Card {
  type: string;
  kind?: string;
  purpose?: string;
  reason?: string;
  answered?: string;
  options?: { id: string; label: string }[];
}

const findCardMessage = (ctx: AppContext, roomId: string, id: string) => ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND room_id = ? AND deleted_at IS NULL", id, roomId);

/**
 * The visitor taps a quick reply under a bot message. The tap is stored as the visitor's own message (so the team reads "Yes, thanks" in the
 * transcript), the card is closed so it cannot be tapped twice, and then the option does its work: resolve the ticket, tell the agent it did not
 * help, ask for a person, or pick a department.
 */
export async function visitorQuickReply(ctx: AppContext, session: SessionRow, roomId: string, input: { message_id: string; option_id: string }) {
  const room = await getVisitorRoom(ctx, session, roomId);
  const m = await findCardMessage(ctx, room.id, input.message_id);
  const card = m ? parseJson<{ card?: Card }>(m.meta, {}).card : undefined;
  if (!m || m.sender_type !== "bot" || card?.type !== "quick_replies") throw notFound("Message");
  const option = card.options?.find((o) => o.id === input.option_id);
  if (!option) throw unprocessable("UNKNOWN_OPTION", "That option is not on this card");
  if (card.answered) throw new AppError(409, "ALREADY_ANSWERED", "This question was already answered");
  // close the card first: a double tap (or a retry) gets the 409 above instead of acting twice
  const claimed = await ctx.db.run("UPDATE messages SET meta = ? WHERE room_id = ? AND id = ? AND meta = ?", JSON.stringify({ ...parseJson<Record<string, unknown>>(m.meta, {}), card: { ...card, answered: option.id } }), room.id, m.id, m.meta);
  if (!claimed.changes) throw new AppError(409, "ALREADY_ANSWERED", "This question was already answered");
  await emitMessage(ctx, await getRoomRow(ctx, room.workspace_id, room.id), (await findCardMessage(ctx, room.id, m.id))!, "message:updated");
  const sent = await visitorSend(ctx, session, room.id, { content: option.label, client_msg_id: `qr-${m.id.slice(-24)}-${option.id}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) }, { meta: { quick_reply: { message_id: m.id, option_id: option.id } } });
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket) return { ok: true as const, ticket: null };
  const fresh = await getRoomRow(ctx, room.workspace_id, room.id);
  if (card.purpose === "solved") {
    if (option.id === "yes") {
      const bot = ticket.handler?.startsWith("bot:");
      const row = await resolveTicketRow(ctx, ticket.id, { type: "contact" }, { resolution: bot ? "bot_resolved" : "human_resolved", reason: "visitor_confirmed" });
      if (row && row.status === "resolved") await announceResolved(ctx, row);
      await publishTickets(ctx, [ticket.id]);
    } else if (option.id === "human") {
      await handoffTicket(ctx, ticket.id, { reason: "customer_requested_human", by: { type: "contact" } });
    } else {
      await handleAgentTurn(ctx, fresh, sent.message, { dissatisfied: true });
    }
  } else if (card.purpose === "call") {
    if (option.id === "yes") await requestCall(ctx, session, room.id, card.kind === "video" ? "video" : "voice");
  } else if (card.purpose === "department" && option.id.startsWith("dept:")) {
    await handoffTicket(ctx, ticket.id, { reason: card.reason ?? "model_handoff", by: { type: "contact" }, departmentId: option.id.slice("dept:".length) });
  }
  const after = await liveTicketOf(ctx, room.id);
  const last = after ?? (await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", ticket.id))!;
  return { ok: true as const, ticket: visitorTicketDto(last) };
}

/**
 * "Talk to a person": always available to the visitor, whether or not an AI agent exists or is switched on. Stores the request as the visitor's
 * message and hands the ticket off through the routing engine; asking again while a person already has it changes nothing.
 */
export async function visitorRequestHuman(ctx: AppContext, session: SessionRow, roomId: string) {
  const room = await getVisitorRoom(ctx, session, roomId);
  const before = await liveTicketOf(ctx, room.id);
  if (before?.handler?.startsWith("human:") && (before.status === "open" || before.status === "waiting_for_human")) return { ok: true as const, already: true, ticket: visitorTicketDto(before) };
  await visitorSend(ctx, session, room.id, { content: "I would like to talk to a person.", client_msg_id: `human-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }, { meta: { human_request: true } });
  const ticket = (await liveTicketOf(ctx, room.id))!;
  await handoffTicket(ctx, ticket.id, { reason: "customer_requested_human", by: { type: "contact" } });
  const after = (await liveTicketOf(ctx, room.id)) ?? ticket;
  return { ok: true as const, already: false, ticket: visitorTicketDto(after) };
}

/** Thumbs up or down on a bot answer, by the visitor (one vote per contact and message, changeable). */
export async function visitorFeedback(ctx: AppContext, session: SessionRow, roomId: string, messageId: string, input: { rating: 1 | -1; comment?: string }) {
  const room = await getVisitorRoom(ctx, session, roomId);
  const m = await findCardMessage(ctx, room.id, messageId);
  if (!m || m.sender_type !== "bot" || !parseJson<{ ai?: boolean }>(m.meta, {}).ai) throw notFound("Message");
  await saveFeedback(ctx, { workspaceId: room.workspace_id, message: m, raterType: "visitor", raterId: session.contact_id, rating: input.rating, comment: input.comment });
  return { ok: true as const };
}

export async function saveFeedback(ctx: AppContext, f: { workspaceId: string; message: MessageRow; raterType: "visitor" | "member"; raterId: string; rating: 1 | -1; comment?: string }) {
  const agentId = parseJson<{ agent?: { id?: string } }>(f.message.meta, {}).agent?.id ?? null;
  await ctx.db.run(
    `INSERT INTO ai_feedback(message_id, rater_type, rater_id, workspace_id, ticket_id, agent_id, rating, comment, created_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(message_id, rater_type, rater_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = excluded.created_at`,
    f.message.id,
    f.raterType,
    f.raterId,
    f.workspaceId,
    f.message.ticket_id,
    agentId,
    f.rating,
    f.comment?.slice(0, 500) ?? null,
    nowIso(ctx),
  );
}
