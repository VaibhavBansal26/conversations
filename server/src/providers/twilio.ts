import { ProviderError, type ProviderDeliveryState, type SmsProvider, type SmsSendInput, type SmsSendResult } from "./types.js";

type Fetch = typeof fetch;

/** Twilio Programmable SMS over plain fetch (no SDK). Only constructed when SMS_PROVIDER=twilio. */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = "https://api.twilio.com",
  ) {}

  private get auth() {
    return "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const body = new URLSearchParams({ To: input.to, From: input.from, Body: input.body });
    if (input.statusCallbackUrl) body.set("StatusCallback", input.statusCallbackUrl);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: this.auth, "Content-Type": "application/x-www-form-urlencoded", "I-Twilio-Idempotency-Token": input.idempotencyKey },
        body,
      });
    } catch (e) {
      throw new ProviderError(`Twilio unreachable: ${e instanceof Error ? e.message : "network error"}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok || !json.sid) {
      // 4xx (bad number, unverified sender, auth) will not get better by retrying; 429 and 5xx will
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`Twilio ${res.status}: ${json.message ?? "request failed"}${json.code ? ` (code ${json.code})` : ""}`, retryable, res.status);
    }
    return { providerMessageId: json.sid };
  }

  async fetchStatus(id: string): Promise<{ state: ProviderDeliveryState; error?: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages/${encodeURIComponent(id)}.json`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) return { state: "unknown" };
    const j = (await res.json()) as { status?: string; error_code?: number | null };
    switch (j.status) {
      case "delivered":
        return { state: "delivered" };
      case "failed":
      case "undelivered":
        return { state: "failed", error: j.error_code ? `Carrier error ${j.error_code}` : "Undelivered" };
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
