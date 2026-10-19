import { z } from "zod";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { unprocessable } from "../errors.js";
import { parseJson } from "../util/json.js";
import { textToHtml } from "../util/html.js";
import { getContact } from "../services/contacts.js";
import { emitMessage, insertMessage, emitInserted, type MessageRow } from "../services/messageStore.js";
import { getRoomRow, getVisibleRoom, type RoomRow } from "../services/roomStore.js";
import { publishRoomUpdated } from "../services/rooms.js";
import { getSettings } from "../services/workspaces.js";
import { AiOutputError, AiUnavailableError, type AiRequest } from "./provider.js";
import { searchKb, type KbDoc, type KbHit } from "./retrieval.js";
import { buildTranscript, parseModelJson, redactPii, SAFETY_RULES, unsupportedCommitment, untrusted, type TranscriptLine } from "./text.js";

const TOKEN_BUDGET = 3000;

export const SuggestSchema = z.object({ suggestions: z.array(z.object({ text: z.string().min(1).max(2000), tone: z.string().optional() })).min(1) });
export const SummarySchema = z.object({
  summary: z.string().min(1).max(1500),
  key_facts: z.array(z.string().max(300)).max(10).default([]),
  open_questions: z.array(z.string().max(300)).max(10).default([]),
  next_action: z.string().max(300).default(""),
});
export const TriageSchema = z.object({
  intent: z.enum(["question", "complaint", "purchase", "support", "spam", "other"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  urgency: z.number().min(0).max(1),
});
export const RephraseSchema = z.object({ text: z.string().min(1).max(20000) });
export const AutoRespondSchema = z.object({
  answer: z.string().max(2000).default(""),
  confidence: z.number().min(0).max(1),
  handoff: z.boolean().default(false),
  reason: z.string().max(200).optional(),
});

export type RephraseMode = "improve" | "fix_grammar" | "shorten" | "friendly" | "professional" | "empathetic";

/** Run a task. Any provider problem becomes AiUnavailableError so callers can degrade; output is validated with zod. */
async function run<T>(ctx: AppContext, req: AiRequest, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await ctx.ai.complete(req);
  } catch (e) {
    ctx.log.warn("ai provider failed", { task: req.task, provider: ctx.ai.name, error: e instanceof Error ? e.message : String(e) });
    throw new AiUnavailableError();
  }
  try {
    return parseModelJson(raw ?? "", schema);
  } catch (e) {
    ctx.log.warn("ai output rejected", { task: req.task, provider: ctx.ai.name });
    throw e instanceof AiOutputError ? e : new AiUnavailableError();
  }
}

async function loadLines(ctx: AppContext, roomId: string, opts: { notes: boolean }): Promise<TranscriptLine[]> {
  const rows = await ctx.db.all<MessageRow>(
    `SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND kind != 'system' ${opts.notes ? "" : "AND kind != 'note'"} ORDER BY seq`,
    roomId,
  );
  return rows.map((m) => ({
    role: m.kind === "note" ? "note" : m.sender_type === "contact" ? "customer" : m.sender_type === "bot" ? "bot" : "agent",
    text: m.content_text || (m.attachments !== "[]" ? "[attachment]" : ""),
  }));
}

const kbDocs = async (ctx: AppContext, ws: string): Promise<KbDoc[]> => ctx.db.all<KbDoc>("SELECT id, question, answer FROM kb_entries WHERE workspace_id = ?", ws);

async function groundingText(ctx: AppContext, ws: string, roomId: string, kb: KbHit[]): Promise<string> {
  const agentTexts = (
    await ctx.db.all<{ content_text: string }>(
      "SELECT content_text FROM messages WHERE room_id = ? AND sender_type = 'agent' AND kind != 'note' AND deleted_at IS NULL",
      roomId,
    )
  ).map((r) => r.content_text);
  return [...kb.map((k) => `${k.doc.question} ${k.doc.answer}`), ...agentTexts].join("\n");
}

const lastCustomerText = (lines: TranscriptLine[]) => [...lines].reverse().find((l) => l.role === "customer")?.text ?? "";

export async function suggestReplies(ctx: AppContext, actor: Actor, roomId: string) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const s = await getSettings(ctx, actor.workspaceId);
  const contact = await getContact(ctx, actor.workspaceId, room.contact_id);
  const lines = await loadLines(ctx, roomId, { notes: false });
  const last = lastCustomerText(lines);
  const kbHits = searchKb(last, await kbDocs(ctx, actor.workspaceId), { limit: 3 }).filter((h) => h.coverage >= 0.4);
  const t = buildTranscript(lines, TOKEN_BUDGET, { redact: s.ai_redact_pii });
  const mask = (v: string) => (s.ai_redact_pii ? redactPii(v) : v);
  const knowledge = kbHits.map((k) => `Q: ${mask(k.doc.question)}\nA: ${mask(k.doc.answer)}`).join("\n---\n") || "(none)";
  const req: AiRequest = {
    task: "suggest_replies",
    maxTokens: 700,
    system: `You draft replies for a customer-support agent. Tone: ${s.ai_tone}.\n${SAFETY_RULES}\nReturn {"suggestions":[{"text":"...","tone":"..."}]} with exactly 3 distinct, ready-to-send replies written as the agent.`,
    prompt: `${untrusted("conversation", t.text)}\n\n${untrusted("knowledge", knowledge)}\n\nAgent name: ${actor.name}\nCustomer first name: ${(contact.name || "").split(" ")[0] || "unknown"}\nWrite the 3 replies now.`,
    input: {
      contactName: contact.name,
      agentName: actor.name,
      tone: s.ai_tone,
      lastCustomerMessage: last,
      kb: kbHits.map((k) => ({ question: k.doc.question, answer: k.doc.answer })),
    },
  };
  const out = await run(ctx, req, SuggestSchema);
  const trusted = await groundingText(ctx, actor.workspaceId, roomId, kbHits);
  const safe = out.suggestions.filter((x) => !unsupportedCommitment(x.text, trusted)).slice(0, 3);
  const fallback = {
    text: `Hi${contact.name ? " " + contact.name.split(" ")[0] : ""}, thanks for your message. Let me look into this and get back to you shortly.`,
    tone: s.ai_tone,
  };
  return { suggestions: safe.length ? safe : [fallback], filtered: out.suggestions.length - safe.length, truncated: t.omitted > 0 };
}

export async function summarizeThread(ctx: AppContext, actor: Actor, roomId: string) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const s = await getSettings(ctx, actor.workspaceId);
  const contact = await getContact(ctx, actor.workspaceId, room.contact_id);
  const lines = await loadLines(ctx, roomId, { notes: true });
  if (!lines.length) throw unprocessable("NOTHING_TO_SUMMARIZE", "This conversation has no messages yet");
  const t = buildTranscript(lines, TOKEN_BUDGET, { redact: s.ai_redact_pii });
  const req: AiRequest = {
    task: "summarize",
    maxTokens: 600,
    system: `You summarise support conversations for the agent.\n${SAFETY_RULES}\nReturn {"summary": one paragraph, "key_facts": string[], "open_questions": string[], "next_action": string}.`,
    prompt: `${untrusted("conversation", t.text)}\n\nSummarise.`,
    input: { contactName: contact.name, lines: lines.slice(-60) },
  };
  return { ...(await run(ctx, req, SummarySchema)), truncated: t.omitted > 0 };
}

export async function rephraseDraft(ctx: AppContext, actor: Actor, input: { text: string; mode: RephraseMode; room_id?: string }) {
  const s = await getSettings(ctx, actor.workspaceId);
  let context = "";
  if (input.room_id) {
    await getVisibleRoom(ctx, actor, input.room_id);
    context = buildTranscript((await loadLines(ctx, input.room_id, { notes: false })).slice(-8), 800, { redact: s.ai_redact_pii }).text;
  }
  const draft = s.ai_redact_pii ? redactPii(input.text) : input.text;
  const req: AiRequest = {
    task: "rephrase",
    maxTokens: 800,
    system: `You rewrite an agent's draft reply. Mode: ${input.mode}. Keep the meaning, do not add facts, promises or prices that are not in the draft.\n${SAFETY_RULES}\nReturn {"text": "..."}.`,
    prompt: `${context ? untrusted("conversation", context) + "\n\n" : ""}${untrusted("draft", draft)}\n\nRewrite the draft.`,
    input: { mode: input.mode, text: input.text },
  };
  const out = await run(ctx, req, RephraseSchema);
  // a rewrite must not invent money commitments the draft did not contain
  if (unsupportedCommitment(out.text, input.text)) throw new AiOutputError("The rewrite introduced a commitment that was not in your draft");
  return out;
}

/** Background triage of an inbound message. Off unless the workspace enables it; always overridable by agents. */
export async function triageMessage(ctx: AppContext, room: RoomRow, message: MessageRow): Promise<void> {
  const s = await getSettings(ctx, room.workspace_id);
  if (!s.ai_triage_enabled || message.sender_type !== "contact" || !message.content_text.trim()) return;
  const text = (s.ai_redact_pii ? redactPii(message.content_text) : message.content_text).slice(0, 3000);
  let result: z.infer<typeof TriageSchema>;
  try {
    result = await run(
      ctx,
      {
        task: "triage",
        maxTokens: 150,
        system: `You classify one inbound customer message.\n${SAFETY_RULES}\nReturn {"intent":"question|complaint|purchase|support|spam|other","sentiment":"positive|neutral|negative","urgency":0..1}.`,
        prompt: `${untrusted("conversation", text)}\n\nClassify the message.`,
        input: { text: message.content_text },
      },
      TriageSchema,
    );
  } catch {
    return; // triage is best-effort: the message is already delivered and notified
  }
  const triage = { ...result, at: nowIso(ctx), provider: ctx.ai.name };
  const meta = parseJson<Record<string, unknown>>(message.meta, {});
  await ctx.db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, triage }), message.id);
  const fresh = await getRoomRow(ctx, room.workspace_id, room.id);
  const roomMeta: Record<string, unknown> = { ...parseJson<Record<string, unknown>>(fresh.meta, {}), triage, spam: result.intent === "spam" };
  const raise = result.urgency >= 0.8 && fresh.priority === 0;
  if (raise) roomMeta.priority_set_by_ai = true;
  await ctx.db.run(
    "UPDATE rooms SET meta = ?, priority = CASE WHEN ? = 1 THEN 1 ELSE priority END, updated_at = ? WHERE id = ?",
    JSON.stringify(roomMeta),
    raise,
    nowIso(ctx),
    room.id,
  );
  await publishRoomUpdated(ctx, fresh);
  const m2 = (await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", message.id))!;
  await emitMessage(ctx, await getRoomRow(ctx, room.workspace_id, room.id), m2, "message:updated");
}

const HUMAN =
  /\b(human|real person|live agent|agent|representative|operator|someone|person|manager|supervisor)\b.*\b(talk|speak|chat|connect|transfer|please|want|need|get)\b|\b(talk|speak|chat|connect|transfer|get|need|want)\b.*\b(human|real person|live agent|agent|representative|operator|manager|supervisor)\b/i;
const SENSITIVE =
  /\b(refund|chargeback|charge ?back|lawsuit|sue|legal|attorney|lawyer|fraud|stolen|harass|abuse|medical|suicide|self[- ]harm|gdpr|delete my (data|account)|password|credit card|ssn|social security|cancel my (account|subscription)|dispute)\b/i;
const HANDOFF_TEXT = "I'm connecting you with a teammate who will reply here as soon as possible.";

export const asksForHuman = (t: string): boolean => HUMAN.test(t);
export const isSensitive = (t: string): boolean => SENSITIVE.test(t);

async function postBot(ctx: AppContext, room: RoomRow, text: string, meta: Record<string, unknown>) {
  const r = await insertMessage(ctx, {
    workspaceId: room.workspace_id,
    roomId: room.id,
    senderType: "bot",
    senderId: "ai",
    senderName: "AI Assistant",
    kind: "text",
    source: "dm",
    content: textToHtml(text),
    contentText: text,
    meta: { ai: true, ...meta },
    clientMsgId: null,
  });
  await emitInserted(ctx, r);
  return r.message;
}

/**
 * Widget auto-responder (workspace opt-in). Answers only from the FAQ knowledge base and hands the conversation to a human when
 * confidence is low, the customer asks for a person, the topic is sensitive, the output fails validation/guards, or the provider is down.
 * Bot messages are marked meta.ai=true and sent as "AI Assistant". After a handoff the bot stays quiet (rooms.bot_paused).
 */
export async function maybeAutoRespond(ctx: AppContext, room: RoomRow, message: MessageRow): Promise<"answered" | "handoff" | "skipped"> {
  const s = await getSettings(ctx, room.workspace_id);
  if (!s.ai_autoresponder_enabled || message.source !== "dm" || message.sender_type !== "contact") return "skipped";
  const fresh = await getRoomRow(ctx, room.workspace_id, room.id);
  if (fresh.bot_paused) return "skipped";
  if (await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND sender_type = 'agent' AND kind != 'note' AND deleted_at IS NULL LIMIT 1", room.id)) return "skipped";

  const handoff = async (reason: string) => {
    await postBot(ctx, fresh, HANDOFF_TEXT, { handoff: true, reason });
    await ctx.db.run("UPDATE rooms SET bot_paused = 1, updated_at = ? WHERE id = ?", nowIso(ctx), room.id);
    await publishRoomUpdated(ctx, await getRoomRow(ctx, room.workspace_id, room.id));
    return "handoff" as const;
  };

  const text = message.content_text;
  if (asksForHuman(text)) return await handoff("customer_requested_human");
  if (isSensitive(text)) return await handoff("sensitive_topic");
  const hits = searchKb(text, await kbDocs(ctx, room.workspace_id), { limit: 3 });
  if (!hits.length || hits[0]!.coverage < 0.5) return await handoff("low_confidence");

  const mask = (v: string) => (s.ai_redact_pii ? redactPii(v) : v);
  const t = buildTranscript(await loadLines(ctx, room.id, { notes: false }), 1500, { redact: s.ai_redact_pii });
  let out: z.infer<typeof AutoRespondSchema>;
  try {
    out = await run(
      ctx,
      {
        task: "autorespond",
        maxTokens: 500,
        system: `You are the first-line AI assistant of a company's website chat. Answer ONLY from <knowledge>. If it does not contain the answer, set handoff=true.\n${SAFETY_RULES}\nReturn {"answer": string, "confidence": 0..1, "handoff": boolean, "reason": string}.`,
        prompt: `${untrusted("conversation", t.text)}\n\n${untrusted("knowledge", hits.map((h) => `Q: ${mask(h.doc.question)}\nA: ${mask(h.doc.answer)}`).join("\n---\n"))}\n\nAnswer the customer's latest message.`,
        input: { question: text, kb: hits.map((h) => ({ question: h.doc.question, answer: h.doc.answer, score: h.score, coverage: h.coverage })) },
      },
      AutoRespondSchema,
    );
  } catch {
    return await handoff("ai_unavailable");
  }
  const kbText = hits.map((h) => `${h.doc.question} ${h.doc.answer}`).join("\n");
  if (out.handoff || out.confidence < 0.6 || !out.answer.trim() || unsupportedCommitment(out.answer, kbText))
    return await handoff(out.handoff ? "model_handoff" : "low_confidence");
  await postBot(ctx, fresh, out.answer.trim(), { confidence: out.confidence, kb_ids: hits.map((h) => h.doc.id) });
  return "answered";
}
