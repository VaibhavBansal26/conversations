import type { Config } from "../config.js";
import { verifyStripeSignature, signStripePayload } from "./signature.js";
import type { BillingProvider, ChargeResult, CheckoutInput, StripeEvent } from "./types.js";

export interface FakeSession {
  id: string;
  url: string;
  account?: string;
  input: Record<string, unknown>;
  expired?: boolean;
}

/**
 * In-memory Stripe for tests and local development: deterministic ids, a record of every call, switchable failures, and a signed-event
 * builder so webhook tests exercise the real signature check. Behaviourally it only does what the app relies on.
 */
export class FakeBilling implements BillingProvider {
  readonly name = "fake";
  readonly configured = true;
  readonly customers: { id: string; workspaceId: string }[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly charges: { id: string; amountCents: number; customerId: string; idempotencyKey: string }[] = [];
  readonly portals: string[] = [];
  readonly accounts = new Map<string, { chargesEnabled: boolean; detailsSubmitted: boolean }>();
  /** next saved-method charge result */
  chargeOutcome: "succeeded" | "failed" | "requires_action" = "succeeded";
  /** the card a completed top-up checkout "saves" */
  card: { id: string; brand: string; last4: string } | null = { id: "pm_fake_1", brand: "visa", last4: "4242" };
  private n = 0;
  private charged = new Map<string, ChargeResult>();
  readonly platformSecret = "whsec_platform_test";
  readonly connectSecret = "whsec_connect_test";

  constructor(private readonly config?: Pick<Config, "WEBHOOK_TOLERANCE_SECONDS">) {}

  private id(p: string) {
    return `${p}_${(++this.n).toString().padStart(4, "0")}`;
  }

  async createCustomer(i: { workspaceId: string }) {
    const c = { id: this.id("cus"), workspaceId: i.workspaceId };
    this.customers.push(c);
    return { id: c.id };
  }

  async createCheckout(i: CheckoutInput) {
    const id = this.id("cs");
    const s: FakeSession = { id, url: `https://checkout.stripe.test/${id}`, input: { ...i } };
    this.sessions.set(id, s);
    return { id, url: s.url };
  }

  async createPortal(i: { customerId: string }) {
    this.portals.push(i.customerId);
    return { url: `https://billing.stripe.test/portal/${i.customerId}` };
  }

  async getCheckoutPaymentMethod() {
    return this.card;
  }

  async chargeSavedMethod(i: { customerId: string; paymentMethodId: string; amountCents: number; idempotencyKey: string }): Promise<ChargeResult> {
    // Stripe returns the first result for a repeated idempotency key
    const prior = this.charged.get(i.idempotencyKey);
    if (prior) return prior;
    const r: ChargeResult = this.chargeOutcome === "succeeded" ? { id: this.id("pi"), status: "succeeded" } : { id: this.id("pi"), status: this.chargeOutcome, error: this.chargeOutcome === "failed" ? "card_declined" : "authentication_required" };
    this.charged.set(i.idempotencyKey, r);
    this.charges.push({ id: r.id, amountCents: i.amountCents, customerId: i.customerId, idempotencyKey: i.idempotencyKey });
    return r;
  }

  async createConnectAccount() {
    const id = this.id("acct");
    this.accounts.set(id, { chargesEnabled: false, detailsSubmitted: false });
    return { id };
  }

  async createConnectLink(i: { accountId: string }) {
    return { url: `https://connect.stripe.test/onboard/${i.accountId}` };
  }

  async getConnectAccount(accountId: string) {
    return this.accounts.get(accountId) ?? { chargesEnabled: false, detailsSubmitted: false };
  }

  async createPaymentCheckout(i: { accountId: string; metadata: Record<string, string> } & Record<string, unknown>) {
    const id = this.id("cs_live");
    const s: FakeSession = { id, url: `https://checkout.stripe.test/pay/${id}`, account: i.accountId, input: { ...i } };
    this.sessions.set(id, s);
    return { id, url: s.url };
  }

  async expirePaymentCheckout(i: { sessionId: string }) {
    const s = this.sessions.get(i.sessionId);
    if (s) s.expired = true;
  }

  verifyWebhook(rawBody: string, signature: string | undefined, kind: "platform" | "connect"): StripeEvent {
    return verifyStripeSignature(kind === "platform" ? this.platformSecret : this.connectSecret, rawBody, signature, this.config?.WEBHOOK_TOLERANCE_SECONDS ?? 300);
  }

  /** Build a signed webhook request body + header for the given event. */
  signed(kind: "platform" | "connect", event: { id?: string; type: string; account?: string; created?: number; object: Record<string, unknown> }): { body: string; signature: string; event: StripeEvent } {
    const e: StripeEvent = { id: event.id ?? this.id("evt"), type: event.type, created: event.created ?? Math.floor(Date.now() / 1000), ...(event.account ? { account: event.account } : {}), data: { object: event.object } };
    const body = JSON.stringify({ ...e, object: "event" });
    return { body, signature: signStripePayload(kind === "platform" ? this.platformSecret : this.connectSecret, body), event: e };
  }
}
