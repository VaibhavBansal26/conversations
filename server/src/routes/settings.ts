import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { parseBody, requireLiveSeat, requireManager, type Env } from "../http.js";
import { AiRoomBody, InboundAddressBody, KbBody, RephraseBody, SenderBody, SmsNumberBody, TemplateBody, TemplateRender, TokenBody } from "../schemas.js";
import { suggestReplies, summarizeThread, rephraseDraft } from "../ai/service.js";
import { AiOutputError, AiUnavailableError } from "../ai/provider.js";
import type { MiddlewareHandler } from "hono";
import { RateLimitedError, enforce, overloaded } from "../ratelimit/http.js";
import { AppError } from "../errors.js";
import {
  addInboundAddress,
  addSender,
  addSmsNumber,
  createKb,
  deleteKb,
  listInboundAddresses,
  listKb,
  listSenders,
  listSmsNumbers,
  removeInboundAddress,
  removeSender,
  removeSmsNumber,
  setSmsDefault,
  updateKb,
  updateSender,
} from "../services/settings.js";
import { createTemplate, deleteTemplate, listTemplates, renderTemplate, templateDto, updateTemplate } from "../services/templates.js";
import { createToken, listTokens, revokeToken, rotateToken, tokenDto } from "../services/visitors.js";

const snd = (s: { id: string; address: string; display_name: string; verified: number; is_default: number }) => ({
  id: s.id,
  address: s.address,
  display_name: s.display_name,
  verified: !!s.verified,
  is_default: !!s.is_default,
});
const num = (n: { id: string; e164: string; label: string; is_default: number }) => ({ id: n.id, e164: n.e164, label: n.label, is_default: !!n.is_default });

/** AI failures never break the app: callers get a clean 503 AI_UNAVAILABLE the UI renders as "AI unavailable". */
async function aiGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiUnavailableError || e instanceof AiOutputError)
      throw new AppError(503, "AI_UNAVAILABLE", "AI is unavailable right now. You can keep working without it.");
    throw e;
  }
}

export function settingsRoutes(ctx: AppContext) {
  const r = new Hono<Env>();

  r.get("/sms-numbers", async (c) => c.json({ data: (await listSmsNumbers(ctx, c.get("actor").workspaceId)).map(num) }));
  r.post("/sms-numbers", async (c) => c.json(num(await addSmsNumber(ctx, c.get("actor"), await parseBody(c, SmsNumberBody))), 201));
  r.post("/sms-numbers/:id/default", async (c) => {
    await setSmsDefault(ctx, c.get("actor"), c.req.param("id"));
    return c.json({ data: (await listSmsNumbers(ctx, c.get("actor").workspaceId)).map(num) });
  });
  r.delete("/sms-numbers/:id", async (c) => {
    await removeSmsNumber(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/email-senders", async (c) => c.json({ data: (await listSenders(ctx, c.get("actor").workspaceId)).map(snd) }));
  r.post("/email-senders", async (c) => c.json(snd(await addSender(ctx, c.get("actor"), await parseBody(c, SenderBody))), 201));
  r.patch("/email-senders/:id", async (c) =>
    c.json(snd(await updateSender(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, SenderBody.omit({ address: true }).partial())))),
  );
  r.delete("/email-senders/:id", async (c) => {
    await removeSender(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/inbound-addresses", async (c) => c.json({ data: await listInboundAddresses(ctx, c.get("actor").workspaceId) }));
  r.post("/inbound-addresses", async (c) => c.json(await addInboundAddress(ctx, c.get("actor"), (await parseBody(c, InboundAddressBody)).address), 201));
  r.delete("/inbound-addresses/:address", async (c) => {
    await removeInboundAddress(ctx, c.get("actor"), decodeURIComponent(c.req.param("address")));
    return c.body(null, 204);
  });

  r.get("/tokens", requireManager, async (c) => c.json({ data: (await listTokens(ctx, c.get("actor").workspaceId)).map(tokenDto) }));
  r.post("/tokens", async (c) => c.json(tokenDto(await createToken(ctx, c.get("actor"), (await parseBody(c, TokenBody)).domain)), 201));
  r.post("/tokens/:id/rotate", async (c) => c.json(tokenDto(await rotateToken(ctx, c.get("actor"), c.req.param("id"))), 201));
  r.delete("/tokens/:id", async (c) => {
    await revokeToken(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/templates", async (c) => c.json({ data: (await listTemplates(ctx, c.get("actor").workspaceId)).map(templateDto) }));
  r.post("/templates", async (c) => c.json(templateDto(await createTemplate(ctx, c.get("actor"), await parseBody(c, TemplateBody))), 201));
  r.patch("/templates/:id", async (c) => c.json(templateDto(await updateTemplate(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, TemplateBody.partial())))));
  r.delete("/templates/:id", async (c) => {
    await deleteTemplate(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/templates/:id/render", async (c) => c.json(await renderTemplate(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, TemplateRender))));

  r.get("/kb", async (c) =>
    c.json({ data: (await listKb(ctx, c.get("actor").workspaceId)).map((k) => ({ id: k.id, question: k.question, answer: k.answer, updated_at: k.updated_at })) }),
  );
  r.post("/kb", async (c) => c.json(await createKb(ctx, c.get("actor"), await parseBody(c, KbBody)), 201));
  r.put("/kb/:id", async (c) => c.json(await updateKb(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, KbBody))));
  r.delete("/kb/:id", async (c) => {
    await deleteKb(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  // per-user bucket and the generic API layers come from routePolicies.ts; here the per-workspace daily budget and the concurrency cap
  const aiLimit: MiddlewareHandler<Env> = async (c, next) => {
    const a = c.get("actor");
    await enforce(ctx, "ai.workspace", { key: a.workspaceId, workspaceId: a.workspaceId });
    await ctx.ratelimit.withLease("ai.concurrency", a.workspaceId, a.workspaceId, next, (r) => {
      throw new RateLimitedError(overloaded("ai.concurrency", r.max));
    });
  };
  r.get("/ai/status", (c) => c.json({ provider: ctx.ai.name, offline_heuristics: ctx.ai.name === "heuristic" }));
  r.post("/ai/suggest-replies", requireLiveSeat, aiLimit, async (c) => {
    const b = await parseBody(c, AiRoomBody);
    return c.json(await aiGuard(() => suggestReplies(ctx, c.get("actor"), b.room_id)));
  });
  r.post("/ai/summary", requireLiveSeat, aiLimit, async (c) => {
    const b = await parseBody(c, AiRoomBody);
    return c.json(await aiGuard(() => summarizeThread(ctx, c.get("actor"), b.room_id)));
  });
  r.post("/ai/rephrase", requireLiveSeat, aiLimit, async (c) => {
    const b = await parseBody(c, RephraseBody);
    return c.json(await aiGuard(() => rephraseDraft(ctx, c.get("actor"), b)));
  });
  return r;
}
