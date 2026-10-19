const STOP = new Set("a an the and or but if then of to in on at for with from by is are was were be been am it this that these those i you we they he she my your our their me us do does did can could would should will just not no yes so as about into than too very please hi hello hey thanks thank".split(" "));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("ing") ? t.slice(0, -3) : t.length > 3 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

export interface KbDoc {
  id: string;
  question: string;
  answer: string;
}
export interface KbHit {
  doc: KbDoc;
  score: number;
  /** share of distinct query terms found in the document */
  coverage: number;
}

/** Okapi BM25 over the (small) per-workspace FAQ list. The question counts double: it is the better signal. */
export function searchKb(query: string, docs: KbDoc[], opts: { k1?: number; b?: number; limit?: number } = {}): KbHit[] {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const tokens = docs.map((d) => [...tokenize(d.question), ...tokenize(d.question), ...tokenize(d.answer)]);
  const avg = tokens.reduce((s, t) => s + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of tokens) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const hits: KbHit[] = docs.map((doc, i) => {
    const tf = new Map<string, number>();
    for (const w of tokens[i]!) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    let matched = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      matched++;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens[i]!.length) / avg)));
    }
    return { doc, score, coverage: matched / q.length };
  });
  return hits.filter((h) => h.score > 0).sort((a, b2) => b2.score - a.score || a.doc.id.localeCompare(b2.doc.id)).slice(0, opts.limit ?? 3);
}
