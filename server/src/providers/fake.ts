import type { EmailProvider, EmailSendInput, EmailSendResult, ProviderDeliveryState, SmsProvider, SmsSendInput, SmsSendResult } from "./types.js";
import { ProviderError } from "./types.js";
import type { Logger } from "../logger.js";

interface FailPlan {
  remaining: number;
  retryable: boolean;
  message: string;
}

/** Deterministic in-memory SMS provider. `ConsoleSmsProvider` is the same thing plus log lines. */
export class FakeSmsProvider implements SmsProvider {
  readonly name: string = "fake";
  readonly sent: (SmsSendInput & SmsSendResult)[] = [];
  readonly statuses = new Map<string, ProviderDeliveryState>();
  private n = 0;
  private plan: FailPlan | null = null;

  failNext(times = 1, opts: { retryable?: boolean; message?: string } = {}) {
    this.plan = { remaining: times, retryable: opts.retryable ?? true, message: opts.message ?? "simulated provider failure" };
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    if (this.plan && this.plan.remaining > 0) {
      this.plan.remaining--;
      throw new ProviderError(this.plan.message, this.plan.retryable);
    }
    const providerMessageId = `fake_sms_${++this.n}`;
    this.sent.push({ ...input, providerMessageId });
    this.statuses.set(providerMessageId, "sent");
    return { providerMessageId };
  }

  async fetchStatus(id: string) {
    return { state: this.statuses.get(id) ?? ("unknown" as ProviderDeliveryState) };
  }
}

export class FakeEmailProvider implements EmailProvider {
  readonly name: string = "fake";
  readonly sent: (EmailSendInput & EmailSendResult)[] = [];
  private n = 0;
  private plan: FailPlan | null = null;

  failNext(times = 1, opts: { retryable?: boolean; message?: string } = {}) {
    this.plan = { remaining: times, retryable: opts.retryable ?? true, message: opts.message ?? "simulated provider failure" };
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    if (this.plan && this.plan.remaining > 0) {
      this.plan.remaining--;
      throw new ProviderError(this.plan.message, this.plan.retryable);
    }
    const providerMessageId = `fake_email_${++this.n}`;
    this.sent.push({ ...input, providerMessageId });
    return { providerMessageId };
  }
}

export class ConsoleSmsProvider extends FakeSmsProvider {
  override readonly name = "console";
  constructor(private readonly log: Logger) {
    super();
  }
  override async send(input: SmsSendInput) {
    const r = await super.send(input);
    this.log.info("sms (console provider)", { to: input.to, from: input.from, chars: input.body.length, id: r.providerMessageId });
    return r;
  }
}

export class ConsoleEmailProvider extends FakeEmailProvider {
  override readonly name = "console";
  constructor(private readonly log: Logger) {
    super();
  }
  override async send(input: EmailSendInput) {
    const r = await super.send(input);
    this.log.info("email (console provider)", { to: input.to, from: input.from.address, subject: input.subject, id: r.providerMessageId });
    return r;
  }
}
