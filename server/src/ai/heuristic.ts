import type { AiProvider, AiRequest } from "./provider.js";

const has = (text: string, words: string[]) => words.some((w) => new RegExp(`\\b${w}`, "i").test(text));

const SPAM = ["viagra", "casino", "crypto giveaway", "free money", "click here", "you have won", "winner", "lottery", "seo services", "work from home"];
const COMPLAINT = ["terrible", "worst", "angry", "unacceptable", "furious", "disappointed", "ridiculous", "scam", "complain", "awful", "horrible"];
const PURCHASE = ["price", "pricing", "quote", "buy", "purchase", "order", "subscribe", "upgrade", "demo", "plan"];
const SUPPORT = ["help", "issue", "error", "broken", "bug", "not working", "doesn't work", "cannot", "can't", "unable", "failed", "crash"];
const URGENT = ["urgent", "asap", "immediately", "emergency", "right now", "outage", "down", "critical", "production"];
const NEGATIVE = [...COMPLAINT, "bad", "slow", "problem", "frustrated", "annoyed", "hate", "broken"];
const POSITIVE = ["thanks", "thank you", "great", "love", "awesome", "perfect", "happy", "excellent", "appreciate", "amazing"];

function triage(text: string) {
  const links = (text.match(/https?:\/\//g) ?? []).length;
  const spam = has(text, SPAM) || links >= 3;
  const complaint = has(text, COMPLAINT);
  const intent = spam ? "spam" : complaint ? "complaint" : has(text, PURCHASE) ? "purchase" : has(text, SUPPORT) ? "support" : /\?|\b(how|what|when|where|why|can you)\b/i.test(text) ? "question" : "other";
  const neg = NEGATIVE.filter((w) => has(text, [w])).length;
  const pos = POSITIVE.filter((w) => has(text, [w])).length;
  const sentiment = neg > pos ? "negative" : pos > neg ? "positive" : "neutral";
  let urgency = 0.15;
  if (intent === "complaint") urgency = 0.6;
  if (intent === "support") urgency = 0.4;
  if (has(text, URGENT)) urgency = Math.max(urgency, 0.9);
  if (/!{3,}/.test(text) || (text.length > 12 && text === text.toUpperCase() && /[A-Z]{6}/.test(text))) urgency = Math.max(urgency, 0.8);
  if (spam) urgency = 0;
  return { intent, sentiment, urgency };
}

const sentences = (t: string) => t.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);

function suggest(i: Record<string, any>) {
  const name = String(i.contactName || "there").split(" ")[0];
  const agent = String(i.agentName || "");
  const tone = String(i.tone || "friendly");
  const sign = agent ? `\n\n${agent.split(" ")[0]}` : "";
  const t = triage(String(i.lastCustomerMessage || ""));
  const kb = (i.kb as { question: string; answer: string }[] | undefined)?.[0];
  const opener = tone === "professional" ? `Hello ${name},` : tone === "concise" ? `Hi ${name},` : tone === "empathetic" ? `Hi ${name}, I'm really sorry for the trouble.` : `Hi ${name}, thanks so much for reaching out!`;
  const out: string[] = [];
  if (kb) out.push(`${opener} ${kb.answer}${sign}`);
  if (t.intent === "complaint") out.push(`${opener} I understand how frustrating this is. I'm looking into it right now and will update you shortly.${sign}`);
  else if (t.intent === "purchase") out.push(`${opener} Happy to help you with that. Could you tell me a bit more about what you need so I can point you to the right option?${sign}`);
  else if (t.intent === "support") out.push(`${opener} Sorry about the issue. Could you share a few more details (what you were doing and any error you saw) so I can get this fixed?${sign}`);
  else out.push(`${opener} Thanks for your message. Let me check on this and get back to you shortly.${sign}`);
  out.push(`${opener} I'm on it and will follow up as soon as I have an update.${sign}`);
  out.push(`${opener} Could you give me a little more detail so I can help you best?${sign}`);
  return { suggestions: out.slice(0, 3).map((text) => ({ text, tone })) };
}

function summarize(i: Record<string, any>) {
  const lines = (i.lines as { role: string; text: string }[]) ?? [];
  const customer = lines.filter((l) => l.role === "customer");
  const lastRole = lines[lines.length - 1]?.role;
  const name = String(i.contactName || "The customer");
  const first = customer[0] ? sentences(customer[0].text)[0] ?? "" : "";
  const latest = customer.length ? sentences(customer[customer.length - 1]!.text)[0] ?? "" : "";
  const questions = customer.flatMap((l) => sentences(l.text).filter((s) => s.includes("?"))).slice(-3);
  const facts = customer.slice(0, 3).map((l) => sentences(l.text)[0]).filter((s): s is string => !!s);
  return {
    summary: `${name} wrote ${customer.length} message${customer.length === 1 ? "" : "s"} in a thread of ${lines.length}. They started with: "${first}". Latest: "${latest}".`.slice(0, 600),
    key_facts: facts,
    open_questions: lastRole === "customer" ? questions : [],
    next_action: lastRole === "customer" ? "Reply to the customer" : lines.length ? "Wait for the customer's response" : "Start the conversation",
  };
}

const TYPOS: [RegExp, string][] = [[/\bteh\b/gi, "the"], [/\brecieve\b/gi, "receive"], [/\bdefinately\b/gi, "definitely"], [/\bthier\b/gi, "their"], [/\bwont\b/gi, "won't"], [/\bdont\b/gi, "don't"], [/\bcant\b/gi, "can't"], [/\bim\b/gi, "I'm"], [/\bu\b/gi, "you"], [/\bpls\b/gi, "please"], [/\bthx\b/gi, "thanks"]];

function fixGrammar(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  for (const [re, rep] of TYPOS) t = t.replace(re, rep);
  t = t.replace(/\bi\b/g, "I").replace(/\s+([,.!?])/g, "$1").replace(/([,.!?])(?=[A-Za-z])/g, "$1 ");
  t = sentences(t).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
  return /[.!?]$/.test(t) || !t ? t : t + ".";
}

function rephrase(i: Record<string, any>) {
  const mode = String(i.mode || "improve");
  const base = fixGrammar(String(i.text || ""));
  let text = base;
  if (mode === "shorten") {
    text = base.replace(/\b(just|really|very|basically|actually|kind of|sort of)\s+/gi, "").replace(/\bI wanted to let you know that\s*/gi, "").replace(/\bplease note that\s*/gi, "");
    const s = sentences(text);
    if (s.length > 2) text = s.slice(0, 2).join(" ");
  } else if (mode === "professional") text = base.replace(/can't/g, "cannot").replace(/won't/g, "will not").replace(/don't/g, "do not").replace(/!+/g, ".");
  else if (mode === "friendly") text = /!|😊/.test(base) ? base : `${base.replace(/\.$/, "")}! Happy to help.`;
  else if (mode === "empathetic") text = `I understand how frustrating this must be. ${base}`;
  return { text };
}

function autorespond(i: Record<string, any>) {
  const kb = (i.kb as { question: string; answer: string; score: number; coverage: number }[]) ?? [];
  const best = kb[0];
  if (!best || best.coverage < 0.5) return { answer: "", confidence: 0.1, handoff: true, reason: "no matching knowledge" };
  return { answer: best.answer, confidence: Math.min(0.95, 0.55 + best.coverage * 0.4), handoff: false };
}

/** Deterministic, offline stand-in so every AI feature works without a key (and in tests). Rule-based, not a language model. */
export class HeuristicProvider implements AiProvider {
  readonly name = "heuristic";
  async complete(req: AiRequest): Promise<string> {
    const i = req.input;
    switch (req.task) {
      case "triage": return JSON.stringify(triage(String(i.text ?? "")));
      case "suggest_replies": return JSON.stringify(suggest(i));
      case "summarize": return JSON.stringify(summarize(i));
      case "rephrase": return JSON.stringify(rephrase(i));
      case "autorespond": return JSON.stringify(autorespond(i));
    }
  }
}
