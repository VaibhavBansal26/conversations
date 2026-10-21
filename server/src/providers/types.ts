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

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Permanent failures (bad number, 4xx) are not retried automatically. */
    public readonly retryable: boolean,
    public readonly status?: number,
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
