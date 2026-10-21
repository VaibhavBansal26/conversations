export interface SmsSendInput {
  to: string;
  from: string;
  body: string;
  /** Stable per message so a retry never produces two texts at providers that honour it. */
  idempotencyKey: string;
  statusCallbackUrl?: string;
}
export interface SmsSendResult {
  providerMessageId: string;
}
export type ProviderDeliveryState = "sent" | "delivered" | "failed" | "unknown";

export interface SmsProvider {
  readonly name: string;
  /**
   * true when nothing leaves this process (the console/fake providers): the service stores the message as `not_sent_test_mode`
   * instead of pretending it was sent. Real adapters leave it undefined.
   */
  readonly simulated?: boolean;
  send(input: SmsSendInput): Promise<SmsSendResult>;
  /** Used by the reconciliation job when status webhooks were missed. */
  fetchStatus?(providerMessageId: string): Promise<{ state: ProviderDeliveryState; error?: string }>;
}

export interface EmailSendInput {
  from: { address: string; name?: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
  /** extra headers, from an allow-list (Auto-Submitted, X-Auto-Response-Suppress, X-Conversations-Bot) */
  extraHeaders?: Record<string, string>;
}
export interface EmailSendResult {
  providerMessageId: string;
}
export interface EmailProvider {
  readonly name: string;
  /** see SmsProvider.simulated */
  readonly simulated?: boolean;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

/**
 * Normalised failure classes, mapped from each provider's own codes so the UI can say what to do about them
 * (see providers/errors.ts). `provider_error` is the catch-all.
 */
export type ProviderErrorCode =
  | "auth_failed"
  | "account_suspended"
  | "unverified_sender"
  | "unverified_number"
  | "trial_restriction"
  | "insufficient_funds"
  | "rate_limited"
  | "invalid_recipient"
  | "invalid_sender"
  | "recipient_opted_out"
  | "permission_denied"
  | "timeout"
  | "unreachable"
  | "malformed_response"
  | "credentials_unusable"
  | "provider_error";

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Permanent failures (bad number, 4xx) are not retried automatically. */
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly code: ProviderErrorCode = "provider_error",
    /** One sentence telling a workspace admin what to do about it */
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface StoredFile {
  key: string;
  size: number;
}
export interface Storage {
  put(workspaceId: string, file: { name: string; contentType: string; content: Buffer }): Promise<StoredFile>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  /** A time-limited URL the browser can GET without credentials. */
  signedUrl(key: string, opts: { fileName: string; contentType: string; ttlSeconds: number }): string;
}
