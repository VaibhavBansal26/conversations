import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { z } from "zod";
import type { AppContext } from "./context.js";
import type { Actor } from "./domain/types.js";
import { AppError, badRequest, forbidden, tooMany, unauthorized } from "./errors.js";
import { actorFromToken } from "./services/auth.js";
import { RateLimiter } from "./util/ratelimit.js";

export interface Env {
  Variables: { actor: Actor };
}

export function clientIp(ctx: AppContext, c: Context): string {
  if (ctx.config.TRUST_PROXY) {
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The caller's address, or null when it cannot be determined (never a shared placeholder that could "match"). */
export function knownIp(ctx: AppContext, c: Context): string | null {
  const ip = clientIp(ctx, c);
  return ip === "unknown" ? null : ip;
}

/** Parse + validate a JSON body. Bad JSON and schema failures are 400s with a readable message. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("INVALID_JSON", "Request body must be valid JSON");
  }
  return validate(schema, raw);
}

export function validate<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw badRequest("VALIDATION_ERROR", issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "), issues);
  }
  return r.data;
}

export const parseQuery = <S extends z.ZodType>(c: Context, schema: S): z.infer<S> => validate(schema, c.req.query());

/** Token-bucket limiter middleware. `key` defaults to the client IP. */
export function rateLimit(ctx: AppContext, name: string, capacity: number, perSecond: number, key?: (c: Context) => string): MiddlewareHandler {
  let limiter = ctx.limiters.get(name);
  if (!limiter) {
    limiter = new RateLimiter(capacity, perSecond, () => ctx.clock().getTime());
    ctx.limiters.set(name, limiter);
  }
  const l = limiter;
  return async (c, next) => {
    if (!l.take(key ? key(c) : clientIp(ctx, c))) {
      c.header("Retry-After", String(Math.ceil(1 / perSecond)));
      throw tooMany();
    }
    await next();
  };
}

/** Bearer JWT -> live seat. The seat (role, flags) is always read from the database. */
export function requireAuth(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    const h = c.req.header("authorization");
    const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
    if (!token) throw unauthorized();
    c.set("actor", await actorFromToken(ctx, token));
    await next();
  };
}

/** Inbox features need a live seat (owners always have one). */
export const requireLiveSeat: MiddlewareHandler<Env> = async (c, next) => {
  const a = c.get("actor");
  if (!a.liveSeat && a.role !== "owner") throw forbidden("Your seat is not enabled for conversations", "NO_LIVE_SEAT");
  await next();
};

export const requireManager: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get("actor").role === "agent") throw forbidden("Managers only");
  await next();
};

export { AppError };
