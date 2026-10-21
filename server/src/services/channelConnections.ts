import { createPublicKey, randomBytes } from "node:crypto";
import { can } from "../authz/permissions.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, forbidden, notFound, unprocessable } from "../errors.js";
import { ProviderError } from "../providers/types.js";
import {
  openWebhookSecret,
  sealCredentials,
  sealWebhookSecret,
  type ChannelKind,
  type ConnectionRow,
  type SendGridCredentials,
  type TwilioCredentials,
} from "../providers/registry.js";
import { enforce } from "../ratelimit/http.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { maskTail, redactSecrets } from "../util/redact.js";
import { randomToken, sha256 } from "../util/crypto.js";
import { normalizePhone } from "../util/phone.js";
import { recordAudit } from "./audit.js";
import { markConnectionError, noteChannelResult } from "./channels.js";
import { insertSmsNumber } from "./settings.js";
import { getSettings, getWorkspace } from "./workspaces.js";

const manager = (a: Actor) => {
  if (!can(a, "channels:manage")) throw forbidden("Only managers can change channel settings");
};
const actorRef = (a: Actor) => ({ type: "member" as const, id: a.memberId });

/** A provider failure as an API error: our own status codes (never 401, which clients treat as "session expired") and a message that says what to do. */
export function providerAppError(e: ProviderError): AppError {
  const status = e.code === "timeout" || e.code === "unreachable" || e.code === "malformed_response" || (e.code === "provider_error" && (e.status ?? 500) >= 500) ? 502 : e.code === "rate_limited" ? 429 : 422;
  return new AppError(status, `CHANNEL_${e.code.toUpperCase()}`, e.hint ?? e.message, { provider_message: redactSecrets(e.message).slice(0, 300) });
}

/* ---------- reading ---------- */

export interface ConnectionDto {
  id: string;
  channel: ChannelKind;
  provider: "twilio" | "sendgrid";
  status: "pending" | "verified" | "error";
  /** hints only: the last four characters of each secret */
  masked: Record<string, string>;
  account: { friendly_name?: string; type?: string; status?: string; scopes_ok?: boolean; domains?: { domain: string; valid: boolean }[]; verified_senders?: number } | null;
  inbound_domain: string | null;
  event_public_key_set: boolean;
  verified_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  /** URLs to paste into the provider's console. SendGrid's carry this connection's secret. */
  webhooks: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export function webhookUrls(ctx: AppContext, row: ConnectionRow): Record<string, string> {
  const base = `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/c/${row.webhook_id}`;
  if (row.provider === "twilio") return { sms: `${base}/twilio/sms`, status: `${base}/twilio/status` };
  const secret = encodeURIComponent(openWebhookSecret(ctx, row));
  return { inbound: `${base}/sendgrid/inbound?secret=${secret}`, events: `${base}/sendgrid/events?secret=${secret}` };
}

export function connectionDto(ctx: AppContext, row: ConnectionRow): ConnectionDto {
  const meta = parseJson<{ masked?: Record<string, string>; account?: ConnectionDto["account"]; inbound_domain?: string | null; event_public_key?: string | null }>(row.meta, {});
  let webhooks: Record<string, string> = {};
  try {
    webhooks = webhookUrls(ctx, row);
  } catch {
    /* unreadable secret (key changed): the connection shows as needing attention anyway */
  }
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    status: row.status,
    masked: meta.masked ?? {},
    account: meta.account ?? null,
    inbound_domain: meta.inbound_domain ?? null,
    event_public_key_set: !!meta.event_public_key,
    verified_at: row.verified_at,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
    webhooks,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getConnections(ctx: AppContext, actor: Actor) {
  manager(actor);
  const rows = await ctx.db.all<ConnectionRow>("SELECT * FROM channel_connections WHERE workspace_id = ?", actor.workspaceId);
  const by = (c: ChannelKind) => rows.find((r) => r.channel === c);
  return { sms: by("sms") ? connectionDto(ctx, by("sms")!) : null, email: by("email") ? connectionDto(ctx, by("email")!) : null };
}

async function requireRow(ctx: AppContext, ws: string, channel: ChannelKind): Promise<ConnectionRow> {
  const row = await ctx.db.get<ConnectionRow>("SELECT * FROM channel_connections WHERE workspace_id = ? AND channel = ?", ws, channel);
  if (!row) throw notFound(channel === "sms" ? "Twilio connection" : "SendGrid connection");
  return row;
}

/* ---------- writing ---------- */

async function upsertConnection(ctx: AppContext, actor: Actor, channel: ChannelKind, provider: "twilio" | "sendgrid", creds: object, masked: Record<string, string>, extraMeta: Record<string, unknown> = {}) {
  const ws = actor.workspaceId;
  const now = nowIso(ctx);
  const sealed = sealCredentials(ctx, ws, channel, creds);
  const existing = await ctx.db.get<ConnectionRow>("SELECT * FROM channel_connections WHERE workspace_id = ? AND channel = ?", ws, channel);
  if (existing) {
    const meta = { ...parseJson<Record<string, unknown>>(existing.meta, {}), ...extraMeta, masked, account: null };
    // new credentials are untrusted until verified: sending stops (it does not fall back to another account) until then
    await ctx.db.run("UPDATE channel_connections SET credentials_enc = ?, meta = ?, status = 'pending', verified_at = NULL, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?", sealed, JSON.stringify(meta), now, existing.id);
  } else {
    const secret = randomToken(24);
    await ctx.db.run(
      `INSERT INTO channel_connections(id, workspace_id, channel, provider, status, credentials_enc, meta, webhook_id, webhook_secret_hash, webhook_secret_enc, created_by, created_at, updated_at)
       VALUES (?,?,?,?,'pending',?,?,?,?,?,?,?,?)`,
      newId("chc"),
      ws,
      channel,
      provider,
      sealed,
      JSON.stringify({ ...extraMeta, masked }),
      `wh_${randomBytes(16).toString("base64url")}`,
      sha256(secret),
      sealWebhookSecret(ctx, ws, channel, secret),
      actor.memberId,
      now,
      now,
    );
  }
  await ctx.providers.invalidate(ws);
  await recordAudit(ctx, { workspaceId: ws, actor: actorRef(actor), action: "channel.connected", target: channel, detail: { provider, replaced: !!existing } });
  return connectionDto(ctx, await requireRow(ctx, ws, channel));
}

export interface TwilioConnectInput {
  account_sid: string;
  auth_token: string;
  api_key_sid?: string;
  api_key_secret?: string;
}

export async function connectTwilio(ctx: AppContext, actor: Actor, i: TwilioConnectInput) {
  manager(actor);
  const creds: TwilioCredentials = { account_sid: i.account_sid.trim(), auth_token: i.auth_token.trim() };
  if (i.api_key_sid || i.api_key_secret) {
    if (!i.api_key_sid || !i.api_key_secret) throw unprocessable("VALIDATION_ERROR", "Give both the API key SID and its secret, or neither");
    creds.api_key_sid = i.api_key_sid.trim();
    creds.api_key_secret = i.api_key_secret.trim();
  }
  const masked: Record<string, string> = { account_sid: `AC${maskTail(creds.account_sid)}`, auth_token: maskTail(creds.auth_token) };
  if (creds.api_key_sid) masked.api_key_sid = `SK${maskTail(creds.api_key_sid)}`;
  return upsertConnection(ctx, actor, "sms", "twilio", creds, masked);
}

export interface SendGridConnectInput {
  api_key: string;
  inbound_domain?: string | null;
  event_public_key?: string | null;
}

export async function connectSendGrid(ctx: AppContext, actor: Actor, i: SendGridConnectInput) {
  manager(actor);
  const creds: SendGridCredentials = { api_key: i.api_key.trim() };
  const extra = settingsMeta(i);
  return upsertConnection(ctx, actor, "email", "sendgrid", creds, { api_key: maskTail(creds.api_key) }, extra);
}

function settingsMeta(i: { inbound_domain?: string | null; event_public_key?: string | null }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (i.inbound_domain !== undefined) {
    const d = i.inbound_domain?.trim().toLowerCase() || null;
    if (d && !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw unprocessable("INVALID_DOMAIN", "Inbound domain must be a host name such as inbound.example.com");
    out.inbound_domain = d;
  }
  if (i.event_public_key !== undefined) {
    const k = i.event_public_key?.replace(/\s+/g, "") || null;
    if (k) {
      try {
        createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" });
      } catch {
        throw unprocessable("INVALID_PUBLIC_KEY", "That is not a SendGrid verification key. Copy it from Settings > Mail Settings > Event Webhook > Signature Verification.");
      }
    }
    out.event_public_key = k;
  }
  return out;
}

/** Inbound domain and event-webhook verification key can change without re-entering the API key. */
export async function updateEmailSettings(ctx: AppContext, actor: Actor, i: { inbound_domain?: string | null; event_public_key?: string | null }) {
  manager(actor);
  const row = await requireRow(ctx, actor.workspaceId, "email");
  const meta = { ...parseJson<Record<string, unknown>>(row.meta, {}), ...settingsMeta(i) };
  await ctx.db.run("UPDATE channel_connections SET meta = ?, updated_at = ? WHERE id = ?", JSON.stringify(meta), nowIso(ctx), row.id);
  await ctx.providers.invalidate(actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: actorRef(actor), action: "channel.settings_changed", target: "email", detail: { inbound_domain: "inbound_domain" in i, event_public_key: "event_public_key" in i } });
  return connectionDto(ctx, await requireRow(ctx, actor.workspaceId, "email"));
}

export async function disconnect(ctx: AppContext, actor: Actor, channel: ChannelKind) {
  manager(actor);
  const row = await requireRow(ctx, actor.workspaceId, channel);
  await ctx.db.run("DELETE FROM channel_connections WHERE id = ?", row.id);
  await ctx.db.run("DELETE FROM channel_events WHERE workspace_id = ? AND channel = ?", actor.workspaceId, channel);
  await ctx.providers.invalidate(actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: actorRef(actor), action: "channel.disconnected", target: channel, detail: { provider: row.provider } });
}

export async function rotateWebhookSecret(ctx: AppContext, actor: Actor, channel: ChannelKind) {
  manager(actor);
  const row = await requireRow(ctx, actor.workspaceId, channel);
  if (row.provider !== "sendgrid") throw unprocessable("NOT_APPLICABLE", "Twilio webhooks are authenticated by Twilio's signature; there is no secret to rotate");
  const secret = randomToken(24);
  await ctx.db.run("UPDATE channel_connections SET webhook_secret_hash = ?, webhook_secret_enc = ?, updated_at = ? WHERE id = ?", sha256(secret), sealWebhookSecret(ctx, actor.workspaceId, channel, secret), nowIso(ctx), row.id);
  await ctx.providers.invalidate(actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: actorRef(actor), action: "channel.secret_rotated", target: channel });
  return connectionDto(ctx, await requireRow(ctx, actor.workspaceId, channel));
}

/* ---------- verifying ---------- */

function unreadable(): AppError {
  return new AppError(409, "CHANNEL_CREDENTIALS_UNREADABLE", "The stored credentials cannot be decrypted (DATA_ENCRYPTION_KEY changed?). Paste them again to reconnect.");
}

async function failVerify(ctx: AppContext, row: ConnectionRow, e: ProviderError): Promise<never> {
  // only an answer from the provider that says "these credentials are wrong" changes the status; a timeout says nothing about them
  if (e.code === "auth_failed" || e.code === "account_suspended") {
    await ctx.db.run("UPDATE channel_connections SET status = 'error', verified_at = NULL, last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?", redactSecrets(e.hint ?? e.message).slice(0, 300), nowIso(ctx), nowIso(ctx), row.id);
    await ctx.providers.invalidate(row.workspace_id);
  }
  throw providerAppError(e);
}

export interface VerifyResult {
  connection: ConnectionDto;
  warnings: string[];
  senders?: { email: string; name: string; verified: boolean }[] | null;
}

/** Read-only provider calls. Twilio: fetch the account. SendGrid: list the key's scopes, verified senders and authenticated domains. */
export async function verifyConnection(ctx: AppContext, actor: Actor, channel: ChannelKind): Promise<VerifyResult> {
  manager(actor);
  await enforce(ctx, "channels.verify", { key: actor.memberId, workspaceId: actor.workspaceId });
  const row = await requireRow(ctx, actor.workspaceId, channel);
  const warnings: string[] = [];
  const meta = parseJson<Record<string, unknown>>(row.meta, {});
  let account: ConnectionDto["account"];
  let senders: VerifyResult["senders"];
  try {
    if (row.provider === "twilio") {
      const a = await ctx.providers.twilioFor(row).fetchAccount();
      if (a.status !== "active") {
        await failVerify(ctx, row, new ProviderError(`Twilio account is ${a.status}`, false, 403, "account_suspended", `Your Twilio account is ${a.status}. Reactivate it in the Twilio Console, then verify again.`));
      }
      account = { friendly_name: a.friendly_name, type: a.type, status: a.status };
      if (/trial/i.test(a.type)) warnings.push("This is a Twilio trial account: it can only text numbers you have verified in the Twilio Console, and every message starts with a trial notice. Upgrade to text anyone.");
      const n = Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sms_numbers WHERE workspace_id = ?", row.workspace_id))!.n);
      if (!n) warnings.push("No SMS numbers yet. Import the numbers on your Twilio account below.");
    } else {
      const sg = ctx.providers.sendgridFor(row);
      const scopes = await sg.fetchScopes();
      const canSend = scopes.includes("mail.send");
      if (!canSend) {
        await failVerify(ctx, row, new ProviderError("SendGrid key lacks mail.send", false, 403, "permission_denied", "This SendGrid API key cannot send mail. Create a key with Mail Send permission (or Full Access) and paste it again."));
      }
      senders = await sg.listVerifiedSenders();
      const domains = await sg.listAuthenticatedDomains();
      account = { scopes_ok: true, ...(domains ? { domains } : {}), ...(senders ? { verified_senders: senders.filter((s) => s.verified).length } : {}) };
      if (senders && !senders.some((s) => s.verified) && !(domains ?? []).some((d) => d.valid)) {
        warnings.push("SendGrid has no verified sender and no authenticated domain: it will refuse to send until you verify a single sender or authenticate your domain (Settings > Sender Authentication).");
      }
      if (senders === null) warnings.push("This key cannot read Sender Authentication, so verified senders cannot be imported. Add senders by hand, or use a key with that permission.");
    }
  } catch (e) {
    if (e instanceof ProviderError) return await failVerify(ctx, row, e);
    if (e instanceof AppError) throw e;
    throw unreadable();
  }
  await ctx.db.run("UPDATE channel_connections SET status = 'verified', verified_at = ?, last_error = NULL, last_error_at = NULL, meta = ?, updated_at = ? WHERE id = ?", nowIso(ctx), JSON.stringify({ ...meta, account }), nowIso(ctx), row.id);
  await ctx.providers.invalidate(row.workspace_id);
  await noteChannelResult(ctx, row.workspace_id, channel);
  await recordAudit(ctx, { workspaceId: row.workspace_id, actor: actorRef(actor), action: "channel.verified", target: channel, detail: { provider: row.provider } });
  return { connection: connectionDto(ctx, await requireRow(ctx, row.workspace_id, channel)), warnings, ...(senders !== undefined ? { senders } : {}) };
}

/* ---------- importing ---------- */

async function verifiedRow(ctx: AppContext, ws: string, channel: ChannelKind): Promise<ConnectionRow> {
  const row = await requireRow(ctx, ws, channel);
  if (row.status !== "verified") throw new AppError(409, "CHANNEL_NOT_VERIFIED", "Verify the credentials first.");
  return row;
}

export async function listTwilioNumbers(ctx: AppContext, actor: Actor) {
  manager(actor);
  await enforce(ctx, "channels.verify", { key: actor.memberId, workspaceId: actor.workspaceId });
  const row = await verifiedRow(ctx, actor.workspaceId, "sms");
  try {
    const numbers = await ctx.providers.twilioFor(row).listNumbers();
    const mine = new Set((await ctx.db.all<{ e164: string }>("SELECT e164 FROM sms_numbers WHERE workspace_id = ?", actor.workspaceId)).map((r) => r.e164));
    return { data: numbers.map((n) => ({ e164: n.e164, label: n.label, sms_capable: n.sms_capable, imported: mine.has(n.e164) })) };
  } catch (e) {
    if (e instanceof ProviderError) return failVerify(ctx, row, e);
    throw e;
  }
}

/** Only numbers Twilio itself lists for this account are imported, so a workspace cannot claim a number it does not own. */
export async function importTwilioNumbers(ctx: AppContext, actor: Actor, e164s: string[]) {
  manager(actor);
  const owned = (await listTwilioNumbers(ctx, actor)).data;
  const imported: string[] = [];
  const skipped: { e164: string; reason: string }[] = [];
  const want = [...new Set(e164s.map((n) => normalizePhone(n) ?? n))];
  for (const e164 of want) {
    const n = owned.find((o) => o.e164 === e164);
    if (!n) skipped.push({ e164, reason: "not on your Twilio account" });
    else if (!n.sms_capable) skipped.push({ e164, reason: "this number cannot send SMS" });
    else if (n.imported) skipped.push({ e164, reason: "already added" });
    else {
      try {
        await insertSmsNumber(ctx, actor.workspaceId, e164, n.label, false);
        imported.push(e164);
      } catch (e) {
        if (e instanceof AppError && e.code === "NUMBER_EXISTS") skipped.push({ e164, reason: "already in use" });
        else throw e;
      }
    }
  }
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: actorRef(actor), action: "channel.numbers_imported", target: "sms", detail: { imported: imported.length, skipped: skipped.length } });
  return { imported, skipped };
}

export async function importSendGridSenders(ctx: AppContext, actor: Actor) {
  manager(actor);
  await enforce(ctx, "channels.verify", { key: actor.memberId, workspaceId: actor.workspaceId });
  const row = await verifiedRow(ctx, actor.workspaceId, "email");
  let list;
  try {
    list = await ctx.providers.sendgridFor(row).listVerifiedSenders();
  } catch (e) {
    if (e instanceof ProviderError) return failVerify(ctx, row, e);
    throw e;
  }
  if (list === null) throw new AppError(422, "CHANNEL_PERMISSION_DENIED", "This API key cannot read Sender Authentication. Add senders by hand, or use a key with that permission.");
  let added = 0;
  let updated = 0;
  const ws = actor.workspaceId;
  for (const s of list.filter((x) => x.verified)) {
    const have = await ctx.db.get<{ id: string; verified: number }>("SELECT id, verified FROM email_senders WHERE workspace_id = ? AND address = ?", ws, s.email);
    if (!have) {
      const first = !(await ctx.db.get("SELECT 1 FROM email_senders WHERE workspace_id = ?", ws));
      await ctx.db.run("INSERT INTO email_senders(id, workspace_id, address, display_name, verified, is_default, created_at) VALUES (?,?,?,?,?,?,?)", newId("snd"), ws, s.email, s.name, true, first, nowIso(ctx));
      added++;
    } else if (!have.verified) {
      await ctx.db.run("UPDATE email_senders SET verified = 1 WHERE id = ?", have.id);
      updated++;
    }
  }
  await recordAudit(ctx, { workspaceId: ws, actor: actorRef(actor), action: "channel.senders_imported", target: "email", detail: { added, updated } });
  return { added, updated, total_verified: list.filter((x) => x.verified).length };
}

/* ---------- test sends ---------- */

const maskTo = (to: string) => (to.includes("@") ? `${to.slice(0, 1)}***@${to.split("@")[1]}` : maskTail(to));

export async function sendTest(ctx: AppContext, actor: Actor, channel: ChannelKind, toRaw: string): Promise<{ ok: true; provider_message_id: string; to: string; from: string }> {
  manager(actor);
  const ws = actor.workspaceId;
  await enforce(ctx, "channels.test", { key: ws, workspaceId: ws });
  const workspace = await getWorkspace(ctx, ws);
  let to: string;
  let from: string;
  let providerId: string;
  let routeInfo: { simulated: boolean; connectionId: string | null };
  try {
    if (channel === "sms") {
      const n = normalizePhone(toRaw, (await getSettings(ctx, ws)).default_region);
      if (!n) throw unprocessable("INVALID_PHONE", "Enter the phone number in international format, for example +14155550123");
      to = n;
      const num = await ctx.db.get<{ e164: string }>("SELECT e164 FROM sms_numbers WHERE workspace_id = ? ORDER BY is_default DESC, created_at LIMIT 1", ws);
      if (!num) throw unprocessable("NO_SMS_NUMBER", "Add or import an SMS number first: a test text is sent from it.");
      from = num.e164;
      const r = await ctx.providers.sms(ws);
      routeInfo = r;
      if (r.simulated) throw new AppError(409, "CHANNEL_NOT_CONNECTED", "SMS is not connected, so a test text would not be sent. Connect Twilio first.");
      providerId = (await r.provider.send({ to, from, body: `Test message from ${workspace.name} (Conversations). If you can read this, SMS works.`, idempotencyKey: newId("tst"), statusCallbackUrl: r.statusCallbackUrl })).providerMessageId;
    } else {
      const addr = toRaw.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw unprocessable("INVALID_EMAIL", "Enter a valid email address");
      to = addr;
      const sender = await ctx.db.get<{ address: string; display_name: string }>("SELECT address, display_name FROM email_senders WHERE workspace_id = ? AND verified = 1 ORDER BY is_default DESC, created_at LIMIT 1", ws);
      if (!sender) throw unprocessable("NO_VERIFIED_SENDER", "Add a verified sender first: a test email is sent from it.");
      from = sender.address;
      const r = await ctx.providers.email(ws);
      routeInfo = r;
      if (r.simulated) throw new AppError(409, "CHANNEL_NOT_CONNECTED", "Email is not connected, so a test email would not be sent. Connect SendGrid first.");
      const domain = from.split("@")[1] ?? "localhost";
      providerId = (
        await r.provider.send({
          from: { address: from, name: sender.display_name || undefined },
          to,
          subject: `Test email from ${workspace.name}`,
          text: `If you can read this, email sending from ${from} works.`,
          html: `<p>If you can read this, email sending from <strong>${from}</strong> works.</p>`,
          messageId: `<${newId("tst")}@${domain}>`,
        })
      ).providerMessageId;
    }
  } catch (e) {
    if (e instanceof ProviderError) {
      await noteChannelResult(ctx, ws, channel, { message: e.message, code: e.code }).catch(() => {});
      if (e.code === "auth_failed") await markConnectionError(ctx, ws, channel, e.hint ?? e.message).catch(() => {});
      throw providerAppError(e);
    }
    throw e;
  }
  await noteChannelResult(ctx, ws, channel);
  void routeInfo;
  await recordAudit(ctx, { workspaceId: ws, actor: actorRef(actor), action: "channel.test_sent", target: channel, detail: { to: maskTo(to) } });
  return { ok: true, provider_message_id: providerId, to, from };
}

/* ---------- inbound event log ("Check webhook") ---------- */

export async function recordChannelEvent(ctx: AppContext, ws: string, channel: ChannelKind, kind: string, outcome: "processed" | "duplicate" | "ignored" | "rejected", detail?: string | null) {
  await ctx.db.run("INSERT INTO channel_events(id, workspace_id, channel, kind, outcome, detail, created_at) VALUES (?,?,?,?,?,?,?)", newId("chev"), ws, channel, kind, outcome, detail?.slice(0, 200) ?? null, nowIso(ctx));
  await ctx.db.run(
    `DELETE FROM channel_events WHERE workspace_id = ? AND channel = ? AND id NOT IN (SELECT id FROM channel_events WHERE workspace_id = ? AND channel = ? ORDER BY created_at DESC, id DESC LIMIT 30)`,
    ws,
    channel,
    ws,
    channel,
  );
}

export async function listChannelEvents(ctx: AppContext, actor: Actor, channel: ChannelKind) {
  manager(actor);
  const rows = await ctx.db.all<{ id: string; kind: string; outcome: string; detail: string | null; created_at: string }>(
    "SELECT id, kind, outcome, detail, created_at FROM channel_events WHERE workspace_id = ? AND channel = ? ORDER BY created_at DESC, id DESC LIMIT 20",
    actor.workspaceId,
    channel,
  );
  return { data: rows.map((r) => ({ id: r.id, kind: r.kind, outcome: r.outcome, detail: r.detail, at: r.created_at })) };
}

/** The From address for system-style mail that a workspace's own SendGrid account must be able to send (visitor OTP): its default verified sender. */
export async function workspaceFromAddress(ctx: AppContext, ws: string): Promise<string | null> {
  const s = await ctx.db.get<{ address: string }>("SELECT address FROM email_senders WHERE workspace_id = ? AND verified = 1 ORDER BY is_default DESC, created_at LIMIT 1", ws);
  return s?.address ?? null;
}
