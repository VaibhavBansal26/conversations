import { ProviderError, type EmailProvider, type EmailSendInput, type EmailSendResult } from "./types.js";

type Fetch = typeof fetch;

/** SendGrid v3 mail/send over plain fetch (no SDK). Only constructed when EMAIL_PROVIDER=sendgrid. */
export class SendGridEmailProvider implements EmailProvider {
  readonly name = "sendgrid";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = "https://api.sendgrid.com",
  ) {}

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
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v3/mail/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new ProviderError(`SendGrid unreachable: ${e instanceof Error ? e.message : "network error"}`, true);
    }
    if (res.status !== 202 && !res.ok) {
      const j = (await res.json().catch(() => ({}))) as { errors?: { message?: string }[] };
      throw new ProviderError(`SendGrid ${res.status}: ${j.errors?.[0]?.message ?? "request failed"}`, res.status === 429 || res.status >= 500, res.status);
    }
    return { providerMessageId: res.headers.get("x-message-id") ?? input.messageId };
  }
}
