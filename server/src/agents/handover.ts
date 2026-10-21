import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { postSystemMessage } from "../services/messageStore.js";
import { getRoomRow } from "../services/roomStore.js";
import { publishRoomUpdated } from "../services/rooms.js";
import { getVisibleTicket, publishTickets, recordTicketEvent, type TicketRow } from "../services/tickets.js";
import { agentDto, selectAgent } from "./config.js";

/**
 * Give a ticket back to the AI agent that serves its department. Only the person who has it (or a manager who sees all) may hand it back; the
 * agent answers the next thing the visitor writes. Taking over is `claimTicket` (services/routing.ts), which also stops the agent at once.
 */
export async function handBackTicket(ctx: AppContext, actor: Actor, ticketId: string): Promise<TicketRow> {
  const t = await getVisibleTicket(ctx, actor, ticketId);
  if (t.status === "resolved" || t.status === "closed") throw new AppError(409, "TICKET_ENDED", "This ticket has ended");
  if (!t.handler?.startsWith("human:")) throw new AppError(409, "NOT_WITH_A_PERSON", "This ticket is not with a person");
  if (t.handler !== `human:${actor.memberId}` && actor.role === "agent") throw new AppError(403, "NOT_YOUR_TICKET", "Only the person who has this ticket can hand it back");
  const sel = await selectAgent(ctx, actor.workspaceId, { channel: "widget", departmentId: t.department_id });
  if (!sel) throw new AppError(409, "NO_AGENT", "No AI agent is switched on for this department");
  const now = nowIso(ctx);
  const row = await ctx.db.get<TicketRow>(
    "UPDATE tickets SET handler = ?, status = 'bot_handling', last_activity_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('resolved','closed') RETURNING *",
    `bot:${sel.agent.id}`,
    now,
    now,
    t.id,
  );
  if (!row) throw new AppError(409, "TICKET_ENDED", "This ticket has ended");
  await recordTicketEvent(ctx, row, "handed_back", { type: "member", id: actor.memberId }, { from: t.handler, agent_id: sel.agent.id }, now);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ticket.handback", target: t.id, detail: { agent_id: sel.agent.id } });
  const a = agentDto(sel.agent);
  await postSystemMessage(ctx, row.room_id, row.workspace_id, `${a.name} (${a.disclosure_label}) is helping again`, { sub_type: "handed_back", agent: { id: a.id, name: a.name, label: a.disclosure_label } });
  await publishTickets(ctx, [row.id]);
  await publishRoomUpdated(ctx, await getRoomRow(ctx, row.workspace_id, row.room_id));
  return row;
}
