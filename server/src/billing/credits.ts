import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { AppError, badRequest, conflict } from "../errors.js";
import { enqueueJob } from "../jobs/queue.js";
import { recordAudit } from "../services/audit.js";
import { applyLedger } from "../services/workspaces.js";
import { notifyOwners } from "./notify.js";
import { CREDIT_PACKS, creditsToCents } from "./plans.js";
import { accountState, ensureBilling, getBilling, patchBilling } from "./state.js";

export const MIN_TOPUP_CREDITS = 100;
export const MAX_TOPUP_CREDITS = 100_000;
/** consecutive failed automatic charges before auto-recharge switches itself off and asks a human */
export const MAX_RECHARGE_FAILURES = 3;
/** one automatic charge per workspace per this window, however fast the balance drains */
const RECHARGE_WINDOW_MS = 10 * 60_000;

export const resolveCredits = (input: { pack?: string; credits?: number }): number => {
  if (input.pack) {
    const p = CREDIT_PACKS.find((x) => x.id === input.pack);
    if (!p) throw badRequest("UNKNOWN_PACK", "Unknown credit pack");
    return p.credits;
  }
  const c = input.credits;
  if (!Number.isInteger(c) || c! < MIN_TOPUP_CREDITS || c! > MAX_TOPUP_CREDITS) throw badRequest("INVALID_CREDITS", `Credits must be a whole number between ${MIN_TOPUP_CREDITS} and ${MAX_TOPUP_CREDITS}`);
  return c!;
};

/** Add purchased credits once per Stripe object (idempotency key), then re-evaluate the low-balance state. */
export async function addPurchasedCredits(ctx: AppContext, workspaceId: string, credits: number, idemKey: string, note: string): Promise<{ balance: number; applied: boolean }> {
  const r = await applyLedger(ctx, workspaceId, "topup", credits, { ref: note, idemKey });
  if (r.applied) await recordAudit(ctx, { workspaceId, actor: { type: "system" }, action: "billing.credits_added", target: idemKey, detail: { credits, balance: r.balance } });
  return r;
}

/**
 * Called (in the background) after every ledger change. Cheap for workspaces without billing settings: one primary-key read.
 *  - low balance: one in-app + email alert when the balance falls to the threshold, re-armed when it rises above it again
 *  - auto-recharge: queue a charge job when the balance is at or below the recharge threshold
 */
export async function onBalanceChanged(ctx: AppContext, workspaceId: string, balance: number): Promise<void> {
  const b = await getBilling(ctx, workspaceId);
  if (!b) return;
  if (b.low_balance_threshold > 0) {
    if (balance <= b.low_balance_threshold && !b.low_balance_notified_at) {
      const claimed = await ctx.db.run("UPDATE billing_accounts SET low_balance_notified_at = ? WHERE workspace_id = ? AND low_balance_notified_at IS NULL", nowIso(ctx), workspaceId);
      if (claimed.changes) await notifyOwners(ctx, workspaceId, { type: "low_balance", title: "Message credits are running low", body: `Your balance is ${balance} credits. Top up under Settings > Billing so sending does not stop.` });
    } else if (balance > b.low_balance_threshold && b.low_balance_notified_at) {
      await ctx.db.run("UPDATE billing_accounts SET low_balance_notified_at = NULL WHERE workspace_id = ?", workspaceId);
    }
  }
  if (b.auto_recharge_enabled && b.payment_method_id && balance <= b.auto_recharge_threshold) {
    const bucket = Math.floor(ctx.clock().getTime() / RECHARGE_WINDOW_MS);
    await enqueueJob(ctx, "auto_recharge", { workspace_id: workspaceId, bucket }, { workspaceId, dedupeKey: `auto_recharge:${workspaceId}:${bucket}` });
  }
}

/**
 * Job: charge the saved card for the configured amount. Safe to run twice and safe to race with the `payment_intent.succeeded` webhook:
 * the Stripe idempotency key stops a double charge, the ledger idempotency key (the payment intent id) stops a double credit.
 */
export async function runAutoRecharge(ctx: AppContext, p: { workspace_id: string; bucket: number }): Promise<"charged" | "skipped" | "failed"> {
  const ws = p.workspace_id;
  const b = await getBilling(ctx, ws);
  if (!b || !b.auto_recharge_enabled || !b.payment_method_id || !b.stripe_customer_id) return "skipped";
  if ((await accountState(ctx, ws)).state === "locked") return "skipped";
  const balance = (await ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", ws))?.credit_balance ?? 0;
  if (balance > b.auto_recharge_threshold) return "skipped";
  const r = await ctx.billing.chargeSavedMethod({
    customerId: b.stripe_customer_id,
    paymentMethodId: b.payment_method_id,
    amountCents: creditsToCents(ctx.config, b.auto_recharge_credits),
    currency: ctx.config.BILLING_CURRENCY,
    metadata: { workspace_id: ws, kind: "auto_recharge", credits: String(b.auto_recharge_credits) },
    idempotencyKey: `recharge:${ws}:${p.bucket}`,
  });
  if (r.status === "succeeded") {
    await addPurchasedCredits(ctx, ws, b.auto_recharge_credits, `pi:${r.id}`, "auto-recharge");
    await patchBilling(ctx, ws, { auto_recharge_failures: 0 });
    return "charged";
  }
  const failures = b.auto_recharge_failures + 1;
  // a card that needs the customer (3-D Secure) cannot be fixed by retrying: stop at once instead of burning attempts
  const giveUp = r.status === "requires_action" || failures >= MAX_RECHARGE_FAILURES;
  await patchBilling(ctx, ws, { auto_recharge_failures: failures, ...(giveUp ? { auto_recharge_enabled: 0 } : {}) });
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "billing.auto_recharge_failed", detail: { reason: r.error ?? r.status, failures, disabled: giveUp } });
  await notifyOwners(ctx, ws, {
    type: "auto_recharge_failed",
    title: giveUp ? "Auto-recharge was turned off" : "Auto-recharge payment failed",
    body: giveUp ? "The saved card could not be charged. Update your payment method and turn auto-recharge back on under Settings > Billing." : "We could not charge the saved card for auto-recharge. We will try again if the balance stays low.",
  });
  return "failed";
}

export interface AutomationInput {
  auto_recharge_enabled?: boolean;
  auto_recharge_threshold?: number;
  auto_recharge_credits?: number;
  low_balance_threshold?: number;
}

export async function updateAutomation(ctx: AppContext, workspaceId: string, actorId: string, input: AutomationInput) {
  const b = await ensureBilling(ctx, workspaceId);
  const patch: Record<string, number | null> = {};
  if (input.low_balance_threshold !== undefined) {
    patch.low_balance_threshold = input.low_balance_threshold;
    patch.low_balance_notified_at = null;
  }
  if (input.auto_recharge_threshold !== undefined) patch.auto_recharge_threshold = input.auto_recharge_threshold;
  if (input.auto_recharge_credits !== undefined) patch.auto_recharge_credits = resolveCredits({ credits: input.auto_recharge_credits });
  if (input.auto_recharge_enabled !== undefined) {
    if (input.auto_recharge_enabled) {
      if (!b.payment_method_id) throw conflict("NO_PAYMENT_METHOD", "Buy credits once to save a card, then turn on auto-recharge");
      const credits = patch.auto_recharge_credits ?? b.auto_recharge_credits;
      if (!credits) throw badRequest("INVALID_CREDITS", "Choose how many credits to buy each time");
      if (!(patch.auto_recharge_threshold ?? b.auto_recharge_threshold)) throw badRequest("INVALID_THRESHOLD", "Choose the balance that triggers a recharge");
      patch.auto_recharge_failures = 0;
    }
    patch.auto_recharge_enabled = input.auto_recharge_enabled ? 1 : 0;
  }
  if (!Object.keys(patch).length) throw badRequest("NOTHING_TO_UPDATE", "Nothing to update");
  await patchBilling(ctx, workspaceId, patch);
  await recordAudit(ctx, { workspaceId, actor: { type: "member", id: actorId }, action: "billing.automation_updated", detail: { ...input } });
  // a new threshold may already be crossed
  const balance = (await ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", workspaceId))!.credit_balance;
  await onBalanceChanged(ctx, workspaceId, balance);
  return await getBilling(ctx, workspaceId);
}

export const assertBillingConfigured = (ctx: AppContext) => {
  if (!ctx.billing.configured) throw new AppError(503, "BILLING_NOT_CONFIGURED", "Billing is not configured on this server");
};
