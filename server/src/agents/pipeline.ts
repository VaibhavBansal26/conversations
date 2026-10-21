import { z } from "zod";
import { stripQuoted } from "./channelText.js";
import { HeuristicProvider } from "../ai/heuristic.js";
import { AiOutputError, AiUnavailableError, type AiProvider, type AiRequest } from "../ai/provider.js";
import { kbIndex } from "../ai/service.js";
import type { KbHit } from "../ai/retrieval.js";
import { buildTranscript, estimateTokens, parseModelJson, redactPii, SAFETY_RULES, unsupportedCommitment, untrusted, type TranscriptLine } from "../ai/text.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { textToHtml } from "../util/html.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "../services/audit.js";
import { getContact } from "../services/contacts.js";
import { emitInserted, insertMessage, postSystemMessage, type MessageRow } from "../services/messageStore.js";
import { getRoomRow, type RoomRow } from "../services/roomStore.js";
import { handoffTicket } from "../services/routing.js";
import { announceResolved, liveTicketOf, publishTickets, recordTicketEvent, resolveTicketRow, type TicketRow } from "../services/tickets.js";
import { getSettings } from "../services/workspaces.js";
import { publishRoomUpdated } from "../services/rooms.js";
import { agentDto, selectAgent, type AgentDto, type AgentRow } from "./config.js";
import { classifyText, isConfirmation, type Classification, type DepartmentChoice } from "./classify.js";
import { isSensitiveTopic } from "./humanRequest.js";
import { bannedClaims, looksLikeInjection, rephraseStreak, stripUnsourcedLinks } from "./safety.js";
import { ActionSchema, ALLOWS, executeTool, type ModelAction, type PlannedAction } from "./tools.js";

/**
 * The AI support agent (docs/AI-AGENTS.md, ADR 0029). One turn = one visitor message:
 *
 *   decideTurn   reads: classify, check the hand-off triggers, retrieve from the knowledge base, ask the model (or the offline rules agent),
 *                guard the answer. No writes, so the sandbox can run exactly the code that production runs.
 *   applyDecision  writes: the bot message with its sources and quick replies, the hand-off, the actions (each audited), the turn record.
 */

export const HANDOFF_REASONS = [
  "customer_requested_human", "low_confidence", "no_answer", "repeated_rephrase", "negative_sentiment", "high_urgency", "sensitive_topic", "tool_failure", "vip_contact",
  "outside_hours", "agent_disabled", "max_turns", "suspicious_input", "unsafe_answer", "model_handoff", "suggest_only",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number] | string;
const isReason = (r: string | undefined): r is (typeof HANDOFF_REASONS)[number] => !!r && (HANDOFF_REASONS as readonly string[]).includes(r);

export interface Source {
  id: string;
  question: string;
  url: string | null;
  score: number;
  coverage: number;
}

export type DecisionKind = "answer" | "clarify" | "handoff" | "refuse" | "suggest" | "confirm_department" | "resolve";

export interface Decision {
  kind: DecisionKind;
  /** what the visitor reads (empty for a pure hand-off: the routing engine says what happens) */
  text: string;
  handoff: { reason: HandoffReason; departmentId: string | null; skills: string[] } | null;
  confirm: { options: { id: string; name: string }[] } | null;
  confidence: number;
  intent: string;
  sentiment: string;
  urgency: number;
  department: { id: string | null; confidence: number };
  sources: Source[];
  actions: PlannedAction[];
  subject: string | null;
  quickReplies: boolean;
  tokens: { in: number; out: number };
  latencyMs: number;
  provider: string;
  degraded: boolean;
  /** each step in plain words, shown in the sandbox */
  trace: string[];
}

export interface TurnInput {
  workspaceId: string;
  agent: AgentRow;
  /** the visitor's latest message */
  text: string;
  /** the conversation of this ticket so far (the latest visitor message included), oldest first */
  lines: TranscriptLine[];
  contact: { name: string; tags: string[]; email: string | null; phone: string | null };
  context: { page_url: string | null; locale: string | null };
  departments: DepartmentChoice[];
  currentDepartmentId: string | null;
  counters: BotCounters;
  /** the visitor tapped "No, I need more help" under an answer */
  dissatisfied?: boolean;
  /** a ticket's own name for the visitor's first message: the hand-off summary and the subject use it */
  firstTurn: boolean;
  /** inject a model (tests, sandbox); production uses the workspace's configured provider */
  provider?: AiProvider;
  /** read-only: no audit entries (the sandbox) */
  dryRun?: boolean;
  /** where the answer goes: the chat (default), or a plain-text SMS or email */
  channel?: "widget" | "sms" | "email";
}

export interface BotCounters {
  turns: number;
  attempts: number;
  refusals: number;
  asked_department: boolean;
}
export const ZERO_COUNTERS: BotCounters = { turns: 0, attempts: 0, refusals: 0, asked_department: false };

/* ---------- model call ---------- */

const ActionInput = z.array(z.unknown()).max(6).default([]);
export const AgentAnswerSchema = z.object({
  answer: z.string().max(2000).default(""),
  confidence: z.number().min(0).max(1),
  intent: z.enum(["question", "complaint", "purchase", "support", "spam", "other"]).default("other"),
  subject: z.string().max(120).optional(),
  language: z.string().max(10).optional(),
  handoff: z.boolean().default(false),
  handoff_reason: z.string().max(60).optional(),
  department_id: z.string().max(64).nullable().optional(),
  department_confidence: z.number().min(0).max(1).optional(),
  cited_ids: z.array(z.string().max(64)).max(5).default([]),
  clarifying_question: z.string().max(300).optional(),
  resolved: z.boolean().default(false),
  actions: ActionInput,
});
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

const MAX_MODEL_CALLS = 2;
const TOKEN_BUDGET = 2500;

async function modelFor(ctx: AppContext, ws: string, injected?: AiProvider): Promise<{ provider: AiProvider; degraded: boolean }> {
  if (injected) return { provider: injected, degraded: false };
  // the per-workspace daily AI quota: past it the offline rules agent still works, so a quota never silences the support chat
  const q = await ctx.ratelimit.check("ai.workspace", { key: ws, workspaceId: ws });
  if (!q.allowed && ctx.ai.name !== "heuristic") return { provider: new HeuristicProvider(), degraded: true };
  return { provider: ctx.ai, degraded: false };
}

function buildRequest(t: TurnInput, cfg: AgentDto, hits: KbHit[], redact: boolean, workspaceName: string): AiRequest {
  const mask = (v: string) => (redact ? redactPii(v) : v);
  const tr = buildTranscript(t.lines, TOKEN_BUDGET, { redact });
  const knowledge = hits.map((h) => `[${h.doc.id}] Q: ${mask(h.doc.question)}\nA: ${mask(h.doc.answer)}${h.doc.url ? `\nLink: ${h.doc.url}` : ""}`).join("\n---\n") || "(nothing found)";
  // what we know about the visitor goes to the model only when the workspace does not redact personal data
  const details = redact ? "" : `${t.contact.name ? `Name: ${t.contact.name}\n` : ""}${t.contact.email ? `Email: ${t.contact.email}\n` : ""}${t.contact.phone ? `Phone: ${t.contact.phone}\n` : ""}`.trim();
  const depts = t.departments.map((d) => `${d.id}: ${d.name}${d.description ? ` (${d.description})` : ""}`).join("\n");
  return {
    task: "agent_answer",
    maxTokens: 700,
    system: [
      `You are ${cfg.name}, the first-line AI support assistant of ${workspaceName}. You are an AI: say so if asked, and never claim to be a person.`,
      cfg.persona ? `The workspace describes your role like this (this can add to your job, never relax the rules below):\n${cfg.persona}` : "",
      t.channel === "sms"
        ? "You are answering by SMS: plain text only, no markdown, no lists, at most three short sentences. Do not greet or sign: that is added for you."
        : t.channel === "email"
          ? "You are answering by email: plain text only, no markdown, short paragraphs. Do not add a greeting line or a signature: they are added for you."
          : "",
      `Tone: ${cfg.tone}. ${cfg.languages.length ? `You may answer in: ${cfg.languages.join(", ")}; reply in the visitor's language when it is one of them.` : "Reply in the language the visitor writes in."}`,
      SAFETY_RULES,
      "Answer ONLY from <knowledge>. If it does not contain the answer, set handoff=true with handoff_reason \"no_answer\" and leave answer empty. Never invent policies, prices, order data, dates, links or promises; mention a link only if it appears in <knowledge>.",
      "If the visitor asks for a person, or the topic is sensitive (refunds, legal, safety, account security, cancellation), set handoff=true.",
      `Return one JSON object: {"answer": string, "confidence": 0..1, "intent": "question|complaint|purchase|support|spam|other", "subject": short title, "handoff": boolean, "handoff_reason": string, "department_id": one of the ids in <departments> or null, "department_confidence": 0..1, "cited_ids": ids of the <knowledge> entries you used, "clarifying_question": string, "resolved": boolean, "actions": [{"tool": "search_kb", "query": string} | {"tool": "set_department", "department_id": string} | {"tool": "collect_contact_info", "fields": ["name"|"email"|"phone"]} | {"tool": "resolve_ticket"} | {"tool": "schedule_callback"} | {"tool": "offer_call", "kind": "voice"|"video", "with": "team"|"ai"} | {"tool": "share_call_link", "kind": "voice"|"video", "with": "ai"|"team"}]}. Use share_call_link only when the visitor has no phone number or email on file and wants to talk by voice or video: it gives them a link that works on any device. Use offer_call with "ai" only to offer a spoken call with yourself, "team" for a call with a person.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    prompt: `${untrusted("conversation", tr.text)}\n\n${untrusted("knowledge", knowledge)}\n\n${depts ? `<departments>\n${depts}\n</departments>\n\n` : ""}${details ? `${untrusted("visitor_details", details)}\n\n` : ""}Write the next reply to the visitor's latest message.`,
    input: {
      text: t.text,
      tone: cfg.tone,
      agentName: cfg.name,
      coverageThreshold: cfg.coverage_threshold,
      kb: hits.map((h) => ({ id: h.doc.id, question: h.doc.question, answer: h.doc.answer, url: h.doc.url ?? null, score: h.score, coverage: h.coverage })),
    },
  };
}

async function callModel(ctx: AppContext, provider: AiProvider, req: AiRequest): Promise<{ out: AgentAnswer; actions: unknown[] }> {
  let raw: string;
  try {
    raw = await provider.complete(req);
  } catch (e) {
    ctx.log.warn("ai agent provider failed", { provider: provider.name, error: e instanceof Error ? e.message : String(e) });
    throw new AiUnavailableError();
  }
  const out = parseModelJson(raw ?? "", AgentAnswerSchema);
  return { out, actions: out.actions };
}

/* ---------- actions the model may ask for ---------- */

function plan(raw: unknown[], cfg: AgentDto, trace: string[]): ModelAction[] {
  const out: ModelAction[] = [];
  for (const r of raw) {
    const p = ActionSchema.safeParse(r);
    if (!p.success) {
      trace.push("a tool request was malformed and ignored");
      continue;
    }
    const need = ALLOWS[p.data.tool];
    if (need && !cfg.allowed_actions.includes(need as never)) {
      trace.push(`tool ${p.data.tool} is not allowed for this agent (${need})`);
      continue;
    }
    out.push(p.data);
  }
  return out.slice(0, 3);
}

/* ---------- the decision ---------- */

const sourceOf = (h: KbHit): Source => ({ id: h.doc.id, question: h.doc.question, url: h.doc.url ?? null, score: Math.round(h.score * 100) / 100, coverage: Math.round(h.coverage * 100) / 100 });

function empty(t: TurnInput, cls: Classification): Decision {
  return {
    kind: "clarify",
    text: "",
    handoff: null,
    confirm: null,
    confidence: 0,
    intent: cls.intent,
    sentiment: cls.sentiment,
    urgency: cls.urgency,
    department: { id: cls.department.id, confidence: cls.department.confidence },
    sources: [],
    actions: [],
    subject: null,
    quickReplies: false,
    tokens: { in: 0, out: 0 },
    latencyMs: 0,
    provider: "",
    degraded: false,
    trace: [],
  };
}

const CLARIFY = "Could you tell me a little more about what you need? For example the product, the page or the error message you see.";
const REFUSAL = "I can only help with questions about our products and services, based on our help centre. Is there something I can look up for you?";

export async function decideTurn(ctx: AppContext, t: TurnInput): Promise<Decision> {
  const started = Date.now();
  const cfg = agentDto(t.agent);
  const settings = await getSettings(ctx, t.workspaceId);
  const cls = classifyText(t.text, t.departments);
  const d = empty(t, cls);
  const { trace } = d;
  trace.push(`classified: intent ${cls.intent}, sentiment ${cls.sentiment}, urgency ${cls.urgency}${cls.department.id ? `, department ${cls.department.id} (${cls.department.confidence.toFixed(2)})` : ""}`);

  const hand = (reason: HandoffReason, why: string): Decision => {
    trace.push(`hand-off: ${why}`);
    d.kind = cfg.autonomy === "suggest_only" ? "suggest" : "handoff";
    d.handoff = { reason, departmentId: null, skills: [] };
    d.latencyMs = Date.now() - started;
    return d;
  };

  // 1. what the visitor wrote
  if (looksLikeInjection(t.text)) {
    trace.push("safety: the message looks like an instruction aimed at the assistant; it is not sent to the model");
    if (t.counters.refusals >= 1) return hand("suspicious_input", "second suspicious message");
    d.kind = "refuse";
    d.text = REFUSAL;
    d.latencyMs = Date.now() - started;
    return d;
  }
  const triggers = cfg.handoff_triggers;
  if (triggers.human_request && cls.wantsHuman) return hand("customer_requested_human", "the visitor asks for a person");
  if (triggers.sensitive_topic && isSensitiveTopic(t.text, triggers.sensitive_topics)) return hand("sensitive_topic", "a topic that needs a person");
  if (triggers.vip_contact && t.contact.tags.some((x) => x.toLowerCase() === "vip")) return hand("vip_contact", "a VIP contact");
  if (triggers.negative_sentiment && cls.sentiment === "negative" && (cls.intent === "complaint" || cls.urgency >= 0.6)) return hand("negative_sentiment", "the visitor sounds upset");
  if (triggers.high_urgency && cls.urgency >= 0.8) return hand("high_urgency", "the message looks urgent");
  const customerTexts = t.lines.filter((l) => l.role === "customer").map((l) => l.text);
  if (triggers.repeated_rephrase && rephraseStreak(customerTexts) >= 2) return hand("repeated_rephrase", "the visitor keeps asking the same thing");
  if (t.counters.turns >= cfg.max_turns) return hand("max_turns", `the turn limit of ${cfg.max_turns} is reached`);

  // 2. the visitor said the answer did not help
  let attempts = t.counters.attempts + (t.dissatisfied ? 1 : 0);
  const giveUp = (reason: HandoffReason, why: string): Decision | null => (attempts >= cfg.max_attempts && triggers.low_confidence ? hand(reason, why) : null);
  if (t.dissatisfied) {
    const g = giveUp("low_confidence", `the visitor was not helped ${attempts} time(s)`);
    if (g) return g;
    d.kind = "clarify";
    d.text = "I'm sorry that did not help. What is still unclear? You can also ask for a person at any time.";
    d.quickReplies = false;
    d.latencyMs = Date.now() - started;
    return d;
  }

  // 3. the knowledge base
  const index = await kbIndex(ctx, t.workspaceId);
  const scoped = (hits: KbHit[]) => (cfg.kb_collections.length ? hits.filter((h) => cfg.kb_collections.includes(h.doc.collection ?? "")) : hits);
  let hits = scoped(index.search(t.text, 8)).slice(0, 3);
  trace.push(`retrieval: ${hits.length} entries${hits[0] ? `, best coverage ${hits[0].coverage.toFixed(2)}` : ""}`);
  const strong = (): KbHit[] => hits.filter((h) => h.coverage >= cfg.coverage_threshold);
  if (!strong().length) {
    // no model call: there is nothing to ground an answer in
    attempts += 1;
    const g = giveUp("no_answer", "the knowledge base has nothing for this question");
    if (g) return g;
    d.kind = "clarify";
    d.text = CLARIFY;
    d.latencyMs = Date.now() - started;
    trace.push("no knowledge covers the question: asking for details");
    return d;
  }

  // 4. the model, or the offline rules agent
  const { provider, degraded } = await modelFor(ctx, t.workspaceId, t.provider);
  d.degraded = degraded;
  if (degraded) trace.push("the daily AI quota is used up: the rules agent answers");
  let out: AgentAnswer | null = null;
  let raw: unknown[] = [];
  let active = provider;
  const ws = await ctx.db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", t.workspaceId);
  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const req = buildRequest(t, cfg, strong(), settings.ai_redact_pii, ws?.name ?? "the company");
    d.tokens.in += estimateTokens(req.system) + estimateTokens(req.prompt);
    try {
      ({ out, actions: raw } = await callModel(ctx, active, req));
    } catch (e) {
      if (!(e instanceof AiUnavailableError || e instanceof AiOutputError)) throw e;
      if (active.name === "heuristic") {
        trace.push("the rules agent could not answer either");
        return triggers.tool_failure ? hand("tool_failure", "the AI provider failed") : { ...d, kind: "clarify", text: CLARIFY, latencyMs: Date.now() - started };
      }
      trace.push(`the provider failed (${e instanceof Error ? e.message : "error"}): the rules agent answers instead`);
      active = new HeuristicProvider();
      d.degraded = true;
      call--; // the fallback does not count against the model-call budget
      continue;
    }
    d.tokens.out += estimateTokens(JSON.stringify(out));
    d.provider = active.name;
    const search = raw.map((x) => ActionSchema.safeParse(x)).find((p) => p.success && p.data.tool === "search_kb");
    if (search?.success && search.data.tool === "search_kb" && !out.answer.trim() && !out.handoff && call + 1 < MAX_MODEL_CALLS) {
      const more = scoped(index.search(search.data.query, 8)).slice(0, 3);
      trace.push(`the model asked to search for "${search.data.query}": ${more.length} entries`);
      if (!t.dryRun) await recordAudit(ctx, { workspaceId: t.workspaceId, actor: { type: "system" }, action: "ai_agent.tool", detail: { tool: "search_kb", agent_id: t.agent.id, hits: more.length } });
      hits = [...new Map([...hits, ...more].map((h) => [h.doc.id, h])).values()].slice(0, 4);
      continue;
    }
    break;
  }
  if (!out) return hand("tool_failure", "no answer from the model");

  // 5. guard what came back
  d.confidence = out.confidence;
  d.intent = out.intent;
  d.subject = out.subject?.trim() || null;
  const acts = plan(raw, cfg, trace);
  d.actions = acts.filter((a) => a.tool !== "search_kb" && a.tool !== "handoff_to_human").map((a) => a as PlannedAction);
  const modelDept = out.department_id && t.departments.some((x) => x.id === out.department_id) ? { id: out.department_id, confidence: out.department_confidence ?? 0.5 } : null;
  if (modelDept && modelDept.confidence >= cls.department.confidence) d.department = modelDept;
  const wantsHandoff = out.handoff || acts.some((a) => a.tool === "handoff_to_human");
  if (wantsHandoff) {
    const asked = acts.find((a) => a.tool === "handoff_to_human");
    const reason = isReason(out.handoff_reason) ? out.handoff_reason : "model_handoff";
    const handDept = asked && asked.tool === "handoff_to_human" ? asked.department_id ?? null : null;
    if (reason === "no_answer" || reason === "low_confidence" || reason === "model_handoff") {
      attempts += 1;
      if (!triggers.low_confidence || attempts < cfg.max_attempts) {
        d.kind = "clarify";
        d.text = out.clarifying_question?.trim() || CLARIFY;
        d.latencyMs = Date.now() - started;
        trace.push(`the model could not answer (${reason}): asking for details (attempt ${attempts} of ${cfg.max_attempts})`);
        return d;
      }
    }
    const r = hand(reason, `the model asked for a person (${reason})`);
    if (r.handoff && handDept) r.handoff.departmentId = handDept;
    return r;
  }
  if (out.confidence < cfg.confidence_threshold) {
    attempts += 1;
    trace.push(`confidence ${out.confidence.toFixed(2)} is below ${cfg.confidence_threshold}`);
    const g = giveUp("low_confidence", "confidence stayed too low");
    if (g) return g;
    d.kind = "clarify";
    d.text = out.clarifying_question?.trim() || CLARIFY;
    d.latencyMs = Date.now() - started;
    return d;
  }
  const cited = hits.filter((h) => out!.cited_ids.includes(h.doc.id));
  const grounding = (cited.length ? cited : strong()).slice(0, 3);
  let answer = stripUnsourcedLinks(out.answer.trim(), grounding.map((h) => h.doc.url).filter((u): u is string => !!u));
  if (!answer) return hand("no_answer", "the answer was empty");
  const banned = bannedClaims(answer);
  if (banned.length) {
    trace.push(`the answer was blocked: ${banned.join(", ")}`);
    return hand("unsafe_answer", `the answer broke a claims rule (${banned.join(", ")})`);
  }
  const kbText = hits.map((h) => `${h.doc.question} ${h.doc.answer}`).join("\n");
  if (unsupportedCommitment(answer, kbText)) {
    trace.push("the answer promised money or a price the knowledge base does not state");
    return hand("unsafe_answer", "the answer contained an ungrounded commitment");
  }

  // 6. the answer, with where it came from
  const links = grounding.filter((h) => h.doc.url);
  if (links.length) answer += `\n\nFrom our help centre:\n${links.map((h) => `${h.doc.question.slice(0, 80)}: ${h.doc.url}`).join("\n")}`;
  if (t.firstTurn && cfg.greeting) answer = `${cfg.greeting}\n\n${answer}`;
  d.kind = "answer";
  d.text = answer;
  d.sources = grounding.map(sourceOf);
  d.quickReplies = cfg.allowed_actions.includes("quick_replies");
  d.latencyMs = Date.now() - started;
  trace.push(`answer from ${grounding.length} knowledge entr${grounding.length === 1 ? "y" : "ies"}, confidence ${out.confidence.toFixed(2)}`);
  return d;
}

/* ---------- applying a decision ---------- */

export function botCounters(ticket: Pick<TicketRow, "meta">): BotCounters {
  const m = parseJson<{ bot?: Partial<BotCounters> }>(ticket.meta, {}).bot ?? {};
  return { turns: Number(m.turns ?? 0), attempts: Number(m.attempts ?? 0), refusals: Number(m.refusals ?? 0), asked_department: !!m.asked_department };
}

async function saveCounters(ctx: AppContext, ticketId: string, patch: Partial<BotCounters> & { agent_id?: string; last_reason?: string }): Promise<void> {
  const row = await ctx.db.get<{ meta: string }>("SELECT meta FROM tickets WHERE id = ?", ticketId);
  const meta = parseJson<Record<string, unknown>>(row?.meta, {});
  const bot = { ...((meta.bot as Record<string, unknown>) ?? {}), ...patch };
  await ctx.db.run("UPDATE tickets SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, bot }), ticketId);
}

export const agentMeta = (a: AgentDto) => ({ id: a.id, name: a.name, label: a.disclosure_label, avatar_url: a.avatar_url });

function typing(ctx: AppContext, room: RoomRow, a: AgentDto, on: boolean) {
  const who = { type: "agent", id: "bot", name: a.name };
  ctx.bus.toRoom(room.workspace_id, room.id, "typing", { room_id: room.id, typing: on, who }, { visitor: { room_id: room.id, typing: on, who: { type: "agent", name: a.name } } });
}

export async function postBot(ctx: AppContext, room: RoomRow, a: AgentDto, text: string, meta: Record<string, unknown>, kind: "text" | "note" = "text"): Promise<MessageRow> {
  const r = await insertMessage(ctx, {
    workspaceId: room.workspace_id,
    roomId: room.id,
    senderType: "bot",
    senderId: a.id,
    senderName: a.name,
    kind,
    source: "dm",
    content: textToHtml(text),
    contentText: text,
    meta: { ai: true, agent: agentMeta(a), ...meta },
  });
  await emitInserted(ctx, r);
  return r.message;
}

/** The widget gets a bot message in the thread; SMS and email get a plain-text message through the delivery pipeline (agents/channelReply.ts). */
async function postReply(ctx: AppContext, i: ApplyInput, a: AgentDto, text: string, meta: Record<string, unknown>): Promise<MessageRow> {
  if (i.channel === "sms" || i.channel === "email") {
    const { postChannelAnswer } = await import("./channelReply.js");
    return postChannelAnswer(ctx, i.room, a, i.channel, text, meta);
  }
  return postBot(ctx, i.room, a, text, meta);
}

export const QUICK_REPLY_SOLVED = {
  type: "quick_replies",
  purpose: "solved",
  prompt: "Did that solve your problem?",
  options: [
    { id: "yes", label: "Yes, thanks" },
    { id: "no", label: "Not quite" },
    { id: "human", label: "Talk to a person" },
  ],
} as const;

/** What one turn did, for callers that need the answer itself (the AI call speaks it). Filled by `applyDecision`. */
export interface TurnCapture {
  decision?: Decision;
  outcome?: "posted" | "handoff" | "aborted" | "resolved" | "none";
  messageId?: string | null;
}

/** The ticket is the agent's: mark it (once), stop the first-response clock, remember which agent. */
export async function assignBot(ctx: AppContext, live: TicketRow, a: Pick<AgentDto, "id" | "name">): Promise<void> {
  if (live.handler !== `bot:${a.id}` || live.status === "new") {
    await ctx.db.run("UPDATE tickets SET handler = ?, status = CASE WHEN status IN ('new','bot_handling') THEN 'bot_handling' ELSE status END, sla_first_response_due_at = CASE WHEN handoff_at IS NULL THEN NULL ELSE sla_first_response_due_at END, updated_at = ? WHERE id = ?", `bot:${a.id}`, nowIso(ctx), live.id);
    await recordTicketEvent(ctx, live, "bot_assigned", { type: "bot", id: a.id }, { agent: a.name });
  }
}

export interface ApplyInput {
  room: RoomRow;
  ticket: TicketRow;
  agentRow: AgentRow;
  decision: Decision;
  trigger: MessageRow | null;
  query: string;
  departments: DepartmentChoice[];
  /** the caller wants to know what happened (the AI call) */
  capture?: TurnCapture;
  /** answers go out by SMS or email instead of the chat */
  channel?: "widget" | "sms" | "email";
}

/** The ticket is still the agent's to work: nobody took it over, nothing ended it, while the model was thinking. */
async function stillMine(ctx: AppContext, ticketId: string, agentId: string): Promise<TicketRow | null> {
  const t = await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", ticketId);
  if (!t || t.status === "resolved" || t.status === "closed") return null;
  if (t.handler?.startsWith("human:")) return null;
  if (t.handler && t.handler !== `bot:${agentId}`) return null;
  return t;
}

async function recordTurn(ctx: AppContext, i: ApplyInput, outcome: string, messageId: string | null, extra: { actions?: { tool: string; ok: boolean; detail?: string }[] } = {}) {
  const d = i.decision;
  const redact = (await getSettings(ctx, i.room.workspace_id)).ai_redact_pii;
  const q = (redact ? redactPii(i.query) : i.query).replace(/\s+/g, " ").trim().slice(0, 300);
  await ctx.db.run(
    `INSERT INTO ai_turns(id, workspace_id, ticket_id, room_id, agent_id, trigger_message_id, message_id, outcome, intent, department_id, confidence, reason, sources, actions, query, provider, tokens_in, tokens_out, latency_ms, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("trn"),
    i.room.workspace_id,
    i.ticket.id,
    i.room.id,
    i.agentRow.id,
    i.trigger?.id ?? null,
    messageId,
    outcome,
    d.intent,
    d.department.id,
    d.confidence,
    d.handoff?.reason ?? null,
    JSON.stringify(d.sources),
    JSON.stringify(extra.actions ?? []),
    q,
    d.provider || (d.degraded ? "heuristic" : ""),
    d.tokens.in,
    d.tokens.out,
    d.latencyMs,
    nowIso(ctx),
  );
}

async function summaryNote(ctx: AppContext, i: ApplyInput): Promise<string> {
  const d = i.decision;
  const lines = [
    `AI agent ${i.agentRow.name} hands this over.`,
    `Visitor asked: ${i.query.slice(0, 200)}`,
    `Detected: intent ${d.intent}, sentiment ${d.sentiment}, urgency ${d.urgency}.`,
  ];
  const attempted = await ctx.db.all<{ sources: string }>("SELECT sources FROM ai_turns WHERE ticket_id = ? AND outcome IN ('answered','suggested') ORDER BY created_at DESC LIMIT 3", i.ticket.id);
  const titles = attempted.flatMap((r) => parseJson<Source[]>(r.sources, []).map((s) => s.question));
  if (titles.length) lines.push(`Answers already given from: ${[...new Set(titles)].join("; ")}`);
  const contact = await getContact(ctx, i.room.workspace_id, i.room.contact_id);
  const got = [contact.name && contact.name !== "Visitor" ? `name ${contact.name}` : "", contact.email ? `email ${contact.email}` : "", contact.phone ? `phone ${contact.phone}` : ""].filter(Boolean);
  // the team may see the details; the redaction setting only protects what leaves for a model
  if (got.length) lines.push(`Contact details on file: ${got.join(", ")}`);
  if (d.kind === "suggest" && d.text) lines.push("", "Suggested reply:", d.text);
  return lines.join("\n");
}

/**
 * Carry out a decision. Returns what happened. Re-checks the ticket first: a person who took it over while the model was working wins, and the
 * bot says nothing.
 */
export async function applyDecision(ctx: AppContext, i: ApplyInput): Promise<"posted" | "handoff" | "aborted" | "resolved"> {
  const out = await applyDecisionInner(ctx, i);
  if (i.capture) {
    i.capture.decision = i.decision;
    i.capture.outcome = out;
  }
  return out;
}

async function applyDecisionInner(ctx: AppContext, i: ApplyInput): Promise<"posted" | "handoff" | "aborted" | "resolved"> {
  const a = agentDto(i.agentRow);
  const d = i.decision;
  const live = await stillMine(ctx, i.ticket.id, a.id);
  if (!live) return "aborted";
  const counters = botCounters(live);
  const ws = i.room.workspace_id;

  await assignBot(ctx, live, a);
  if (d.subject && live.subject_set_by === "auto" && counters.turns === 0) {
    await ctx.db.run("UPDATE tickets SET subject = ? WHERE id = ? AND subject_set_by = 'auto'", d.subject.slice(0, 120), live.id);
  }

  // the agent's own tools, each one audited and shown to the team: the department first (a hand-off needs it), the others after the visitor's message
  const results: { tool: string; ok: boolean; detail?: string }[] = [];
  const runTools = async (list: PlannedAction[]) => {
    for (const act of list) {
      const r = await executeTool(ctx, { room: i.room, ticket: live, agent: a, action: act });
      results.push({ tool: act.tool, ok: r.ok, detail: r.detail });
      await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "ai_agent.tool", target: live.id, detail: { tool: act.tool, ok: r.ok, agent_id: a.id, ticket_id: live.id } });
      await postSystemMessage(ctx, i.room.id, ws, `${a.name} (AI agent): ${r.summary}`, { sub_type: "ai_action", tool: act.tool, ok: r.ok });
    }
  };
  await runTools(d.actions.filter((x) => x.tool === "set_department"));
  const afterActions = d.actions.filter((x) => x.tool !== "set_department");

  const next: Partial<BotCounters> & { agent_id: string; last_reason?: string } = { agent_id: a.id, turns: counters.turns + 1 };

  if (d.kind === "answer" || d.kind === "clarify" || d.kind === "refuse") {
    typing(ctx, i.room, a, true);
    const card = d.kind === "answer" && d.quickReplies ? { card: QUICK_REPLY_SOLVED } : {};
    const msg = await postReply(ctx, i, a, d.text, { confidence: d.confidence, kb_ids: d.sources.map((s) => s.id), sources: d.sources.filter((s) => s.url).map((s) => ({ title: s.question, url: s.url })), ...card });
    typing(ctx, i.room, a, false);
    if (i.capture) i.capture.messageId = msg.id;
    if (d.kind === "clarify") next.attempts = counters.attempts + 1;
    if (d.kind === "refuse") next.refusals = counters.refusals + 1;
    if (d.kind === "answer") next.attempts = 0;
    await saveCounters(ctx, live.id, next);
    await runTools(afterActions);
    await recordTurn(ctx, i, d.kind === "answer" ? "answered" : d.kind === "clarify" ? "clarified" : "refused", msg.id, { actions: results });
    await publishTickets(ctx, [live.id]);
    return "posted";
  }

  if (d.kind === "confirm_department" && d.confirm) {
    typing(ctx, i.room, a, true);
    const opts = d.confirm.options.map((o) => ({ id: `dept:${o.id}`, label: o.name }));
    const names = d.confirm.options.map((o) => o.name);
    const msg = await postReply(ctx, i, a, `So that I send you to the right people: is this about ${names.length === 2 ? `${names[0]} or ${names[1]}` : names.join(", ")}?`, {
      card: { type: "quick_replies", purpose: "department", prompt: "Choose the closest match", options: opts, reason: d.handoff?.reason ?? "model_handoff" },
    });
    typing(ctx, i.room, a, false);
    await saveCounters(ctx, live.id, { ...next, asked_department: true });
    await recordTurn(ctx, i, "clarified", msg.id, { actions: results });
    return "posted";
  }

  if (d.kind === "resolve") {
    const row = await resolveTicketRow(ctx, live.id, { type: "bot", id: a.id }, { resolution: "bot_resolved", reason: "visitor_confirmed" });
    if (row) await announceResolved(ctx, row);
    await saveCounters(ctx, live.id, next);
    await recordTurn(ctx, i, "resolved", null, { actions: results });
    await publishTickets(ctx, [live.id]);
    await publishRoomUpdated(ctx, await getRoomRow(ctx, ws, i.room.id));
    return "resolved";
  }

  // hand-off (also the suggest-only agent: it drafts for the team and the visitor goes straight to a person)
  const h = d.handoff ?? { reason: "model_handoff", departmentId: null, skills: [] };
  const note = await summaryNote(ctx, i);
  await saveCounters(ctx, live.id, next);
  await recordTurn(ctx, i, d.kind === "suggest" ? "suggested" : "handoff", null, { actions: results });
  await handoffTicket(ctx, live.id, { reason: d.kind === "suggest" ? "suggest_only" : h.reason, by: { type: "bot", id: a.id }, departmentId: h.departmentId ?? undefined, skills: h.skills, note });
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "ai_agent.handoff", target: live.id, detail: { agent_id: a.id, reason: h.reason, ticket_id: live.id } });
  return "handoff";
}

/* ---------- one visitor message ---------- */

async function transcriptOf(ctx: AppContext, ticketId: string, roomId: string): Promise<{ lines: TranscriptLine[]; lastContact: MessageRow | undefined }> {
  const rows = await ctx.db.all<MessageRow>(
    "SELECT * FROM messages WHERE room_id = ? AND ticket_id = ? AND deleted_at IS NULL AND kind NOT IN ('note','system') ORDER BY seq DESC LIMIT 40",
    roomId,
    ticketId,
  );
  rows.reverse();
  // an email carries the whole quoted history: the transcript keeps only what each message added
  const lines: TranscriptLine[] = rows.map((m) => ({ role: m.sender_type === "contact" ? "customer" : m.sender_type === "bot" ? "bot" : "agent", text: (m.source === "email" ? stripQuoted(m.content_text) : m.content_text) || (m.attachments !== "[]" ? "[attachment]" : "") }));
  return { lines, lastContact: [...rows].reverse().find((m) => m.sender_type === "contact") };
}

export async function departmentChoices(ctx: AppContext, ws: string, agent: AgentRow): Promise<DepartmentChoice[]> {
  const scope = parseJson<string[]>(agent.department_ids, []);
  const rows = await ctx.db.all<{ id: string; name: string; description: string }>("SELECT id, name, description FROM inboxes WHERE workspace_id = ? ORDER BY name, id", ws);
  return rows.filter((r) => !scope.length || scope.includes(r.id));
}

/** Where a hand-off should go: the visitor's own department, a confident classification when the conversation has no specific one, or a question. */
function routeHandoff(d: Decision, t: TurnInput, cfg: AgentDto): Decision {
  if (d.kind !== "handoff" && d.kind !== "suggest") return d;
  if (!d.handoff || !cfg.allowed_actions.includes("route") || t.departments.length < 2) return d;
  if (d.handoff.departmentId) return d;
  const urgent = ["high_urgency", "negative_sentiment", "sensitive_topic", "vip_contact"].includes(d.handoff.reason);
  const generic = !t.currentDepartmentId || t.departments.find((x) => x.id === t.currentDepartmentId) === undefined;
  const { id, confidence } = d.department;
  if (id && id !== t.currentDepartmentId && confidence >= 0.6 && (generic || t.currentDepartmentId === null)) {
    d.handoff.departmentId = id;
    d.trace.push(`routing: the question points at ${id} (${confidence.toFixed(2)})`);
    return d;
  }
  if (!urgent && !t.counters.asked_department && cfg.allowed_actions.includes("quick_replies") && id && confidence >= 0.35 && confidence < 0.6 && d.kind === "handoff" && !t.currentDepartmentId) {
    const cls = classifyText(t.text, t.departments);
    const opt = [cls.department.id, cls.department.second?.id].filter((x): x is string => !!x).map((x) => t.departments.find((y) => y.id === x)!).filter(Boolean);
    if (opt.length === 2) {
      d.kind = "confirm_department";
      d.confirm = { options: opt.map((o) => ({ id: o.id, name: o.name })) };
      d.trace.push("routing: not sure which department: asking the visitor");
    }
  }
  return d;
}

/** Run one turn for `message` if an AI agent works this conversation. 'handled' = skip the old auto-responder, notifications and away message. */
export async function handleCustomerMessage(ctx: AppContext, room: RoomRow, message: MessageRow, opts: { provider?: AiProvider } = {}): Promise<"handled" | "none"> {
  if (message.sender_type !== "contact" || message.source !== "dm") return "none";
  const meta = parseJson<{ quick_reply?: unknown; human_request?: unknown; form_submission?: unknown; call_utterance?: unknown; ai_call?: unknown }>(message.meta, {});
  // messages the server wrote for the visitor (a tap, "talk to a person", a submitted form) are acted on by their own handler, not answered;
  // what is said in an AI call is answered by the call itself (it needs the answer in its own reply), and the call's first line only opens the ticket
  if (meta.quick_reply || meta.human_request || meta.form_submission || meta.call_utterance || meta.ai_call) return "handled";
  return handleAgentTurn(ctx, room, message, opts);
}

/** The turn itself (also run after "Not quite", which has its own handler and needs `dissatisfied`). */
export async function handleAgentTurn(ctx: AppContext, room: RoomRow, message: MessageRow, opts: { provider?: AiProvider; dissatisfied?: boolean; capture?: TurnCapture; channel?: "widget" | "sms" | "email"; text?: string } = {}): Promise<"handled" | "none"> {
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket || ticket.status === "resolved") return "none";
  const sel = await selectAgent(ctx, room.workspace_id, { channel: opts.channel ?? "widget", departmentId: ticket.department_id ?? room.inbox_id });
  if (!sel) return "none";
  // a person has it, or it is waiting for one: the team is told about the message the usual way
  if (ticket.handler?.startsWith("human:") || ticket.status === "waiting_for_human") return "none";
  if (!sel.inHours) {
    await handoffTicket(ctx, ticket.id, { reason: "outside_hours", by: { type: "bot", id: sel.agent.id } });
    return "handled";
  }
  const lock = async (): Promise<"handled" | "none"> => {
    for (let n = 0; n < 60; n++) {
      const r = await ctx.locks.withLock(`agent-turn:${ticket.id}`, 90_000, () => turn(ctx, room, message, sel.agent, opts));
      if (r !== undefined) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    return "handled";
  };
  return lock();
}

async function turn(ctx: AppContext, room: RoomRow, message: MessageRow, agentRow: AgentRow, opts: { provider?: AiProvider; dissatisfied?: boolean; capture?: TurnCapture; channel?: "widget" | "sms" | "email"; text?: string }): Promise<"handled" | "none"> {
  const ticket = await stillMine(ctx, (await liveTicketOf(ctx, room.id))?.id ?? "", agentRow.id);
  if (!ticket) return "none";
  // a newer visitor message is already waiting: its own turn answers both
  const newer = await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND sender_type = 'contact' AND seq > ? AND deleted_at IS NULL LIMIT 1", room.id, message.seq);
  if (newer) return "handled";
  const fresh = await getRoomRow(ctx, room.workspace_id, room.id);
  const { lines } = await transcriptOf(ctx, ticket.id, room.id);
  const counters = botCounters(ticket);
  const contact = await getContact(ctx, room.workspace_id, room.contact_id);
  const departments = await departmentChoices(ctx, room.workspace_id, agentRow);
  const rctx = parseJson<{ context?: { page_url?: string | null; locale?: string | null } }>(fresh.meta, {}).context ?? {};
  const cfg = agentDto(agentRow);
  const input: TurnInput = {
    workspaceId: room.workspace_id,
    agent: agentRow,
    text: opts.text ?? message.content_text,
    lines,
    contact: { name: contact.name, tags: parseJson<string[]>(contact.tags, []), email: contact.email, phone: contact.phone },
    context: { page_url: rctx.page_url ?? null, locale: rctx.locale ?? null },
    departments,
    currentDepartmentId: ticket.department_id ?? fresh.inbox_id,
    counters,
    dissatisfied: opts.dissatisfied,
    firstTurn: counters.turns === 0,
    provider: opts.provider,
    channel: opts.channel,
  };
  let decision: Decision;
  const confirmed = !opts.dissatisfied && isConfirmation(opts.text ?? message.content_text) && counters.turns > 0;
  if (confirmed) {
    decision = { ...empty(input, classifyText(message.content_text, departments)), kind: "resolve", trace: ["the visitor confirms the problem is solved"], provider: "rules" };
  } else decision = routeHandoff(await decideTurn(ctx, input), input, cfg);
  // suggest-only agents never talk to the visitor
  if (cfg.autonomy === "suggest_only" && (decision.kind === "answer" || decision.kind === "clarify")) {
    decision = { ...decision, kind: "suggest", handoff: { reason: "suggest_only", departmentId: null, skills: [] } };
  }
  await applyDecision(ctx, { room: fresh, ticket, agentRow, decision, trigger: message, query: opts.text ?? message.content_text, departments, capture: opts.capture, channel: opts.channel });
  return "handled";
}
