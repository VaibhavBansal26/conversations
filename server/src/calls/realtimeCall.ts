import { z } from "zod";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { AppError, notFound } from "../errors.js";
import { agentDto, findAgent, type AgentDto } from "../agents/config.js";
import { classifyText } from "../agents/classify.js";
import { isSensitiveTopic } from "../agents/humanRequest.js";
import { departmentChoices, postBot } from "../agents/pipeline.js";
import { bannedClaims, looksLikeInjection } from "../agents/safety.js";
import { ActionSchema, executeTool, type PlannedAction } from "../agents/tools.js";
import { kbIndex } from "../ai/service.js";
import { redactPii, unsupportedCommitment } from "../ai/text.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { recordAudit } from "../services/audit.js";
import { postSystemMessage } from "../services/messageStore.js";
import { getRoomRow } from "../services/roomStore.js";
import { handoffTicket } from "../services/routing.js";
import { liveTicketOf } from "../services/tickets.js";
import { getVisitorRoom, visitorSend } from "../services/visitorChat.js";
import type { SessionRow } from "../services/visitors.js";
import { getSettings } from "../services/workspaces.js";
import { buildInstructions, RealtimeError, safetyIdentifier, TOOL_NEEDS, toolsFor } from "./realtime.js";
import { finishAi, offerHumanCall, visitorOwnedAiCall, type AiEndReason } from "./aiCall.js";
import { callSettings, type CallRow } from "./service.js";

/**
 * The realtime engine's server half (ADR 0035). Choosing it, minting its one-call secret, running the tools the model asks for, storing the transcripts
 * the browser forwards, and the safety MONITOR. The weaker guarantee, plainly: the realtime model speaks before any server-side guard can read what it
 * said, so the text pipeline's banned-claims and ungrounded-promise guards cannot stop a sentence, only end the call right after it. The mitigations are
 * the strict instructions, tools that are the only way to learn facts or act, this monitor, a hard maximum duration, a daily minutes budget and a
 * concurrency cap, and the kill switch.
 */

export type FallbackReason = "kill_switch" | "not_configured" | "no_webrtc" | "budget" | "concurrency" | "provider_failed" | "client_failed";

export interface RealtimeAck {
  client_secret: string;
  expires_at: number;
  url: string;
  model: string;
  voice: string | null;
  tools: string[];
  /** the sentence the model is told to say first (also stored in the thread by the server) */
  opening: string;
}

const startOfUtcDay = (ctx: AppContext) => {
  const d = ctx.clock();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

/** Why the realtime engine cannot be used right now (null: it can). Cheap checks only; nothing is sent to the provider. */
export async function realtimeUnavailable(ctx: AppContext, ws: string, o: { webrtc: boolean; excludeCall?: string }): Promise<FallbackReason | null> {
  const s = await callSettings(ctx, ws);
  if (s.ai_engine !== "realtime") return "not_configured";
  if (!ctx.config.AI_REALTIME_ENABLED) return "kill_switch";
  if (!ctx.realtime || !ctx.config.OPENAI_REALTIME_MODEL) return "not_configured";
  if (!o.webrtc) return "no_webrtc";
  const used = await realtimeSecondsToday(ctx, ws, o.excludeCall);
  if (used >= s.ai.realtime_minutes_daily * 60) return "budget";
  const live = await ctx.db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM calls WHERE workspace_id = ? AND transport = 'ai' AND engine = 'realtime' AND state = 'active' AND id <> ?", ws, o.excludeCall ?? "");
  if (Number(live!.n) >= s.ai.realtime_max_concurrent) return "concurrency";
  return null;
}

/** seconds of realtime calls today: finished ones by their duration, running ones by how long they have run */
export async function realtimeSecondsToday(ctx: AppContext, ws: string, excludeCall?: string): Promise<number> {
  const rows = await ctx.db.all<{ state: string; duration_s: number | null; answered_at: string | null }>(
    "SELECT state, duration_s, answered_at FROM calls WHERE workspace_id = ? AND transport = 'ai' AND engine = 'realtime' AND created_at >= ? AND id <> ?",
    ws, startOfUtcDay(ctx), excludeCall ?? "",
  );
  const now = ctx.clock().getTime();
  return rows.reduce((sum, r) => sum + (r.state === "active" && r.answered_at ? Math.max(0, Math.round((now - Date.parse(r.answered_at)) / 1000)) : r.duration_s ?? 0), 0);
}

/**
 * Called by `startAiCall` once the row exists: try to give this call the realtime engine. Any failure leaves the call on the browser engine and says why;
 * the visitor is never left without a way to talk.
 */
export async function negotiateRealtime(ctx: AppContext, o: { call: CallRow; agent: AgentDto; session: SessionRow; webrtc: boolean; opening: string }): Promise<{ engine: "realtime"; realtime: RealtimeAck } | { engine: "browser"; fallback: FallbackReason | null }> {
  const ws = o.call.workspace_id;
  const s = await callSettings(ctx, ws);
  if (s.ai_engine !== "realtime") return { engine: "browser", fallback: null };
  const why = await realtimeUnavailable(ctx, ws, { webrtc: o.webrtc, excludeCall: o.call.id });
  if (why) return { engine: "browser", fallback: why };
  const wsRow = await ctx.db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", ws);
  const inbox = await findAgent(ctx, ws, o.agent.id);
  const departments = inbox ? await departmentChoices(ctx, ws, inbox) : [];
  // the link tool is only offered when call links with the team are on (the model would otherwise promise a link the server refuses to make)
  const tools = toolsFor(o.agent).filter((t) => t.name !== "share_call_link" || (s.links.enabled && s.links.allow_team));
  try {
    const secret = await ctx.realtime!.mint({
      model: ctx.config.OPENAI_REALTIME_MODEL!,
      instructions: buildInstructions({ agent: o.agent, workspaceName: wsRow?.name ?? "the company", disclosure: o.opening, departments }),
      tools,
      voice: ctx.config.OPENAI_REALTIME_VOICE,
      transcribeModel: ctx.config.OPENAI_REALTIME_TRANSCRIBE_MODEL,
      ttlSeconds: ctx.config.OPENAI_CLIENT_SECRET_TTL_SECONDS,
      safetyId: safetyIdentifier(ws, o.call.contact_id),
    });
    await ctx.db.run("UPDATE calls SET engine = 'realtime' WHERE id = ? AND state = 'active'", o.call.id);
    return {
      engine: "realtime",
      realtime: { client_secret: secret.value, expires_at: secret.expiresAt, url: ctx.realtime!.callsUrl(), model: ctx.config.OPENAI_REALTIME_MODEL!, voice: ctx.config.OPENAI_REALTIME_VOICE ?? null, tools: tools.map((t) => t.name), opening: o.opening },
    };
  } catch (e) {
    // the message of a RealtimeError is safe (no key, no body); anything else is logged by name only
    ctx.log.warn("realtime session could not be created", { workspace_id: ws, reason: e instanceof RealtimeError ? e.message : "unexpected error", status: e instanceof RealtimeError ? e.status : undefined });
    return { engine: "browser", fallback: "provider_failed" };
  }
}

const requireRealtimeCall = async (ctx: AppContext, session: SessionRow, callId: string): Promise<CallRow> => {
  const c = await visitorOwnedAiCall(ctx, session, callId);
  if (c.state !== "active") throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  if (c.engine !== "realtime") throw new AppError(409, "WRONG_ENGINE", "This call does not use the realtime engine");
  return c;
};

/** The kill switch: the workspace chose the browser engine again, or the instance turned realtime off. A running realtime call ends at its next sign of life. */
async function killed(ctx: AppContext, c: CallRow): Promise<boolean> {
  if (!ctx.config.AI_REALTIME_ENABLED) return true;
  return (await callSettings(ctx, c.workspace_id)).ai_engine !== "realtime";
}

/* ---------- the browser could not connect to the provider: carry on with the browser engine ---------- */

export async function fallbackToBrowser(ctx: AppContext, session: SessionRow, callId: string, reason: string) {
  const c = await visitorOwnedAiCall(ctx, session, callId);
  if (c.state !== "active") throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  if (c.engine === "realtime") {
    await ctx.db.run("UPDATE calls SET engine = 'browser', updated_at = ? WHERE id = ? AND state = 'active' AND engine = 'realtime'", nowIso(ctx), c.id);
    await recordAudit(ctx, { workspaceId: c.workspace_id, actor: { type: "system" }, action: "call.ai_engine_fallback", target: c.id, detail: { from: "realtime", to: "browser", reason: String(reason).replace(/[^a-z_]/g, "").slice(0, 40) || "client_failed" } });
  }
  return { engine: "browser" as const, fallback: "client_failed" as FallbackReason };
}

/* ---------- tools: what the model may do, run by this server ---------- */

const ToolArgs = z.object({ call_id: z.string().min(1).max(64), name: z.string().min(1).max(40), arguments: z.string().max(4000).default("{}") });
export const RealtimeToolBody = ToolArgs;
const HAND_REASONS = ["customer_requested_human", "no_answer", "low_confidence", "sensitive_topic", "negative_sentiment", "model_handoff"];

export async function runRealtimeTool(ctx: AppContext, session: SessionRow, input: z.infer<typeof ToolArgs>) {
  const c = await requireRealtimeCall(ctx, session, input.call_id);
  if (await killed(ctx, c)) return endForKill(ctx, c);
  const rate = await ctx.ratelimit.check("calls.ai.say", { key: `${c.workspace_id}:${c.contact_id}`, workspaceId: c.workspace_id });
  if (!rate.allowed) throw new RateLimitedError(rate);
  const agentRow = c.ai_agent_id ? await findAgent(ctx, c.workspace_id, c.ai_agent_id) : undefined;
  if (!agentRow) throw notFound("AI agent");
  const agent = agentDto(agentRow);
  const room = await getVisitorRoom(ctx, session, c.room_id);
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket || ticket.handler?.startsWith("human:") || ticket.status === "waiting_for_human") {
    const row = await finishAi(ctx, c, { by: "system", reason: "taken_over", handoff: "taken_over" });
    return { output: JSON.stringify({ error: "A person has taken over" }), ended: { reason: "taken_over" as AiEndReason, handoff_reason: "taken_over" }, call: row.id };
  }
  const audit = (ok: boolean, detail?: string) => recordAudit(ctx, { workspaceId: c.workspace_id, actor: { type: "system" }, action: "ai_agent.tool", target: ticket.id, detail: { tool: input.name, ok, agent_id: agent.id, ticket_id: ticket.id, source: "realtime", ...(detail ? { detail } : {}) } });
  // a closed list, and only what this agent is allowed (the same switches as the text pipeline)
  const need = TOOL_NEEDS[input.name];
  const offered = toolsFor(agent).some((t) => t.name === input.name);
  if (need === undefined || !offered) {
    await audit(false, "not allowed");
    return { output: JSON.stringify({ error: "That action is not available" }) };
  }
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.arguments || "{}");
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    await audit(false, "bad arguments");
    return { output: JSON.stringify({ error: "The arguments were not valid JSON" }) };
  }
  await ctx.db.run("UPDATE calls SET updated_at = ? WHERE id = ? AND state = 'active'", nowIso(ctx), c.id);
  await ctx.ratelimit.renew("ai.concurrency", c.workspace_id, [c.id]);

  if (input.name === "search_kb") {
    const q = z.object({ query: z.string().trim().min(2).max(200) }).safeParse(args);
    if (!q.success) return { output: JSON.stringify({ error: "A query is needed" }) };
    const index = await kbIndex(ctx, c.workspace_id);
    const hits = index
      .search(q.data.query, 8)
      .filter((h) => (agent.kb_collections.length ? agent.kb_collections.includes(h.doc.collection ?? "") : true) && h.coverage >= agent.coverage_threshold)
      .slice(0, 3);
    await audit(true, `${hits.length} entries`);
    // the entries are the only facts the model may use; links are left out (a voice does not read them, and the monitor treats any address as ungrounded)
    return { output: JSON.stringify(hits.length ? { entries: hits.map((h) => ({ id: h.doc.id, question: h.doc.question, answer: h.doc.answer })) } : { entries: [], note: "Nothing relevant: say you cannot answer and hand over to a person." }) };
  }

  if (input.name === "handoff_to_human") {
    const r = z.object({ reason: z.string().max(100).optional() }).safeParse(args);
    const reason = r.success && r.data.reason && HAND_REASONS.includes(r.data.reason) ? r.data.reason : "model_handoff";
    return await handOver(ctx, session, c, reason, "tool");
  }

  // the rest are the text pipeline's own tools, with its own checks (department scope, autonomy, what the settings ask for)
  const parsed = ActionSchema.safeParse({ tool: input.name, ...args });
  if (!parsed.success || parsed.data.tool === "search_kb" || parsed.data.tool === "handoff_to_human" || parsed.data.tool === "offer_call") {
    await audit(false, "invalid");
    return { output: JSON.stringify({ error: "Those arguments are not valid for this action" }) };
  }
  const roomRow = await getRoomRow(ctx, c.workspace_id, room.id);
  const result = await executeTool(ctx, { room: roomRow, ticket, agent, action: parsed.data as PlannedAction });
  await audit(result.ok, result.detail);
  await postSystemMessage(ctx, room.id, c.workspace_id, `${agent.name} (AI agent): ${result.summary}`, { sub_type: "ai_action", tool: input.name, ok: result.ok, call_id: c.id });
  if (input.name === "resolve_ticket" && result.ok) {
    const row = await finishAi(ctx, c, { by: "system", reason: "resolved" });
    return { output: JSON.stringify({ ok: true }), ended: { reason: "resolved" as AiEndReason }, call: row.id };
  }
  return { output: JSON.stringify(result.ok ? { ok: true, note: result.summary } : { ok: false, note: result.summary }) };
}

/** End the call and give the conversation to a person (the model asked, the visitor asked, or the monitor decided). */
async function handOver(ctx: AppContext, session: SessionRow, c: CallRow, reason: string, via: "tool" | "monitor") {
  const room = await getVisitorRoom(ctx, session, c.room_id);
  const ticket = await liveTicketOf(ctx, room.id);
  const row = await finishAi(ctx, c, { by: "system", reason: via === "monitor" ? "monitor" : "handoff", handoff: reason });
  if (ticket) await handoffTicket(ctx, ticket.id, { reason, by: c.ai_agent_id ? { type: "bot", id: c.ai_agent_id } : { type: "system" }, note: via === "monitor" ? "The safety monitor ended the AI call." : undefined });
  const humanCall = await offerHumanCall(ctx, session, room.id, row);
  return { output: JSON.stringify({ ok: true, note: "The conversation was handed to a person. Say goodbye briefly." }), ended: { reason: (via === "monitor" ? "monitor" : "handoff") as AiEndReason, handoff_reason: reason, human_call: humanCall }, call: row.id };
}

async function endForKill(ctx: AppContext, c: CallRow) {
  await finishAi(ctx, c, { by: "system", reason: "kill_switch" });
  await recordAudit(ctx, { workspaceId: c.workspace_id, actor: { type: "system" }, action: "call.ai_kill_switch", target: c.id, detail: {} });
  return { output: JSON.stringify({ error: "The call was ended" }), ended: { reason: "kill_switch" as AiEndReason } };
}

/* ---------- transcripts and the monitor ---------- */

const TranscriptSchema = z.object({ call_id: z.string().min(1).max(64), role: z.enum(["user", "assistant"]), text: z.string().max(4000), item_id: z.string().min(1).max(80), greeting: z.boolean().optional(), via: z.enum(["voice", "typed"]).default("voice") });
export const RealtimeTranscriptBody = TranscriptSchema;

/**
 * Store what was said (the visitor's words with redaction honoured, the assistant's as an ordinary bot message, both tagged with the call) and read it
 * with the monitor: an injection attempt, a sensitive topic, a banned claim or an invented commitment ends the call at once and hands over to a person.
 * Idempotent per `item_id`.
 */
export async function recordRealtimeTranscript(ctx: AppContext, session: SessionRow, input: z.infer<typeof TranscriptSchema>) {
  const c = await requireRealtimeCall(ctx, session, input.call_id);
  if (await killed(ctx, c)) return endForKill(ctx, c).then((r) => ({ ok: true as const, ended: r.ended }));
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) return { ok: true as const, ended: null };
  const agentRow = c.ai_agent_id ? await findAgent(ctx, c.workspace_id, c.ai_agent_id) : undefined;
  if (!agentRow) throw notFound("AI agent");
  const agent = agentDto(agentRow);
  const room = await getVisitorRoom(ctx, session, c.room_id);
  const settings = await getSettings(ctx, c.workspace_id);
  await ctx.db.run("UPDATE calls SET updated_at = ? WHERE id = ? AND state = 'active'", nowIso(ctx), c.id);
  await ctx.ratelimit.renew("ai.concurrency", c.workspace_id, [c.id]);
  const qid = `rt-${input.role[0]}-${input.item_id}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

  if (input.role === "user") {
    const stored = settings.ai_redact_pii ? redactPii(text) : text;
    await visitorSend(ctx, session, room.id, { content: stored.slice(0, 2000), client_msg_id: qid }, { meta: { call_utterance: true, call_id: c.id, via: input.via === "typed" ? "typed" : "realtime" } });
    const depts = await departmentChoices(ctx, c.workspace_id, agentRow);
    const cls = classifyText(text, depts);
    const t = agent.handoff_triggers;
    if (looksLikeInjection(text)) return cut(ctx, session, c, "suspicious_input", "injection");
    if (t.sensitive_topic && isSensitiveTopic(text, t.sensitive_topics)) return cut(ctx, session, c, "sensitive_topic", "sensitive_topic");
    if (t.human_request && cls.wantsHuman) return cut(ctx, session, c, "customer_requested_human", "human_request");
    return { ok: true as const, ended: null };
  }

  // the assistant's words. The greeting is stored by the server when the call starts, so the spoken copy of it is not stored twice.
  if (input.greeting) return { ok: true as const, ended: null };
  const roomRow = await getRoomRow(ctx, c.workspace_id, room.id);
  const existing = await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND client_msg_id = ?", room.id, qid);
  if (!existing) {
    const m = await postBot(ctx, roomRow, agent, text, { call_id: c.id, via: "realtime", realtime: true });
    await ctx.db.run("UPDATE messages SET client_msg_id = ? WHERE id = ? AND room_id = ?", qid, m.id, room.id).catch(() => {});
  }
  const kb = await ctx.db.all<{ question: string; answer: string }>("SELECT question, answer FROM kb_entries WHERE workspace_id = ?", c.workspace_id);
  const kbText = kb.map((k) => `${k.question} ${k.answer}`).join("\n");
  const banned = bannedClaims(text);
  if (banned.length) return cut(ctx, session, c, "unsafe_answer", `banned:${banned.join(",")}`);
  if (unsupportedCommitment(text, kbText)) return cut(ctx, session, c, "unsafe_answer", "ungrounded_commitment");
  return { ok: true as const, ended: null };
}

/** the monitor's cut: the call ends, the conversation goes to a person, and the audit log says why (never the words) */
async function cut(ctx: AppContext, session: SessionRow, c: CallRow, handoffReason: string, trigger: string) {
  await recordAudit(ctx, { workspaceId: c.workspace_id, actor: { type: "system" }, action: "call.ai_monitor_cut", target: c.id, detail: { trigger, handoff_reason: handoffReason } });
  const r = await handOver(ctx, session, c, handoffReason, "monitor");
  return { ok: true as const, ended: r.ended };
}

/* ---------- the sweep's part ---------- */

/** kill switch and the day's minutes: a realtime call that must stop is ended here when the browser says nothing */
export async function sweepRealtime(ctx: AppContext, c: CallRow): Promise<AiEndReason | null> {
  if (c.engine !== "realtime") return null;
  if (await killed(ctx, c)) return "kill_switch";
  const s = await callSettings(ctx, c.workspace_id);
  if ((await realtimeSecondsToday(ctx, c.workspace_id)) >= s.ai.realtime_minutes_daily * 60) return "budget";
  return null;
}

