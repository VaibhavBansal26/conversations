const STOP = new Set(
  "a an the and or but if then of to in on at for with from by is are was were be been am it this that these those i you we they he she my your our their me us do does did can could would should will just not no yes so as about into than too very please hi hello hey thanks thank".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) =>
      t.length > 4 && t.endsWith("ing") ? t.slice(0, -3) : t.length > 3 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t,
    );
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

/**
 * Okapi BM25 over a FAQ list. The question counts double: it is the better signal. Building the index (tokenising every entry,
 * document frequencies) is the expensive part, so it is built once and reused for many queries (see `kbIndex` in ai/service.ts).
 */
export class Bm25Index {
  private readonly tokens: string[][];
  private readonly tf: Map<string, number>[];
  private readonly df = new Map<string, number>();
  private readonly avg: number;

  constructor(
    private readonly docs: KbDoc[],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    this.tokens = docs.map((d) => [...tokenize(d.question), ...tokenize(d.question), ...tokenize(d.answer)]);
    this.avg = this.tokens.reduce((s, t) => s + t.length, 0) / (docs.length || 1) || 1;
    this.tf = this.tokens.map((t) => {
      const m = new Map<string, number>();
      for (const w of t) m.set(w, (m.get(w) ?? 0) + 1);
      for (const w of m.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return m;
    });
  }

  search(query: string, limit = 3): KbHit[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !this.docs.length) return [];
    const hits: KbHit[] = [];
    this.docs.forEach((doc, i) => {
      let score = 0;
      let matched = 0;
      for (const term of q) {
        const f = this.tf[i]!.get(term) ?? 0;
        if (!f) continue;
        matched++;
        const n = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.tokens[i]!.length) / this.avg)));
      }
      if (score > 0) hits.push({ doc, score, coverage: matched / q.length });
    });
    return hits.sort((a, b2) => b2.score - a.score || a.doc.id.localeCompare(b2.doc.id)).slice(0, limit);
  }
}

export function searchKb(query: string, docs: KbDoc[], opts: { k1?: number; b?: number; limit?: number } = {}): KbHit[] {
  return new Bm25Index(docs, opts.k1, opts.b).search(query, opts.limit ?? 3);
}
