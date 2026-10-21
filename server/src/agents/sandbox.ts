import { z } from "zod";
import type { AppContext } from "../context.js";
import type { Actor } from "../domain/types.js";
import { chooseRoute } from "../services/routing.js";
import { getAgent } from "./config.js";
import { decideTurn, departmentChoices, ZERO_COUNTERS, type Decision, type TurnInput } from "./pipeline.js";

export const SandboxBody = z.object({
  /** the visitor's next message */
  message: z.string().trim().min(1).max(2000),
  /** the conversation so far, oldest first */
  history: z.array(z.object({ role: z.enum(["visitor", "assistant"]), text: z.string().max(2000) })).max(30).default([]),
  contact: z.object({ name: z.string().max(100).default(""), tags: z.array(z.string().max(40)).max(20).default([]) }).default({ name: "", tags: [] }),
  context: z.object({ page_url: z.string().max(500).nullable().default(null), locale: z.string().max(20).nullable().default(null) }).default({ page_url: null, locale: null }),
  /** the department the conversation would be in */
  department_id: z.string().max(64).nullable().default(null),
  /** how the conversation stands: turns taken, unanswered attempts */
  turns: z.number().int().min(0).max(50).default(0),
  attempts: z.number().int().min(0).max(20).default(0),
});

/**
 * Try an agent without a real conversation: exactly the production decision (classification, hand-off triggers, retrieval, model, guards) for one
 * message, reported with its reasoning, sources, confidence and the routing decision it would lead to. Nothing is stored: no room, no ticket, no
 * message, no audit entry. The model call counts against the workspace's AI budget like any other.
 */
export async function runSandbox(ctx: AppContext, actor: Actor, agentId: string, body: z.infer<typeof SandboxBody>) {
  const agent = await getAgent(ctx, actor.workspaceId, agentId);
  const departments = await departmentChoices(ctx, actor.workspaceId, agent);
  const lines: TurnInput["lines"] = [
    ...body.history.map((h) => ({ role: h.role === "visitor" ? ("customer" as const) : ("bot" as const), text: h.text })),
    { role: "customer", text: body.message },
  ];
  const input: TurnInput = {
    workspaceId: actor.workspaceId,
    agent,
    text: body.message,
    lines,
    contact: { name: body.contact.name, tags: body.contact.tags, email: null, phone: null },
    context: body.context,
    departments,
    currentDepartmentId: body.department_id,
    counters: { ...ZERO_COUNTERS, turns: body.turns, attempts: body.attempts },
    firstTurn: body.turns === 0 && body.history.length === 0,
    // the route already counted this against the workspace's AI budget; the model is the configured one
    provider: ctx.ai,
    dryRun: true,
  };
  const d: Decision = await decideTurn(ctx, input);
  let routing: Record<string, unknown> | null = null;
  if (d.handoff || d.kind === "confirm_department") {
    const choice = await chooseRoute(ctx, actor.workspaceId, { departmentId: d.handoff?.departmentId ?? input.currentDepartmentId, skills: d.handoff?.skills ?? [], language: input.context.locale?.split(/[-_]/)[0] ?? null });
    routing = {
      outcome: choice.outcome,
      department: choice.dept ? { id: choice.dept.id, name: choice.dept.name } : null,
      mode: choice.mode,
      assignee: choice.picked ? { id: choice.picked.seat.id, name: choice.picked.seat.name } : null,
      path: choice.path,
      closed: choice.closedReason,
      confirm_between: d.confirm?.options ?? null,
    };
  }
  return {
    kind: d.kind,
    reply: d.text,
    handoff: d.handoff,
    confidence: d.confidence,
    intent: d.intent,
    sentiment: d.sentiment,
    urgency: d.urgency,
    department: d.department,
    sources: d.sources,
    actions: d.actions,
    subject: d.subject,
    quick_replies: d.quickReplies,
    provider: d.provider || "none (no model was needed)",
    degraded: d.degraded,
    tokens: d.tokens,
    latency_ms: d.latencyMs,
    trace: d.trace,
    routing,
  };
}
