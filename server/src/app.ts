import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { AppError } from "./errors.js";
import { LocalDiskStorage } from "./providers/storage.js";
import { requireAuth, type Env } from "./http.js";
import { attachmentByKey } from "./services/attachments.js";
import { authRoutes } from "./routes/auth.js";
import { publicRoutes } from "./routes/public.js";
import { roomRoutes } from "./routes/rooms.js";
import { settingsRoutes } from "./routes/settings.js";
import { teamRoutes } from "./routes/team.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { readPublicFile, serveSpa } from "./static.js";

const here = dirname(fileURLToPath(import.meta.url));
// `src/` and `dist/` both sit next to `public/`
const PUBLIC_DIR = resolve(here, "../public");

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|audio\/)/;

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    ctx.log.info("request", { method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms: Date.now() - started });
  });
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false, contentSecurityPolicy: undefined }));

  // team API: explicit allow-list from env. Public widget endpoints: any origin (access is decided by the embed token's domain).
  app.use("/api/*", cors({ origin: ctx.config.corsOrigins, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], maxAge: 600 }));
  app.use("/public/*", cors({ origin: (o) => o, allowHeaders: ["content-type", "x-api-key", "x-device-id", "x-support-session"], allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 600 }));

  const jsonLimit = bodyLimit({ maxSize: ctx.config.BODY_LIMIT_BYTES, onError: (c) => c.json({ error: { code: "BODY_TOO_LARGE", message: "Request body is too large" } }, 413) });
  const uploadLimit = bodyLimit({ maxSize: ctx.config.UPLOAD_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: { code: "FILE_TOO_LARGE", message: "File is too large" } }, 413) });
  app.use("*", (c, next) => (c.req.path === "/api/attachments" ? uploadLimit(c, next) : jsonLimit(c, next)));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => {
    try {
      ctx.db.get("SELECT 1");
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
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
    const meta = attachmentByKey(ctx, key);
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
    return c.body(new Uint8Array(f), 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" });
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
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, err.status as never);
    }
    if (err instanceof ZodError) return c.json({ error: { code: "VALIDATION_ERROR", message: err.issues.map((i) => i.message).join("; ") } }, 400);
    ctx.log.error("unhandled error", { error: err.message, stack: err.stack });
    return c.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, 500);
  });
  return app;
}
