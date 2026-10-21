import { Queue, Worker } from "bullmq";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { RedisHub } from "../infra/redis.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { addSeconds } from "../util/time.js";

export type JobHandler = (ctx: AppContext, payload: any) => Promise<void> | void;

export interface EnqueueOptions {
  runAt?: Date;
  /** a repeated key is ignored while the first job still exists, so enqueueing is safe to repeat */
  dedupeKey?: string;
  maxAttempts?: number;
  /** tenant the job belongs to: used for fair scheduling and per-tenant backpressure */
  workspaceId?: string;
}

export interface QueueDepth {
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
}

/**
 * Background job queue. `DbJobQueue` (default) keeps jobs in the application database and is driven by the scheduler;
 * `BullJobQueue` (when REDIS_URL is set) runs them on BullMQ workers with native delayed jobs. Same interface, same handlers.
 */
export interface JobQueue {
  readonly kind: "db" | "bullmq";
  /** resolves true when a new job was queued, false when the dedupe key already existed */
  enqueue(type: string, payload: unknown, opts?: EnqueueOptions): Promise<boolean>;
  start(handlers: Record<string, JobHandler>): Promise<void>;
  depth(): Promise<QueueDepth>;
  close(): Promise<void>;
}

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
}

export class DbJobQueue implements JobQueue {
  readonly kind = "db" as const;
  constructor(private readonly ctx: AppContext) {}

  async enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<boolean> {
    const ctx = this.ctx;
    const now = nowIso(ctx);
    const res = await ctx.db.run(
      `INSERT OR IGNORE INTO jobs(id, type, payload, dedupe_key, run_at, max_attempts, created_at, updated_at, workspace_id) VALUES (?,?,?,?,?,?,?,?,?)`,
      newId("job"),
      type,
      JSON.stringify(payload),
      opts.dedupeKey ?? null,
      (opts.runAt ?? ctx.clock()).toISOString(),
      opts.maxAttempts ?? 6,
      now,
      now,
      opts.workspaceId ?? null,
    );
    return res.changes > 0;
  }

  /** Processing is pulled by the scheduler (`runDueJobs`), nothing to start. */
  async start() {}

  async depth(): Promise<QueueDepth> {
    const rows = await this.ctx.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status");
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    const delayed = (await this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND run_at > ?", nowIso(this.ctx)))?.n ?? 0;
    return { waiting: (by.pending ?? 0) - delayed, delayed, active: by.running ?? 0, failed: by.failed ?? 0 };
  }

  async close() {}
}

export const enqueueJob = (ctx: AppContext, type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<boolean> => ctx.queue.enqueue(type, payload, opts);

/**
 * Run every due db job once. A failing job is rescheduled with exponential backoff (2^attempt seconds, capped at 15 min)
 * until max_attempts, then parked as `failed`. Claiming is a conditional UPDATE so two workers never run the same job.
 */
export async function runDueJobs(ctx: AppContext, handlers: Record<string, JobHandler>, limit = 50, quantum = 5): Promise<{ ran: number; failed: number }> {
  // Fair scheduling: at most `quantum` jobs per workspace per pass, interleaved round-robin (rank 1 of every workspace first, then rank 2, ...).
  // A tenant that enqueues a million sends therefore delays other tenants' jobs by at most one rank per pass, not by its whole backlog.
  const due = await ctx.db.all<JobRow>(
    `SELECT t.* FROM (SELECT j.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(j.workspace_id, '') ORDER BY j.run_at, j.id) AS rn
                      FROM jobs j WHERE j.status = 'pending' AND j.run_at <= ?) t
     WHERE t.rn <= ? ORDER BY t.rn, t.run_at, t.id LIMIT ?`,
    nowIso(ctx),
    quantum,
    limit,
  );
  let ran = 0;
  let failed = 0;
  for (const job of due) {
    const claimed = await ctx.db.run("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'", nowIso(ctx), job.id);
    if (!claimed.changes) continue;
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`no handler for job type ${job.type}`);
      await handler(ctx, parseJson(job.payload, {}));
      await ctx.db.run("UPDATE jobs SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?", nowIso(ctx), job.id);
      ran++;
    } catch (e) {
      failed++;
      const attempts = job.attempts + 1;
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      if (attempts >= job.max_attempts) {
        await ctx.db.run("UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?", attempts, msg, nowIso(ctx), job.id);
        ctx.log.error("job failed permanently", { job: job.id, type: job.type, error: msg });
        ctx.monitor.capture(e, { area: "job", job_type: job.type });
      } else {
        const delay = Math.min(900, 2 ** attempts);
        await ctx.db.run(
          "UPDATE jobs SET status = 'pending', attempts = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?",
          attempts,
          msg,
          addSeconds(ctx.clock(), delay).toISOString(),
          nowIso(ctx),
          job.id,
        );
      }
    }
  }
  return { ran, failed };
}

const QUEUE_NAME = "conversations-jobs";
const safeId = (k: string) => k.replace(/[:\s]/g, "_");

export class BullJobQueue implements JobQueue {
  readonly kind = "bullmq" as const;
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly hub: RedisHub,
    private readonly concurrency = 10,
  ) {
    this.queue = new Queue(QUEUE_NAME, {
      connection: hub.duplicate(),
      prefix: hub.k("bull"),
      defaultJobOptions: { removeOnComplete: { age: 3600, count: 5000 }, removeOnFail: { age: 7 * 86400 } },
    });
  }

  async enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<boolean> {
    const jobId = opts.dedupeKey ? safeId(opts.dedupeKey) : undefined;
    if (jobId && (await this.queue.getJob(jobId))) return false;
    const delay = opts.runAt ? Math.max(0, opts.runAt.getTime() - this.ctx.clock().getTime()) : 0;
    await this.queue.add(type, payload, { jobId, delay, attempts: opts.maxAttempts ?? 6, backoff: { type: "exponential", delay: 2000 } });
    return true;
  }

  async start(handlers: Record<string, JobHandler>) {
    if (this.worker) return;
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const h = handlers[job.name];
        if (!h) throw new Error(`no handler for job type ${job.name}`);
        await this.ctx.db.detached(() => h(this.ctx, job.data));
      },
      { connection: this.hub.duplicate(), prefix: this.hub.k("bull"), concurrency: this.concurrency },
    );
    this.worker.on("failed", (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        this.ctx.log.error("job failed permanently", { job: job.id, type: job.name, error: err.message });
        this.ctx.monitor.capture(err, { area: "job", job_type: job.name });
      }
    });
    this.worker.on("error", (e) => this.ctx.log.warn("job worker error", { error: e.message }));
  }

  async depth(): Promise<QueueDepth> {
    const c = await this.queue.getJobCounts("waiting", "delayed", "active", "failed");
    return { waiting: c.waiting ?? 0, delayed: c.delayed ?? 0, active: c.active ?? 0, failed: c.failed ?? 0 };
  }

  /** Test/ops helper: wait until nothing is waiting or running (delayed jobs excluded). */
  async drain(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const d = await this.depth();
      if (d.waiting + d.active === 0) return;
      if (Date.now() > end) throw new Error("queue did not drain");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
  }
}
