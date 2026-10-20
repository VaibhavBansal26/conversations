import type { AppContext } from "../context.js";
import { badRequest, conflict } from "../errors.js";
import type { Actor } from "../domain/types.js";
import { recordAudit } from "../services/audit.js";
import { assertBillingConfigured, resolveCredits } from "./credits.js";
import { CREDIT_PACKS, PLANS, creditsToCents, isPlanId, type PlanId } from "./plans.js";
import { accountState, ensureBilling, getBilling, patchBilling, planOf, type BillingRow } from "./state.js";

const base = (ctx: AppContext) => ctx.config.PUBLIC_URL.replace(/\/$/, "");

/** The Stripe customer of this workspace, created on first use. Two concurrent first uses converge on one customer (idempotency key + conditional update). */
export async function ensureCustomer(ctx: AppContext, actor: Pick<Actor, "workspaceId" | "email">): Promise<{ customerId: string; account: BillingRow }> {
  assertBillingConfigured(ctx);
  const b = await ensureBilling(ctx, actor.workspaceId);
  if (b.stripe_customer_id) return { customerId: b.stripe_customer_id, account: b };
  const w = (await ctx.db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", actor.workspaceId))!;
  const c = await ctx.billing.createCustomer({ workspaceId: actor.workspaceId, name: w.name, email: actor.email });
  await ctx.db.run("UPDATE billing_accounts SET stripe_customer_id = ?, updated_at = ? WHERE workspace_id = ? AND stripe_customer_id IS NULL", c.id, ctx.clock().toISOString(), actor.workspaceId);
  const fresh = (await getBilling(ctx, actor.workspaceId))!;
  return { customerId: fresh.stripe_customer_id!, account: fresh };
}

export async function startSubscription(ctx: AppContext, actor: Actor, plan: string): Promise<{ url: string }> {
  if (!isPlanId(plan) || plan === "free") throw badRequest("INVALID_PLAN", "Choose the pro or business plan");
  const { customerId, account } = await ensureCustomer(ctx, actor);
  // an active subscription is changed in the customer portal (proration, cancel), never by stacking a second subscription
  if (account.stripe_subscription_id && ["active", "trialing", "past_due"].includes(account.status)) throw conflict("ALREADY_SUBSCRIBED", "This workspace already has a subscription. Use the billing portal to change or cancel it.");
  const s = await ctx.billing.createCheckout({
    customerId,
    mode: "subscription",
    plan: plan as PlanId,
    currency: ctx.config.BILLING_CURRENCY,
    successUrl: `${base(ctx)}/settings/billing?checkout=success`,
    cancelUrl: `${base(ctx)}/settings/billing?checkout=cancelled`,
    metadata: { workspace_id: actor.workspaceId, kind: "subscription", plan },
  });
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "billing.checkout_started", target: s.id, detail: { kind: "subscription", plan } });
  return { url: s.url };
}

export async function startTopUp(ctx: AppContext, actor: Actor, input: { pack?: string; credits?: number }): Promise<{ url: string; credits: number; amount_cents: number }> {
  const credits = resolveCredits(input);
  const { customerId } = await ensureCustomer(ctx, actor);
  const amountCents = creditsToCents(ctx.config, credits);
  const s = await ctx.billing.createCheckout({
    customerId,
    mode: "payment",
    credits,
    amountCents,
    currency: ctx.config.BILLING_CURRENCY,
    successUrl: `${base(ctx)}/settings/billing?checkout=success`,
    cancelUrl: `${base(ctx)}/settings/billing?checkout=cancelled`,
    metadata: { workspace_id: actor.workspaceId, kind: "topup", credits: String(credits) },
  });
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "billing.checkout_started", target: s.id, detail: { kind: "topup", credits, amount_cents: amountCents } });
  return { url: s.url, credits, amount_cents: amountCents };
}

export async function openPortal(ctx: AppContext, actor: Actor): Promise<{ url: string }> {
  const { customerId } = await ensureCustomer(ctx, actor);
  return await ctx.billing.createPortal({ customerId, returnUrl: `${base(ctx)}/settings/billing` });
}

/** Everything the billing page shows. Never includes Stripe ids beyond what the UI needs, and never card numbers (only brand and last four). */
export async function billingSummary(ctx: AppContext, workspaceId: string) {
  const b = await getBilling(ctx, workspaceId);
  const w = (await ctx.db.get<{ plan: string; credit_balance: number }>("SELECT plan, credit_balance FROM workspaces WHERE id = ?", workspaceId))!;
  const state = await accountState(ctx, workspaceId);
  const plan = isPlanId(w.plan) ? PLANS[w.plan] : PLANS.free;
  const seatsUsed = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id = ? AND removed_at IS NULL AND live_seat = 1", workspaceId))!.n;
  return {
    configured: ctx.billing.configured,
    plan: { id: plan.id, name: plan.name, seats: plan.seats, seats_used: seatsUsed, monthly_credits: plan.monthlyCredits, price_cents: plan.priceCents },
    plans: Object.values(PLANS),
    status: b?.status ?? "none",
    access: state.state,
    grace_until: state.graceUntil,
    current_period_end: b?.current_period_end ?? null,
    cancel_at_period_end: !!b?.cancel_at_period_end,
    credit_balance: w.credit_balance,
    credit_price_cents: ctx.config.CREDIT_PRICE_CENTS,
    currency: ctx.config.BILLING_CURRENCY,
    packs: CREDIT_PACKS.map((p) => ({ ...p, amount_cents: creditsToCents(ctx.config, p.credits) })),
    payment_method: b?.payment_method_id ? { brand: b.payment_method_brand, last4: b.payment_method_last4 } : null,
    automation: {
      auto_recharge_enabled: !!b?.auto_recharge_enabled,
      auto_recharge_threshold: b?.auto_recharge_threshold ?? 0,
      auto_recharge_credits: b?.auto_recharge_credits ?? 0,
      low_balance_threshold: b?.low_balance_threshold ?? 0,
    },
    connect: { connected: !!b?.connect_account_id, charges_enabled: !!b?.connect_charges_enabled },
  };
}

/** Used by the webhook handlers: find the workspace a Stripe object belongs to, by our metadata first, then by customer id. */
export async function workspaceOfStripeObject(ctx: AppContext, obj: { metadata?: Record<string, string> | null; customer?: unknown }): Promise<string | null> {
  const cust = typeof obj.customer === "string" ? obj.customer : (obj.customer as { id?: string } | null)?.id;
  const meta = obj.metadata?.workspace_id;
  if (meta) {
    const b = await getBilling(ctx, meta);
    const w = await ctx.db.get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", meta);
    // an object that names a workspace but belongs to a different Stripe customer than the one we linked is not applied
    if (!w || (cust && b?.stripe_customer_id && b.stripe_customer_id !== cust)) return null;
    return w.id;
  }
  if (cust) return (await ctx.db.get<{ workspace_id: string }>("SELECT workspace_id FROM billing_accounts WHERE stripe_customer_id = ?", cust))?.workspace_id ?? null;
  return null;
}

export { patchBilling, planOf };
