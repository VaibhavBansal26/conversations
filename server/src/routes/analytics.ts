import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parseBody, parseQuery, type Env } from "../http.js";
import { getPepper, overview, parseRange, rotatePepper, setPepper, timeseries, type TimeseriesMetric } from "../services/analytics.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apiKeys.js";

export const Range = z.object({ from: z.string().optional(), to: z.string().optional(), tz: z.string().max(64).optional(), interval: z.string().optional() });
export const PepperBody = z.object({ pepper: z.string().max(512), confirm: z.string().max(512).optional() });
export const KeyBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.string()).min(1).max(5),
  ip_allowlist: z.array(z.string().max(64)).max(50).optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

/** Session-authenticated side of analytics: the in-app dashboard (with agent names), API key management and the identity pepper (aliases; the canonical paths are under /api/v1/analytics). */
export function analyticsRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.get("/analytics/overview", async (c) => c.json(await overview(ctx, c.get("actor").workspaceId, parseRange(ctx, parseQuery(c, Range)), { withNames: true })));
  r.get("/analytics/timeseries", async (c) => {
    const q = parseQuery(c, Range.extend({ metric: z.string() }));
    return c.json(await timeseries(ctx, c.get("actor").workspaceId, q.metric as TimeseriesMetric, parseRange(ctx, q)));
  });
  // Aliases of the documented /api/v1/analytics/identity-pepper routes (same behaviour and response); kept for existing clients.
  r.get("/analytics/identity-pepper", async (c) => c.json(await getPepper(ctx, c.get("actor").workspaceId)));
  r.put("/analytics/identity-pepper", async (c) => c.json(await setPepper(ctx, c.get("actor"), await parseBody(c, PepperBody))));
  r.post("/analytics/identity-pepper/rotate", async (c) => c.json(await rotatePepper(ctx, c.get("actor"))));
  r.get("/v1/api-keys", async (c) => c.json({ data: await listApiKeys(ctx, c.get("actor").workspaceId) }));
  r.post("/v1/api-keys", async (c) => c.json(await createApiKey(ctx, c.get("actor"), await parseBody(c, KeyBody)), 201));
  r.delete("/v1/api-keys/:id", async (c) => {
    await revokeApiKey(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  return r;
}
