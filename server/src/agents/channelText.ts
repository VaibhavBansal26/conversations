/**
 * Text rules of AI replies by SMS and email (docs/AI-AGENTS.md "AI agents on SMS and email"): what counts as an automatic message the AI must never
 * answer, how quoted history is removed from an email before the AI reads it, how a reply is turned into plain text with numbered options, and how
 * long an SMS may be. Pure functions, tested on their own (tests/ai-channels.test.ts).
 */

/** Why an inbound email is automatic (out-of-office, bounce, mailing list, no-reply sender, another bot), or null for a person's email. */
export function autoEmailReason(headers: Record<string, string>, from: string, subject: string | undefined): string | null {
  const h = (k: string) => (headers[k.toLowerCase()] ?? "").trim().toLowerCase();
  const as = h("auto-submitted");
  if (as && as !== "no") return "auto_submitted";
  if (h("x-autoreply") || h("x-autorespond") || h("x-autoresponder")) return "auto_reply_header";
  if (/^(auto_reply|auto-reply|bulk|junk|list)$/.test(h("precedence"))) return `precedence_${h("precedence").replace(/[^a-z]/g, "_")}`;
  if (h("list-id") || h("list-unsubscribe") || h("list-post")) return "mailing_list";
  if (/\b(oof|autoreply|all)\b/.test(h("x-auto-response-suppress")) && h("x-ms-exchange-generated-message-source")) return "exchange_generated";
  if (h("x-conversations-bot") || h("x-ai-agent")) return "other_bot";
  if (h("return-path") === "<>") return "bounce";
  if (/^(mailer-daemon|postmaster|bounce[s]?|no-?reply|do-?not-?reply|donotreply|notifications?|automated)([+.-][^@]*)?@/i.test(from)) return "no_reply_sender";
  const s = (subject ?? "").trim().toLowerCase();
  if (/^(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|auto:|abwesenheitsnotiz|réponse automatique|respuesta automática|undeliverable|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice)/.test(s)) return "auto_subject";
  if (h("content-type").includes("multipart/report")) return "delivery_report";
  return null;
}

/** Why an inbound SMS looks automatic (a short code, an automated notice), or null. */
export function autoSmsReason(from: string, body: string): string | null {
  const digits = from.replace(/\D/g, "");
  if (!from.startsWith("+") || digits.length <= 6) return "short_code";
  const b = body.toLowerCase();
  if (/\b(this is an automated|auto[- ]?reply|automatic reply|do not reply|don't reply to this|no-?reply|msg&data rates|reply stop to|txt stop)\b/.test(b)) return "automated_text";
  return null;
}

/** An email reply without the quoted history, the forwarded headers and the signature: what the customer actually wrote this time. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const t = l.trim();
    if (/^-- ?$/.test(l)) break; // signature delimiter
    if (/^>/.test(t)) break;
    if (/^-{2,}\s*(original message|forwarded message|ursprüngliche nachricht|message d'origine|mensaje original)\s*-{2,}$/i.test(t)) break;
    if (/^(on|am|le|el) .{4,200}(wrote|schrieb|a écrit|escribió):?$/i.test(t)) break;
    if (/^(am|le|el) .{2,120} (schrieb|a écrit|escribió) .{0,160}:$/i.test(t)) break;
    // "On Mon, 3 Jun 2026 at 10:00, Ann <ann@x>" + next line "wrote:" (some clients break the line)
    if (/^(on|am|le|el) .{4,200}$/i.test(t) && /^(wrote|schrieb|a écrit|escribió):?$/i.test((lines[i + 1] ?? "").trim())) break;
    if (/^from: .+/i.test(t) && /^(sent|date|to|subject): /i.test((lines[i + 1] ?? "").trim())) break;
    if (/^sent from my (iphone|ipad|android|mobile|phone|samsung)/i.test(t)) break;
    out.push(l);
  }
  return out.join("\n").trim() || text.trim();
}

/** Markdown and HTML habits of a model, turned into plain text. Links are kept as "text: address". */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*+]\s+/gm, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** GSM 03.38 basic and extension characters: anything else makes the whole SMS UCS-2 (70 characters a segment). */
const GSM = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà");
const GSM_EXT = new Set("^{}\\[~]|€");
export function smsSegments(text: string): { encoding: "gsm7" | "ucs2"; units: number; segments: number } {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM.has(ch)) units += 1;
    else if (GSM_EXT.has(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    const n = [...text].reduce((s, c) => s + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return { encoding: "ucs2", units: n, segments: n <= 70 ? 1 : Math.ceil(n / 67) };
  }
  return { encoding: "gsm7", units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
}

/** Shorten `body` so that prefix + body + suffix fits in `max` segments, cutting at a sentence or word and adding an ellipsis. */
export function fitSms(prefix: string, body: string, suffix: string, max: number): string {
  const whole = `${prefix}${body}${suffix}`;
  if (smsSegments(whole).segments <= max) return whole;
  let cut = body;
  while (cut.length > 0 && smsSegments(`${prefix}${cut}…${suffix}`).segments > max) {
    const s = cut.slice(0, -1);
    const at = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "));
    const sp = s.lastIndexOf(" ");
    cut = at > s.length * 0.6 ? s.slice(0, at + 1) : sp > 0 ? s.slice(0, sp) : s;
  }
  return `${prefix}${cut.trimEnd()}…${suffix}`;
}

export interface ChannelOption {
  id: string;
  label: string;
}
/** "Reply 1 for Yes, thanks, 2 for Not quite or 3 for Talk to a person." */
export function optionsLine(options: ChannelOption[]): string {
  const parts = options.map((o, i) => `${i + 1} for ${o.label}`);
  return parts.length > 1 ? `Reply ${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}.` : parts.length ? `Reply ${parts[0]}.` : "";
}
/** The option a reply such as "2", "2.", " 2 " picks, or null. */
export function pickOption(reply: string, options: ChannelOption[]): ChannelOption | null {
  const m = /^\s*(\d{1,2})\s*[.)!]?\s*$/.exec(reply);
  if (!m) return null;
  return options[Number(m[1]) - 1] ?? null;
}

/** Does the customer ask for a person in one word (the reply the disclosure tells them to send)? */
export const asksForHuman = (reply: string): boolean => /^\s*(human|agent|person|representative|operator|humano|persona|mensch|humain|personne)\s*[.!]?\s*$/i.test(reply);
