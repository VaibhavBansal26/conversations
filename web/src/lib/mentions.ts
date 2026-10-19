export interface MentionTarget {
  id: string;
  name: string;
}

export type MentionSegment = { type: "text"; text: string } | { type: "mention"; id: string; name: string };

const TOKEN = /@\[([^\]]+)\]\(([^)]+)\)/g;

export const mentionToken = (m: MentionTarget): string => `@[${m.name}](${m.id})`;

export function splitMentions(text: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "mention", name: m[1] ?? "", id: m[2] ?? "" });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** The "@que" fragment being typed right before the caret, or null when the caret is not inside one. */
export function activeMention(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@[\]()]*)$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? "";
  return { query, start: caret - query.length - 1 };
}

export function insertMention(text: string, caret: number, target: MentionTarget): { text: string; caret: number } {
  const active = activeMention(text, caret);
  const start = active ? active.start : caret;
  const token = `${mentionToken(target)} `;
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}

/** Plain-text rendering for previews and SMS/email bodies. */
export const mentionsToPlain = (text: string): string => text.replace(TOKEN, "@$1");

export const mentionedIds = (text: string): string[] => [...text.matchAll(TOKEN)].map((m) => m[2] ?? "");
