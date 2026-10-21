import { tokenize } from "../ai/retrieval.js";

/**
 * Text checks the agent runs on what a visitor writes and on what the model answers. They are deliberately plain and deterministic: the model is
 * also told to treat visitor text as data, but an instruction-looking message never has to reach it for the agent to behave.
 */

const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|polic(?:y|ies))\b/i,
  /\b(reveal|show|print|repeat|display|tell me|leak)\b[^.\n]{0,30}\b(system|hidden|initial|original|developer)\b[^.\n]{0,15}\b(prompt|message|instructions?|rules?)\b/i,
  /\b(system|developer) prompt\b/i,
  /\b(jailbreak|jailbroken|dan mode|developer mode|do anything now)\b/i,
  /\byou are (now )?(dan|an? (unrestricted|unfiltered|uncensored)\b)/i,
  /\bact as (if you (are|were)|an? (unrestricted|unfiltered|different))\b/i,
  /<\/?\s*(conversation|knowledge|draft|visitor_details|departments|system|assistant|instructions?)\s*>/i,
  /(^|\n)\s*(system|assistant)\s*:/i,
  /\[\s*(system|assistant|inst)\s*\]/i,
  // the same request in the other widget languages
  /\b(ignora|ignorar|olvida)\b[^.\n]{0,40}\b(instrucciones|reglas)\b/i,
  /\b(ignore|ignorez|oublie)\b[^.\n]{0,40}\b(instructions|consignes|règles)\b/i,
  /\b(ignoriere?|vergiss)\b[^.\n]{0,40}\b(anweisungen|regeln|instruktionen)\b/i,
  /(以前|これまで|上記)の(指示|命令|ルール)を(無視|忘れ)/,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

/** Things a first-line AI assistant must never say, whatever the model produced (the Funnels banned-claims guard, adapted to support). */
const BANNED: { id: string; re: RegExp }[] = [
  { id: "guarantee", re: /\b(guarantee[sd]?|guaranteed|100\s?% (safe|secure|accurate|reliable|uptime)|risk[- ]free|no risk)\b/i },
  { id: "promise", re: /\b(i|we) (promise|swear|assure you)\b|\bwill definitely\b|\bwithout (a )?doubt\b/i },
  { id: "legal", re: /\b(legal(ly)? (advice|binding|obligat\w+)|you (should|can) sue|lawsuit|liable|liability)\b/i },
  { id: "medical", re: /\b(diagnos(e|is)|prescri(be|ption)|medical advice|dosage)\b/i },
  { id: "secrets", re: /\b(send|give|tell|share|enter)\b[^.\n]{0,20}\b(your )?(password|card number|cvv|cvc|pin code|ssn|social security)\b/i },
  { id: "identity", re: /\bi am (a )?(human|real person|not an? (ai|bot|robot))\b/i },
];

export function bannedClaims(text: string): string[] {
  return BANNED.filter((b) => b.re.test(text)).map((b) => b.id);
}

const URL_RE = /https?:\/\/[^\s<>)"']+/gi;

/** Remove every link that does not come from the knowledge base: the agent never invents addresses. */
export function stripUnsourcedLinks(text: string, allowed: readonly string[]): string {
  const ok = new Set(allowed.map((u) => u.replace(/[.,;:!?]+$/, "")));
  return text.replace(URL_RE, (u) => (ok.has(u.replace(/[.,;:!?]+$/, "")) ? u : "")).replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** Share of distinct words two messages have in common (0..1): how alike a visitor's rephrasing is. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both);
}

/**
 * The customer keeps asking the same thing: counts the messages at the end of `customerTexts` (oldest first) that each resemble the one before.
 * Two of them in a row (three alike messages) means the answers are not landing.
 */
export function rephraseStreak(customerTexts: string[], threshold = 0.5): number {
  let streak = 0;
  for (let i = customerTexts.length - 1; i > 0; i--) {
    if (similarity(customerTexts[i]!, customerTexts[i - 1]!) >= threshold) streak++;
    else break;
  }
  return streak;
}
