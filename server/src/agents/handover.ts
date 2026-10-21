import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { postSystemMessage } from "../services/messageStore.js";
import { assigneeIds, getRoomRow } from "../services/roomStore.js";
import { metricsAssignee } from "../services/roomMetrics.js";
import { publishRoomUpdated } from "../services/rooms.js";
import { getVisibleTicket, publishTickets, recordTicketEvent, type TicketRow } from "../services/tickets.js";
import { agentDto, findAgent, selectAgent } from "./config.js";

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

/**
 * A person gives a ticket to a chosen AI agent (the inbox's assign menu): from unassigned, from the queue, from a person or from another agent.
 * The agent must be switched on; it does not need to cover the ticket's department, because a person chose it. People assigned to the conversation
 * are removed (the agent has it now, as `claimTicket` does the other way round). An agent (the role) may only give away a ticket that is theirs or
 * nobody's. Returns the ticket; the caller starts a turn when the visitor's last message is still unanswered.
 */
export async function assignTicketToAgent(ctx: AppContext, actor: Actor, ticketId: string, agentId: string): Promise<TicketRow> {
  const t = await getVisibleTicket(ctx, actor, ticketId);
  if (t.status === "resolved" || t.status === "closed") throw new AppError(409, "TICKET_ENDED", "This ticket has ended");
  const agent = await findAgent(ctx, actor.workspaceId, agentId);
  if (!agent) throw new AppError(404, "NOT_FOUND", "AI agent not found");
  if (!agent.enabled) throw new AppError(409, "AGENT_OFF", "Switch this AI agent on in Settings > AI agents first");
  if (t.handler?.startsWith("human:") && t.handler !== `human:${actor.memberId}` && actor.role === "agent") throw new AppError(403, "NOT_YOUR_TICKET", "Only the person who has this ticket, or a manager, can give it to an AI agent");
  if (t.handler === `bot:${agent.id}`) return t;
  const now = nowIso(ctx);
  const prev = await assigneeIds(ctx, t.room_id);
  const row = await ctx.db.tx(async () => {
    const r = await ctx.db.get<TicketRow>(
      "UPDATE tickets SET handler = ?, status = 'bot_handling', last_activity_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('resolved','closed') RETURNING *",
      `bot:${agent.id}`,
      now,
      now,
      t.id,
    );
    if (!r) return null;
    for (const m of prev) await ctx.db.run("DELETE FROM room_assignees WHERE room_id = ? AND member_id = ?", t.room_id, m);
    if (prev.length) await metricsAssignee(ctx, t.room_id, null);
    await recordTicketEvent(ctx, r, "assigned_to_agent", { type: "member", id: actor.memberId }, { from: t.handler, agent_id: agent.id }, now);
    return r;
  });
  if (!row) throw new AppError(409, "TICKET_ENDED", "This ticket has ended");
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ticket.assign_agent", target: t.id, detail: { agent_id: agent.id, from: t.handler } });
  const a = agentDto(agent);
  // the visitor sees the same line as a hand-back (an allowed visitor-visible sub type); who chose it stays in the audit log and the ticket timeline
  await postSystemMessage(ctx, row.room_id, row.workspace_id, `${a.name} (${a.disclosure_label}) is helping you now`, { sub_type: "handed_back", agent: { id: a.id, name: a.name, label: a.disclosure_label }, assigned_by: actor.memberId });
  await publishTickets(ctx, [row.id]);
  await publishRoomUpdated(ctx, await getRoomRow(ctx, row.workspace_id, row.room_id), { lost: prev });
  return row;
}
