// Micro-benchmarks of the CPU-heavy operations that could be offloaded to worker threads. Run: npx tsx bench/cpu.ts
import { performance } from "node:perf_hooks";
import { sanitizeHtml, htmlToText } from "../src/util/html.js";
import { parseCsv } from "../src/util/csv.js";
import { Bm25Index, searchKb } from "../src/ai/retrieval.js";
import { sniff } from "../src/services/attachments.js";
import { parseHeaders } from "../src/services/inbound.js";

const time = (name: string, fn: () => void, n: number) => {
  for (let i = 0; i < 3; i++) fn();
  const t = performance.now();
  for (let i = 0; i < n; i++) fn();
  const ms = (performance.now() - t) / n;
  console.log(`${name.padEnd(52)} ${ms.toFixed(3).padStart(9)} ms/op`);
  return ms;
};

const para = '<p style="color:red">Hello <b>there</b>, see <a href="https://example.test/x?y=1">this link</a> and <img src="https://x.test/a.png" onerror="alert(1)"> thanks.</p><div><span>nested <i>markup</i></span></div>\n';
const mkHtml = (kb: number) => para.repeat(Math.ceil((kb * 1024) / para.length));
for (const kb of [2, 32, 256, 1024]) {
  const h = mkHtml(kb);
  time(`sanitizeHtml ${kb} KB email body`, () => sanitizeHtml(h), kb > 200 ? 5 : 40);
  time(`htmlToText ${kb} KB`, () => htmlToText(h), kb > 200 ? 5 : 40);
}
const csv = (rows: number) => "name,email,phone,tags,plan\n" + Array.from({ length: rows }, (_, i) => `"Person ${i}",p${i}@example.test,+1415555${String(i).padStart(4, "0")},vip;new,pro`).join("\n");
for (const rows of [100, 2000, 20000]) {
  const c = csv(rows);
  time(`parseCsv ${rows} rows`, () => parseCsv(c), rows > 5000 ? 3 : 20);
}
const kb = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, question: `How do I configure feature number ${i} for my account?`, answer: `Open settings, choose feature ${i} and follow the wizard. This takes about ${i % 9} minutes and requires admin rights.` }));
for (const n of [50, 500, 5000]) {
  const docs = kb(n);
  time(`BM25 index+query over ${n} entries (old: per query)`, () => searchKb("how do I configure feature 42 for my account", docs, { limit: 3 }), n > 1000 ? 5 : 40);
  const idx = new Bm25Index(docs);
  time(`BM25 query on cached index, ${n} entries`, () => idx.search("how do I configure feature 42 for my account", 3), n > 1000 ? 50 : 400);
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10 * 1024 * 1024, 1)]);
time("sniff 10 MB png (reads only the head)", () => sniff(png), 2000);
const text = Buffer.alloc(10 * 1024 * 1024, 97);
time("sniff 10 MB text file", () => sniff(text), 200);
const hdr = Array.from({ length: 60 }, (_, i) => `X-Header-${i}: value ${i}`).join("\r\n") + "\r\nMessage-ID: <a@b>\r\nReferences: " + Array.from({ length: 30 }, (_, i) => `<${i}@x>`).join(" ");
time("parseHeaders (60 headers + 30 references)", () => parseHeaders(hdr), 2000);
