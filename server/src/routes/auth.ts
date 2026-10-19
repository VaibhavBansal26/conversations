import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { clientIp, parseBody, requireAuth, type Env } from "../http.js";
import { guardStrikes } from "../ratelimit/http.js";
import { currentSession, login, register } from "../services/auth.js";
import { LoginBody, RegisterBody } from "../schemas.js";
import { ipKey } from "../util/clientIp.js";

export function authRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.post("/register", async (c) => c.json(await register(ctx, await parseBody(c, RegisterBody)), 201));
  r.post("/login", async (c) => {
    const body = await parseBody(c, LoginBody);
    // account lockout and IP block: checked BEFORE the password is verified, keyed by hashed email so unknown accounts behave identically
    const keys = [
      { policy: "auth.fail.account", key: body.email.trim().toLowerCase() },
      { policy: "auth.fail.ip", key: ipKey(clientIp(ctx, c)) },
    ];
    await guardStrikes(ctx, keys);
    try {
      const out = await login(ctx, body);
      await ctx.ratelimit.clearStrikes("auth.fail.account", keys[0]!.key);
      return c.json(out);
    } catch (e) {
      if (e instanceof AppError && e.code === "INVALID_CREDENTIALS") for (const k of keys) await ctx.ratelimit.strike(k.policy, k.key);
      throw e;
    }
  });
  r.get("/me", requireAuth(ctx), async (c) => c.json(await currentSession(ctx, c.get("actor"))));
  return r;
}
