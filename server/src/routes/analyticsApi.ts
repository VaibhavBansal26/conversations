import { Hono, type Context } from "hono";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { SCHEMAS, SCHEMA_VERSION } from "../analytics/schemas.js";
import type { AppContext } from "../context.js";
import { AppError, forbidden, notFound } from "../errors.js";
import { clientIp, parseQuery } from "../http.js";
import { RateLimitedError, applyPrincipalLimits, overloaded } from "../ratelimit/http.js";
import { authenticateApiKey, type AuthenticatedKey } from "../services/apiKeys.js";
import { EXPORT_MAX_LIMIT, TIMESERIES_METRICS, exportMessagesMeta, exportRooms, getPepper, overview, parseRange, timeseries } from "../services/analytics.js";
import { ipKey } from "../util/clientIp.js";

type KeyEnv = { Variables: { apiKey: AuthenticatedKey } };

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
};

/**
 * Workspace-scoped analytics API (contract: analysis/ANALYTICS-CONTRACT.md). Authenticates with `Authorization: Bearer ca_live_...`, not with a
 * user session: every response is scoped to the key's workspace, and a key from another workspace sees nothing of this one.
 */
export function analyticsApiRoutes(ctx: AppContext) {
  const r = new Hono<KeyEnv>();

  r.use("*", async (c, next) => {
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

  r.get("/identity-pepper", async (c) => {
    const k = c.get("apiKey");
    if (!k.scopes.includes("analytics_identity:manage")) throw forbidden("This key lacks the analytics_identity:manage scope", "INSUFFICIENT_SCOPE");
    const p = await getPepper(ctx, k.workspaceId);
    return c.json({ pepper: p.pepper, version: p.version, algorithm: "contact_key = hex(HMAC-SHA256(pepper, lower(trim(email))))" });
  });

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
