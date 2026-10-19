import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createAiProvider, type AiProvider } from "./ai/provider.js";
import type { Config } from "./config.js";
import { BackgroundTracker, type AppContext } from "./context.js";
import { migrate, openDb } from "./db/index.js";
import { LocalCache } from "./infra/cache.js";
import { MemoryLimiterFactory, RedisLimiterFactory, type LimiterFactory } from "./infra/limiter.js";
import { MemoryLocks, RedisLocks } from "./infra/locks.js";
import { MemoryPresenceService, RedisPresenceService, type PresenceService } from "./infra/presence.js";
import { RedisHub } from "./infra/redis.js";
import { BullJobQueue, DbJobQueue } from "./jobs/queue.js";
import { Metrics } from "./metrics.js";
import { createLogger, type Logger } from "./logger.js";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "./providers/fake.js";
import { LocalDiskStorage } from "./providers/storage.js";
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
  clock?: () => Date;
  presence?: PresenceService;
  limiters?: LimiterFactory;
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
  const db = await openDb({ url: config.DATABASE_URL, path: config.DATABASE_PATH, poolMax: config.DATABASE_POOL_MAX });
  await migrate(db);
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
    storage: o.storage ?? new LocalDiskStorage(resolve(config.DATA_DIR, "uploads"), config.PUBLIC_URL, config.JWT_SECRET, () => ctxRef.clock().getTime()),
    ai: o.ai ?? createAiProvider(config),
    limiters:
      o.limiters ??
      (hub
        ? new RedisLimiterFactory(hub, (e) => log.warn("redis limiter failed open", { error: e instanceof Error ? e.message : String(e) }))
        : new MemoryLimiterFactory(() => ctxRef.clock().getTime())),
    cache,
    locks: hub ? new RedisLocks(hub) : new MemoryLocks(),
    queue: undefined as never,
    metrics: new Metrics(config.NODE_ENV !== "test"),
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
  await ctx.queue.close();
  ctx.metrics.close();
  await ctx.presence.close();
  await ctx.redis?.close();
  await ctx.db.close();
}
