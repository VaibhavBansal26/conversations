import type { PlanId } from "./plans.js";

/** The subset of a Stripe event the app reads. Real events and the fake's events have the same shape. */
export interface StripeEvent {
  id: string;
  type: string;
  /** unix seconds the event was created */
  created?: number;
  /** set on Connect events: the connected account the event belongs to */
  account?: string;
  data: { object: Record<string, any> };
}

export interface CheckoutInput {
  customerId: string;
  mode: "subscription" | "payment";
  plan?: PlanId;
  /** payment mode: what is being bought */
  credits?: number;
  amountCents?: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface ChargeResult {
  id: string;
  status: "succeeded" | "failed" | "requires_action";
  error?: string;
}

/**
 * Everything the app needs from Stripe, behind one interface so tests (and installs without a Stripe account) use `FakeBilling`/`NullBilling`
 * and production uses `StripeBilling`. No other module imports the Stripe SDK.
 */
export interface BillingProvider {
  readonly name: string;
  /** false = no Stripe credentials: checkout/portal/Connect answer 503 and the rest of the app is unaffected */
  readonly configured: boolean;
  createCustomer(i: { workspaceId: string; name: string; email?: string }): Promise<{ id: string }>;
  createCheckout(i: CheckoutInput): Promise<{ id: string; url: string }>;
  createPortal(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** the card a completed top-up checkout saved for later off-session charges */
  getCheckoutPaymentMethod(sessionId: string): Promise<{ id: string; brand: string; last4: string } | null>;
  chargeSavedMethod(i: { customerId: string; paymentMethodId: string; amountCents: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<ChargeResult>;

  /* Connect Standard: the customer's own Stripe account receives the money */
  createConnectAccount(i: { workspaceId: string; email?: string }): Promise<{ id: string }>;
  createConnectLink(i: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  getConnectAccount(accountId: string): Promise<{ chargesEnabled: boolean; detailsSubmitted: boolean }>;
  createPaymentCheckout(i: {
    accountId: string;
    amountCents: number;
    currency: string;
    description: string;
    feeCents: number;
    successUrl: string;
    cancelUrl: string;
    /** unix seconds; Stripe allows 30 minutes to 24 hours */
    expiresAt: number;
    metadata: Record<string, string>;
  }): Promise<{ id: string; url: string }>;
  expirePaymentCheckout(i: { accountId: string; sessionId: string }): Promise<void>;

  /** verifies the signature and parses the event; throws on a bad signature or a stale timestamp */
  verifyWebhook(rawBody: string, signature: string | undefined, kind: "platform" | "connect"): StripeEvent;
}
