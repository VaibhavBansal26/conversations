import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { recordAudit } from "../services/audit.js";
import { applyLedger } from "../services/workspaces.js";
import { addPurchasedCredits } from "./credits.js";
import { notifyOwners } from "./notify.js";
import { applyPaymentEvent } from "./payments.js";
import { PLANS, isPlanId, planOfPrice, type PlanId } from "./plans.js";
import { workspaceOfStripeObject } from "./service.js";
import { ensureBilling, getBilling, patchBilling, setWorkspacePlan } from "./state.js";
import type { StripeEvent } from "./types.js";

const iso = (unix: unknown): string | null => (typeof unix === "number" ? new Date(unix * 1000).toISOString() : null);

export type WebhookResult = "processed" | "duplicate" | "ignored";

/**
 * Entry point for both Stripe endpoints. Exactly-once effect on top of at-least-once delivery:
 *  1. the event id is inserted first (primary key); a redelivery of a processed event is acknowledged and does nothing
 *  2. an event whose earlier attempt failed (we answered 5xx) is claimed and re-run
 *  3. every handler is itself idempotent (ledger idempotency keys, absolute state writes), so even a lost claim cannot double-apply
 * Errors propagate so Stripe sees a 5xx and retries with backoff.
 */
export async function handleStripeEvent(ctx: AppContext, event: StripeEvent, kind: "platform" | "connect"): Promise<WebhookResult> {
  const ins = await ctx.db.run("INSERT INTO stripe_events(id, type, account, status, received_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING", event.id, event.type, event.account ?? null, "processing", nowIso(ctx));
  if (!ins.changes) {
    const claimed = await ctx.db.run("UPDATE stripe_events SET status = 'processing', error = NULL WHERE id = ? AND status = 'failed'", event.id);
    if (!claimed.changes) return "duplicate";
  }
  try {
    const handled = kind === "connect" ? await applyConnectEvent(ctx, event) : await applyPlatformEvent(ctx, event);
    await ctx.db.run("UPDATE stripe_events SET status = ?, workspace_id = ?, processed_at = ? WHERE id = ?", handled.handled ? "processed" : "ignored", handled.workspaceId ?? null, nowIso(ctx), event.id);
    return handled.handled ? "processed" : "ignored";
  } catch (e) {
    await ctx.db.run("UPDATE stripe_events SET status = 'failed', error = ? WHERE id = ?", (e instanceof Error ? e.message : String(e)).slice(0, 500), event.id);
    throw e;
  }
}

interface Handled {
  handled: boolean;
  workspaceId?: string | null;
}
const no: Handled = { handled: false };

async function applyPlatformEvent(ctx: AppContext, e: StripeEvent): Promise<Handled> {
  const o = e.data.object;
  switch (e.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return await onCheckoutCompleted(ctx, o);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return await onSubscription(ctx, o, e, false);
    case "customer.subscription.deleted":
      return await onSubscription(ctx, o, e, true);
    case "invoice.paid":
      return await onInvoicePaid(ctx, o);
    case "invoice.payment_failed":
      return await onInvoiceFailed(ctx, o);
    case "payment_intent.succeeded":
      return await onPaymentIntentSucceeded(ctx, o);
    default:
      return no;
  }
}

async function onCheckoutCompleted(ctx: AppContext, s: Record<string, any>): Promise<Handled> {
  const ws = await workspaceOfStripeObject(ctx, s);
  if (!ws) return no;
  await ensureBilling(ctx, ws);
  if (s.mode === "subscription") {
    // plan and status arrive with customer.subscription.*; here we only remember which subscription is ours
    if (typeof s.subscription === "string") await patchBilling(ctx, ws, { stripe_subscription_id: s.subscription });
    return { handled: true, workspaceId: ws };
  }
  if (s.mode === "payment" && s.metadata?.kind === "topup") {
    if (s.payment_status !== "paid") return no; // async methods: the credit waits for async_payment_succeeded
    const credits = Number(s.metadata.credits);
    if (!Number.isInteger(credits) || credits <= 0) return no;
    await addPurchasedCredits(ctx, ws, credits, `cs:${s.id}`, "top-up");
    const pm = await ctx.billing.getCheckoutPaymentMethod(s.id).catch(() => null);
    if (pm) await patchBilling(ctx, ws, { payment_method_id: pm.id, payment_method_brand: pm.brand, payment_method_last4: pm.last4, auto_recharge_failures: 0 });
    return { handled: true, workspaceId: ws };
  }
  return no;
}

async function onSubscription(ctx: AppContext, sub: Record<string, any>, e: StripeEvent, deleted: boolean): Promise<Handled> {
  const ws = await workspaceOfStripeObject(ctx, sub);
  if (!ws) return no;
  const b = await ensureBilling(ctx, ws);
  const created = Number(e.created ?? 0);
  // Stripe does not guarantee ordering: an older event must not overwrite a newer state
  if (created && created < b.sub_event_at) return { handled: false, workspaceId: ws };
  const priceId = sub.items?.data?.[0]?.price?.id as string | undefined;
  const status = deleted ? "canceled" : String(sub.status);
  let plan: PlanId = isPlanId(b.plan) ? b.plan : "free";
  const mapped = planOfPrice(ctx.config, priceId) ?? (isPlanId(sub.metadata?.plan) ? (sub.metadata.plan as PlanId) : null);
  if (mapped) plan = mapped;
  const ended = deleted || status === "canceled" || status === "incomplete_expired";
  if (ended) plan = "free";
  const failing = status === "past_due" || status === "unpaid";
  let grace = b.grace_until;
  if (failing && !grace) grace = new Date(ctx.clock().getTime() + ctx.config.BILLING_GRACE_DAYS * 86_400_000).toISOString();
  if (!failing) grace = null;
  await patchBilling(ctx, ws, {
    plan,
    status: ended ? "canceled" : status,
    stripe_subscription_id: ended ? null : String(sub.id),
    current_period_end: iso(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    grace_until: grace,
    ...(created ? { sub_event_at: created } : {}),
  });
  if (plan !== b.plan) {
    await setWorkspacePlan(ctx, ws, plan);
    await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "billing.plan_changed", target: String(sub.id), detail: { from: b.plan, to: plan, status } });
  }
  return { handled: true, workspaceId: ws };
}

async function onInvoicePaid(ctx: AppContext, inv: Record<string, any>): Promise<Handled> {
  const ws = await workspaceOfStripeObject(ctx, { metadata: inv.subscription_details?.metadata ?? inv.metadata, customer: inv.customer });
  if (!ws) return no;
  const b = await ensureBilling(ctx, ws);
  // paying clears a failed-payment grace period at once: the soft lock lifts without waiting for the subscription event
  await patchBilling(ctx, ws, { grace_until: null, ...(b.status === "past_due" || b.status === "unpaid" ? { status: "active" } : {}) });
  const line = inv.lines?.data?.[0];
  const priceId = (line?.price?.id ?? line?.pricing?.price_details?.price) as string | undefined;
  const plan = planOfPrice(ctx.config, priceId) ?? (isPlanId(b.plan) ? b.plan : "free");
  const credits = PLANS[plan].monthlyCredits;
  if (credits > 0 && Number(inv.amount_paid ?? 1) > 0) await applyLedger(ctx, ws, "plan_credits", credits, { ref: `invoice ${inv.id}`, idemKey: `inv:${inv.id}` });
  return { handled: true, workspaceId: ws };
}

async function onInvoiceFailed(ctx: AppContext, inv: Record<string, any>): Promise<Handled> {
  const ws = await workspaceOfStripeObject(ctx, { metadata: inv.subscription_details?.metadata ?? inv.metadata, customer: inv.customer });
  if (!ws) return no;
  const b = await ensureBilling(ctx, ws);
  const grace = b.grace_until ?? new Date(ctx.clock().getTime() + ctx.config.BILLING_GRACE_DAYS * 86_400_000).toISOString();
  await patchBilling(ctx, ws, { status: "past_due", grace_until: grace });
  // one alert per failure episode (the grace date is set by the first failure and stays), not one per Stripe retry
  if (!b.grace_until) {
    await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "billing.payment_failed", target: String(inv.id), detail: { grace_until: grace } });
    await notifyOwners(ctx, ws, {
      type: "payment_failed",
      title: "We could not charge your subscription",
      body: `Update your payment method before ${grace.slice(0, 10)} to keep sending SMS and email.`,
    });
  }
  return { handled: true, workspaceId: ws };
}

async function onPaymentIntentSucceeded(ctx: AppContext, pi: Record<string, any>): Promise<Handled> {
  if (pi.metadata?.kind !== "auto_recharge") return no;
  const ws = await workspaceOfStripeObject(ctx, pi);
  const credits = Number(pi.metadata.credits);
  if (!ws || !Number.isInteger(credits) || credits <= 0) return no;
  // same key the job used: whichever of the two runs second adds nothing
  await addPurchasedCredits(ctx, ws, credits, `pi:${pi.id}`, "auto-recharge");
  return { handled: true, workspaceId: ws };
}

async function applyConnectEvent(ctx: AppContext, e: StripeEvent): Promise<Handled> {
  const account = e.account ?? (e.type === "account.updated" ? (e.data.object.id as string) : undefined);
  if (!account) return no;
  const row = await ctx.db.get<{ workspace_id: string }>("SELECT workspace_id FROM billing_accounts WHERE connect_account_id = ?", account);
  if (!row) return no;
  if (e.type === "account.updated") {
    await patchBilling(ctx, row.workspace_id, { connect_charges_enabled: e.data.object.charges_enabled ? 1 : 0 });
    return { handled: true, workspaceId: row.workspace_id };
  }
  const handled = await applyPaymentEvent(ctx, row.workspace_id, account, e);
  return { handled, workspaceId: row.workspace_id };
}

export { getBilling };
