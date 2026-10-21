import { triage } from "../ai/heuristic.js";
import { tokenize } from "../ai/retrieval.js";
import { asksForHuman } from "./humanRequest.js";

export interface DepartmentChoice {
  id: string;
  name: string;
  description: string;
}

export interface Classification {
  intent: "question" | "complaint" | "purchase" | "support" | "spam" | "other";
  sentiment: "positive" | "neutral" | "negative";
  urgency: number;
  wantsHuman: boolean;
  /** the department the text points at, and how sure we are (0..1); `second` is the runner-up when there is one */
  department: { id: string | null; confidence: number; second: { id: string; confidence: number } | null };
}

// words that point at a kind of department, matched against the department's NAME so any workspace's naming works
const HINTS: { words: RegExp; dept: RegExp }[] = [
  { words: /\b(invoices?|billing|bill|payments?|paid|charged?|charges|refunds?|subscriptions?|card|receipts?|vat|tax)\b/i, dept: /(bill|invoice|payment|financ|account)/i },
  { words: /\b(price|prices|pricing|quote|demo|buy|purchase|plans?|upgrade|trial|enterprise|discount|sales)\b/i, dept: /(sale|pricing|commercial|growth)/i },
  { words: /\b(error|bug|crash(es)?|broken|not working|doesn't work|api|install\w*|log ?in|sign ?in|integration|outage|down|slow|technical)\b/i, dept: /(tech|support|engineer|\bit\b|help|developer)/i },
];

/**
 * What can be said about a visitor's message without a model: intent, sentiment, urgency, whether they ask for a person, and which department it
 * points at (by words the department's name and description share with the message, plus a few well-known hints). Cheap and deterministic: it runs
 * before any model call and is the whole classifier of the offline rules agent.
 */
export function classifyText(text: string, departments: DepartmentChoice[]): Classification {
  const t = triage(text);
  const words = new Set(tokenize(text));
  const scored = departments
    .map((d) => {
      const own = new Set([...tokenize(d.name), ...tokenize(d.description)]);
      let overlap = 0;
      for (const w of own) if (words.has(w)) overlap++;
      const hint = HINTS.some((h) => h.words.test(text) && h.dept.test(d.name)) ? 0.6 : 0;
      return { id: d.id, confidence: Math.min(1, Math.min(overlap, 3) / 3 * 0.5 + hint) };
    })
    .filter((s) => s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  const top = scored[0];
  const second = scored[1];
  return {
    intent: t.intent as Classification["intent"],
    sentiment: t.sentiment as Classification["sentiment"],
    urgency: t.urgency,
    wantsHuman: asksForHuman(text),
    department: { id: top?.id ?? null, confidence: top?.confidence ?? 0, second: second ? { id: second.id, confidence: second.confidence } : null },
  };
}

/**
 * The visitor says it worked ("thanks, that solved it"). Only whole short messages that are nothing but thanks or a plain statement that the problem
 * is gone count, so "ok but it still fails" or a long message containing "thanks" is not a goodbye.
 */
const CONFIRM: RegExp[] = [
  /^\W*(ok(ay)?|perfect|great|awesome|thanks?|thank you|thx|cheers|got it)(\W+(thanks?|thank you|so much|a lot|very much|that'?s (great|perfect|all|helpful)))*\W*$/i,
  /\b(that (solved|fixed|worked|helped|answers?)( it| my (problem|question|issue))?|it (works|worked) now|problem (is )?(solved|fixed)|all (sorted|good|set)|that'?s (all|everything) i needed)\b/i,
  /^\W*(gracias|muchas gracias|perfecto|listo|genial|merci|parfait|danke|dankesch[oö]n|perfekt|ありがとう|ありがとうございます|助かりました|解決しました)\W*$/i,
];
export function isConfirmation(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 90 && !t.includes("?") && CONFIRM.some((re) => re.test(t));
}
