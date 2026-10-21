import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { redactSecrets } from "../util/redact.js";
import { parseJson } from "../util/json.js";

export type ChannelKey = "sms" | "email";

/**
 * - `live`       messages leave the server through a real provider
 * - `test`       no provider is connected and the console one is active: messages are stored and marked "not sent"
 * - `attention`  the workspace connected its own account but it is unverified or the provider rejected it: sends fail with a message
 */
export type ChannelMode = "live" | "test" | "attention";

export interface ChannelStatus {
  channel: ChannelKey;
  mode: ChannelMode;
  /** true only when a real provider is active */
  connected: boolean;
  /** provider in use: twilio | sendgrid | console */
  provider: string;
  /** where the credentials come from: the platform's environment, or nothing */
  source: "workspace" | "platform" | "none";
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


export async function markConnectionError(ctx: AppContext, ws: string, channel: ChannelKey, message: string): Promise<void> {
  await ctx.db.run("UPDATE channel_connections SET status = 'error', last_error = ?, last_error_at = ?, updated_at = ? WHERE workspace_id = ? AND channel = ? AND status = 'verified'", redactSecrets(message).slice(0, 300), nowIso(ctx), nowIso(ctx), ws, channel);
  await ctx.providers.invalidate(ws);
}

async function lastEvent(ctx: AppContext, ws: string, channel: ChannelKey) {
  const e = await ctx.db.get<{ kind: string; outcome: string; detail: string | null; created_at: string }>(
    "SELECT kind, outcome, detail, created_at FROM channel_events WHERE workspace_id = ? AND channel = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ws,
    channel,
  );
  return e ? { kind: e.kind, outcome: e.outcome, detail: e.detail, at: e.created_at } : null;
}

async function status(ctx: AppContext, ws: string, channel: ChannelKey): Promise<ChannelStatus> {
  const resolved = channel === "sms" ? await ctx.providers.sms(ws) : await ctx.providers.email(ws);
  const row = await ctx.providers.connection(ws, channel);
  const brand = channel === "sms" ? "Twilio" : "SendGrid";
  const label = channel === "sms" ? "SMS" : "Email";
  let mode: ChannelMode;
  let summary: string;
  if (row && row.status !== "verified") {
    mode = "attention";
    summary =
      row.status === "error"
        ? `${brand} rejected the saved credentials${row.last_error ? `: ${row.last_error}` : ""}. Messages cannot be sent until you verify them again in Settings > Channels.`
        : `${brand} credentials are saved but not verified yet. Verify them in Settings > Channels to start sending.`;
  } else if (resolved.simulated) {
    mode = "test";
    summary = SUMMARY[channel].test;
  } else {
    mode = "live";
    summary = SUMMARY[channel].live;
  }
  const meta = row ? parseJson<Record<string, unknown>>(row.meta, {}) : {};
  const details: Record<string, unknown> =
    channel === "sms"
      ? {
          numbers: Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sms_numbers WHERE workspace_id = ?", ws))!.n),
          default_number: (await ctx.db.get<{ e164: string }>("SELECT e164 FROM sms_numbers WHERE workspace_id = ? AND is_default = 1", ws))?.e164 ?? null,
        }
      : (() => ({}))();
  if (channel === "email") {
    const s = await ctx.db.get<{ n: number; v: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS v FROM email_senders WHERE workspace_id = ?", ws);
    Object.assign(details, {
      senders: Number(s?.n ?? 0),
      verified_senders: Number(s?.v ?? 0),
      inbound_addresses: Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound_addresses WHERE workspace_id = ?", ws))!.n),
    });
  }
  if (row) {
    details.connection_status = row.status;
    details.verified_at = row.verified_at;
    details.account = meta.account ?? null;
    details.masked = meta.masked ?? null;
    details.last_event = await lastEvent(ctx, ws, channel);
  }
  return {
    channel,
    mode,
    connected: mode === "live",
    provider: row ? row.provider : resolved.provider.name,
    source: row ? "workspace" : resolved.simulated ? "none" : "platform",
    summary: summary || `${label} status unknown`,
    details,
    ...(await health(ctx, ws, channel)),
  };
}

/**
 * Provider status for the workspace. Never contains credentials: only names, masked hints, counts and the last error text (redacted).
 * `system_email` is the platform mailer behind invitations, password resets and notification emails (a platform setting, not a workspace one).
 */
export async function channelStatuses(ctx: AppContext, ws: string) {
  return {
    sms: await status(ctx, ws, "sms"),
    email: await status(ctx, ws, "email"),
    system_email: { mode: ctx.email.simulated ? ("test" as const) : ("live" as const), provider: ctx.email.name },
  };
}
