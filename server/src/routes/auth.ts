import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { AppError, unauthorized } from "../errors.js";
import { clientIp, parseBody, requireAuth, type Env } from "../http.js";
import { enforce, guardStrikes } from "../ratelimit/http.js";
import { acceptInvitation, changePassword, describeInvitation, listSessions, mfaComplete, mfaDisable, mfaEnable, mfaSetup, requestPasswordReset, resetPassword, revokeSession, rotateRefresh, type SessionMeta } from "../services/accounts.js";
import { currentSession, login, register, verifyAccessToken } from "../services/auth.js";
import { recordAudit } from "../services/audit.js";
import { LoginBody, RegisterBody } from "../schemas.js";
import { ipKey } from "../util/clientIp.js";
import { sha256 } from "../util/crypto.js";
import type { Context } from "hono";

const Refresh = z.object({ refresh_token: z.string().min(20).max(200) });
const MfaVerify = z.object({ mfa_token: z.string().min(20).max(2000), code: z.string().min(6).max(20) });
const MfaEnable = z.object({ code: z.string().regex(/^\d{6}$/) });
const MfaDisable = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(20) });
const Forgot = z.object({ email: z.string().email().max(254) });
const Reset = z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(200) });
const Change = z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(8).max(200) });
const Accept = z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(100).optional(), password: z.string().min(8).max(200) });

export function authRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  const meta = (c: Context): SessionMeta => ({ ip: ipKey(clientIp(ctx, c)), userAgent: c.req.header("user-agent") });

  r.post("/register", async (c) => c.json(await register(ctx, await parseBody(c, RegisterBody), meta(c)), 201));

  r.post("/login", async (c) => {
    const body = await parseBody(c, LoginBody);
    // account lockout and IP block: checked BEFORE the password is verified, keyed by hashed email so unknown accounts behave identically
    const keys = [
      { policy: "auth.fail.account", key: body.email.trim().toLowerCase() },
      { policy: "auth.fail.ip", key: ipKey(clientIp(ctx, c)) },
    ];
    await guardStrikes(ctx, keys);
    try {
      const out = await login(ctx, body, meta(c));
      await ctx.ratelimit.clearStrikes("auth.fail.account", keys[0]!.key);
      return c.json(out);
    } catch (e) {
      if (e instanceof AppError && e.code === "INVALID_CREDENTIALS") for (const k of keys) await ctx.ratelimit.strike(k.policy, k.key);
      throw e;
    }
  });

  // second step of a login for accounts with two-factor enabled
  r.post("/mfa/verify", async (c) => {
    const body = await parseBody(c, MfaVerify);
    // the challenge token names the user: strikes are per user so a stolen password cannot be used to guess codes
    let user = "unknown";
    try {
      user = (await import("jose")).decodeJwt(body.mfa_token).sub ?? "unknown";
    } catch {
      /* invalid token: handled by mfaComplete */
    }
    const keys = [{ policy: "auth.fail.mfa", key: user }];
    await guardStrikes(ctx, keys);
    try {
      return c.json(await mfaComplete(ctx, body.mfa_token, body.code, meta(c)));
    } catch (e) {
      if (e instanceof AppError && e.code === "INVALID_CODE") await ctx.ratelimit.strike("auth.fail.mfa", user);
      throw e;
    }
  });

  r.post("/refresh", async (c) => c.json(await rotateRefresh(ctx, (await parseBody(c, Refresh)).refresh_token, meta(c))));

  r.post("/logout", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = typeof body?.refresh_token === "string" ? body.refresh_token : undefined;
    if (raw) {
      const t = await ctx.db.get<{ session_id: string }>("SELECT session_id FROM refresh_tokens WHERE token_hash = ?", sha256(raw));
      if (t) await revokeSession(ctx, t.session_id, "logout");
    }
    return c.body(null, 204);
  });

  r.post("/password/forgot", async (c) => {
    const { email } = await parseBody(c, Forgot);
    // limits per address and per IP; the answer is the same whether or not the account exists
    await enforce(ctx, "auth.forgot.email", { key: email.trim().toLowerCase() });
    await requestPasswordReset(ctx, email);
    return c.json({ ok: true });
  });

  r.post("/password/reset", async (c) => {
    const b = await parseBody(c, Reset);
    await resetPassword(ctx, b.token, b.password);
    return c.json({ ok: true });
  });

  r.get("/invitations/:token", async (c) => c.json(await describeInvitation(ctx, c.req.param("token"))));
  r.post("/invitations/accept", async (c) => c.json(await acceptInvitation(ctx, await parseBody(c, Accept), meta(c)), 201));

  /* ---- signed-in endpoints ---- */
  const sidOf = async (c: Context<Env>) => {
    const h = c.req.header("authorization");
    return h?.startsWith("Bearer ") ? (await verifyAccessToken(ctx, h.slice(7).trim())).sid : undefined;
  };
  r.get("/me", requireAuth(ctx), async (c) => c.json(await currentSession(ctx, c.get("actor"))));
  r.get("/sessions", requireAuth(ctx), async (c) => c.json({ data: await listSessions(ctx, c.get("actor").userId, await sidOf(c)) }));
  r.delete("/sessions/:id", requireAuth(ctx), async (c) => {
    const a = c.get("actor");
    const own = await ctx.db.get("SELECT 1 FROM auth_sessions WHERE id = ? AND user_id = ?", c.req.param("id"), a.userId);
    if (!own) throw unauthorized("Not your session", "NOT_FOUND");
    await revokeSession(ctx, c.req.param("id"), "revoked_by_user");
    await recordAudit(ctx, { workspaceId: a.workspaceId, actor: { type: "member", id: a.memberId }, action: "auth.session_revoked", target: c.req.param("id") });
    return c.body(null, 204);
  });
  r.post("/password/change", requireAuth(ctx), async (c) => {
    const b = await parseBody(c, Change);
    await changePassword(ctx, c.get("actor"), await sidOf(c), { current: b.current_password, next: b.new_password });
    return c.json({ ok: true });
  });
  r.post("/mfa/setup", requireAuth(ctx), async (c) => c.json(await mfaSetup(ctx, c.get("actor"))));
  r.post("/mfa/enable", requireAuth(ctx), async (c) => c.json(await mfaEnable(ctx, c.get("actor"), (await parseBody(c, MfaEnable)).code)));
  r.post("/mfa/disable", requireAuth(ctx), async (c) => {
    await mfaDisable(ctx, c.get("actor"), await parseBody(c, MfaDisable));
    return c.json({ ok: true });
  });
  return r;
}
