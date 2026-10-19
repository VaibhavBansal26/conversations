import type { SearchHit, SearchItem } from "../protocol";

/** Lower-case and strip accents so "cafe" finds "café". */
export const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const CHUNK = 400;

/**
 * Substring search over a (possibly very large) cached thread. Works in chunks and asks `cancelled()` between them so a newer
 * keystroke can abandon an outdated search. Newest hits first.
 */
export function searchItems(items: SearchItem[], query: string, limit: number, cancelled: () => boolean = () => false): SearchHit[] {
  const q = fold(query.trim());
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (let i = items.length - 1; i >= 0 && hits.length < limit; i -= CHUNK) {
    if (cancelled()) throw new Error("cancelled");
    for (let j = i; j > i - CHUNK && j >= 0 && hits.length < limit; j--) {
      const it = items[j]!;
      const hay = fold(it.text);
      const at = hay.indexOf(q);
      if (at < 0) continue;
      const start = Math.max(0, at - 40);
      const end = Math.min(it.text.length, at + q.length + 80);
      const snippet = (start > 0 ? "…" : "") + it.text.slice(start, end) + (end < it.text.length ? "…" : "");
      const shift = (start > 0 ? 1 : 0) - start;
      const ranges: [number, number][] = [];
      for (let p = hay.indexOf(q, start); p >= 0 && p < end; p = hay.indexOf(q, p + q.length)) ranges.push([p + shift, Math.min(p + q.length, end) + shift]);
      hits.push({ id: it.id, sender: it.sender, at: it.at, snippet, ranges });
    }
  }
  return hits;
}
