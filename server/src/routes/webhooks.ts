import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { clientIp } from "../http.js";
import { guardStrikes } from "../ratelimit/http.js";
import { ipKey } from "../util/clientIp.js";
import { handleInboundEmail, handleInboundSms, handleSendgridEvents, handleTwilioStatus, type SendgridEvent } from "../services/inbound.js";
import { handleStripeEvent } from "../billing/webhooks.js";
import { claimEvent, requireSendgridEvents, requireSharedSecret, requireTwilio, verifySendgridSignature, verifyTwilioSignature } from "../webhooks/signatures.js";
import { enforce } from "../ratelimit/http.js";
import { openCredentials, type ConnectionRow, type TwilioCredentials } from "../providers/registry.js";
import { voiceConnect, voiceStatus } from "../calls/phone.js";
import { recordChannelEvent } from "../services/channelConnections.js";
import { safeEqual, sha256 } from "../util/crypto.js";
import { parseJson } from "../util/json.js";
import { unauthorized } from "../errors.js";

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

  /*
   * Per-workspace webhooks: /webhooks/c/<webhook id>/... . The id selects the workspace's connection, and the request is verified with THAT
   * connection's credentials (Twilio: the workspace's own auth token; SendGrid: the connection's secret, or its event-webhook public key).
   * Unknown ids and bad proofs answer the same 401, so ids cannot be probed, and every proof failure counts toward the IP block above.
   */
  const connection = async (c: Context, provider: "twilio" | "sendgrid"): Promise<ConnectionRow> => {
    const row = await ctx.db.get<ConnectionRow>("SELECT * FROM channel_connections WHERE webhook_id = ?", c.req.param("id") ?? "");
    if (!row || row.provider !== provider) throw unauthorized("Invalid webhook signature", "INVALID_SIGNATURE");
    await enforce(ctx, "webhook.connection", { key: row.webhook_id });
    return row;
  };
  const reject = async (row: ConnectionRow, kind: string, why: string): Promise<never> => {
    await recordChannelEvent(ctx, row.workspace_id, row.channel, kind, "rejected", why).catch(() => {});
    throw unauthorized("Invalid webhook signature", "INVALID_SIGNATURE");
  };
  const secretOk = (row: ConnectionRow, provided: string | undefined) => !!provided && safeEqual(sha256(provided), row.webhook_secret_hash);

  r.post("/c/:id/twilio/sms", async (c) => {
    const row = await connection(c, "twilio");
    const p = await formParams(c);
    const url = new URL(c.req.url);
    const creds = openCredentials<TwilioCredentials>(ctx, row);
    if (!verifyTwilioSignature(creds.auth_token, ctx.config.PUBLIC_URL.replace(/\/$/, "") + url.pathname + url.search, p, c.req.header("x-twilio-signature"))) await reject(row, "twilio_sms", "signature does not match this workspace's auth token");
    if (!p.From || !p.To || !p.MessageSid) throw badRequest("VALIDATION_ERROR", "From, To and MessageSid are required");
    const res = await handleInboundSms(ctx, { From: p.From, To: p.To, Body: p.Body ?? "", MessageSid: p.MessageSid }, { workspaceId: row.workspace_id });
    await recordChannelEvent(ctx, row.workspace_id, "sms", "twilio_sms", res.status === "processed" ? "processed" : res.status === "duplicate" ? "duplicate" : "ignored", res.status === "ignored" ? "the To number is not registered in this workspace, or the text was empty" : null);
    return c.body(TWIML, 200, { "Content-Type": "text/xml" });
  });

  r.post("/c/:id/twilio/status", async (c) => {
    const row = await connection(c, "twilio");
    const p = await formParams(c);
    const url = new URL(c.req.url);
    const creds = openCredentials<TwilioCredentials>(ctx, row);
    if (!verifyTwilioSignature(creds.auth_token, ctx.config.PUBLIC_URL.replace(/\/$/, "") + url.pathname + url.search, p, c.req.header("x-twilio-signature"))) await reject(row, "twilio_status", "signature does not match this workspace's auth token");
    if (!p.MessageSid || !p.MessageStatus) throw badRequest("VALIDATION_ERROR", "MessageSid and MessageStatus are required");
    const res = await handleTwilioStatus(ctx, { MessageSid: p.MessageSid, MessageStatus: p.MessageStatus, ErrorCode: p.ErrorCode }, { workspaceId: row.workspace_id });
    await recordChannelEvent(ctx, row.workspace_id, "sms", "twilio_status", res === "updated" ? "processed" : res, `${p.MessageStatus}`);
    return c.body(null, 204);
  });

  // phone calls (click-to-call): the agent's leg asks for instructions when it is answered, and both legs report their progress. The call id is in the
  // query string, which the signature covers, so it cannot be swapped; the call must belong to this connection's workspace.
  const voiceRow = async (c: Context) => {
    const row = await connection(c, "twilio");
    const p = await formParams(c);
    const url = new URL(c.req.url);
    const creds = openCredentials<TwilioCredentials>(ctx, row);
    if (!verifyTwilioSignature(creds.auth_token, ctx.config.PUBLIC_URL.replace(/\/$/, "") + url.pathname + url.search, p, c.req.header("x-twilio-signature"))) await reject(row, "twilio_voice", "signature does not match this workspace's auth token");
    const call = url.searchParams.get("call");
    if (!call) throw badRequest("VALIDATION_ERROR", "call is required");
    return { row, p, call, url };
  };
  r.post("/c/:id/twilio/voice/connect", async (c) => {
    const { row, p, call } = await voiceRow(c);
    const twiml = await voiceConnect(ctx, row, call, p);
    await recordChannelEvent(ctx, row.workspace_id, "sms", "twilio_voice", "processed", "agent answered");
    return c.body(twiml, 200, { "Content-Type": "text/xml" });
  });
  r.post("/c/:id/twilio/voice/status", async (c) => {
    const { row, p, call, url } = await voiceRow(c);
    const leg = url.searchParams.get("leg") === "visitor" ? "visitor" : "agent";
    const res = await voiceStatus(ctx, row, call, leg, p);
    await recordChannelEvent(ctx, row.workspace_id, "sms", "twilio_voice", res === "processed" ? "processed" : res, `${leg} ${p.CallStatus ?? ""}`);
    return c.body(null, 204);
  });

  r.post("/c/:id/sendgrid/inbound", async (c) => {
    const row = await connection(c, "sendgrid");
    if (!secretOk(row, c.req.query("secret") ?? c.req.header("x-webhook-secret"))) await reject(row, "sendgrid_inbound", "wrong or missing secret");
    const p = await formParams(c);
    if (!p.from || !p.to) throw badRequest("VALIDATION_ERROR", "from and to are required");
    const res = await handleInboundEmail(ctx, { from: p.from, to: p.to, subject: p.subject, text: p.text, html: p.html, headers: p.headers }, { workspaceId: row.workspace_id });
    await recordChannelEvent(ctx, row.workspace_id, "email", "sendgrid_inbound", res.status === "processed" ? "processed" : res.status === "duplicate" ? "duplicate" : "ignored", res.status === "ignored" ? "no inbound address of this workspace in the To field, or an empty message" : null);
    return c.json(res);
  });

  r.post("/c/:id/sendgrid/events", async (c) => {
    const row = await connection(c, "sendgrid");
    const raw = await c.req.text();
    const publicKey = parseJson<{ event_public_key?: string | null }>(row.meta, {}).event_public_key;
    if (publicKey) {
      const sig = c.req.header("x-twilio-email-event-webhook-signature");
      const ts = c.req.header("x-twilio-email-event-webhook-timestamp");
      if (!verifySendgridSignature(publicKey, raw, sig, ts)) await reject(row, "sendgrid_events", "signature does not match this workspace's verification key");
      const n = Number(ts);
      if (!Number.isFinite(n) || Math.abs(ctx.clock().getTime() / 1000 - n) > ctx.config.WEBHOOK_TOLERANCE_SECONDS) await reject(row, "sendgrid_events", "timestamp outside the tolerated window");
      if (!(await claimEvent(ctx, "sendgrid_sig", sha256(`${row.id}|${sig}|${ts}`)))) await reject(row, "sendgrid_events", "replayed request");
    } else if (!secretOk(row, c.req.query("secret") ?? c.req.header("x-webhook-secret"))) await reject(row, "sendgrid_events", "wrong or missing secret");
    let events: unknown;
    try {
      events = JSON.parse(raw);
    } catch {
      throw badRequest("INVALID_JSON", "Body must be a JSON array of events");
    }
    if (!Array.isArray(events)) throw badRequest("VALIDATION_ERROR", "Body must be a JSON array of events");
    const res = await handleSendgridEvents(ctx, events as SendgridEvent[], { workspaceId: row.workspace_id });
    await recordChannelEvent(ctx, row.workspace_id, "email", "sendgrid_events", res.processed ? "processed" : "ignored", `${res.processed} processed, ${res.ignored} ignored`);
    return c.json(res);
  });

  // Stripe: the signature is checked over the exact raw bytes, then the event is applied once (stripe_events journal). 2xx = done or ignorable,
  // anything else makes Stripe retry with backoff.
  for (const [path, kind] of [["/stripe", "platform"], ["/stripe/connect", "connect"]] as const) {
    r.post(path, async (c) => {
      const raw = await c.req.text();
      const event = ctx.billing.verifyWebhook(raw, c.req.header("stripe-signature"), kind);
      const result = await handleStripeEvent(ctx, event, kind);
      return c.json({ received: true, result });
    });
  }

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
