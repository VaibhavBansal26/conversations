import { z } from "zod";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { announceResolved, publishTickets, recordTicketEvent, resolveTicketRow, type TicketRow } from "../services/tickets.js";
import type { RoomRow } from "../services/roomStore.js";
import { publishRoomUpdated } from "../services/rooms.js";
import { getRoomRow } from "../services/roomStore.js";
import type { AgentDto } from "./config.js";

/**
 * The tools an AI agent can call. They are a closed list implemented here (no arbitrary HTTP and no plugins in v1; docs/AI-AGENTS.md describes the
 * extension point). The model names a tool in its structured answer; the server validates the arguments, checks the agent's `allowed_actions`,
 * runs it scoped to the workspace of the ticket, records it in the audit log and shows it to the team as a line in the conversation.
 */
export const ActionSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search_kb"), query: z.string().trim().min(2).max(200) }),
  z.object({ tool: z.literal("set_department"), department_id: z.string().min(1).max(64), reason: z.string().max(200).optional() }),
  z.object({ tool: z.literal("collect_contact_info"), fields: z.array(z.enum(["name", "email", "phone"])).min(1).max(3), reason: z.string().max(200).optional() }),
  z.object({ tool: z.literal("handoff_to_human"), reason: z.string().max(100).optional(), department_id: z.string().max(64).nullable().optional() }),
  z.object({ tool: z.literal("resolve_ticket"), reason: z.string().max(200).optional() }),
  z.object({ tool: z.literal("schedule_callback"), note: z.string().max(300).optional() }),
  z.object({ tool: z.literal("offer_call"), kind: z.enum(["voice", "video"]).default("voice") }),
]);
export type ModelAction = z.infer<typeof ActionSchema>;
/** What `applyDecision` executes: everything the model can ask for except its own retrieval and the hand-off (which are decisions, not tools). */
export type PlannedAction = Exclude<ModelAction, { tool: "search_kb" } | { tool: "handoff_to_human" }>;

/** The agent's `allowed_actions` switch tools on and off; `search_kb` is the agent's own retrieval and always allowed. */
export const ALLOWS: Record<ModelAction["tool"], string | null> = {
  search_kb: null,
  set_department: "route",
  collect_contact_info: "collect_info",
  handoff_to_human: "request_human",
  resolve_ticket: "resolve",
  schedule_callback: "schedule_callback",
  offer_call: "offer_call",
};

export interface ToolContext {
  room: RoomRow;
  ticket: TicketRow;
  agent: AgentDto;
  action: PlannedAction;
}
export interface ToolResult {
  ok: boolean;
  detail?: string;
  /** one line for the team ("set the department to Billing"), shown in the conversation */
  summary: string;
}

/** Tools other parts of the product provide (the contact form card, calls, callbacks) register here when they exist. */
export type ToolHandler = (ctx: AppContext, t: ToolContext) => Promise<ToolResult>;
export const toolHandlers: Partial<Record<PlannedAction["tool"], ToolHandler>> = {};

async function setDepartment(ctx: AppContext, t: ToolContext & { action: Extract<PlannedAction, { tool: "set_department" }> }): Promise<ToolResult> {
  const dept = await ctx.db.get<{ id: string; name: string }>("SELECT id, name FROM inboxes WHERE id = ? AND workspace_id = ?", t.action.department_id, t.room.workspace_id);
  if (!dept) return { ok: false, detail: "unknown department", summary: "tried to set a department that does not exist" };
  if (t.agent.department_ids.length && !t.agent.department_ids.includes(dept.id)) return { ok: false, detail: "outside the agent's departments", summary: `may not use the department ${dept.name}` };
  const now = nowIso(ctx);
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE tickets SET department_id = ?, updated_at = ? WHERE id = ?", dept.id, now, t.ticket.id);
    await ctx.db.run("UPDATE rooms SET inbox_id = ?, updated_at = ? WHERE id = ?", dept.id, now, t.room.id);
    await recordTicketEvent(ctx, t.ticket, "department_set", { type: "bot", id: t.agent.id }, { department_id: dept.id, reason: t.action.reason ?? null }, now);
  });
  await publishTickets(ctx, [t.ticket.id]);
  await publishRoomUpdated(ctx, await getRoomRow(ctx, t.room.workspace_id, t.room.id));
  return { ok: true, summary: `set the department to ${dept.name}` };
}

async function resolveTicket(ctx: AppContext, t: ToolContext): Promise<ToolResult> {
  if (t.agent.autonomy !== "auto_resolve") return { ok: false, detail: "autonomy", summary: "asked to resolve the ticket, which this agent may not do on its own" };
  const row = await resolveTicketRow(ctx, t.ticket.id, { type: "bot", id: t.agent.id }, { resolution: "bot_resolved", reason: "agent_resolved" });
  if (!row || row.status !== "resolved") return { ok: false, detail: "already ended", summary: "the ticket had already ended" };
  await announceResolved(ctx, row);
  await publishTickets(ctx, [row.id]);
  return { ok: true, summary: "resolved the ticket" };
}

export async function executeTool(ctx: AppContext, t: ToolContext): Promise<ToolResult> {
  try {
    if (t.action.tool === "set_department") return await setDepartment(ctx, { ...t, action: t.action });
    if (t.action.tool === "resolve_ticket") return await resolveTicket(ctx, t);
    const h = toolHandlers[t.action.tool];
    if (!h) return { ok: false, detail: "unavailable", summary: `asked for ${t.action.tool.replace(/_/g, " ")}, which is not available` };
    return await h(ctx, t);
  } catch (e) {
    ctx.log.warn("ai agent tool failed", { tool: t.action.tool, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, detail: "failed", summary: `${t.action.tool.replace(/_/g, " ")} failed` };
  }
}
