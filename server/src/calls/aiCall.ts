import type { AiProvider } from "../ai/provider.js";
import { redactPii } from "../ai/text.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { agentDto, selectAgent, type AgentRow } from "../agents/config.js";
import { assignBot, handleAgentTurn, postBot, type TurnCapture } from "../agents/pipeline.js";
import { visitorRequestHuman } from "../agents/visitorActions.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "../services/audit.js";
import { getRoomRow } from "../services/roomStore.js";
import { liveTicketOf, recordTicketEvent, type TicketRow } from "../services/tickets.js";
import { getVisitorRoom, visitorSend } from "../services/visitorChat.js";
import type { SessionRow } from "../services/visitors.js";
import { IllegalTransition } from "./machine.js";
import { negotiateRealtime, sweepRealtime, type FallbackReason, type RealtimeAck } from "./realtimeCall.js";
import { browserSpeech, speakable, speechLanguage } from "./speech.js";
import { callDto, callSettings, postCardFor, publish, requestCall, stepCall, visitorCallDto, RECONNECT_GRACE_S, type CallRow } from "./service.js";
import { getSettings } from "../services/workspaces.js";

/**
 * Calls with the AI agent (docs/CALLS.md, ADR 0033). The visitor's browser listens and speaks; this service receives TEXT. Each thing the visitor says is
 * stored as an ordinary visitor message and answered by the same pipeline as a typed message (knowledge base, safety guards, hand-off triggers, AI
 * budget, audit, turn records), and the answer is both stored as an ordinary bot message and returned to the browser to be spoken. A call is a row in
 * `calls` (transport `ai`, kind `ai_voice` or `ai_video`) so it appears in the thread, the ticket timeline and the analytics like any other call.
 *
 * Nothing here records audio, and a "video" call with the AI sends no video anywhere: it shows the agent's avatar (the visitor's own camera is a local
 * self-view at most).
 */

export type AiKind = "voice" | "video";
const kindOf = (k: AiKind) => (k === "video" ? "ai_video" : "ai_voice");
export type AiEndReason = "completed" | "silence" | "unsupported" | "error" | "handoff" | "taken_over" | "idle" | "max_duration" | "resolved" | "disconnected" | "monitor" | "kill_switch" | "budget";

/** Fixed lines the visitor's browser says when the server ends or moves the call: plain text here, translated by the page where it can. */
export const AI_LINES = {
  handoff: "I'm connecting you with a person.",
  handoff_call: "I'm connecting you with a person. Keep this window open: they will call you here.",
  resolved: "Glad I could help. Goodbye!",
  taken_over: "A person has joined this conversation.",
  max_duration: "We have reached the time limit for a call with me. A person can continue by chat or call.",
  idle: "I did not hear anything, so I am ending the call. You can start again at any time.",
} as const;

export const MAX_UTTERANCE_CHARS = 600;

/* ---------- availability (public config, start) ---------- */

export interface AiCallAvailability {
  enabled: boolean;
  voice: boolean;
  video: boolean;
  /** the realtime engine is chosen for this workspace and set up on this installation (a call can still fall back to the browser engine) */
  realtime: boolean;
  engine: "browser";
  agent: { name: string; label: string; avatar_url: string | null; avatar_alt: string; languages: string[] } | null;
  max_duration_s: number;
  idle_timeout_s: number;
}

/** An agent can take calls when it is on, is allowed the `ai_call` action and talks to the visitor (suggest-only agents never do). */
const canTakeCalls = (a: AgentRow): boolean => {
  const cfg = agentDto(a);
  return cfg.allowed_actions.includes("ai_call") && cfg.autonomy !== "suggest_only";
};

/** What the widget needs to decide whether to show "Talk to our AI assistant". */
export async function aiCallAvailability(ctx: AppContext, ws: string, departmentId: string | null): Promise<AiCallAvailability> {
  const s = (await callSettings(ctx, ws)).ai;
  const sel = s.enabled ? await selectAgent(ctx, ws, { channel: "widget", departmentId }) : null;
  const agent = sel && canTakeCalls(sel.agent) ? sel.agent : null;
  const cfg = agent ? agentDto(agent) : null;
  return {
    enabled: s.enabled && !!agent,
    voice: s.enabled && s.voice && !!agent,
    video: s.enabled && s.video && !!agent,
    realtime: s.enabled && !!agent && (await callSettings(ctx, ws)).ai_engine === "realtime" && !!ctx.realtime && !!ctx.config.OPENAI_REALTIME_MODEL && ctx.config.AI_REALTIME_ENABLED,
    engine: "browser",
    agent: cfg ? { name: cfg.name, label: cfg.disclosure_label, avatar_url: cfg.avatar_url, avatar_alt: cfg.avatar_alt, languages: cfg.languages } : null,
    max_duration_s: s.max_duration_s,
    idle_timeout_s: s.idle_timeout_s,
  };
}

/* ---------- helpers ---------- */

export async function visitorOwnedAiCall(ctx: AppContext, session: SessionRow, callId: string): Promise<CallRow> {
  const c = await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", callId);
  // 404 for another visitor's call and for a call that is not an AI call: nothing is revealed
  if (!c || c.workspace_id !== session.workspace_id || c.contact_id !== session.contact_id || c.transport !== "ai") throw notFound("Call");
  return c;
}

const isStateConflict = (e: unknown) => e instanceof IllegalTransition || (e instanceof AppError && (e.code === "CALL_STATE_CHANGED" || e.code === "CALL_STATE"));

/** End a live AI call; a call somebody else already ended is not an error (the visitor tapping end while the sweep ends it). */
export async function finishAi(ctx: AppContext, c: CallRow, o: { by: "visitor" | "system"; reason: AiEndReason; handoff?: string }): Promise<CallRow> {
  const fresh = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", c.id)) ?? c;
  try {
    return await stepCall(ctx, fresh, "end", { ended_by: o.by, end_reason: o.reason, handoff_reason: o.handoff });
  } catch (e) {
    if (isStateConflict(e)) return (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", c.id)) ?? fresh;
    throw e;
  }
}

const startOfUtcDay = (ctx: AppContext) => {
  const d = ctx.clock();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

/* ---------- start ---------- */

export interface AiStartInput {
  room_id: string;
  kind: AiKind;
  locale?: string;
  speech?: { stt: boolean; tts: boolean; webrtc?: boolean };
}

export async function startAiCall(ctx: AppContext, session: SessionRow, socketId: string, input: AiStartInput) {
  const room = await getVisitorRoom(ctx, session, input.room_id);
  const ws = room.workspace_id;
  const s = (await callSettings(ctx, ws)).ai;
  if (!s.enabled) throw new AppError(403, "AI_CALLS_DISABLED", "Calls with the AI assistant are switched off");
  if (!s[input.kind]) throw new AppError(403, "AI_CALL_KIND_DISABLED", `${input.kind === "video" ? "Video" : "Voice"} calls with the AI assistant are switched off`);
  let ticket = await liveTicketOf(ctx, room.id);
  // a person has the conversation (or it is queued for one): the AI does not talk over them
  if (ticket && (ticket.handler?.startsWith("human:") || ticket.status === "waiting_for_human")) throw new AppError(409, "HUMAN_HANDLING", "A person is handling this conversation");
  const sel = await selectAgent(ctx, ws, { channel: "widget", departmentId: ticket?.department_id ?? room.inbox_id });
  if (!sel || !canTakeCalls(sel.agent)) throw new AppError(409, "AI_CALL_UNAVAILABLE", "The AI assistant is not available for calls right now");
  if (!sel.inHours) throw new AppError(409, "AI_CALL_UNAVAILABLE", "The AI assistant is outside its hours");
  if (await ctx.db.get("SELECT 1 FROM calls WHERE room_id = ? AND state IN ('ringing','connecting','active')", room.id)) throw new AppError(409, "CALL_IN_PROGRESS", "There is already a call in this conversation");
  const rate = await ctx.ratelimit.check("calls.ai.visitor", { key: `${ws}:${session.contact_id}`, workspaceId: ws });
  if (!rate.allowed) throw new RateLimitedError(rate);

  const agent = agentDto(sel.agent);
  const callId = newId("call");
  // the call needs a ticket to live in (the thread, the hand-over and the analytics all hang on it): the first line of an AI call opens one
  if (!ticket || ticket.status === "resolved") {
    await visitorSend(ctx, session, room.id, { content: `Started a ${input.kind} call with ${agent.name} (${agent.disclosure_label}).`, client_msg_id: `aicall-${callId}`.slice(0, 64) }, { meta: { ai_call: { id: callId, kind: input.kind } } });
    ticket = await liveTicketOf(ctx, room.id);
  }
  if (!ticket) throw new AppError(409, "NO_CONVERSATION", "Write a message first");

  const now = nowIso(ctx);
  const lang = speechLanguage(agent.languages, input.locale);
  const meta = { agent_name: agent.name, label: agent.disclosure_label, lang, speech: input.speech ?? null, ...(session.call_link_id ? { link_id: session.call_link_id } : {}) };
  try {
    await ctx.db.run(
      `INSERT INTO calls(id, workspace_id, room_id, ticket_id, contact_id, transport, kind, state, initiated_by, visitor_socket, created_at, answered_at, updated_at, ai_agent_id, engine, meta)
       VALUES (?,?,?,?,?,'ai',?,'active',?,?,?,?,?,?,?,?)`,
      callId, ws, room.id, ticket.id, room.contact_id, kindOf(input.kind), room.contact_id, socketId, now, now, now, agent.id, browserSpeech.name, JSON.stringify(meta),
    );
  } catch (e) {
    if (e instanceof Error && /unique|UNIQUE|duplicate/i.test(e.message)) throw new AppError(409, "CALL_IN_PROGRESS", "There is already a call in this conversation");
    throw e;
  }
  const cleanup = async () => void (await ctx.db.run("DELETE FROM calls WHERE id = ?", callId));
  // the row is written first and then counted up to it, so parallel starts can only over-refuse, never over-spend; refused starts do not count
  const mine = await ctx.db.get<{ created_at: string }>("SELECT created_at FROM calls WHERE id = ?", callId);
  const todayN = Number((await ctx.db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM calls WHERE workspace_id = ? AND transport = 'ai' AND created_at >= ? AND (created_at < ? OR (created_at = ? AND id <= ?))", ws, startOfUtcDay(ctx), mine!.created_at, mine!.created_at, callId))!.n);
  if (todayN > s.daily_limit) {
    await cleanup();
    throw new AppError(429, "AI_DAILY_LIMIT", "The AI assistant has reached its limit of calls for today. A person can help by chat.");
  }
  const liveN = Number((await ctx.db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM calls WHERE workspace_id = ? AND transport = 'ai' AND state = 'active' AND (created_at < ? OR (created_at = ? AND id <= ?))", ws, mine!.created_at, mine!.created_at, callId))!.n);
  if (liveN > s.max_concurrent) {
    await cleanup();
    throw new AppError(429, "AI_BUSY", "The AI assistant is busy with other calls. Please try again in a minute, or write to us.");
  }
  const lease = await ctx.ratelimit.acquire("ai.concurrency", ws, callId, ws);
  if (!lease.ok) {
    await cleanup();
    throw new AppError(429, "AI_BUSY", "The AI assistant is busy with other calls. Please try again in a minute, or write to us.");
  }

  let row = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", callId))!;
  const roomRow = await getRoomRow(ctx, ws, room.id);
  const messageId = await postCardFor(ctx, roomRow, row);
  await ctx.db.run("UPDATE calls SET message_id = ? WHERE id = ?", messageId, callId);
  row = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", callId))!;
  await assignBot(ctx, ticket, agent);
  await recordTicketEvent(ctx, ticket, "call_started", { type: "bot", id: agent.id }, { call_id: callId, kind: kindOf(input.kind) });
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "call.ai_started", target: callId, detail: { room_id: room.id, kind: kindOf(input.kind), agent_id: agent.id, engine: browserSpeech.name } });
  // the disclosure is spoken first, then the agent's own greeting; both are stored as ordinary bot messages tagged with the call
  const disclosure = `Hi, I'm ${agent.name} (${agent.disclosure_label}), not a person. This call is not recorded.`;
  const greeting = `${disclosure} ${agent.greeting || "How can I help you today?"}`;
  await postBot(ctx, roomRow, agent, greeting, { call_id: callId, via: "voice", kind: "greeting" });
  // the realtime engine, when the workspace chose it and it can be used right now; otherwise (and whenever anything about it fails) the browser engine
  const neg = await negotiateRealtime(ctx, { call: row, agent, session, webrtc: !!input.speech?.webrtc, opening: greeting });
  row = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", callId))!;
  await publish(ctx, row);
  const realtime: RealtimeAck | null = neg.engine === "realtime" ? neg.realtime : null;
  const fallback: FallbackReason | null = neg.engine === "browser" ? neg.fallback : null;
  return {
    call: visitorCallDto(row, agent.name),
    ai: {
      agent: { name: agent.name, label: agent.disclosure_label, avatar_url: agent.avatar_url, avatar_alt: agent.avatar_alt },
      greeting,
      disclosure,
      engine: neg.engine,
      fallback_reason: fallback,
      realtime,
      speech_lang: lang,
      max_duration_s: s.max_duration_s,
      idle_timeout_s: s.idle_timeout_s,
      max_utterance_chars: MAX_UTTERANCE_CHARS,
    },
  };
}

/* ---------- one thing the visitor said ---------- */

export interface AiSayInput {
  call_id: string;
  text: string;
  seq: number;
  via?: "voice" | "typed";
}
export interface AiReply {
  /** `answer`, `clarify`, `refuse`, `handoff`, `resolved`, `taken_over`, `max_duration` */
  kind: string;
  text: string;
  speech: string;
  message_id: string | null;
  /** the call ended with this reply (it still has to be spoken) */
  ended: { reason: AiEndReason; handoff_reason?: string; human_call?: boolean } | null;
}

/** What the visitor said, answered by the same pipeline as a typed message. Idempotent per `seq` (a retry after a lost ack returns the first answer). */
export async function aiSay(ctx: AppContext, session: SessionRow, input: AiSayInput, opts: { provider?: AiProvider } = {}): Promise<{ reply: AiReply; call: ReturnType<typeof visitorCallDto> }> {
  let c = await visitorOwnedAiCall(ctx, session, input.call_id);
  const agentName = parseJson<{ agent_name?: string }>(c.meta, {}).agent_name ?? "AI assistant";
  const out = (reply: AiReply, row: CallRow = c) => ({ reply, call: visitorCallDto(row, agentName) });
  if (c.state !== "active") throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  // with the realtime engine the words go over the provider connection; the browser forwards transcripts and tool calls instead
  if (c.engine === "realtime") throw new AppError(409, "WRONG_ENGINE", "This call uses the realtime engine");
  const s = (await callSettings(ctx, c.workspace_id)).ai;
  const nowMs = ctx.clock().getTime();
  if (c.answered_at && nowMs - Date.parse(c.answered_at) >= s.max_duration_s * 1000) {
    c = await finishAi(ctx, c, { by: "system", reason: "max_duration" });
    return out({ kind: "max_duration", text: AI_LINES.max_duration, speech: AI_LINES.max_duration, message_id: null, ended: { reason: "max_duration" } }, c);
  }
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw unprocessable("EMPTY_MESSAGE", "Nothing was said");
  if (text.length > MAX_UTTERANCE_CHARS) throw unprocessable("CONTENT_TOO_LONG", `What is said in a call is limited to ${MAX_UTTERANCE_CHARS} characters`);
  const rate = await ctx.ratelimit.check("calls.ai.say", { key: `${c.workspace_id}:${c.contact_id}`, workspaceId: c.workspace_id });
  if (!rate.allowed) throw new RateLimitedError(rate);

  const room = await getVisitorRoom(ctx, session, c.room_id);
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket || ticket.handler?.startsWith("human:") || ticket.status === "waiting_for_human") {
    c = await finishAi(ctx, c, { by: "system", reason: "taken_over", handoff: "taken_over" });
    return out({ kind: "taken_over", text: AI_LINES.taken_over, speech: AI_LINES.taken_over, message_id: null, ended: { reason: "taken_over", handoff_reason: "taken_over" } }, c);
  }

  // what was said is kept as an ordinary visitor message. With "redact personal data" on, emails and numbers are masked before anything is stored or reaches a model
  const redact = (await getSettings(ctx, c.workspace_id)).ai_redact_pii;
  const stored = redact ? redactPii(text) : text;
  const sent = await visitorSend(ctx, session, room.id, { content: stored, client_msg_id: `v-${c.id}-${input.seq}`.slice(0, 64) }, { meta: { call_utterance: true, call_id: c.id, via: input.via ?? "voice" } });
  if (!sent.created) {
    // a retry of an utterance that was already answered: return that answer, do not spend a second turn
    const prior = await ctx.db.get<{ id: string; content_text: string }>("SELECT id, content_text FROM messages WHERE room_id = ? AND seq > ? AND sender_type = 'bot' AND deleted_at IS NULL ORDER BY seq LIMIT 1", room.id, sent.message.seq);
    const t = prior?.content_text ?? "";
    return out({ kind: "answer", text: t, speech: speakable(t), message_id: prior?.id ?? null, ended: null });
  }
  await ctx.db.run("UPDATE calls SET updated_at = ? WHERE id = ? AND state = 'active'", nowIso(ctx), c.id);
  await ctx.ratelimit.renew("ai.concurrency", c.workspace_id, [c.id]);

  const capture: TurnCapture = {};
  const fresh = await getRoomRow(ctx, c.workspace_id, room.id);
  const res = await handleAgentTurn(ctx, fresh, sent.message, { provider: opts.provider, capture });
  const outcome = capture.outcome;
  if (res === "none" || !outcome || outcome === "aborted") {
    c = await finishAi(ctx, c, { by: "system", reason: "taken_over", handoff: "taken_over" });
    return out({ kind: "taken_over", text: AI_LINES.taken_over, speech: AI_LINES.taken_over, message_id: null, ended: { reason: "taken_over", handoff_reason: "taken_over" } }, c);
  }
  if (outcome === "posted") {
    const m = capture.messageId ? await ctx.db.get<{ content_text: string }>("SELECT content_text FROM messages WHERE id = ? AND room_id = ?", capture.messageId, room.id) : undefined;
    const t = m?.content_text ?? "";
    // tag the stored answer with the call so the transcript can be read as a call
    if (capture.messageId) await tagMessage(ctx, room.id, capture.messageId, c.id);
    return out({ kind: capture.decision?.kind ?? "answer", text: t, speech: speakable(t), message_id: capture.messageId ?? null, ended: null });
  }
  if (outcome === "resolved") {
    c = await finishAi(ctx, c, { by: "system", reason: "resolved" });
    return out({ kind: "resolved", text: AI_LINES.resolved, speech: AI_LINES.resolved, message_id: null, ended: { reason: "resolved" } }, c);
  }
  // handoff
  const reason = capture.decision?.handoff?.reason ?? "model_handoff";
  c = await finishAi(ctx, c, { by: "system", reason: "handoff", handoff: reason });
  const humanCall = await offerHumanCall(ctx, session, room.id, c);
  const line = humanCall ? AI_LINES.handoff_call : AI_LINES.handoff;
  return out({ kind: "handoff", text: line, speech: line, message_id: null, ended: { reason: "handoff", handoff_reason: reason, human_call: humanCall } }, c);
}

async function tagMessage(ctx: AppContext, roomId: string, messageId: string, callId: string): Promise<void> {
  const m = await ctx.db.get<{ meta: string }>("SELECT meta FROM messages WHERE id = ? AND room_id = ?", messageId, roomId);
  if (!m) return;
  await ctx.db.run("UPDATE messages SET meta = ? WHERE id = ? AND room_id = ?", JSON.stringify({ ...parseJson<Record<string, unknown>>(m.meta, {}), call_id: callId, via: "voice" }), messageId, roomId);
}

/** After a hand-over, a person may ring the visitor in the same window: leave the usual call request for the team when browser calls are on. */
export async function offerHumanCall(ctx: AppContext, session: SessionRow, roomId: string, c: CallRow): Promise<boolean> {
  const s = await callSettings(ctx, c.workspace_id);
  const kind = c.kind === "ai_video" ? "video" : "voice";
  if (!s.browser.enabled || !s.browser[kind]) return false;
  try {
    await requestCall(ctx, session, roomId, kind);
    return true;
  } catch (e) {
    if (e instanceof AppError) return false;
    throw e;
  }
}

/* ---------- end, hand-over ---------- */

export async function endAiCall(ctx: AppContext, session: SessionRow, callId: string, reason: "completed" | "silence" | "unsupported" | "error" = "completed") {
  const c = await visitorOwnedAiCall(ctx, session, callId);
  if (c.state !== "active") throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  const row = await finishAi(ctx, c, { by: "visitor", reason });
  return { call: visitorCallDto(row, parseJson<{ agent_name?: string }>(row.meta, {}).agent_name ?? "AI assistant") };
}

/** "Talk to a person" during the call: the call ends, the ticket goes through the usual hand-off, and the visitor stays on the line for a person to ring. */
export async function handoffAiCall(ctx: AppContext, session: SessionRow, callId: string) {
  const c = await visitorOwnedAiCall(ctx, session, callId);
  if (c.state !== "active") throw new AppError(409, "CALL_STATE", `The call is ${c.state}`, { state: c.state });
  const row = await finishAi(ctx, c, { by: "visitor", reason: "handoff", handoff: "customer_requested_human" });
  const r = await visitorRequestHuman(ctx, session, c.room_id);
  const humanCall = await offerHumanCall(ctx, session, c.room_id, row);
  return { call: visitorCallDto(row, parseJson<{ agent_name?: string }>(row.meta, {}).agent_name ?? "AI assistant"), ticket: r.ticket, human_call: humanCall, text: humanCall ? AI_LINES.handoff_call : AI_LINES.handoff };
}

/* ---------- time limits (scheduler, every node) ---------- */

/** Ends an AI call that ran past its limit, has been silent too long, or whose visitor has been gone past the grace period. Returns whether it ended one. */
export async function sweepAi(ctx: AppContext, c: CallRow): Promise<boolean> {
  if (c.state !== "active") return false;
  const s = (await callSettings(ctx, c.workspace_id)).ai;
  const now = ctx.clock().getTime();
  let reason: AiEndReason | null = null;
  if (c.answered_at && now - Date.parse(c.answered_at) >= s.max_duration_s * 1000) reason = "max_duration";
  else if ((reason = await sweepRealtime(ctx, c))) {
    /* the kill switch or the day's realtime minutes */
  } else if (now - Date.parse(c.updated_at) >= s.idle_timeout_s * 1000) reason = "idle";
  else {
    const gone = parseJson<{ gone?: Record<string, string> }>(c.meta, {}).gone ?? {};
    const since = Object.values(gone).map((t) => Date.parse(t)).sort((a, b) => a - b)[0];
    if (since !== undefined && now - since >= RECONNECT_GRACE_S * 1000) reason = "disconnected";
  }
  if (!reason) {
    await ctx.ratelimit.renew("ai.concurrency", c.workspace_id, [c.id]);
    return false;
  }
  await finishAi(ctx, c, { by: "system", reason });
  return true;
}

export { callDto };
export type { TicketRow };
