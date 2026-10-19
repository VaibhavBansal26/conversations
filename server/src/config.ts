import { randomBytes } from "node:crypto";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_PATH: z.string().default("./data/conversations.db"),
  DATA_DIR: z.string().default("./data"),
  WEB_DIST: z.string().optional(),
  JWT_SECRET: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 12),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  TRUST_PROXY: bool.default(false),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1024 * 1024),

  SOCKET_ADAPTER: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().optional(),
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
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  SYSTEM_EMAIL_FROM: z.string().default("notifications@conversations.local"),
  CREDIT_COST_SMS: z.coerce.number().int().min(0).default(1),
  CREDIT_COST_EMAIL: z.coerce.number().int().min(0).default(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  SCHEDULER_ENABLED: bool.default(true),
  SEND_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SEND_RETRY_BASE_SECONDS: z.coerce.number().positive().default(30),
  SEND_RETRY_CAP_SECONDS: z.coerce.number().positive().default(3600),
  DIGEST_MIN_AGE_MINUTES: z.coerce.number().positive().default(2),
  DIGEST_MAX_AGE_MINUTES: z.coerce.number().positive().default(60),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type Config = Omit<z.infer<typeof schema>, "JWT_SECRET"> & {
  JWT_SECRET: string;
  corsOrigins: string[];
};

export function loadConfig(env: Record<string, string | undefined> = process.env, warn: (m: string) => void = console.warn): Config {
  const parsed = schema.safeParse(env);
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
  if (cfg.SMS_PROVIDER === "twilio" && !(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN)) {
    throw new Error("SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
  }
  if (cfg.EMAIL_PROVIDER === "sendgrid" && !cfg.SENDGRID_API_KEY) {
    throw new Error("EMAIL_PROVIDER=sendgrid requires SENDGRID_API_KEY");
  }
  if (cfg.SOCKET_ADAPTER === "redis" && !cfg.REDIS_URL) throw new Error("SOCKET_ADAPTER=redis requires REDIS_URL");
  return {
    ...cfg,
    JWT_SECRET: secret,
    corsOrigins: cfg.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  };
}
