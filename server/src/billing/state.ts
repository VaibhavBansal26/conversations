import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { AppError, paymentRequired } from "../errors.js";
import { PLANS, isPlanId, type Plan, type PlanId } from "./plans.js";

export interface BillingRow {
  workspace_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
  grace_until: string | null;
  payment_method_id: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
  auto_recharge_enabled: number;
  auto_recharge_threshold: number;
  auto_recharge_credits: number;
  auto_recharge_failures: number;
  low_balance_threshold: number;
  low_balance_notified_at: string | null;
  sub_event_at: number;
  connect_account_id: string | null;
  connect_charges_enabled: number;
  created_at: string;
  updated_at: string;
}

export const getBilling = (ctx: AppContext, workspaceId: string) => ctx.db.get<BillingRow>("SELECT * FROM billing_accounts WHERE workspace_id = ?", workspaceId);

/** The billing row, created on first use. Concurrent first uses are safe: the insert is `ON CONFLICT DO NOTHING`. */
export async function ensureBilling(ctx: AppContext, workspaceId: string): Promise<BillingRow> {
  const now = nowIso(ctx);
  await ctx.db.run(
    "INSERT INTO billing_accounts(workspace_id, plan, status, created_at, updated_at) VALUES (?, (SELECT plan FROM workspaces WHERE id = ?), 'none', ?, ?) ON CONFLICT (workspace_id) DO NOTHING",
    workspaceId,
    workspaceId,
    now,
    now,
  );
  return (await getBilling(ctx, workspaceId))!;
}

export async function patchBilling(ctx: AppContext, workspaceId: string, patch: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await ctx.db.run(`UPDATE billing_accounts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE workspace_id = ?`, ...keys.map((k) => patch[k]!), nowIso(ctx), workspaceId);
}

/** The workspace's plan column is what the rate limiter reads (tier), so changing it changes every plan-scaled limit on the next request. */
export async function setWorkspacePlan(ctx: AppContext, workspaceId: string, plan: PlanId): Promise<void> {
  await ctx.db.run("UPDATE workspaces SET plan = ? WHERE id = ?", plan, workspaceId);
  await ctx.cache.invalidate(`tier:${workspaceId}`);
}

export type AccessState = "ok" | "grace" | "locked";

export interface AccountState {
  plan: PlanId;
  status: string;
  state: AccessState;
  graceUntil: string | null;
}

/**
 * ok      paid up (or never needed to pay)
 * grace   a subscription payment failed: everything keeps working until `graceUntil`, the owner is told
 * locked  grace ran out: the workspace is soft-locked (see assertNotLocked). Evaluated lazily from the clock, so no sweep job can miss it
 *         and paying (invoice.paid) unlocks immediately.
 */
export async function accountState(ctx: AppContext, workspaceId: string): Promise<AccountState> {
  const b = await getBilling(ctx, workspaceId);
  const plan = isPlanId(b?.plan) ? b.plan : "free";
  if (!b || !b.grace_until || (b.status !== "past_due" && b.status !== "unpaid")) return { plan, status: b?.status ?? "none", state: "ok", graceUntil: null };
  return { plan, status: b.status, state: b.grace_until > nowIso(ctx) ? "grace" : "locked", graceUntil: b.grace_until };
}

export const planOf = (b: Pick<BillingRow, "plan"> | undefined): Plan => (isPlanId(b?.plan) ? PLANS[b.plan] : PLANS.free);

/**
 * Soft lock: refuses what costs the platform money or creates new obligations (external SMS/email sends, new seats). Reading, replying in
 * live chat, exports, the billing pages themselves and every webhook keep working, so a customer can always pay their way out.
 * Only enforced when PLAN_ENFORCEMENT=true.
 */
export async function assertNotLocked(ctx: AppContext, workspaceId: string, what = "send this"): Promise<void> {
  if (!ctx.config.PLAN_ENFORCEMENT) return;
  const s = await accountState(ctx, workspaceId);
  if (s.state === "locked") throw paymentRequired("ACCOUNT_LOCKED", `Billing is overdue, so this workspace cannot ${what}. Update the payment method under Settings > Billing.`);
}

/** Seats are the people who work conversations. Enforced only when PLAN_ENFORCEMENT=true, against the plan's limit. */
export async function assertSeatAvailable(ctx: AppContext, workspaceId: string): Promise<void> {
  if (!ctx.config.PLAN_ENFORCEMENT) return;
  await assertNotLocked(ctx, workspaceId, "add team members");
  const w = await ctx.db.get<{ plan: string }>("SELECT plan FROM workspaces WHERE id = ?", workspaceId);
  const plan = isPlanId(w?.plan) ? PLANS[w.plan] : PLANS.free;
  const used = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id = ? AND removed_at IS NULL AND live_seat = 1", workspaceId))!.n;
  if (used >= plan.seats) throw new AppError(402, "SEAT_LIMIT", `The ${plan.name} plan includes ${plan.seats} seats. Upgrade to add more.`);
}
