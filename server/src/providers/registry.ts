import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { decryptWithDataKey, encryptWithDataKey } from "../util/dataCrypto.js";
import { SendGridEmailProvider } from "./sendgrid.js";
import { TwilioSmsProvider } from "./twilio.js";
import { ProviderError, type EmailProvider, type EmailSendInput, type SmsProvider, type SmsSendInput } from "./types.js";

export type ChannelKind = "sms" | "email";

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  channel: ChannelKind;
  provider: "twilio" | "sendgrid";
  status: "pending" | "verified" | "error";
  credentials_enc: string;
  meta: string;
  webhook_id: string;
  webhook_secret_hash: string;
  webhook_secret_enc: string;
  verified_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TwilioCredentials {
  account_sid: string;
  auth_token: string;
  api_key_sid?: string;
  api_key_secret?: string;
}
export interface SendGridCredentials {
  api_key: string;
}

const connKey = (ws: string, channel: ChannelKind) => `chconn:${ws}:${channel}`;
const aad = (ws: string, channel: ChannelKind) => `channel:${ws}:${channel}`;
const secretAad = (ws: string, channel: ChannelKind) => `channel-webhook:${ws}:${channel}`;

/** Credentials are sealed with DATA_ENCRYPTION_KEY; the message names the setting (the shared helper talks about the analytics pepper). */
export function sealCredentials(ctx: AppContext, ws: string, channel: ChannelKind, creds: object): string {
  try {
    return encryptWithDataKey(ctx.config, JSON.stringify(creds), aad(ws, channel));
  } catch (e) {
    if (e instanceof AppError && e.code === "DATA_ENCRYPTION_KEY_REQUIRED") {
      throw new AppError(503, "DATA_ENCRYPTION_KEY_REQUIRED", "This server has no DATA_ENCRYPTION_KEY, so it cannot store provider credentials. Ask the operator to set it (32 random bytes as 64 hex characters or base64).");
    }
    throw e;
  }
}
export const sealWebhookSecret = (ctx: AppContext, ws: string, channel: ChannelKind, secret: string) => encryptWithDataKey(ctx.config, secret, secretAad(ws, channel));
export const openWebhookSecret = (ctx: AppContext, row: ConnectionRow) => decryptWithDataKey(ctx.config, row.webhook_secret_enc, secretAad(row.workspace_id, row.channel)).plain;

/** Decrypts or throws; callers decide whether that is a 5xx or a "reconnect" message. Never logs the plaintext. */
export function openCredentials<T extends object>(ctx: AppContext, row: ConnectionRow): T {
  const { plain, needsRewrite } = decryptWithDataKey(ctx.config, row.credentials_enc, aad(row.workspace_id, row.channel));
  if (needsRewrite) {
    // read under a previous key: re-seal under the current one, so the previous key can be retired (conditional on the old ciphertext)
    ctx.background.run(async () => {
      await ctx.db.run("UPDATE channel_connections SET credentials_enc = ? WHERE id = ? AND credentials_enc = ?", encryptWithDataKey(ctx.config, plain, aad(row.workspace_id, row.channel)), row.id, row.credentials_enc);
      await ctx.cache.invalidate(connKey(row.workspace_id, row.channel));
    });
  }
  return JSON.parse(plain) as T;
}

/** What a failed lookup looks like to the sender: every send fails fast and says how to fix it, nothing falls back to another account. */
function unusable(provider: string, why: string): ProviderError {
  return new ProviderError(`${provider} is not usable for this workspace: ${why}`, false, undefined, "credentials_unusable", `Open Settings > Channels, check the ${provider} credentials and verify them again.`);
}
class BrokenSms implements SmsProvider {
  readonly name = "twilio";
  constructor(private readonly why: string) {}
  async send(_i: SmsSendInput): Promise<never> {
    throw unusable("Twilio", this.why);
  }
}
class BrokenEmail implements EmailProvider {
  readonly name = "sendgrid";
  constructor(private readonly why: string) {}
  async send(_i: EmailSendInput): Promise<never> {
    throw unusable("SendGrid", this.why);
  }
}

export interface ResolvedSms {
  provider: SmsProvider;
  source: "workspace" | "platform";
  connectionId: string | null;
  simulated: boolean;
  statusCallbackUrl: string;
}
export interface ResolvedEmail {
  provider: EmailProvider;
  source: "workspace" | "platform";
  connectionId: string | null;
  simulated: boolean;
}


/**
 * Which SMS / email provider serves a workspace.
 *   1. the workspace's own connection (credentials pasted in Settings > Channels), when it exists;
 *   2. otherwise the platform default from the environment (`ctx.sms` / `ctx.email`: Twilio or SendGrid for a self-hoster, the console providers otherwise).
 * A workspace that HAS a connection never silently falls back to the platform's account: a pending, errored or unreadable connection
 * resolves to a provider whose sends fail with a message that says what to fix (fail closed). Rows are cached per node and the cache is
 * invalidated cluster-wide on every change; decrypted providers are kept in process memory only, keyed by row version.
 */
export class ProviderRegistry {
  /** replaced by tests with a mock; every outbound provider call goes through it */
  fetchImpl: typeof fetch = (...a) => fetch(...a);
  baseUrls: { twilio?: string; sendgrid?: string } = {};
  private readonly built = new Map<string, { sig: string; provider: SmsProvider | EmailProvider }>();

  constructor(private readonly ctxOf: () => AppContext) {}

  private get ctx() {
    return this.ctxOf();
  }

  async connection(ws: string, channel: ChannelKind): Promise<ConnectionRow | undefined> {
    return this.ctx.cache.wrap(connKey(ws, channel), () => this.ctx.db.get<ConnectionRow>("SELECT * FROM channel_connections WHERE workspace_id = ? AND channel = ?", ws, channel));
  }

  async invalidate(ws: string): Promise<void> {
    this.built.delete(`${ws}:sms`);
    this.built.delete(`${ws}:email`);
    await this.ctx.cache.invalidate(`chconn:${ws}:*`);
  }

  private publicUrl() {
    return this.ctx.config.PUBLIC_URL.replace(/\/$/, "");
  }

  private twilio(row: ConnectionRow): SmsProvider {
    const sig = `${row.id}:${row.updated_at}`;
    const hit = this.built.get(`${row.workspace_id}:sms`);
    if (hit && hit.sig === sig) return hit.provider as SmsProvider;
    const c = openCredentials<TwilioCredentials>(this.ctx, row);
    const p = new TwilioSmsProvider(c.account_sid, c.auth_token, (...a) => this.fetchImpl(...a), this.baseUrls.twilio, {
      apiKeySid: c.api_key_sid,
      apiKeySecret: c.api_key_secret,
      timeoutMs: this.ctx.config.PROVIDER_TIMEOUT_MS,
    });
    this.built.set(`${row.workspace_id}:sms`, { sig, provider: p });
    return p;
  }

  private sendgrid(row: ConnectionRow): EmailProvider {
    const sig = `${row.id}:${row.updated_at}`;
    const hit = this.built.get(`${row.workspace_id}:email`);
    if (hit && hit.sig === sig) return hit.provider as EmailProvider;
    const c = openCredentials<SendGridCredentials>(this.ctx, row);
    const p = new SendGridEmailProvider(c.api_key, (...a) => this.fetchImpl(...a), this.baseUrls.sendgrid, this.ctx.config.PROVIDER_TIMEOUT_MS);
    this.built.set(`${row.workspace_id}:email`, { sig, provider: p });
    return p;
  }

  /** The Twilio client of a workspace regardless of connection status (verify and import use it before the connection is trusted). */
  twilioFor(row: ConnectionRow): TwilioSmsProvider {
    const c = openCredentials<TwilioCredentials>(this.ctx, row);
    return new TwilioSmsProvider(c.account_sid, c.auth_token, (...a) => this.fetchImpl(...a), this.baseUrls.twilio, { apiKeySid: c.api_key_sid, apiKeySecret: c.api_key_secret, timeoutMs: this.ctx.config.PROVIDER_TIMEOUT_MS });
  }
  sendgridFor(row: ConnectionRow): SendGridEmailProvider {
    const c = openCredentials<SendGridCredentials>(this.ctx, row);
    return new SendGridEmailProvider(c.api_key, (...a) => this.fetchImpl(...a), this.baseUrls.sendgrid, this.ctx.config.PROVIDER_TIMEOUT_MS);
  }

  async sms(ws: string): Promise<ResolvedSms> {
    const row = await this.connection(ws, "sms");
    if (!row) {
      return { provider: this.ctx.sms, source: "platform", connectionId: null, simulated: !!this.ctx.sms.simulated, statusCallbackUrl: `${this.publicUrl()}/webhooks/twilio/status` };
    }
    const statusCallbackUrl = `${this.publicUrl()}/webhooks/c/${row.webhook_id}/twilio/status`;
    const broken = (why: string): ResolvedSms => ({ provider: new BrokenSms(why), source: "workspace", connectionId: row.id, simulated: false, statusCallbackUrl });
    if (row.status !== "verified") return broken(row.status === "error" ? row.last_error ?? "the provider rejected the credentials" : "the credentials have not been verified yet");
    try {
      return { provider: this.twilio(row), source: "workspace", connectionId: row.id, simulated: false, statusCallbackUrl };
    } catch {
      return broken("the stored credentials cannot be decrypted (was DATA_ENCRYPTION_KEY changed?)");
    }
  }

  async email(ws: string): Promise<ResolvedEmail> {
    const row = await this.connection(ws, "email");
    if (!row) return { provider: this.ctx.email, source: "platform", connectionId: null, simulated: !!this.ctx.email.simulated };
    const broken = (why: string): ResolvedEmail => ({ provider: new BrokenEmail(why), source: "workspace", connectionId: row.id, simulated: false });
    if (row.status !== "verified") return broken(row.status === "error" ? row.last_error ?? "the provider rejected the API key" : "the API key has not been verified yet");
    try {
      return { provider: this.sendgrid(row), source: "workspace", connectionId: row.id, simulated: false };
    } catch {
      return broken("the stored API key cannot be decrypted (was DATA_ENCRYPTION_KEY changed?)");
    }
  }
}
