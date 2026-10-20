import Stripe from "stripe";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { priceIdOf } from "./plans.js";
import { verifyStripeSignature } from "./signature.js";
import type { BillingProvider, ChargeResult, CheckoutInput, StripeEvent } from "./types.js";

const notConfigured = () => new AppError(503, "BILLING_NOT_CONFIGURED", "Billing is not configured on this server");

/** Installs without Stripe credentials: every billing call that needs Stripe answers 503, nothing else in the app is affected. */
export class NullBilling implements BillingProvider {
  readonly name = "none";
  readonly configured = false;
  private no = (): never => {
    throw notConfigured();
  };
  createCustomer = this.no;
  createCheckout = this.no;
  createPortal = this.no;
  getCheckoutPaymentMethod = this.no;
  chargeSavedMethod = this.no;
  createConnectAccount = this.no;
  createConnectLink = this.no;
  getConnectAccount = this.no;
  createPaymentCheckout = this.no;
  expirePaymentCheckout = this.no;
  verifyWebhook = (): never => {
    throw new AppError(401, "WEBHOOK_NOT_CONFIGURED", "Stripe webhooks are not configured");
  };
}

/** The real Stripe SDK. The SDK is typed very strictly; this file is the one place that talks to it, so loose casts stay local. */
export class StripeBilling implements BillingProvider {
  readonly name = "stripe";
  readonly configured = true;
  private readonly s: any;

  constructor(private readonly config: Config) {
    this.s = new Stripe(config.STRIPE_SECRET_KEY!, { maxNetworkRetries: 2, timeout: 15_000, appInfo: { name: "conversations" } });
  }

  async createCustomer(i: { workspaceId: string; name: string; email?: string }) {
    const c = await this.s.customers.create({ name: i.name, email: i.email, metadata: { workspace_id: i.workspaceId } }, { idempotencyKey: `cust:${i.workspaceId}` });
    return { id: c.id as string };
  }

  async createCheckout(i: CheckoutInput) {
    const common = { customer: i.customerId, success_url: i.successUrl, cancel_url: i.cancelUrl, client_reference_id: i.metadata.workspace_id, metadata: i.metadata };
    let session;
    if (i.mode === "subscription") {
      const price = i.plan ? priceIdOf(this.config, i.plan) : undefined;
      if (!price) throw new AppError(503, "BILLING_NOT_CONFIGURED", `No Stripe price is configured for the ${i.plan} plan`);
      session = await this.s.checkout.sessions.create({ ...common, mode: "subscription", line_items: [{ price, quantity: 1 }], subscription_data: { metadata: i.metadata } });
    } else {
      session = await this.s.checkout.sessions.create({
        ...common,
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: i.currency, unit_amount: i.amountCents, product_data: { name: `${i.credits} message credits` } } }],
        // the card is kept for auto-recharge; off_session charges are SCA-exempt only after the customer authorised this first one
        payment_intent_data: { setup_future_usage: "off_session", metadata: i.metadata },
      });
    }
    return { id: session.id as string, url: session.url as string };
  }

  async createPortal(i: { customerId: string; returnUrl: string }) {
    const p = await this.s.billingPortal.sessions.create({ customer: i.customerId, return_url: i.returnUrl });
    return { url: p.url as string };
  }

  async getCheckoutPaymentMethod(sessionId: string) {
    const session = await this.s.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent.payment_method"] });
    const pm = session.payment_intent?.payment_method;
    if (!pm || typeof pm === "string") return null;
    return { id: pm.id as string, brand: (pm.card?.brand as string) ?? "card", last4: (pm.card?.last4 as string) ?? "" };
  }

  async chargeSavedMethod(i: { customerId: string; paymentMethodId: string; amountCents: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<ChargeResult> {
    try {
      const pi = await this.s.paymentIntents.create(
        { amount: i.amountCents, currency: i.currency, customer: i.customerId, payment_method: i.paymentMethodId, off_session: true, confirm: true, metadata: i.metadata },
        { idempotencyKey: i.idempotencyKey },
      );
      if (pi.status === "succeeded") return { id: pi.id, status: "succeeded" };
      return { id: pi.id, status: pi.status === "requires_action" ? "requires_action" : "failed", error: pi.status };
    } catch (e) {
      const err = e as { payment_intent?: { id: string; status: string }; message?: string; code?: string };
      return { id: err.payment_intent?.id ?? "", status: err.payment_intent?.status === "requires_action" ? "requires_action" : "failed", error: err.code ?? err.message ?? "charge failed" };
    }
  }

  async createConnectAccount(i: { workspaceId: string; email?: string }) {
    const a = await this.s.accounts.create({ type: "standard", email: i.email, metadata: { workspace_id: i.workspaceId } }, { idempotencyKey: `acct:${i.workspaceId}` });
    return { id: a.id as string };
  }

  async createConnectLink(i: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const l = await this.s.accountLinks.create({ account: i.accountId, refresh_url: i.refreshUrl, return_url: i.returnUrl, type: "account_onboarding" });
    return { url: l.url as string };
  }

  async getConnectAccount(accountId: string) {
    const a = await this.s.accounts.retrieve(accountId);
    return { chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted };
  }

  async createPaymentCheckout(i: { accountId: string; amountCents: number; currency: string; description: string; feeCents: number; successUrl: string; cancelUrl: string; expiresAt: number; metadata: Record<string, string> }) {
    // a direct charge on the connected account: the money and the dispute liability are the customer's, the platform keeps only the fee
    const session = await this.s.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: i.currency, unit_amount: i.amountCents, product_data: { name: i.description.slice(0, 120) } } }],
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
        expires_at: i.expiresAt,
        metadata: i.metadata,
        payment_intent_data: { metadata: i.metadata, ...(i.feeCents > 0 ? { application_fee_amount: i.feeCents } : {}) },
      },
      { stripeAccount: i.accountId },
    );
    return { id: session.id as string, url: session.url as string };
  }

  async expirePaymentCheckout(i: { accountId: string; sessionId: string }) {
    await this.s.checkout.sessions.expire(i.sessionId, {}, { stripeAccount: i.accountId });
  }

  verifyWebhook(rawBody: string, signature: string | undefined, kind: "platform" | "connect"): StripeEvent {
    const secret = kind === "platform" ? this.config.STRIPE_WEBHOOK_SECRET : this.config.STRIPE_CONNECT_WEBHOOK_SECRET;
    return verifyStripeSignature(secret, rawBody, signature, this.config.WEBHOOK_TOLERANCE_SECONDS);
  }
}

export const createBilling = (config: Config): BillingProvider => (config.STRIPE_SECRET_KEY ? new StripeBilling(config) : new NullBilling());
