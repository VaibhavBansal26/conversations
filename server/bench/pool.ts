// Worker-pool overhead vs inline, and event-loop stall while a big task runs. Run: npx tsx bench/pool.ts
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { taskImpl } from "../src/workers/tasks.js";
import { WorkerPool } from "../src/workers/pool.js";

const para = '<p style="color:red">Hello <b>there</b>, see <a href="https://example.test/x?y=1">this link</a> and <img src="https://x.test/a.png" onerror="alert(1)"> thanks.</p><div><span>nested <i>markup</i></span></div>\n';
const mk = (kb: number) => para.repeat(Math.ceil((kb * 1024) / para.length));
const pool = new WorkerPool(2);
await pool.run("sanitizeEmail", { html: "<p>warm</p>" });
await pool.run("sanitizeEmail", { html: "<p>warm</p>" });

for (const kb of [2, 32, 256, 1024]) {
  const html = mk(kb);
  const n = kb > 200 ? 8 : 60;
  let t = performance.now();
  for (let i = 0; i < n; i++) taskImpl.sanitizeEmail({ html });
  const inline = (performance.now() - t) / n;
  t = performance.now();
  for (let i = 0; i < n; i++) await pool.run("sanitizeEmail", { html });
  const viaPool = (performance.now() - t) / n;
  console.log(`${String(kb).padStart(5)} KB  inline ${inline.toFixed(2).padStart(7)} ms   pool round-trip ${viaPool.toFixed(2).padStart(7)} ms`);
}

// what the rest of the server sees: longest stall of a 1 ms heartbeat while 20 big emails arrive back to back
for (const mode of ["inline", "pool"] as const) {
  let last = performance.now();
  let worst = 0;
  const gaps: number[] = [];
  const beat = setInterval(() => {
    const now = performance.now();
    const gap = now - last - 1;
    gaps.push(gap);
    worst = Math.max(worst, gap);
    last = now;
  }, 1);
  const html = mk(512);
  const t = performance.now();
  await Promise.all(Array.from({ length: 20 }, () => (mode === "inline" ? Promise.resolve().then(() => taskImpl.sanitizeEmail({ html })) : pool.run("sanitizeEmail", { html }))));
  const wall = performance.now() - t;
  clearInterval(beat);
  gaps.push(performance.now() - last - 1); // the final gap includes any stall the heartbeat could not observe while blocked
  worst = Math.max(worst, gaps[gaps.length - 1]!);
  gaps.sort((a, b) => a - b);
  console.log(`20 x 512 KB emails, ${mode.padEnd(6)}: wall ${wall.toFixed(0).padStart(5)} ms   heartbeat gap p50 ${gaps[Math.floor(gaps.length / 2)]!.toFixed(1)} ms  p99 ${gaps[Math.floor(gaps.length * 0.99)]!.toFixed(1)} ms  max ${worst.toFixed(1)} ms`);
}
await pool.close();
