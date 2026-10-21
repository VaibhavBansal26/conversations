import { DEFAULT_PROVIDER_TIMEOUT_MS, mapTwilioError, timedFetch } from "./errors.js";
import { ProviderError, type ProviderDeliveryState, type SmsProvider, type SmsSendInput, type SmsSendResult } from "./types.js";

type Fetch = typeof fetch;

export interface TwilioOptions {
  /** REST calls authenticate with this API key instead of the auth token (the auth token is still what signs webhooks) */
  apiKeySid?: string;
  apiKeySecret?: string;
  timeoutMs?: number;
}

export interface TwilioAccountInfo {
  sid: string;
  friendly_name: string;
  status: string;
  /** "Trial" or "Full" */
  type: string;
}
export interface TwilioNumber {
  sid: string;
  e164: string;
  label: string;
  sms_capable: boolean;
}

/** Twilio Programmable SMS over plain fetch (no SDK). Constructed per workspace from its own credentials, or once from the platform's environment. */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  private readonly timeoutMs: number;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = "https://api.twilio.com",
    private readonly opts: TwilioOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  private get auth() {
    const user = this.opts.apiKeySid && this.opts.apiKeySecret ? this.opts.apiKeySid : this.accountSid;
    const pass = this.opts.apiKeySid && this.opts.apiKeySecret ? this.opts.apiKeySecret : this.authToken;
    return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  private async call(path: string, init: RequestInit = {}): Promise<{ res: Response; json: Record<string, unknown> }> {
    const res = await timedFetch(this.fetchImpl, `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}${path}`, { ...init, headers: { Authorization: this.auth, ...(init.headers as Record<string, string> | undefined) } }, "Twilio", this.timeoutMs);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, json };
  }

  private fail(status: number, json: Record<string, unknown>): ProviderError {
    const code = typeof json.code === "number" ? json.code : undefined;
    const message = typeof json.message === "string" ? json.message : "request failed";
    const mapped = mapTwilioError(status, code, message);
    return new ProviderError(`Twilio ${status}: ${message}${code ? ` (code ${code})` : ""}`, mapped.retryable, status, mapped.code, mapped.hint);
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const body = new URLSearchParams({ To: input.to, From: input.from, Body: input.body });
    if (input.statusCallbackUrl) body.set("StatusCallback", input.statusCallbackUrl);
    const { res, json } = await this.call("/Messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "I-Twilio-Idempotency-Token": input.idempotencyKey },
      body,
    });
    if (!res.ok) throw this.fail(res.status, json);
    if (typeof json.sid !== "string") throw new ProviderError("Twilio answered without a message id", false, res.status, "malformed_response", "Twilio returned an unexpected answer. Check the Twilio Console message log before retrying.");
    return { providerMessageId: json.sid };
  }

  /** Read-only: fetch the account. Proves the SID and token work and tells trial from full accounts. */
  async fetchAccount(): Promise<TwilioAccountInfo> {
    const { res, json } = await this.call(".json");
    if (!res.ok) throw this.fail(res.status, json);
    if (typeof json.sid !== "string") throw new ProviderError("Twilio answered without an account", false, res.status, "malformed_response", "Twilio returned an unexpected answer.");
    return { sid: json.sid, friendly_name: String(json.friendly_name ?? ""), status: String(json.status ?? "unknown"), type: String(json.type ?? "unknown") };
  }

  /** Read-only: the phone numbers this account owns (first 100). */
  async listNumbers(): Promise<TwilioNumber[]> {
    const { res, json } = await this.call("/IncomingPhoneNumbers.json?PageSize=100");
    if (!res.ok) throw this.fail(res.status, json);
    if (!Array.isArray(json.incoming_phone_numbers)) throw new ProviderError("Twilio answered without a number list", false, res.status, "malformed_response", "Twilio returned an unexpected answer.");
    return (json.incoming_phone_numbers as Record<string, unknown>[])
      .filter((n) => typeof n.phone_number === "string")
      .map((n) => ({
        sid: String(n.sid ?? ""),
        e164: n.phone_number as string,
        label: String(n.friendly_name ?? ""),
        sms_capable: (n.capabilities as { sms?: boolean } | undefined)?.sms !== false,
      }));
  }

  /**
   * Network Traversal Service: short-lived STUN and TURN credentials for one call, minted with this workspace's own Twilio account.
   * (Twilio bills relayed media to that account; the token itself is free.)
   */
  async networkTraversalToken(ttlSeconds: number): Promise<{ iceServers: { urls: string[]; username?: string; credential?: string }[]; ttl: number }> {
    const { res, json } = await this.call("/Tokens.json", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Ttl: String(ttlSeconds) }) });
    if (!res.ok) throw this.fail(res.status, json);
    if (!Array.isArray(json.ice_servers)) throw new ProviderError("Twilio answered without ICE servers", false, res.status, "malformed_response", "Twilio returned an unexpected answer.");
    const iceServers = (json.ice_servers as Record<string, unknown>[])
      .map((s) => ({ urls: [String(s.urls ?? s.url ?? "")].filter((u) => /^(stun|turn)s?:/i.test(u)), username: typeof s.username === "string" ? s.username : undefined, credential: typeof s.credential === "string" ? s.credential : undefined }))
      .filter((s) => s.urls.length);
    return { iceServers, ttl: Number(json.ttl) > 0 ? Number(json.ttl) : ttlSeconds };
  }

  /**
   * Voice: place the first leg of a click-to-call (to the agent). When the agent answers Twilio fetches `url` for TwiML; progress comes back
   * to `statusCallback`. The idempotency token makes a retried request create one call.
   */
  async createCall(i: { to: string; from: string; url: string; statusCallback: string; timeoutS: number; idempotencyKey: string }): Promise<{ sid: string }> {
    const body = new URLSearchParams({ To: i.to, From: i.from, Url: i.url, Method: "POST", StatusCallback: i.statusCallback, StatusCallbackMethod: "POST", Timeout: String(i.timeoutS) });
    for (const e of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", e);
    const { res, json } = await this.call("/Calls.json", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "I-Twilio-Idempotency-Token": i.idempotencyKey }, body });
    if (!res.ok) throw this.fail(res.status, json);
    if (typeof json.sid !== "string") throw new ProviderError("Twilio answered without a call id", false, res.status, "malformed_response", "Twilio returned an unexpected answer. Check the Twilio Console call log.");
    return { sid: json.sid };
  }

  /** Hang up (`completed`) or cancel a call that has not been answered. */
  async endCall(sid: string): Promise<void> {
    const { res, json } = await this.call(`/Calls/${encodeURIComponent(sid)}.json`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Status: "completed" }) });
    // 404 and 21220 (already completed) mean the call is over, which is what was wanted
    if (!res.ok && res.status !== 404 && json.code !== 21220) throw this.fail(res.status, json);
  }

  async fetchStatus(id: string): Promise<{ state: ProviderDeliveryState; error?: string }> {
    const { res, json: j } = await this.call(`/Messages/${encodeURIComponent(id)}.json`);
    if (!res.ok) return { state: "unknown" };
    switch (j.status) {
      case "delivered":
        return { state: "delivered" };
      case "failed":
      case "undelivered":
        return { state: "failed", error: j.error_code ? `Carrier error ${String(j.error_code)}` : "Undelivered" };
      case "queued":
      case "sending":
      case "sent":
      case "accepted":
        return { state: "sent" };
      default:
        return { state: "unknown" };
    }
  }
}
