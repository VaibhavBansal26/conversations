import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { parseBody, rateLimit, requireAuth, type Env } from "../http.js";
import { currentSession, login, register } from "../services/auth.js";
import { LoginBody, RegisterBody } from "../schemas.js";

export function authRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.post("/register", rateLimit(ctx, "auth", 10, 10 / 60), async (c) => c.json(await register(ctx, await parseBody(c, RegisterBody)), 201));
  r.post("/login", rateLimit(ctx, "auth", 10, 10 / 60), async (c) => c.json(await login(ctx, await parseBody(c, LoginBody))));
  r.get("/me", requireAuth(ctx), async (c) => c.json(await currentSession(ctx, c.get("actor"))));
  return r;
}
