import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { redactSecrets } from "../util/redact.js";

export type ChannelKey = "sms" | "email";

/**
 * - `live`          messages leave the server through a real provider
 * - `test`          the console/fake provider is active: messages are stored and marked "not sent"
 */
export type ChannelMode = "live" | "test";

export interface ChannelStatus {
  channel: ChannelKey;
  mode: ChannelMode;
  /** true only when a real provider is active */
  connected: boolean;
  /** provider in use: twilio | sendgrid | console */
  provider: string;
  /** where the credentials come from: the platform's environment, or nothing */
  source: "platform" | "none";
  /** human-readable one-liner for banners */
  summary: string;
  details: Record<string, unknown>;
  last_error: { message: string; code: string | null; at: string } | null;
  last_ok_at: string | null;
}

const SUMMARY = {
  sms: { test: "SMS is not connected. Messages are saved but not sent. Connect Twilio in Settings > Channels.", live: "SMS is connected." },
  email: { test: "Email is not connected. Messages are saved but not sent. Connect SendGrid in Settings > Channels.", live: "Email is connected." },
} as const;

/** Called by the delivery path after every provider attempt. A success only writes when an error is on record. */
export async function noteChannelResult(ctx: AppContext, ws: string, channel: ChannelKey, err?: { message: string; code?: string | null }): Promise<void> {
  const now = nowIso(ctx);
  if (err) {
    const msg = redactSecrets(err.message).slice(0, 300);
    await ctx.db.run(
      `INSERT INTO channel_health(workspace_id, channel, last_error, last_error_code, last_error_at) VALUES (?,?,?,?,?)
       ON CONFLICT (workspace_id, channel) DO UPDATE SET last_error = excluded.last_error, last_error_code = excluded.last_error_code, last_error_at = excluded.last_error_at`,
      ws,
      channel,
      msg,
      err.code ?? null,
      now,
    );
    return;
  }
  const cleared = await ctx.db.run("UPDATE channel_health SET last_error = NULL, last_error_code = NULL, last_error_at = NULL, last_ok_at = ? WHERE workspace_id = ? AND channel = ? AND last_error IS NOT NULL", now, ws, channel);
  if (!cleared.changes) {
    // no error on record: remember the first success only (an upsert on every send would put a write on the hot path)
    await ctx.db.run("INSERT INTO channel_health(workspace_id, channel, last_ok_at) VALUES (?,?,?) ON CONFLICT (workspace_id, channel) DO NOTHING", ws, channel, now);
  }
}

interface HealthRow {
  last_error: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  last_ok_at: string | null;
}

async function health(ctx: AppContext, ws: string, channel: ChannelKey) {
  const h = await ctx.db.get<HealthRow>("SELECT last_error, last_error_code, last_error_at, last_ok_at FROM channel_health WHERE workspace_id = ? AND channel = ?", ws, channel);
  return {
    last_error: h?.last_error ? { message: h.last_error, code: h.last_error_code, at: h.last_error_at! } : null,
    last_ok_at: h?.last_ok_at ?? null,
  };
}

async function smsStatus(ctx: AppContext, ws: string): Promise<ChannelStatus> {
  const live = !ctx.sms.simulated;
  const n = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sms_numbers WHERE workspace_id = ?", ws))!.n;
  const def = await ctx.db.get<{ e164: string }>("SELECT e164 FROM sms_numbers WHERE workspace_id = ? AND is_default = 1", ws);
  return {
    channel: "sms",
    mode: live ? "live" : "test",
    connected: live,
    provider: ctx.sms.name,
    source: live ? "platform" : "none",
    summary: SUMMARY.sms[live ? "live" : "test"],
    details: { numbers: Number(n), default_number: def?.e164 ?? null },
    ...(await health(ctx, ws, "sms")),
  };
}

async function emailStatus(ctx: AppContext, ws: string): Promise<ChannelStatus> {
  const live = !ctx.email.simulated;
  const senders = await ctx.db.get<{ n: number; v: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS v FROM email_senders WHERE workspace_id = ?", ws);
  const inbound = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound_addresses WHERE workspace_id = ?", ws))!.n;
  return {
    channel: "email",
    mode: live ? "live" : "test",
    connected: live,
    provider: ctx.email.name,
    source: live ? "platform" : "none",
    summary: SUMMARY.email[live ? "live" : "test"],
    details: { senders: Number(senders?.n ?? 0), verified_senders: Number(senders?.v ?? 0), inbound_addresses: Number(inbound) },
    ...(await health(ctx, ws, "email")),
  };
}

/**
 * Provider status for the workspace. Never contains credentials: only names, counts and the last error text (redacted).
 * `system_email` is the platform mailer behind invitations, password resets and notification emails (a platform setting, not a workspace one).
 */
export async function channelStatuses(ctx: AppContext, ws: string) {
  return {
    sms: await smsStatus(ctx, ws),
    email: await emailStatus(ctx, ws),
    system_email: { mode: ctx.email.simulated ? ("test" as const) : ("live" as const), provider: ctx.email.name },
  };
}
