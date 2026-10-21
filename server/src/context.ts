import type { RealtimeProvider } from "./calls/realtime.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Logger } from "./logger.js";
import type { RealtimeBus } from "./realtime/bus.js";
import type { PresenceService } from "./infra/presence.js";
import type { EventBus } from "./infra/eventbus.js";
import type { RateLimiter } from "./ratelimit/limiter.js";
import type { Cache } from "./infra/cache.js";
import type { Locks } from "./infra/locks.js";
import type { RedisHub } from "./infra/redis.js";
import type { JobQueue } from "./jobs/queue.js";
import type { Metrics } from "./metrics.js";
import type { Monitor } from "./monitoring/sentry.js";
import type { WorkerPool } from "./workers/pool.js";
import type { EmailProvider, SmsProvider, Storage } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { AiProvider } from "./ai/provider.js";
import type { BillingProvider } from "./billing/types.js";

/** Everything a service needs, passed explicitly. Tests build one with fakes (see tests/helpers). */
export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  /** Mutable on purpose: tests swap it to advance time. Always call it, never capture the result. */
  clock: () => Date;
  bus: RealtimeBus;
  presence: PresenceService;
  /** the PLATFORM default providers (environment). Conversation traffic resolves per workspace through `providers`. */
  sms: SmsProvider;
  email: EmailProvider;
  /** per-workspace provider resolution: the workspace's own Twilio/SendGrid connection, else the platform default above */
  providers: ProviderRegistry;
  storage: Storage;
  ai: AiProvider;
  /** the optional realtime speech engine of AI calls (OpenAI); null when it is not configured on this installation */
  realtime: RealtimeProvider | null;
  /** Stripe behind an interface: the real SDK, a fake in tests, or a stub that answers 503 when no key is configured */
  billing: BillingProvider;
  ratelimit: RateLimiter;
  /** domain event bus fed by the transactional outbox (Redis Streams when REDIS_URL is set, in-process otherwise) */
  eventBus: EventBus;
  cache: Cache;
  locks: Locks;
  queue: JobQueue;
  metrics: Metrics;
  /** optional error monitoring; the no-op unless SENTRY_DSN is set */
  monitor: Monitor;
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
