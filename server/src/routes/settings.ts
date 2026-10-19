import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { rateLimit, parseBody, requireLiveSeat, requireManager, type Env } from "../http.js";
import { AiRoomBody, InboundAddressBody, KbBody, RephraseBody, SenderBody, SmsNumberBody, TemplateBody, TemplateRender, TokenBody } from "../schemas.js";
import { suggestReplies, summarizeThread, rephraseDraft } from "../ai/service.js";
import { AiOutputError, AiUnavailableError } from "../ai/provider.js";
import { AppError } from "../errors.js";
import {
  addInboundAddress, addSender, addSmsNumber, createKb, deleteKb, listInboundAddresses, listKb, listSenders, listSmsNumbers, removeInboundAddress, removeSender, removeSmsNumber,
  setSmsDefault, updateKb, updateSender,
} from "../services/settings.js";
import { createTemplate, deleteTemplate, listTemplates, renderTemplate, templateDto, updateTemplate } from "../services/templates.js";
import { createToken, listTokens, revokeToken, rotateToken, tokenDto } from "../services/visitors.js";

const snd = (s: { id: string; address: string; display_name: string; verified: number; is_default: number }) => ({ id: s.id, address: s.address, display_name: s.display_name, verified: !!s.verified, is_default: !!s.is_default });
const num = (n: { id: string; e164: string; label: string; is_default: number }) => ({ id: n.id, e164: n.e164, label: n.label, is_default: !!n.is_default });

/** AI failures never break the app: callers get a clean 503 AI_UNAVAILABLE the UI renders as "AI unavailable". */
async function aiGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiUnavailableError || e instanceof AiOutputError) throw new AppError(503, "AI_UNAVAILABLE", "AI is unavailable right now. You can keep working without it.");
    throw e;
  }
}

export function settingsRoutes(ctx: AppContext) {
  const r = new Hono<Env>();

  r.get("/sms-numbers", (c) => c.json({ data: listSmsNumbers(ctx, c.get("actor").workspaceId).map(num) }));
  r.post("/sms-numbers", async (c) => c.json(num(addSmsNumber(ctx, c.get("actor"), await parseBody(c, SmsNumberBody))), 201));
  r.post("/sms-numbers/:id/default", (c) => {
    setSmsDefault(ctx, c.get("actor"), c.req.param("id"));
    return c.json({ data: listSmsNumbers(ctx, c.get("actor").workspaceId).map(num) });
  });
  r.delete("/sms-numbers/:id", (c) => {
    removeSmsNumber(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/email-senders", (c) => c.json({ data: listSenders(ctx, c.get("actor").workspaceId).map(snd) }));
  r.post("/email-senders", async (c) => c.json(snd(addSender(ctx, c.get("actor"), await parseBody(c, SenderBody))), 201));
  r.patch("/email-senders/:id", async (c) => c.json(snd(updateSender(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, SenderBody.omit({ address: true }).partial())))));
  r.delete("/email-senders/:id", (c) => {
    removeSender(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/inbound-addresses", (c) => c.json({ data: listInboundAddresses(ctx, c.get("actor").workspaceId) }));
  r.post("/inbound-addresses", async (c) => c.json(addInboundAddress(ctx, c.get("actor"), (await parseBody(c, InboundAddressBody)).address), 201));
  r.delete("/inbound-addresses/:address", (c) => {
    removeInboundAddress(ctx, c.get("actor"), decodeURIComponent(c.req.param("address")));
    return c.body(null, 204);
  });

  r.get("/tokens", requireManager, (c) => c.json({ data: listTokens(ctx, c.get("actor").workspaceId).map(tokenDto) }));
  r.post("/tokens", async (c) => c.json(tokenDto(createToken(ctx, c.get("actor"), (await parseBody(c, TokenBody)).domain)), 201));
  r.post("/tokens/:id/rotate", (c) => c.json(tokenDto(rotateToken(ctx, c.get("actor"), c.req.param("id"))), 201));
  r.delete("/tokens/:id", (c) => {
    revokeToken(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/templates", (c) => c.json({ data: listTemplates(ctx, c.get("actor").workspaceId).map(templateDto) }));
  r.post("/templates", async (c) => c.json(templateDto(createTemplate(ctx, c.get("actor"), await parseBody(c, TemplateBody))), 201));
  r.patch("/templates/:id", async (c) => c.json(templateDto(updateTemplate(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, TemplateBody.partial())))));
  r.delete("/templates/:id", (c) => {
    deleteTemplate(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/templates/:id/render", async (c) => c.json(renderTemplate(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, TemplateRender))));

  r.get("/kb", (c) => c.json({ data: listKb(ctx, c.get("actor").workspaceId).map((k) => ({ id: k.id, question: k.question, answer: k.answer, updated_at: k.updated_at })) }));
  r.post("/kb", async (c) => c.json(createKb(ctx, c.get("actor"), await parseBody(c, KbBody)), 201));
  r.put("/kb/:id", async (c) => c.json(updateKb(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, KbBody))));
  r.delete("/kb/:id", (c) => {
    deleteKb(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });

  const aiLimit = rateLimit(ctx, "ai", 20, 0.5, (c) => c.get("actor").memberId);
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

