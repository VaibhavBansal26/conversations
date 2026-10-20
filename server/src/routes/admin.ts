import { Hono, type Context } from "hono";
import { z } from "zod";
import { adminLogin, adminMfaEnable, adminMfaSetup, adminMfaVerify, adminFromToken, requireSuperadmin, type PlatformAdmin } from "../admin/auth.js";
import { ADMIN_ACCESS } from "../admin/access.js";
import { adjustCredits, listAdmins, listWorkspaces, overrideTier, setHomeRegion, platformAudit, platformStats, rateLimitAdd, rateLimitOverview, rateLimitRemove, setAdminDisabled, startImpersonation, suspendWorkspace, unsuspendWorkspace, workspaceDetail } from "../admin/service.js";
import type { AppContext } from "../context.js";
import { AppError, unauthorized } from "../errors.js";
import { clientIp, parseBody, parseQuery } from "../http.js";
import { applyPrincipalLimits, guardStrikes } from "../ratelimit/http.js";
import { specFor } from "../ratelimit/http.js";
import { ipKey } from "../util/clientIp.js";
import { TIERS } from "../ratelimit/types.js";

type AdminEnv = { Variables: { admin: PlatformAdmin } };

export const Login = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });
export const Step = z.object({ mfa_token: z.string().min(20).max(2000) });
export const StepCode = Step.extend({ code: z.string().min(6).max(20) });
export const Reason = z.object({ reason: z.string().max(500).optional() });
export const Credits = z.object({ amount: z.number().int(), note: z.string().max(500).optional() });
export const Tier = z.object({ tier: z.enum(TIERS as [string, ...string[]]).nullable(), note: z.string().max(200).optional() });
export const Region = z.object({ region: z.string().min(2).max(32).nullable() });
export const Impersonate = Reason.extend({ member_id: z.string().max(80).optional() });
export const ListEntry = z.object({ entity: z.string().min(3).max(100), ttl_seconds: z.number().int().min(1).max(30 * 86400), note: z.string().max(200).optional() });
export const WsQuery = z.object({ search: z.string().max(100).optional(), plan: z.string().max(20).optional(), suspended: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(300).optional() });
export const AuditQuery = z.object({ workspace_id: z.string().max(80).optional(), action: z.string().max(60).optional(), actor_type: z.string().max(30).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional() });

/**
 * The platform console API. Everything here authenticates with a PLATFORM admin token (own issuer/audience, mandatory TOTP), never with a
 * workspace token. Reads are open to `support`; every change needs `superadmin` and is written to the append-only audit log.
 */
export function adminRoutes(ctx: AppContext) {
  const r = new Hono<AdminEnv>();
  const ipOf = (c: Context) => ipKey(clientIp(ctx, c));

  r.use("*", async (c, next) => {
    const { key } = specFor(c);
    const access = ADMIN_ACCESS.get(key);
    if (access === undefined) {
      // an unregistered path is a plain 404; a registered one without a declaration is refused
      if (!c.req.matchedRoutes.some((m) => m.method !== "ALL" && m.path !== "/*" && m.path !== "*")) return next();
      throw new AppError(403, "NO_POLICY", "This route has no authorisation policy");
    }
    if (access === "public") return next();
    const h = c.req.header("authorization");
    if (!h?.startsWith("Bearer ")) throw unauthorized();
    const admin = await adminFromToken(ctx, h.slice(7).trim());
    c.set("admin", admin);
    await applyPrincipalLimits(ctx, c, { userId: admin.id });
    if (access === "superadmin") requireSuperadmin(admin);
    await next();
  });

  /* ---- sign-in: password -> TOTP, always. The strikes are keyed so one stolen password cannot be used to guess codes. ---- */
  r.post("/login", async (c) => {
    const body = await parseBody(c, Login);
    const keys = [
      { policy: "admin.fail.account", key: body.email.trim().toLowerCase() },
      { policy: "admin.fail.ip", key: ipOf(c) },
    ];
    await guardStrikes(ctx, keys);
    try {
      const out = await adminLogin(ctx, body);
      await ctx.ratelimit.clearStrikes("admin.fail.account", keys[0]!.key);
      return c.json(out);
    } catch (e) {
      if (e instanceof AppError && e.code === "INVALID_CREDENTIALS") for (const k of keys) await ctx.ratelimit.strike(k.policy, k.key);
      throw e;
    }
  });
  r.post("/mfa/setup", async (c) => c.json(await adminMfaSetup(ctx, (await parseBody(c, Step)).mfa_token)));
  const codeStep = (fn: typeof adminMfaVerify) => async (c: Context) => {
    const b = await parseBody(c, StepCode);
    let who = "unknown";
    try {
      who = (await import("jose")).decodeJwt(b.mfa_token).sub ?? "unknown";
    } catch {
      /* invalid token: rejected below */
    }
    await guardStrikes(ctx, [{ policy: "admin.fail.mfa", key: who }]);
    try {
      return c.json(await fn(ctx, b.mfa_token, b.code));
    } catch (e) {
      if (e instanceof AppError && (e.code === "INVALID_CODE" || e.code === "MFA_TOKEN_INVALID")) await ctx.ratelimit.strike("admin.fail.mfa", who);
      throw e;
    }
  };
  r.post("/mfa/enable", codeStep(adminMfaEnable));
  r.post("/mfa/verify", codeStep(adminMfaVerify));

  /* ---- reads ---- */
  r.get("/me", (c) => c.json({ admin: c.get("admin") }));
  r.get("/stats", async (c) => c.json(await platformStats(ctx)));
  r.get("/workspaces", async (c) => {
    const q = parseQuery(c, WsQuery);
    return c.json(await listWorkspaces(ctx, { search: q.search, plan: q.plan, suspended: q.suspended === undefined ? undefined : q.suspended === "true", limit: q.limit, cursor: q.cursor }));
  });
  r.get("/workspaces/:id", async (c) => c.json(await workspaceDetail(ctx, c.req.param("id"))));
  r.get("/audit", async (c) => c.json(await platformAudit(ctx, parseQuery(c, AuditQuery))));
  r.get("/ratelimit", async (c) => c.json(await rateLimitOverview(ctx)));
  r.get("/admins", async (c) => c.json(await listAdmins(ctx)));

  /* ---- changes (superadmin) ---- */
  r.post("/workspaces/:id/suspend", async (c) => (await suspendWorkspace(ctx, c.get("admin"), c.req.param("id"), (await parseBody(c, Reason)).reason), c.body(null, 204)));
  r.post("/workspaces/:id/unsuspend", async (c) => (await unsuspendWorkspace(ctx, c.get("admin"), c.req.param("id"), (await parseBody(c, Reason)).reason), c.body(null, 204)));
  r.post("/workspaces/:id/credits", async (c) => {
    const b = await parseBody(c, Credits);
    const out = await adjustCredits(ctx, c.get("admin"), c.req.param("id"), { amount: b.amount, note: b.note, idempotencyKey: c.req.header("idempotency-key") ?? undefined });
    return c.json(out, out.applied ? 201 : 200);
  });
  r.put("/workspaces/:id/tier", async (c) => {
    const b = await parseBody(c, Tier);
    await overrideTier(ctx, c.get("admin"), c.req.param("id"), b.tier as never, b.note);
    return c.body(null, 204);
  });
  r.put("/workspaces/:id/region", async (c) => (await setHomeRegion(ctx, c.get("admin"), c.req.param("id"), (await parseBody(c, Region)).region), c.body(null, 204)));
  r.post("/workspaces/:id/impersonate", async (c) => c.json(await startImpersonation(ctx, c.get("admin"), c.req.param("id"), await parseBody(c, Impersonate))));
  const kindOf = (c: Context) => {
    const k = c.req.param("kind");
    if (k !== "allow" && k !== "deny") throw new AppError(404, "NOT_FOUND", "Route not found");
    return k;
  };
  r.post("/ratelimit/:kind", async (c) => {
    const b = await parseBody(c, ListEntry);
    await rateLimitAdd(ctx, c.get("admin"), kindOf(c), b.entity, b.ttl_seconds, b.note);
    return c.body(null, 204);
  });
  r.delete("/ratelimit/:kind/:entity", async (c) => c.json({ removed: await rateLimitRemove(ctx, c.get("admin"), kindOf(c), decodeURIComponent(c.req.param("entity"))) }));
  r.post("/admins/:id/disable", async (c) => (await setAdminDisabled(ctx, c.get("admin"), c.req.param("id"), true), c.body(null, 204)));
  r.post("/admins/:id/enable", async (c) => (await setAdminDisabled(ctx, c.get("admin"), c.req.param("id"), false), c.body(null, 204)));
  return r;
}
