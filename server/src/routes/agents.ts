import { Hono, type MiddlewareHandler } from "hono";
import type { AppContext } from "../context.js";
import { parseBody, parseQuery, requireLiveSeat, type Env } from "../http.js";
import { AgentBodySchema, AgentPatchSchema, agentDto, createAgent, deleteAgent, getAgent, listAgentRows, updateAgent } from "../agents/config.js";
import { FeedbackBody, listTurns, memberFeedback, TurnQuery, unansweredQuestions, UnansweredQuery } from "../agents/review.js";
import { runSandbox, SandboxBody } from "../agents/sandbox.js";
import { overloaded, RateLimitedError } from "../ratelimit/errors.js";
import { enforce } from "../ratelimit/http.js";
import { AiOutputError, AiUnavailableError } from "../ai/provider.js";
import { AppError } from "../errors.js";

export function agentRoutes(ctx: AppContext) {
  const r = new Hono<Env>();

  r.get("/agents", async (c) => c.json({ data: (await listAgentRows(ctx, c.get("actor").workspaceId)).map(agentDto) }));
  r.post("/agents", async (c) => c.json(agentDto(await createAgent(ctx, c.get("actor"), await parseBody(c, AgentBodySchema))), 201));
  r.get("/agents/turns", async (c) => c.json(await listTurns(ctx, c.get("actor"), parseQuery(c, TurnQuery))));
  r.get("/agents/unanswered", async (c) => c.json(await unansweredQuestions(ctx, c.get("actor"), parseQuery(c, UnansweredQuery))));
  r.get("/agents/:id", async (c) => c.json(agentDto(await getAgent(ctx, c.get("actor").workspaceId, c.req.param("id")))));
  r.patch("/agents/:id", async (c) => c.json(agentDto(await updateAgent(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, AgentPatchSchema)))));
  r.delete("/agents/:id", async (c) => {
    await deleteAgent(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  // the sandbox spends the workspace's AI budget like any other AI call: per user and per minute from the route policy, the daily budget and the concurrency cap here
  const aiLimit: MiddlewareHandler<Env> = async (c, next) => {
    const a = c.get("actor");
    await enforce(ctx, "ai.workspace", { key: a.workspaceId, workspaceId: a.workspaceId });
    await ctx.ratelimit.withLease("ai.concurrency", a.workspaceId, a.workspaceId, next, (x) => {
      throw new RateLimitedError(overloaded("ai.concurrency", x.max));
    });
  };
  r.post("/agents/:id/sandbox", requireLiveSeat, aiLimit, async (c) => {
    const body = await parseBody(c, SandboxBody);
    try {
      return c.json(await runSandbox(ctx, c.get("actor"), c.req.param("id"), body));
    } catch (e) {
      if (e instanceof AiUnavailableError || e instanceof AiOutputError) throw new AppError(503, "AI_UNAVAILABLE", "AI is unavailable right now");
      throw e;
    }
  });

  r.post("/messages/:id/feedback", requireLiveSeat, async (c) => c.json(await memberFeedback(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, FeedbackBody), c.req.query("room_id"))));
  return r;
}
