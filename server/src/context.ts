import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Logger } from "./logger.js";
import type { RealtimeBus } from "./realtime/bus.js";
import type { PresenceService } from "./infra/presence.js";
import type { RateLimiter } from "./ratelimit/limiter.js";
import type { Cache } from "./infra/cache.js";
import type { Locks } from "./infra/locks.js";
import type { RedisHub } from "./infra/redis.js";
import type { JobQueue } from "./jobs/queue.js";
import type { Metrics } from "./metrics.js";
import type { WorkerPool } from "./workers/pool.js";
import type { EmailProvider, SmsProvider, Storage } from "./providers/types.js";
import type { AiProvider } from "./ai/provider.js";

/** Everything a service needs, passed explicitly. Tests build one with fakes (see tests/helpers). */
export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  /** Mutable on purpose: tests swap it to advance time. Always call it, never capture the result. */
  clock: () => Date;
  bus: RealtimeBus;
  presence: PresenceService;
  sms: SmsProvider;
  email: EmailProvider;
  storage: Storage;
  ai: AiProvider;
  ratelimit: RateLimiter;
  cache: Cache;
  locks: Locks;
  queue: JobQueue;
  metrics: Metrics;
  /** CPU-heavy tasks (large HTML bodies) run here instead of blocking the event loop; null = inline */
  workers: WorkerPool | null;
  /** present only when REDIS_URL is configured */
  redis: RedisHub | null;
  /** mutable process state shared by the HTTP and socket layers */
  state: { draining: boolean };
  /** identifies this process in logs, metrics and Redis keys */
  nodeId: string;
  /** Fire-and-forget side effects (triage, notifications). Tests await `settle()`. */
  background: BackgroundTracker;
}

export class BackgroundTracker {
  private pending = new Set<Promise<unknown>>();
  constructor(
    private readonly onError: (e: unknown) => void,
    /** background work must not inherit the caller's ambient transaction */
    private readonly detach: <T>(fn: () => T) => T = (fn) => fn(),
  ) {}

  get size(): number {
    return this.pending.size;
  }

  run(fn: () => Promise<unknown> | unknown): void {
    const p: Promise<unknown> = Promise.resolve()
      .then(() => this.detach(fn))
      .catch(this.onError)
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export const nowIso = (ctx: AppContext): string => ctx.clock().toISOString();
