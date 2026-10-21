import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { notFound } from "../errors.js";
import { parseBody, type Env } from "../http.js";
import { EmailSettingsBody, ImportNumbersBody, SendGridConnectBody, TestSendBody, TwilioConnectBody } from "../schemas.js";
import { channelStatuses } from "../services/channels.js";
import { gettingStarted } from "../services/gettingStarted.js";
import {
  connectSendGrid,
  connectTwilio,
  disconnect,
  getConnections,
  importSendGridSenders,
  importTwilioNumbers,
  listChannelEvents,
  listTwilioNumbers,
  rotateWebhookSecret,
  sendTest,
  updateEmailSettings,
  verifyConnection,
} from "../services/channelConnections.js";
import type { ChannelKind } from "../providers/registry.js";

const channelOf = (v: string): ChannelKind => {
  if (v !== "sms" && v !== "email") throw notFound("Channel");
  return v;
};

/**
 * Channel connections (SMS via Twilio, email via SendGrid): status for everyone who works conversations, management for `channels:manage`.
 * Credentials go in, never out: responses carry masked hints (the last four characters) only.
 */
export function channelRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.get("/channels/status", async (c) => c.json(await channelStatuses(ctx, c.get("actor").workspaceId)));
  r.get("/getting-started", async (c) => c.json(await gettingStarted(ctx, c.get("actor").workspaceId)));
  r.get("/channels/connections", async (c) => c.json(await getConnections(ctx, c.get("actor"))));
  r.put("/channels/sms/connection", async (c) => c.json(await connectTwilio(ctx, c.get("actor"), await parseBody(c, TwilioConnectBody)), 200));
  r.put("/channels/email/connection", async (c) => c.json(await connectSendGrid(ctx, c.get("actor"), await parseBody(c, SendGridConnectBody)), 200));
  r.patch("/channels/email/connection", async (c) => c.json(await updateEmailSettings(ctx, c.get("actor"), await parseBody(c, EmailSettingsBody))));
  r.delete("/channels/:channel/connection", async (c) => {
    await disconnect(ctx, c.get("actor"), channelOf(c.req.param("channel")));
    return c.body(null, 204);
  });
  r.post("/channels/:channel/verify", async (c) => c.json(await verifyConnection(ctx, c.get("actor"), channelOf(c.req.param("channel")))));
  r.get("/channels/sms/numbers", async (c) => c.json(await listTwilioNumbers(ctx, c.get("actor"))));
  r.post("/channels/sms/numbers/import", async (c) => c.json(await importTwilioNumbers(ctx, c.get("actor"), (await parseBody(c, ImportNumbersBody)).e164s)));
  r.post("/channels/email/senders/import", async (c) => c.json(await importSendGridSenders(ctx, c.get("actor"))));
  r.post("/channels/email/webhook-secret/rotate", async (c) => c.json(await rotateWebhookSecret(ctx, c.get("actor"), "email")));
  r.post("/channels/:channel/test", async (c) => c.json(await sendTest(ctx, c.get("actor"), channelOf(c.req.param("channel")), (await parseBody(c, TestSendBody)).to)));
  r.get("/channels/:channel/events", async (c) => c.json(await listChannelEvents(ctx, c.get("actor"), channelOf(c.req.param("channel")))));
  return r;
}
