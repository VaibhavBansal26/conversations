import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { timeout } from "hono/timeout";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { AppError } from "./errors.js";
import { RateLimitedError, rateLimitBody, rateLimitHeaders, rateLimitMiddleware } from "./ratelimit/http.js";
import { LocalDiskStorage } from "./providers/storage.js";
import { requireAuth, type Env } from "./http.js";
import { attachmentByKey } from "./services/attachments.js";
import { authRoutes } from "./routes/auth.js";
import { publicRoutes } from "./routes/public.js";
import { roomRoutes } from "./routes/rooms.js";
import { settingsRoutes } from "./routes/settings.js";
import { teamRoutes } from "./routes/team.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { compressed, readPublicFile, serveSpa } from "./static.js";

const here = dirname(fileURLToPath(import.meta.url));
// `src/` and `dist/` both sit next to `public/`
const PUBLIC_DIR = resolve(here, "../public");

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|audio\/)/;

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  // request id (client-supplied ids are accepted when sane so traces join up across a proxy), access log and latency histogram
  app.use("*", async (c, next) => {
    const supplied = c.req.header("x-request-id");
    const rid = supplied && /^[\w.-]{8,64}$/.test(supplied) ? supplied : randomUUID();
    c.header("x-request-id", rid);
    const started = process.hrtime.bigint();
    await next();
    const sec = Number(process.hrtime.bigint() - started) / 1e9;
    const path = new URL(c.req.url).pathname;
    if (path !== "/metrics" && path !== "/healthz") {
      ctx.metrics.http.observe({ method: c.req.method, route: c.req.routePath === "/*" ? "unmatched" : c.req.routePath, status: String(c.res.status) }, sec);
      ctx.log.info("request", { request_id: rid, node: ctx.nodeId, method: c.req.method, path, status: c.res.status, ms: Math.round(sec * 1000) });
    }
  });
  app.use("*", rateLimitMiddleware(ctx));
  app.use("/api/*", compress({ threshold: 1024 }));
  app.use("/api/*", timeout(ctx.config.REQUEST_TIMEOUT_MS, () => new HTTPException(504, { message: "Request timed out" })));
  app.use("/public/*", timeout(ctx.config.REQUEST_TIMEOUT_MS, () => new HTTPException(504, { message: "Request timed out" })));
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false, contentSecurityPolicy: undefined }));

  // team API: explicit allow-list from env. Public widget endpoints: any origin (access is decided by the embed token's domain).
  app.use(
    "/api/*",
    cors({
      origin: ctx.config.corsOrigins,
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use(
    "/public/*",
    cors({ origin: (o) => o, allowHeaders: ["content-type", "x-api-key", "x-device-id", "x-support-session"], allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 600 }),
  );

  const jsonLimit = bodyLimit({
    maxSize: ctx.config.BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: { code: "BODY_TOO_LARGE", message: "Request body is too large" } }, 413),
  });
  const uploadLimit = bodyLimit({
    maxSize: ctx.config.UPLOAD_MAX_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: { code: "FILE_TOO_LARGE", message: "File is too large" } }, 413),
  });
  app.use("*", async (c, next) => (c.req.path === "/api/attachments" ? await uploadLimit(c, next) : await jsonLimit(c, next)));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // readiness reflects every dependency this node needs, and flips to 503 while draining so load balancers stop sending traffic
  app.get("/readyz", async (c) => {
    const checks: Record<string, boolean> = { draining: !ctx.state.draining };
    checks.database = await ctx.db.get("SELECT 1").then(() => true, () => false);
    if (ctx.redis) checks.redis = await ctx.redis.ping();
    const ok = Object.values(checks).every(Boolean);
    return c.json({ status: ok ? "ready" : "unavailable", node: ctx.nodeId, checks }, ok ? 200 : 503);
  });
  app.get("/metrics", async (c) => {
    const want = ctx.config.METRICS_TOKEN;
    if (want && c.req.header("authorization") !== `Bearer ${want}`) return c.json({ error: { code: "UNAUTHORIZED", message: "Metrics token required" } }, 401);
    return c.text(await ctx.metrics.render(ctx), 200, { "Content-Type": ctx.metrics.registry.contentType });
  });

  app.route("/api/auth", authRoutes(ctx));
  const api = new Hono<Env>();
  api.use("*", requireAuth(ctx));
  api.route("/", teamRoutes(ctx));
  api.route("/", roomRoutes(ctx));
  api.route("/", settingsRoutes(ctx));
  app.route("/api", api);

  app.route("/public", publicRoutes(ctx));
  app.route("/webhooks", webhookRoutes(ctx));

  app.get("/files/*", async (c) => {
    const key = new URL(c.req.url).pathname.slice("/files/".length);
    const q = c.req.query();
    const storage = ctx.storage;
    if (!(storage instanceof LocalDiskStorage) || !storage.verify(key, Number(q.exp), q.sig ?? "")) {
      return c.json({ error: { code: "INVALID_SIGNATURE", message: "Link is invalid or has expired" } }, 403);
    }
    const meta = await attachmentByKey(ctx, key);
    const data = await storage.read(key);
    if (!meta || !data) return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    const safeName = encodeURIComponent(meta.file_name);
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": meta.content_type,
      "Content-Disposition": `${INLINE_TYPES.test(meta.content_type) ? "inline" : "attachment"}; filename*=UTF-8''${safeName}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=300",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
  });

  app.get("/widget.js", (c) => {
    const f = readPublicFile(PUBLIC_DIR, "widget.js");
    if (!f) return c.notFound();
    // short max-age plus revalidation: an embed on a customer's site picks up a widget fix within minutes, and a 304 costs ~nothing
    return compressed(c.req.header("accept-encoding"), c.req.header("if-none-match"), f, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    }, "widget.js");
  });
  app.get("/widget-demo.html", (c) => {
    const f = readPublicFile(PUBLIC_DIR, "widget-demo.html");
    return f ? c.body(new Uint8Array(f), 200, { "Content-Type": "text/html; charset=utf-8" }) : c.notFound();
  });

  const webDist = ctx.config.WEB_DIST ?? resolve(here, "../../web/dist");
  if (existsSync(webDist)) {
    app.get("*", (c) => {
      const p = new URL(c.req.url).pathname;
      if (p.startsWith("/api/") || p.startsWith("/public/") || p.startsWith("/webhooks/") || p.startsWith("/socket.io")) return c.notFound();
      return serveSpa(webDist, c) ?? c.notFound();
    });
  }

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: { code: err.status === 504 ? "REQUEST_TIMEOUT" : "HTTP_ERROR", message: err.message } }, err.status);
    if (err instanceof RateLimitedError) {
      ctx.metrics.rateLimited.inc({ scope: "http" });
      return c.json(rateLimitBody(err.decision), err.status as never, rateLimitHeaders(err.decision));
    }
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, err.status as never);
    }
    if (err instanceof ZodError) return c.json({ error: { code: "VALIDATION_ERROR", message: err.issues.map((i) => i.message).join("; ") } }, 400);
    ctx.log.error("unhandled error", { error: err.message, stack: err.stack });
    return c.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, 500);
  });
  return app;
}
