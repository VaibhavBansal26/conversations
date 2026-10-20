import { Hono, type Context } from "hono";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { SCHEMAS, SCHEMA_VERSION } from "../analytics/schemas.js";
import type { AppContext } from "../context.js";
import { PermissionDenied } from "../authz/http.js";
import { can } from "../authz/permissions.js";
import type { Actor } from "../domain/types.js";
import { AppError, forbidden, notFound, unauthorized } from "../errors.js";
import { clientIp, parseBody, parseQuery } from "../http.js";
import { PepperBody } from "./analytics.js";
import { actorFromToken } from "../services/auth.js";
import { RateLimitedError, applyPrincipalLimits, overloaded } from "../ratelimit/http.js";
import { authenticateApiKey, type AuthenticatedKey } from "../services/apiKeys.js";
import { EXPORT_MAX_LIMIT, TIMESERIES_METRICS, exportMessagesMeta, exportRooms, getPepper, overview, parseRange, rotatePepper, setPepper, timeseries } from "../services/analytics.js";
import { ipKey } from "../util/clientIp.js";

type KeyEnv = { Variables: { apiKey: AuthenticatedKey; actor?: Actor } };

export const Range = z.object({ from: z.string().optional(), to: z.string().optional(), tz: z.string().max(64).optional(), interval: z.string().optional() });
export const ExportQ = Range.extend({ limit: z.coerce.number().int().min(1).max(EXPORT_MAX_LIMIT).default(1000), cursor: z.string().max(500).optional() });
export const TsQ = Range.extend({ metric: z.string() });

/** Which scope each route needs. A test requires every route registered below to be listed. */
export const KEY_SCOPES: Record<string, string> = {
  "GET /api/v1/analytics/overview": "analytics:read",
  "GET /api/v1/analytics/timeseries": "analytics:read",
  "GET /api/v1/analytics/schema": "analytics:read",
  "GET /api/v1/analytics/export/rooms": "analytics:export",
  "GET /api/v1/analytics/export/messages-meta": "analytics:export",
  "GET /api/v1/analytics/identity-pepper": "analytics:export",
  "PUT /api/v1/analytics/identity-pepper": "analytics:export",
  "POST /api/v1/analytics/identity-pepper/rotate": "analytics:export",
};

/**
 * Workspace-scoped analytics API (contract: analysis/ANALYTICS-CONTRACT.md). Authenticates with `Authorization: Bearer ca_live_...`, not with a
 * user session: every response is scoped to the key's workspace, and a key from another workspace sees nothing of this one.
 */
export function analyticsApiRoutes(ctx: AppContext) {
  const r = new Hono<KeyEnv>();

  r.use("*", async (c, next) => {
    // The identity-pepper routes take EITHER a user session (permissions analytics_identity:manage + analytics:export) OR an API key; every other route is key-only.
    if (/^\/api\/v1\/analytics\/identity-pepper(\/rotate)?$/.test(c.req.path) && !/^Bearer\s+ca_/.test(c.req.header("authorization") ?? "")) {
      const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/)?.[1];
      if (!token) throw unauthorized("A user session or an API key is required");
      const actor = await actorFromToken(ctx, token);
      for (const p of ["analytics_identity:manage", "analytics:export"] as const) if (!can(actor, p)) throw new PermissionDenied(p);
      if (actor.impersonatedBy && c.req.method !== "GET") throw new AppError(403, "IMPERSONATION_READ_ONLY", "Support access is read-only");
      c.set("actor", actor);
      await applyPrincipalLimits(ctx, c as unknown as Context, { userId: actor.memberId, workspaceId: actor.workspaceId });
      return next();
    }
    const key = await authenticateApiKey(ctx, c.req.header("authorization"), clientIp(ctx, c) === "unknown" ? null : clientIp(ctx, c));
    c.set("apiKey", key);
    const handler = c.req.matchedRoutes.filter((m) => m.method !== "ALL" && !m.path.endsWith("*")).at(-1);
    const need = KEY_SCOPES[`${c.req.method} ${handler?.path ?? ""}`];
    if (need && !key.scopes.includes(need)) throw forbidden(`This key lacks the ${need} scope`, "INSUFFICIENT_SCOPE");
    await applyPrincipalLimits(ctx, c as unknown as Context, { apiKeyId: key.id, workspaceId: key.workspaceId });
    await next();
  });

  r.get("/overview", async (c) => c.json(await overview(ctx, c.get("apiKey").workspaceId, parseRange(ctx, parseQuery(c, Range)))));

  r.get("/timeseries", async (c) => {
    const q = parseQuery(c, TsQ);
    return c.json(await timeseries(ctx, c.get("apiKey").workspaceId, q.metric as (typeof TIMESERIES_METRICS)[number], parseRange(ctx, q)));
  });

  r.get("/schema", (c) => c.json({ schema_version: SCHEMA_VERSION, schemas: SCHEMAS }));

  /** Who is calling the pepper routes: a session (full access) or an API key (read only, with both scopes). */
  const pepperCaller = (c: Context<KeyEnv>, write: boolean): { workspaceId: string; actor: Actor | null } => {
    const actor = c.get("actor");
    if (actor) return { workspaceId: actor.workspaceId, actor };
    const k = c.get("apiKey");
    for (const need of ["analytics:export", "analytics_identity:manage"]) if (!k.scopes.includes(need)) throw forbidden(`This key lacks the ${need} scope`, "INSUFFICIENT_SCOPE");
    if (write) throw forbidden("Changing the identity pepper needs a user session, not an API key", "SESSION_REQUIRED");
    return { workspaceId: k.workspaceId, actor: null };
  };
  r.get("/identity-pepper", async (c) => c.json(await getPepper(ctx, pepperCaller(c, false).workspaceId)));
  r.put("/identity-pepper", async (c) => c.json(await setPepper(ctx, pepperCaller(c, true).actor!, await parseBody(c as unknown as Context, PepperBody))));
  r.post("/identity-pepper/rotate", async (c) => c.json(await rotatePepper(ctx, pepperCaller(c, true).actor!)));

  /**
   * NDJSON export. The page is read first (so `X-Next-Cursor` can be a response header), then streamed one JSON object per line; gzip when the
   * client accepts it. Resume by passing the header's value as `cursor`. Concurrency per key is capped; a full cap is 503 with Retry-After.
   */
  const exporter = <T>(fetchPage: (workspaceId: string, q: z.infer<typeof ExportQ>) => Promise<{ rows: T[]; next_cursor: string | null }>) => async (c: Context<KeyEnv>) => {
    const key = c.get("apiKey");
    const q = parseQuery(c, ExportQ);
    const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const lease = await ctx.ratelimit.acquire("analytics.concurrency", key.id, id, key.workspaceId);
    if (!lease.ok) throw new RateLimitedError(overloaded("analytics.concurrency", lease.max));
    try {
      const page = await fetchPage(key.workspaceId, q);
      const body = page.rows.map((x) => JSON.stringify(x)).join("\n") + (page.rows.length ? "\n" : "");
      const headers: Record<string, string> = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Row-Count": String(page.rows.length) };
      if (page.next_cursor) headers["X-Next-Cursor"] = page.next_cursor;
      const gz = /\bgzip\b/.test(c.req.header("accept-encoding") ?? "") && body.length > 1024;
      if (gz) {
        headers["Content-Encoding"] = "gzip";
        headers.Vary = "Accept-Encoding";
      }
      return new Response(gz ? new Uint8Array(gzipSync(body)) : body, { headers });
    } finally {
      await ctx.ratelimit.release("analytics.concurrency", key.id, id);
    }
  };
  r.get("/export/rooms", exporter((ws, q) => exportRooms(ctx, ws, parseRange(ctx, q), { cursor: q.cursor, limit: q.limit })));
  r.get("/export/messages-meta", exporter((ws, q) => exportMessagesMeta(ctx, ws, parseRange(ctx, q), { cursor: q.cursor, limit: q.limit })));

  r.all("*", () => {
    throw notFound("Endpoint");
  });
  return r;
}

export { AppError, ipKey };
