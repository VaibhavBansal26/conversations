import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../context.js";
import { clientIp } from "../http.js";
import { ipKey } from "../util/clientIp.js";
import type { Decision } from "./limiter.js";
import { RateLimitedError, overloaded } from "./errors.js";
export { RateLimitedError, overloaded };
import { policyOf } from "./policies.js";
import { EXEMPT, ROUTE_LIMITS, routeKey, type RouteSpec } from "./routePolicies.js";

export const retryAfterSeconds = (d: Decision) => Math.max(1, Math.ceil(d.retryAfterMs / 1000));

export function rateLimitHeaders(d: Decision): Record<string, string> {
  const reset = Math.max(0, Math.ceil(d.resetMs / 1000));
  const h: Record<string, string> = {
    "RateLimit-Policy": `"${d.policy}";q=${d.limit};w=${d.windowSec}`,
    RateLimit: `"${d.policy}";r=${Math.max(0, Math.floor(d.remaining))};t=${reset}`,
    "X-RateLimit-Limit": String(d.limit),
    "X-RateLimit-Remaining": String(Math.max(0, Math.floor(d.remaining))),
    "X-RateLimit-Reset": String(reset),
  };
  if (!d.allowed) h["Retry-After"] = String(retryAfterSeconds(d));
  return h;
}

export function rateLimitBody(d: Decision) {
  return {
    error: {
      code: d.shed ? "OVERLOADED" : "RATE_LIMITED",
      message: d.shed ? "The service is busy, retry shortly" : d.outcome === "blocked" ? "Too many failed attempts, try again later" : "Too many requests",
      retry_after_s: retryAfterSeconds(d),
      policy: d.policy,
    },
  };
}

interface RlState {
  tight?: Decision;
  spec?: RouteSpec;
  ip: string;
  idem?: string;
  write: boolean;
}
const STATE = Symbol("rl");

const tighter = (a: Decision | undefined, b: Decision) => (!a || b.remaining / Math.max(1, b.limit) < a.remaining / Math.max(1, a.limit) ? b : a);

/** the route's declaration, from Hono's matched route (the pattern, e.g. `/api/rooms/:id`, not the concrete path) */
export function specFor(c: Context): { key: string; spec?: RouteSpec; exempt: boolean } {
  const matched = c.req.matchedRoutes.filter((r) => r.method !== "ALL" && r.path !== "/*" && r.path !== "*");
  const last = matched[matched.length - 1];
  const key = routeKey(c.req.method === "HEAD" ? "GET" : c.req.method, last?.path ?? new URL(c.req.url).pathname);
  return { key, spec: ROUTE_LIMITS.get(key), exempt: key in EXEMPT };
}

function keyFor(c: Context, policyId: string, st: RlState, who: { userId?: string; workspaceId?: string; visitorId?: string }): string | null {
  switch (policyOf(policyId).keyBy) {
    case "ip":
      return st.ip;
    case "user":
      return who.userId ?? null;
    case "workspace":
      return who.workspaceId ?? null;
    case "visitor":
      return who.visitorId ?? null;
    case "composite":
      // composite keys that can be computed from headers; body-derived ones are applied in handlers
      if (policyId === "public.session") return `${st.ip}|${c.req.header("origin") ?? ""}|${c.req.header("x-api-key") ?? ""}`;
      return null;
    default:
      return null;
  }
}

async function apply(ctx: AppContext, c: Context, ids: string[], st: RlState, who: { userId?: string; workspaceId?: string; visitorId?: string }, spec: RouteSpec) {
  for (const id of ids) {
    const key = keyFor(c, id, st, who);
    if (key === null) continue;
    const entities = [`ip:${st.ip}`, ...(who.workspaceId ? [`ws:${who.workspaceId}`] : []), ...(who.userId ? [`user:${who.userId}`] : [])];
    const d = await ctx.ratelimit.check(id, { key, workspaceId: policyOf(id).keyBy === "workspace" ? who.workspaceId : undefined }, {
      cost: spec.cost?.[id],
      entities: id === "ip.global" ? entities : undefined,
      idempotencyKey: st.write ? st.idem : undefined,
    });
    st.tight = tighter(st.tight, d);
    if (!d.allowed) throw new RateLimitedError(d);
  }
}

/** Global middleware, mounted first: the IP guard, then every `pre` policy of the matched route. Sets the RateLimit headers on the way out. */
export function rateLimitMiddleware(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    const { spec, exempt } = specFor(c);
    if (exempt) return next();
    const st: RlState = { ip: ipKey(clientIp(ctx, c)), spec, idem: c.req.header("idempotency-key") ?? undefined, write: c.req.method !== "GET" && c.req.method !== "HEAD" };
    (c as unknown as Record<symbol, RlState>)[STATE] = st;
    try {
      await apply(ctx, c, ["ip.global"], st, {}, {});
      await apply(ctx, c, spec?.pre ?? [], st, {}, spec ?? {});
    } catch (e) {
      if (e instanceof RateLimitedError) throw e;
      throw e;
    }
    await next();
    if (st.tight) for (const [k, v] of Object.entries(rateLimitHeaders(st.tight))) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  };
}

/** Called by the auth middlewares once the principal is known: runs the route's `post` policies. */
export async function applyPrincipalLimits(ctx: AppContext, c: Context, who: { userId?: string; workspaceId?: string; visitorId?: string }): Promise<void> {
  const st = (c as unknown as Record<symbol, RlState>)[STATE];
  if (!st?.spec?.post?.length) return;
  await apply(ctx, c, st.spec.post, st, who, st.spec);
}

/** Throws when any of the strike keys is blocked (429 with the remaining block as Retry-After; 503 when the store is down and the policy is fail-closed). */
export async function guardStrikes(ctx: AppContext, keys: { policy: string; key: string }[]): Promise<void> {
  for (const k of keys) {
    const r = await ctx.ratelimit.blockedFor(k.policy, k.key);
    const limit = policyOf(k.policy).limit;
    if (r.unavailable) throw new RateLimitedError({ allowed: false, outcome: "fail_closed", policy: k.policy, limit, windowSec: policyOf(k.policy).windowSec, remaining: 0, retryAfterMs: 2000, resetMs: 0, shed: true });
    if (r.blockedMs > 0) throw new RateLimitedError({ allowed: false, outcome: "blocked", policy: k.policy, limit, windowSec: policyOf(k.policy).windowSec, remaining: 0, retryAfterMs: r.blockedMs, resetMs: r.blockedMs, shed: false });
  }
}

/** Handler-level limit (needs the body or an entity). Throws RateLimitedError. */
export async function enforce(
  ctx: AppContext,
  policyId: string,
  principal: { key: string; workspaceId?: string },
  o: { cost?: number; idempotencyKey?: string } = {},
): Promise<Decision> {
  const d = await ctx.ratelimit.check(policyId, principal, o);
  if (!d.allowed) throw new RateLimitedError(d);
  return d;
}

/** Record a failure against a strike policy and report the block, if any. */
export async function strikeAndThrow(ctx: AppContext, policyId: string, key: string) {
  await ctx.ratelimit.strike(policyId, key);
}
