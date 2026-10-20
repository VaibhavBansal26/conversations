import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { signStripePayload } from "../src/billing/signature.js";
import { NullBilling, StripeBilling } from "../src/billing/stripe.js";

const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "x".repeat(32), STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_a", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_b", STRIPE_PRICE_PRO: "price_pro" }, () => {});

/** The real provider class driven against a recording stub of the SDK: checks the exact requests we would send to Stripe. */
function provider() {
  const calls: { fn: string; args: any[] }[] = [];
  const rec = (fn: string, result: unknown) => async (...args: any[]) => {
    calls.push({ fn, args });
    return typeof result === "function" ? (result as (...a: any[]) => unknown)(...args) : result;
  };
  const p = new StripeBilling(config);
  (p as any).s = {
    customers: { create: rec("customers.create", { id: "cus_1" }) },
    checkout: {
      sessions: {
        create: rec("sessions.create", { id: "cs_1", url: "https://stripe.test/cs_1" }),
        retrieve: rec("sessions.retrieve", { payment_intent: { payment_method: { id: "pm_1", card: { brand: "visa", last4: "4242" } } } }),
        expire: rec("sessions.expire", {}),
      },
    },
    billingPortal: { sessions: { create: rec("portal.create", { url: "https://stripe.test/portal" }) } },
    paymentIntents: { create: rec("pi.create", { id: "pi_1", status: "succeeded" }) },
    accounts: { create: rec("accounts.create", { id: "acct_1" }), retrieve: rec("accounts.retrieve", { charges_enabled: true, details_submitted: true }) },
    accountLinks: { create: rec("links.create", { url: "https://connect.stripe.test/x" }) },
  };
  return { p, calls };
}

describe("StripeBilling request shapes", () => {
  it("subscription checkout uses the configured price and carries our ids in the metadata of both the session and the subscription", async () => {
    const { p, calls } = provider();
    await p.createCheckout({ customerId: "cus_1", mode: "subscription", plan: "pro", currency: "usd", successUrl: "s", cancelUrl: "c", metadata: { workspace_id: "ws_1", plan: "pro" } });
    const a = calls[0]!.args[0];
    expect(a).toMatchObject({ mode: "subscription", customer: "cus_1", line_items: [{ price: "price_pro", quantity: 1 }], metadata: { workspace_id: "ws_1" }, subscription_data: { metadata: { workspace_id: "ws_1" } } });
  });

  it("a plan without a configured price is a clear 503, not a Stripe error", async () => {
    const { p } = provider();
    await expect(p.createCheckout({ customerId: "c", mode: "subscription", plan: "business", currency: "usd", successUrl: "s", cancelUrl: "c", metadata: {} })).rejects.toMatchObject({ status: 503, code: "BILLING_NOT_CONFIGURED" });
  });

  it("top-up checkout charges the computed amount and saves the card for off-session use", async () => {
    const { p, calls } = provider();
    await p.createCheckout({ customerId: "cus_1", mode: "payment", credits: 1000, amountCents: 2000, currency: "usd", successUrl: "s", cancelUrl: "c", metadata: { workspace_id: "ws_1", kind: "topup" } });
    expect(calls[0]!.args[0]).toMatchObject({ mode: "payment", line_items: [{ price_data: { unit_amount: 2000, currency: "usd" } }], payment_intent_data: { setup_future_usage: "off_session", metadata: { kind: "topup" } } });
    expect(await p.getCheckoutPaymentMethod("cs_1")).toEqual({ id: "pm_1", brand: "visa", last4: "4242" });
  });

  it("saved-card charges are off-session, confirmed, and carry the idempotency key; declines become a result, not an exception", async () => {
    const { p, calls } = provider();
    const ok = await p.chargeSavedMethod({ customerId: "cus_1", paymentMethodId: "pm_1", amountCents: 2000, currency: "usd", metadata: { kind: "auto_recharge" }, idempotencyKey: "recharge:ws_1:7" });
    expect(ok).toEqual({ id: "pi_1", status: "succeeded" });
    expect(calls[0]!.args[0]).toMatchObject({ off_session: true, confirm: true, payment_method: "pm_1", customer: "cus_1", amount: 2000 });
    expect(calls[0]!.args[1]).toEqual({ idempotencyKey: "recharge:ws_1:7" });
    (p as any).s.paymentIntents.create = async () => {
      throw Object.assign(new Error("Your card was declined."), { code: "card_declined", payment_intent: { id: "pi_2", status: "requires_payment_method" } });
    };
    expect(await p.chargeSavedMethod({ customerId: "c", paymentMethodId: "pm", amountCents: 1, currency: "usd", metadata: {}, idempotencyKey: "k" })).toEqual({ id: "pi_2", status: "failed", error: "card_declined" });
    (p as any).s.paymentIntents.create = async () => {
      throw Object.assign(new Error("auth"), { code: "authentication_required", payment_intent: { id: "pi_3", status: "requires_action" } });
    };
    expect((await p.chargeSavedMethod({ customerId: "c", paymentMethodId: "pm", amountCents: 1, currency: "usd", metadata: {}, idempotencyKey: "k2" })).status).toBe("requires_action");
  });

  it("customer payments are direct charges on the connected account with the platform fee, and expiry targets the same account", async () => {
    const { p, calls } = provider();
    await p.createPaymentCheckout({ accountId: "acct_9", amountCents: 5000, currency: "usd", description: "Deposit", feeCents: 50, successUrl: "s", cancelUrl: "c", expiresAt: 1_900_000_000, metadata: { payment_request_id: "pay_1" } });
    expect(calls[0]!.args[0]).toMatchObject({ mode: "payment", expires_at: 1_900_000_000, payment_intent_data: { application_fee_amount: 50, metadata: { payment_request_id: "pay_1" } } });
    expect(calls[0]!.args[1]).toEqual({ stripeAccount: "acct_9" });
    await p.createPaymentCheckout({ accountId: "acct_9", amountCents: 5000, currency: "usd", description: "No fee", feeCents: 0, successUrl: "s", cancelUrl: "c", expiresAt: 1, metadata: {} });
    expect(calls[1]!.args[0].payment_intent_data.application_fee_amount).toBeUndefined();
    await p.expirePaymentCheckout({ accountId: "acct_9", sessionId: "cs_1" });
    expect(calls[2]!.args).toEqual(["cs_1", {}, { stripeAccount: "acct_9" }]);
  });

  it("Connect Standard accounts, onboarding links and status", async () => {
    const { p, calls } = provider();
    expect(await p.createConnectAccount({ workspaceId: "ws_1", email: "o@example.test" })).toEqual({ id: "acct_1" });
    expect(calls[0]!.args[0]).toMatchObject({ type: "standard", metadata: { workspace_id: "ws_1" } });
    expect(calls[0]!.args[1]).toEqual({ idempotencyKey: "acct:ws_1" });
    await p.createConnectLink({ accountId: "acct_1", refreshUrl: "r", returnUrl: "u" });
    expect(calls[1]!.args[0]).toMatchObject({ account: "acct_1", type: "account_onboarding" });
    expect(await p.getConnectAccount("acct_1")).toEqual({ chargesEnabled: true, detailsSubmitted: true });
  });

  it("verifies platform and Connect webhooks with their own secrets", () => {
    const { p } = provider();
    const body = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", data: { object: {} } });
    expect(p.verifyWebhook(body, signStripePayload("whsec_a", body), "platform").id).toBe("evt_1");
    expect(p.verifyWebhook(body, signStripePayload("whsec_b", body), "connect").id).toBe("evt_1");
    expect(() => p.verifyWebhook(body, signStripePayload("whsec_b", body), "platform")).toThrow(/signature/i);
  });

  it("the null provider answers 503 for everything that needs Stripe and rejects webhooks", async () => {
    const n = new NullBilling();
    expect(n.configured).toBe(false);
    expect(() => n.createCheckout({} as never)).toThrow(/not configured/);
    expect(() => n.verifyWebhook()).toThrow(/not configured/);
  });
});

describe("configuration", () => {
  it("a Stripe key without a webhook secret is refused at startup (subscriptions could never be confirmed)", () => {
    expect(() => loadConfig({ NODE_ENV: "test", JWT_SECRET: "x".repeat(32), STRIPE_SECRET_KEY: "sk_test_x" }, () => {})).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});
