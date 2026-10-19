import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { clientIp } from "../http.js";
import { guardStrikes } from "../ratelimit/http.js";
import { ipKey } from "../util/clientIp.js";
import { handleInboundEmail, handleInboundSms, handleSendgridEvents, handleTwilioStatus, type SendgridEvent } from "../services/inbound.js";
import { requireSendgridEvents, requireSharedSecret, requireTwilio } from "../webhooks/signatures.js";

const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

async function formParams(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

/** Provider webhooks. Authenticated by signature/secret (not by session), rate limited, idempotent on provider ids. */
export function webhookRoutes(ctx: AppContext) {
  const r = new Hono();
  // rate limit and ip guard are applied globally (routePolicies.ts: webhook.provider); here: signature failures escalate into an IP block
  r.use("*", async (c, next) => {
    const key = { policy: "webhook.badsig", key: ipKey(clientIp(ctx, c)) };
    await guardStrikes(ctx, [key]);
    await next();
    // Hono turns a thrown AppError into a response before control returns here, so look at the status
    if (c.res.status === 401 || c.res.status === 403) await ctx.ratelimit.strike(key.policy, key.key);
  });

  r.post("/twilio/sms", async (c) => {
    const p = await formParams(c);
    const url = new URL(c.req.url);
    requireTwilio(ctx, url.pathname + url.search, p, c.req.header("x-twilio-signature"));
    if (!p.From || !p.To || !p.MessageSid) throw badRequest("VALIDATION_ERROR", "From, To and MessageSid are required");
    await handleInboundSms(ctx, { From: p.From, To: p.To, Body: p.Body ?? "", MessageSid: p.MessageSid });
    return c.body(TWIML, 200, { "Content-Type": "text/xml" });
  });

  r.post("/twilio/status", async (c) => {
    const p = await formParams(c);
    const url = new URL(c.req.url);
    requireTwilio(ctx, url.pathname + url.search, p, c.req.header("x-twilio-signature"));
    if (!p.MessageSid || !p.MessageStatus) throw badRequest("VALIDATION_ERROR", "MessageSid and MessageStatus are required");
    await handleTwilioStatus(ctx, { MessageSid: p.MessageSid, MessageStatus: p.MessageStatus, ErrorCode: p.ErrorCode });
    return c.body(null, 204);
  });

  r.post("/sendgrid/inbound", async (c) => {
    requireSharedSecret(ctx, c.req.query("secret") ?? c.req.header("x-webhook-secret"));
    const p = await formParams(c);
    if (!p.from || !p.to) throw badRequest("VALIDATION_ERROR", "from and to are required");
    const res = await handleInboundEmail(ctx, { from: p.from, to: p.to, subject: p.subject, text: p.text, html: p.html, headers: p.headers });
    return c.json(res);
  });

  r.post("/sendgrid/events", async (c) => {
    const raw = await c.req.text();
    await requireSendgridEvents(ctx, raw, {
      signature: c.req.header("x-twilio-email-event-webhook-signature"),
      timestamp: c.req.header("x-twilio-email-event-webhook-timestamp"),
      secret: c.req.query("secret") ?? c.req.header("x-webhook-secret"),
    });
    let events: unknown;
    try {
      events = JSON.parse(raw);
    } catch {
      throw badRequest("INVALID_JSON", "Body must be a JSON array of events");
    }
    if (!Array.isArray(events)) throw badRequest("VALIDATION_ERROR", "Body must be a JSON array of events");
    return c.json(await handleSendgridEvents(ctx, events as SendgridEvent[]));
  });
  return r;
}
