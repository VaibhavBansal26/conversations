import type { EmailParts } from "../protocol";

const ATTRIBUTION = /^(on .{10,200} wrote:|le .{10,200} a écrit\s?:|am .{10,200} schrieb .{0,80}:|-{2,}\s*original message\s*-{2,}|from:\s.+\ssent:\s.+)$/i;

/**
 * Split an email body into what the sender wrote and the quoted history/signature beneath it, so long threads render short and the
 * rest sits behind a "show quoted text" toggle. Conservative: when unsure everything stays in `main`.
 */
export function splitQuoted(text: string): EmailParts {
  const lines = text.split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    const next = lines[i + 1]?.trim() ?? "";
    if (ATTRIBUTION.test(l) || (/^on .{10,200}$/i.test(l) && /wrote:$/i.test(next)) || l === "-- " || l === "--") {
      cut = i;
      break;
    }
    if (l.startsWith(">")) {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return { main: text, quoted: "" };
  const main = lines.slice(0, cut).join("\n").trimEnd();
  if (!main.trim()) return { main: text, quoted: "" }; // a pure forward/quote: show it all
  return { main, quoted: lines.slice(cut).join("\n").trim() };
}
