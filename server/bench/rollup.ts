// Rollup consumer throughput. Run: npx tsx bench/rollup.ts [--n 1000000] [--url postgres://...]
// Feeds N message.created events through the real `rollupHandler` (idempotent consumer + counter upsert, one transaction per event) on in-memory SQLite,
// and on PostgreSQL when a URL is given (use a throwaway database).
import { performance } from "node:perf_hooks";
import { closeContext, createContext } from "../src/app-context.js";
import { loadConfig } from "../src/config.js";
import { rollupHandler } from "../src/events/outbox.js";
import { silentLogger } from "../src/logger.js";
import { seedWorkspaceRaw } from "./support.js";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const N = Number(arg("n") ?? 1_000_000);
const results: Record<string, unknown> = { date: new Date().toISOString(), events: N };

async function run(label: string, env: Record<string, string>) {
  const ctx = await createContext(loadConfig({ NODE_ENV: "test", JWT_SECRET: "bench-bench-bench-bench-bench", LOG_LEVEL: "silent", MESSAGE_HASH_PARTITIONS: "4", DATA_DIR: "/tmp/bench-rollup", ...env }, () => {}), { log: silentLogger });
  const ws = await seedWorkspaceRaw(ctx);
  const t0 = performance.now();
  const day = (i: number) => `2026-03-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00.000Z`;
  for (let i = 0; i < N; i++) {
    await rollupHandler(ctx, { id: `evt_${label}_${i}`, topic: "message.events", key: `room${i % 1000}`, attempt: 1, payload: { type: "message.created", workspace_id: ws, sender_type: i % 3 ? "contact" : "agent", kind: "text", source: i % 5 ? "dm" : "sms", created_at: day(i) } });
    if (i && i % 100_000 === 0) console.error(label, i, Math.round(i / ((performance.now() - t0) / 1000)), "events/s");
  }
  const secs = (performance.now() - t0) / 1000;
  const total = Number((await ctx.db.get<{ n: number }>("SELECT COALESCE(SUM(messages),0) AS n FROM rollup_messages_daily"))!.n);
  results[label] = { events_per_s: Math.round(N / secs), secs: Math.round(secs), rollup_total: total, correct: total === N, ctx_us_per_event: Math.round((secs / N) * 1e6) };
  await closeContext(ctx);
}
await run("sqlite_memory", { DATABASE_PATH: ":memory:" });
if (arg("url")) await run("postgres", { DATABASE_URL: arg("url")! });
console.log(JSON.stringify(results, null, 2));
