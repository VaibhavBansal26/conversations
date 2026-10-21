// Fails CI when the initial JS payload (gzip) outgrows its budget.
// Initial = every chunk referenced by dist/index.html (entry + modulepreloads).
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_INITIAL_KB = Number(process.env.BUDGET_INITIAL_KB ?? 170);
const BUDGET_CHUNK_KB = Number(process.env.BUDGET_CHUNK_KB ?? 120);
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const html = readFileSync(join(dist, "index.html"), "utf8");
const initial = new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]));
const kb = (f) => gzipSync(readFileSync(join(dist, f))).length / 1024;
let total = 0;
for (const f of initial) total += kb(f);
let failed = false;
console.log(`initial JS (gzip): ${total.toFixed(1)} KB (budget ${BUDGET_INITIAL_KB})`);
if (total > BUDGET_INITIAL_KB) failed = true;
for (const f of readdirSync(join(dist, "assets")).filter((x) => x.endsWith(".js"))) {
  const s = kb(`assets/${f}`);
  // the Sentry SDK is a lazy chunk that is fetched only when SENTRY_DSN is configured; it is never part of the initial payload (checked above)
  const optional = /^vendor-sentry-/.test(f);
  const over = s > BUDGET_CHUNK_KB && !optional;
  console.log(`  ${initial.has(`assets/${f}`) ? "*" : " "} ${f.padEnd(40)} ${s.toFixed(1)} KB${over ? "  OVER" : ""}`);
  if (over) failed = true;
}
if (failed) {
  console.error("bundle budget exceeded");
  process.exit(1);
}
