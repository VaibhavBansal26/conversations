import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createAiProvider, type AiProvider } from "./ai/provider.js";
import { createBilling } from "./billing/stripe.js";
import type { BillingProvider } from "./billing/types.js";
import type { Config } from "./config.js";
import { BackgroundTracker, type AppContext } from "./context.js";
import { migrate, openDb } from "./db/index.js";
import { ensureMessagePartitions } from "./db/partitions.js";
import { LocalCache } from "./infra/cache.js";
import { MemoryBus, RedisStreamsBus } from "./infra/eventbus.js";
import { MemoryStore } from "./ratelimit/memoryStore.js";
import { RedisStore } from "./ratelimit/redisStore.js";
import { RateLimiter } from "./ratelimit/limiter.js";
import type { Store, Tier } from "./ratelimit/types.js";
import { MemoryLocks, RedisLocks } from "./infra/locks.js";
import { MemoryPresenceService, RedisPresenceService, type PresenceService } from "./infra/presence.js";
import { RedisHub } from "./infra/redis.js";
import { BullJobQueue, DbJobQueue } from "./jobs/queue.js";
import { Metrics } from "./metrics.js";
import { WorkerPool } from "./workers/pool.js";
import { createLogger, type Logger } from "./logger.js";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "./providers/fake.js";
import { LocalDiskStorage } from "./providers/storage.js";
import { ProviderRegistry } from "./providers/registry.js";
import { SendGridEmailProvider } from "./providers/sendgrid.js";
import { TwilioSmsProvider } from "./providers/twilio.js";
import type { EmailProvider, SmsProvider, Storage } from "./providers/types.js";
import { RecordingBus, type RealtimeBus } from "./realtime/bus.js";
import { Presence } from "./realtime/presence.js";
import { memberScope } from "./services/members.js";

export interface ContextOverrides {
  log?: Logger;
  bus?: RealtimeBus;
  sms?: SmsProvider;
  email?: EmailProvider;
  storage?: Storage;
  ai?: AiProvider;
  billing?: BillingProvider;
  clock?: () => Date;
  presence?: PresenceService;
  /** inject a rate-limit store (tests); defaults to Redis when REDIS_URL is set, memory otherwise */
  rateStore?: Store;
  /** force-disable Redis even when REDIS_URL is set (tests of the in-memory path) */
  noRedis?: boolean;
}

/**
 * Wires config -> concrete implementations. Everything has an in-memory/SQLite default so `npm run dev` needs no services;
 * setting `DATABASE_URL` switches to PostgreSQL and `REDIS_URL` switches limiter, presence, cache invalidation, locks and the
 * job queue to Redis. Tests inject fakes through `overrides`.
 */
export async function createContext(config: Config, o: ContextOverrides = {}): Promise<AppContext> {
  const log = o.log ?? createLogger(config.LOG_LEVEL);
  const db = await openDb({ url: config.DATABASE_URL, path: config.DATABASE_PATH, poolMax: config.DATABASE_POOL_MAX, pgbouncer: config.DATABASE_PGBOUNCER, replicaUrl: config.DATABASE_REPLICA_URL, replicaMaxLagMs: config.DATABASE_REPLICA_MAX_LAG_MS, readAfterWriteMs: config.DATABASE_READ_AFTER_WRITE_MS });
  await migrate(db, undefined, { hashPartitions: config.MESSAGE_HASH_PARTITIONS });
  await ensureMessagePartitions(db, config.MESSAGE_PARTITION_MONTHS_AHEAD);
  const bus = o.bus ?? new RecordingBus();
  const nodeId = config.NODE_ID ?? `${hostname()}-${randomBytes(3).toString("hex")}`;
  const hub = config.REDIS_URL && !o.noRedis ? new RedisHub(config.REDIS_URL, log, config.REDIS_PREFIX) : null;
  const clock = o.clock ?? (() => new Date());

  const cache = new LocalCache(config.CACHE_TTL_MS, () => ctxRef.clock().getTime());
  if (hub) await cache.attach(hub);

  const ctxRef: AppContext = {
    config,
    db,
    log,
    clock,
    bus,
    presence: undefined as never,
    sms: o.sms ?? (config.SMS_PROVIDER === "twilio" ? new TwilioSmsProvider(config.TWILIO_ACCOUNT_SID!, config.TWILIO_AUTH_TOKEN!) : new ConsoleSmsProvider(log)),
    email: o.email ?? (config.EMAIL_PROVIDER === "sendgrid" ? new SendGridEmailProvider(config.SENDGRID_API_KEY!) : new ConsoleEmailProvider(log)),
    providers: new ProviderRegistry(() => ctxRef),
    storage: o.storage ?? new LocalDiskStorage(resolve(config.DATA_DIR, "uploads"), config.PUBLIC_URL, config.JWT_SECRET, () => ctxRef.clock().getTime()),
    ai: o.ai ?? createAiProvider(config),
    billing: o.billing ?? createBilling(config),
    ratelimit: undefined as never,
    eventBus: hub ? new RedisStreamsBus(hub) : new MemoryBus(),
    cache,
    locks: hub ? new RedisLocks(hub) : new MemoryLocks(),
    queue: undefined as never,
    metrics: new Metrics(config.NODE_ENV !== "test"),
    workers: config.WORKER_POOL_SIZE > 0 && config.NODE_ENV !== "test" ? new WorkerPool(config.WORKER_POOL_SIZE) : null,
    redis: hub,
    nodeId,
    state: { draining: false },
    background: new BackgroundTracker(
      (e) => log.error("background task failed", { error: e instanceof Error ? e.message : String(e) }),
      (fn) => db.detached(fn),
    ),
  };

  const onPresence = (scope: string, idv: string, online: boolean) => {
    const [ws] = scope.split(":");
    if (!ws) return;
    if (scope === memberScope(ws)) {
      ctxRef.bus.toWorkspace(ws, "presence:update", { member_id: idv, online });
      return;
    }
    ctxRef.background.run(async () => {
      const rooms = await ctxRef.db.all<{ id: string }>("SELECT id FROM rooms WHERE workspace_id = ? AND contact_id = ? AND archived = 0", ws, idv);
      for (const r of rooms) ctxRef.bus.toRoom(ws, r.id, "visitor:presence", { room_id: r.id, contact_id: idv, online });
    });
  };
  const clockNow = () => ctxRef.clock().getTime();
  let redisStore: RedisStore | null = null;
  if (!o.rateStore && hub) {
    redisStore = new RedisStore(hub, { timeoutMs: config.RATELIMIT_REDIS_TIMEOUT_MS, breakerThreshold: config.RATELIMIT_BREAKER_FAILURES, breakerOpenMs: config.RATELIMIT_BREAKER_OPEN_MS });
    redisStore.onCall = (sec, ok) => ctxRef.metrics.rlRedis.observe({ ok: String(ok) }, sec);
    // the store reports on every failure and every recovery; the log and the gauge change only on a real transition (a flapping breaker used to log hundreds of identical lines per second)
    let breakerOpen = false;
    redisStore.onBreaker = (open) => {
      if (open === breakerOpen) return;
      breakerOpen = open;
      ctxRef.metrics.rlBreaker.set(open ? 1 : 0);
      log.warn(open ? "rate-limit redis circuit opened; failing per policy" : "rate-limit redis circuit closed");
    };
  }
  ctxRef.ratelimit = new RateLimiter({
    store: o.rateStore ?? redisStore ?? new MemoryStore(clockNow),
    fallback: new MemoryStore(clockNow),
    now: clockNow,
    scale: config.RATE_LIMIT_SCALE,
    log,
    leaseFraction: config.RATELIMIT_LEASE_FRACTION,
    leaseTtlMs: config.RATELIMIT_LEASE_TTL_MS,
    logSample: config.RATELIMIT_LOG_SAMPLE,
    overrides: {
      "ws.connect.ip": { limit: config.WS_CONNECT_RATE_PER_IP, burst: Math.max(5, config.WS_CONNECT_RATE_PER_IP * 2) },
      "ws.actor": { limit: config.SOCKET_RATE_PER_SEC * 4, burst: config.SOCKET_RATE_BURST * 4 },
    },
    metrics: {
      decision: (policy, outcome) => ctxRef.metrics.rlDecisions.inc({ policy, outcome }),
      lease: (result) => ctxRef.metrics.rlLease.inc({ result }),
      redis: () => {},
      breaker: () => {},
    },
    tierOf: (ws) =>
      ctxRef.cache.wrap(`tier:${ws}`, async () => {
        const o2 = await ctxRef.db.get<{ tier: string }>("SELECT tier FROM rate_limit_overrides WHERE workspace_id = ?", ws);
        const t = o2?.tier ?? (await ctxRef.db.get<{ plan: string }>("SELECT plan FROM workspaces WHERE id = ?", ws))?.plan ?? "free";
        return (["free", "pro", "business"].includes(t) ? t : "free") as Tier;
      }),
  });
  if (!o.rateStore) ctxRef.ratelimit.startLists();

  ctxRef.presence =
    o.presence ??
    (hub
      ? new RedisPresenceService(hub, onPresence, { nodeId, graceMs: config.PRESENCE_GRACE_MS, ttlMs: config.PRESENCE_TTL_MS })
      : new MemoryPresenceService(new Presence(config.PRESENCE_GRACE_MS, onPresence)));

  const useBull = config.JOB_QUEUE === "bullmq" || (config.JOB_QUEUE === "auto" && !!hub);
  ctxRef.queue = useBull && hub ? new BullJobQueue(ctxRef, hub) : new DbJobQueue(ctxRef);
  return ctxRef;
}

/** Orderly teardown of everything createContext opened. */
export async function closeContext(ctx: AppContext): Promise<void> {
  if ((ctx as { closed?: boolean }).closed) return;
  (ctx as { closed?: boolean }).closed = true;
  await ctx.background.settle();
  await ctx.eventBus.close();
  await ctx.queue.close();
  ctx.ratelimit.stop();
  await ctx.ratelimit.shared.close();
  ctx.metrics.close();
  await ctx.workers?.close();
  await ctx.presence.close();
  await ctx.redis?.close();
  await ctx.db.close();
}
