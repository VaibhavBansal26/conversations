import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseDataKey } from "./util/dataCrypto.js";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_PATH: z.string().default("./data/conversations.db"),
  /** postgres://... selects PostgreSQL (multi-node); unset keeps the embedded SQLite file above */
  DATABASE_URL: z.string().optional(),
  /** hash partitions of the messages table; only read when the partitioning migration first runs (cannot be changed afterwards without a rebuild) */
  MESSAGE_HASH_PARTITIONS: z.coerce.number().int().min(1).max(256).default(16),
  MESSAGE_PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(0).max(24).default(3),
  /** transaction-mode PgBouncer between the app and PostgreSQL: disables named prepared statements (the app already uses no session state; migrations use transaction-scoped advisory locks) */
  DATABASE_PGBOUNCER: bool.default(false),
  /** optional read replica for history/list/search reads */
  DATABASE_REPLICA_URL: z.string().optional(),
  DATABASE_REPLICA_MAX_LAG_MS: z.coerce.number().int().min(0).default(1000),
  DATABASE_READ_AFTER_WRITE_MS: z.coerce.number().int().min(0).default(1500),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATA_DIR: z.string().default("./data"),
  WEB_DIST: z.string().optional(),
  JWT_SECRET: z.string().min(16).optional(),
  /** key for secrets that must outlive JWT_SECRET rotations (the analytics identity pepper): 32 bytes as 64 hex characters or base64 */
  DATA_ENCRYPTION_KEY: z.string().refine((v) => parseDataKey(v) !== null, "must be 32 bytes as 64 hex characters or base64 (openssl rand -hex 32)").optional(),
  /** previous DATA_ENCRYPTION_KEY value(s), comma separated, kept while a rotation re-encrypts stored secrets on their next read */
  DATA_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .refine((v) => v.split(",").every((x) => !x.trim() || parseDataKey(x) !== null), "every entry must be 32 bytes as 64 hex characters or base64")
    .optional(),
  /** access tokens are short lived; clients renew them with the refresh token (30 days, single use, rotated) */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  TRUST_PROXY: bool.default(false),
  /** proxies of ours that append to X-Forwarded-For; the client address is the entry this many from the right */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),

  /** "auto" = Redis adapter when REDIS_URL is set, in-memory otherwise */
  SOCKET_ADAPTER: z.enum(["auto", "memory", "redis"]).default("auto"),
  REDIS_URL: z.string().optional(),
  /** namespaces every Redis key and channel (several environments can share one Redis) */
  REDIS_PREFIX: z.string().default("conv"),
  JOB_QUEUE: z.enum(["auto", "db", "bullmq"]).default("auto"),
  CACHE_TTL_MS: z.coerce.number().int().min(0).default(3000),
  NODE_ID: z.string().optional(),
  /** the region this installation serves; a workspace whose `home_region` is set to another region is refused here (421) so a global edge can route it home */
  REGION: z.string().max(32).optional(),
  PRESENCE_TTL_MS: z.coerce.number().int().positive().default(30000),

  WS_PING_INTERVAL_MS: z.coerce.number().int().positive().default(25000),
  WS_PING_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  WS_MAX_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024),
  /** 0 = unlimited */
  WS_MAX_CONNECTIONS: z.coerce.number().int().min(0).default(0),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(0).default(0),
  WS_CONNECT_RATE_PER_IP: z.coerce.number().positive().default(20),
  /** a socket whose outbound queue grows past this many packets is a slow consumer and is disconnected */
  WS_MAX_WRITE_BUFFER: z.coerce.number().int().positive().default(500),
  WS_DRAIN_MS: z.coerce.number().int().min(0).default(5000),
  WS_PERMESSAGE_DEFLATE: bool.default(false),
  WS_TRANSPORTS: z.enum(["websocket", "polling,websocket", "websocket,polling"]).default("polling,websocket"),
  /** shared secret a CDN adds as `x-edge-secret`; only then is CF-Connecting-IP believed */
  CF_SHARED_SECRET: z.string().optional(),
  /** multiplies every rate limit; for load tests only (logged loudly at startup when != 1) */
  /** per-plan limits (free/pro/business) are always evaluated; connection caps per plan only when this is on (needs billing to set plans) */
  PLAN_ENFORCEMENT: bool.default(false),
  RATELIMIT_REDIS_TIMEOUT_MS: z.coerce.number().int().positive().default(30),
  RATELIMIT_BREAKER_FAILURES: z.coerce.number().int().positive().default(5),
  RATELIMIT_BREAKER_OPEN_MS: z.coerce.number().int().positive().default(3000),
  /** share of a hot policy's burst leased from Redis in one call and spent locally (0 disables the lease tier) */
  RATELIMIT_LEASE_FRACTION: z.coerce.number().min(0).max(0.5).default(0.1),
  RATELIMIT_LEASE_TTL_MS: z.coerce.number().int().positive().default(1000),
  /** log 1 in N limited decisions (policy id only, never raw keys) */
  RATELIMIT_LOG_SAMPLE: z.coerce.number().int().positive().default(100),
  /** socket admission control */
  WS_MAX_HANDSHAKES: z.coerce.number().int().positive().default(500),
  SHED_LOOP_LAG_MS: z.coerce.number().int().min(0).default(250),
  WS_STRIKE_LIMIT: z.coerce.number().int().positive().default(25),
  WS_MAX_CONNECTIONS_PER_WORKSPACE: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  /** Bearer token required for /metrics (unset = open, intended for a private network only) */
  METRICS_TOKEN: z.string().optional(),
  /** error monitoring (Sentry); everything stays off, with no SDK loaded and no network, until a DSN is set */
  SENTRY_DSN: z.string().optional(),
  SENTRY_WEB_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  SENTRY_RELEASE: z.string().optional(),
  WORKER_POOL_SIZE: z.coerce.number().int().min(0).default(2),
  WORKER_THRESHOLD_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .default(32 * 1024),
  PRESENCE_GRACE_MS: z.coerce.number().int().min(0).default(5000),
  SOCKET_RATE_PER_SEC: z.coerce.number().positive().default(10),
  SOCKET_RATE_BURST: z.coerce.number().positive().default(30),

  SMS_PROVIDER: z.enum(["console", "twilio"]).default("console"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  EMAIL_PROVIDER: z.enum(["console", "sendgrid"]).default("console"),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  WEBHOOK_SHARED_SECRET: z.string().optional(),
  /** time budget of every call to Twilio or SendGrid (sends, credential checks, number and sender imports) */
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  /** calls (docs/CALLS.md): STUN servers every call may use, and the optional shared TURN relay with coturn-style time-limited credentials */
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  TURN_URLS: z.string().optional(),
  TURN_SECRET: z.string().min(16).optional(),
  TURN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  SYSTEM_EMAIL_FROM: z.string().default("notifications@conversations.local"),
  CREDIT_COST_SMS: z.coerce.number().int().min(0).default(1),
  CREDIT_COST_EMAIL: z.coerce.number().int().min(0).default(1),

  /** Stripe. Without STRIPE_SECRET_KEY billing is off: the app runs, checkout endpoints answer 503 BILLING_NOT_CONFIGURED */
  STRIPE_SECRET_KEY: z.string().optional(),
  /** signing secret of the platform webhook endpoint (/webhooks/stripe) */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** signing secret of the Connect webhook endpoint (/webhooks/stripe/connect): events from customers' connected accounts */
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  /** days a workspace keeps working after a failed subscription payment before it is soft-locked (applies when PLAN_ENFORCEMENT=true) */
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  /** price of one credit in the smallest currency unit (cents); credit packs are priced from it */
  CREDIT_PRICE_CENTS: z.coerce.number().min(0.01).default(2),
  BILLING_CURRENCY: z.string().length(3).toLowerCase().default("usd"),
  /** Connect: fee kept by the platform on payment requests, in basis points (100 = 1%) */
  CONNECT_APPLICATION_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(0),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  /** the optional "realtime" speech engine of AI calls (docs/CALLS.md, ADR 0035): the visitor's browser talks to OpenAI over WebRTC with a short-lived secret minted here */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_REALTIME_MODEL: z.string().optional(),
  OPENAI_REALTIME_VOICE: z.string().optional(),
  OPENAI_REALTIME_TRANSCRIBE_MODEL: z.string().optional(),
  OPENAI_CLIENT_SECRET_TTL_SECONDS: z.coerce.number().int().min(10).max(7200).default(60),
  AI_REALTIME_ENABLED: bool.default(true),
  /** a new workspace starts with the two preset AI agents, Aria and vb, switched on (docs/AI-AGENTS.md); tests and the demo seed turn it off */
  DEFAULT_AI_AGENTS: bool.default(true),
  /** photoreal avatar of AI video calls (ADR 0039): the instance fallback key for D-ID (workspaces connect their own in Settings > Calls), the kill switch and a price for the analytics estimate */
  DID_API_KEY: z.string().optional(),
  DID_API_BASE: z.string().url().default("https://api.d-id.com"),
  DID_AUTH_ENCODE: z.enum(["raw", "base64"]).default("raw"),
  AVATAR_PHOTOREAL_ENABLED: bool.default(true),
  AVATAR_COST_PER_MINUTE_USD: z.coerce.number().min(0).max(100).optional(),
  AVATAR_TEST_PROVIDER: z.enum(["fake"]).optional(),
  /** Web Push for team members (docs/NOTIFICATIONS.md): all three or the feature is off */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  PUSH_ALLOWED_HOSTS: z.string().optional(),
  AI_REALTIME_COST_PER_MINUTE_USD: z.coerce.number().min(0).max(100).optional(),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  SCHEDULER_ENABLED: bool.default(true),
  /** pace provider sends per number/sender (queue with a delay instead of rejecting); off only in tests that assert immediate sends */
  SEND_PACING: bool.default(true),
  /** a workspace with more than this many sends waiting gets 429 on new external sends (other tenants are unaffected) */
  SEND_QUEUE_WORKSPACE_MAX: z.coerce.number().int().positive().default(5000),
  SEND_RETRY_JITTER: bool.default(true),
  SEND_QUEUE_MAX: z.coerce.number().int().positive().default(500),
  SEND_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SEND_RETRY_BASE_SECONDS: z.coerce.number().positive().default(30),
  SEND_RETRY_CAP_SECONDS: z.coerce.number().positive().default(3600),
  DIGEST_MIN_AGE_MINUTES: z.coerce.number().positive().default(2),
  DIGEST_MAX_AGE_MINUTES: z.coerce.number().positive().default(60),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type Config = Omit<z.infer<typeof configSchema>, "JWT_SECRET"> & {
  JWT_SECRET: string;
  corsOrigins: string[];
};

export function loadConfig(env: Record<string, string | undefined> = process.env, warn: (m: string) => void = console.warn): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  const cfg = parsed.data;
  let secret = cfg.JWT_SECRET;
  if (!secret) {
    if (cfg.NODE_ENV === "production") throw new Error("JWT_SECRET is required in production");
    secret = randomBytes(32).toString("hex");
    warn("JWT_SECRET not set: generated an ephemeral development secret (tokens die on restart)");
  }
  if (!cfg.DATA_ENCRYPTION_KEY && cfg.NODE_ENV !== "test") {
    if (cfg.NODE_ENV === "production") warn("DATA_ENCRYPTION_KEY not set: the analytics identity pepper (and so every analytics export) is refused until it is configured");
    else warn("DATA_ENCRYPTION_KEY not set: derived a development key from JWT_SECRET (an identity pepper stored now is unreadable if JWT_SECRET changes)");
  }
  if (cfg.AVATAR_TEST_PROVIDER && cfg.NODE_ENV === "production") throw new Error("AVATAR_TEST_PROVIDER is for tests and demos only and cannot be set in production");
  if (cfg.SMS_PROVIDER === "twilio" && !(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN)) {
    throw new Error("SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
  }
  if (cfg.STRIPE_SECRET_KEY && !cfg.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_SECRET_KEY requires STRIPE_WEBHOOK_SECRET (webhooks are how subscriptions and top-ups are confirmed)");
  if (cfg.EMAIL_PROVIDER === "sendgrid" && !cfg.SENDGRID_API_KEY) {
    throw new Error("EMAIL_PROVIDER=sendgrid requires SENDGRID_API_KEY");
  }
  if ((cfg.SOCKET_ADAPTER === "redis" || cfg.JOB_QUEUE === "bullmq") && !cfg.REDIS_URL) throw new Error("SOCKET_ADAPTER=redis / JOB_QUEUE=bullmq require REDIS_URL");
  if (cfg.DATABASE_URL && !/^postgres(ql)?:\/\//.test(cfg.DATABASE_URL)) throw new Error("DATABASE_URL must be a postgres:// URL");
  return {
    ...cfg,
    JWT_SECRET: secret,
    corsOrigins: cfg.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
