import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { addSeconds } from "../util/time.js";

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (ctx: AppContext, payload: any) => Promise<void> | void;

/** Insert a job. A repeated dedupe_key is ignored, so enqueueing is safe to repeat. Returns true when newly queued. */
export function enqueueJob(ctx: AppContext, type: string, payload: unknown, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): boolean {
  const now = nowIso(ctx);
  const res = ctx.db.run(
    `INSERT OR IGNORE INTO jobs(id, type, payload, dedupe_key, run_at, max_attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    newId("job"), type, JSON.stringify(payload), opts.dedupeKey ?? null, (opts.runAt ?? ctx.clock()).toISOString(), opts.maxAttempts ?? 6, now, now,
  );
  return res.changes > 0;
}

/**
 * Run every due job once. A failing job is rescheduled with exponential backoff (2^attempt seconds, capped at 15 min)
 * until max_attempts, then parked as `failed`. Claiming is a conditional UPDATE so two workers never run the same job.
 */
export async function runDueJobs(ctx: AppContext, handlers: Record<string, JobHandler>, limit = 50): Promise<{ ran: number; failed: number }> {
  const due = ctx.db.all<JobRow>("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?", nowIso(ctx), limit);
  let ran = 0;
  let failed = 0;
  for (const job of due) {
    const claimed = ctx.db.run("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'", nowIso(ctx), job.id);
    if (!claimed.changes) continue;
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`no handler for job type ${job.type}`);
      await handler(ctx, parseJson(job.payload, {}));
      ctx.db.run("UPDATE jobs SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?", nowIso(ctx), job.id);
      ran++;
    } catch (e) {
      failed++;
      const attempts = job.attempts + 1;
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      if (attempts >= job.max_attempts) {
        ctx.db.run("UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?", attempts, msg, nowIso(ctx), job.id);
        ctx.log.error("job failed permanently", { job: job.id, type: job.type, error: msg });
      } else {
        const delay = Math.min(900, 2 ** attempts);
        ctx.db.run("UPDATE jobs SET status = 'pending', attempts = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?", attempts, msg, addSeconds(ctx.clock(), delay).toISOString(), nowIso(ctx), job.id);
      }
    }
  }
  return { ran, failed };
}
