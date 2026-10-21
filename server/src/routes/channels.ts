import { Hono } from "hono";
import type { AppContext } from "../context.js";
import type { Env } from "../http.js";
import { channelStatuses } from "../services/channels.js";

/** Channel connections (SMS via Twilio, email via SendGrid): status for everyone who works conversations, management for `channels:manage`. */
export function channelRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.get("/channels/status", async (c) => c.json(await channelStatuses(ctx, c.get("actor").workspaceId)));
  return r;
}
