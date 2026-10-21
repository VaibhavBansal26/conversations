import { DEFAULT_PROVIDER_TIMEOUT_MS, mapSendGridError, timedFetch } from "./errors.js";
import { ProviderError, type EmailProvider, type EmailSendInput, type EmailSendResult } from "./types.js";

type Fetch = typeof fetch;

export interface SendGridSender {
  id: number | string;
  email: string;
  name: string;
  verified: boolean;
}

/** SendGrid v3 over plain fetch (no SDK). Constructed per workspace from its own API key, or once from the platform's environment. */
export class SendGridEmailProvider implements EmailProvider {
  readonly name = "sendgrid";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = "https://api.sendgrid.com",
    private readonly timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  private fail(status: number, json: { errors?: { message?: string }[] }): ProviderError {
    const message = json.errors?.[0]?.message ?? "request failed";
    const mapped = mapSendGridError(status, message);
    return new ProviderError(`SendGrid ${status}: ${message}`, mapped.retryable, status, mapped.code, mapped.hint);
  }

  private async get(path: string): Promise<{ res: Response; json: Record<string, unknown> }> {
    const res = await timedFetch(this.fetchImpl, `${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` } }, "SendGrid", this.timeoutMs);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, json };
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const headers: Record<string, string> = { "Message-ID": input.messageId };
    if (input.inReplyTo) headers["In-Reply-To"] = input.inReplyTo;
    if (input.references?.length) headers["References"] = input.references.join(" ");
    const payload = {
      personalizations: [{ to: [{ email: input.to }] }],
      from: { email: input.from.address, ...(input.from.name ? { name: input.from.name } : {}) },
      ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
      subject: input.subject,
      content: [
        { type: "text/plain", value: input.text || " " },
        { type: "text/html", value: input.html || input.text || " " },
      ],
      headers,
      ...(input.attachments?.length
        ? { attachments: input.attachments.map((a) => ({ content: a.content.toString("base64"), filename: a.filename, type: a.contentType, disposition: "attachment" })) }
        : {}),
      tracking_settings: { open_tracking: { enable: true } },
    };
    const res = await timedFetch(
      this.fetchImpl,
      `${this.baseUrl}/v3/mail/send`,
      { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      "SendGrid",
      this.timeoutMs,
    );
    if (res.status !== 202 && !res.ok) throw this.fail(res.status, (await res.json().catch(() => ({}))) as never);
    return { providerMessageId: res.headers.get("x-message-id") ?? input.messageId };
  }

  /** Read-only: the permissions of this API key. A usable key has `mail.send`. */
  async fetchScopes(): Promise<string[]> {
    const { res, json } = await this.get("/v3/scopes");
    if (!res.ok) throw this.fail(res.status, json as never);
    if (!Array.isArray(json.scopes)) throw new ProviderError("SendGrid answered without a scope list", false, res.status, "malformed_response", "SendGrid returned an unexpected answer.");
    return (json.scopes as unknown[]).filter((s): s is string => typeof s === "string");
  }

  /** Read-only: single-sender verifications on the account. Needs the sender-authentication permission, so a restricted key gets `null` instead of an error. */
  async listVerifiedSenders(): Promise<SendGridSender[] | null> {
    const { res, json } = await this.get("/v3/verified_senders");
    if (res.status === 401) throw this.fail(res.status, json as never);
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw this.fail(res.status, json as never);
    if (!Array.isArray(json.results)) throw new ProviderError("SendGrid answered without a sender list", false, res.status, "malformed_response", "SendGrid returned an unexpected answer.");
    return (json.results as Record<string, unknown>[])
      .filter((r) => typeof r.from_email === "string")
      .map((r) => ({ id: (r.id as number | string) ?? "", email: String(r.from_email).toLowerCase(), name: String(r.from_name ?? ""), verified: r.verified === true }));
  }

  /** Read-only: authenticated sending domains (domain authentication). `null` when the key may not read them. */
  async listAuthenticatedDomains(): Promise<{ domain: string; valid: boolean }[] | null> {
    const { res, json } = await this.get("/v3/whitelabel/domains");
    if (res.status === 401) throw this.fail(res.status, json as never);
    if (!res.ok) return null;
    const list = Array.isArray(json) ? json : [];
    return (list as Record<string, unknown>[]).filter((d) => typeof d.domain === "string").map((d) => ({ domain: String(d.domain), valid: d.valid === true }));
  }
}
