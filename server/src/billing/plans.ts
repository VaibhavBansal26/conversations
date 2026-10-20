import type { Config } from "../config.js";

export type PlanId = "free" | "pro" | "business";

export interface Plan {
  id: PlanId;
  name: string;
  /** live seats (members that work conversations); enforced when PLAN_ENFORCEMENT=true */
  seats: number;
  /** credits added to the balance every time a subscription invoice is paid */
  monthlyCredits: number;
  /** list price per month in cents, shown in the UI (the amount actually charged is the Stripe price) */
  priceCents: number;
}

/**
 * The plan catalogue. Limits that are not seats (messages per hour, API calls, AI calls, socket connections) come from the rate-limit
 * tiers of the same name (ratelimit/policies.ts): a workspace's `plan` column is what picks the tier, so upgrading raises every one of them.
 */
export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Free", seats: 3, monthlyCredits: 0, priceCents: 0 },
  pro: { id: "pro", name: "Pro", seats: 10, monthlyCredits: 500, priceCents: 4900 },
  business: { id: "business", name: "Business", seats: 50, monthlyCredits: 5000, priceCents: 19900 },
};

export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && v in PLANS;

export const CREDIT_PACKS = [
  { id: "pack_1000", credits: 1000 },
  { id: "pack_5000", credits: 5000 },
  { id: "pack_20000", credits: 20000 },
] as const;

export const creditsToCents = (config: Pick<Config, "CREDIT_PRICE_CENTS">, credits: number): number => Math.max(50, Math.round(credits * config.CREDIT_PRICE_CENTS));

export const priceIdOf = (config: Pick<Config, "STRIPE_PRICE_PRO" | "STRIPE_PRICE_BUSINESS">, plan: PlanId): string | undefined =>
  plan === "pro" ? config.STRIPE_PRICE_PRO : plan === "business" ? config.STRIPE_PRICE_BUSINESS : undefined;

/** Reverse lookup used by subscription webhooks: Stripe tells us the price, we decide the plan. */
export const planOfPrice = (config: Pick<Config, "STRIPE_PRICE_PRO" | "STRIPE_PRICE_BUSINESS">, priceId: string | undefined): PlanId | null => {
  if (!priceId) return null;
  if (priceId === config.STRIPE_PRICE_PRO) return "pro";
  if (priceId === config.STRIPE_PRICE_BUSINESS) return "business";
  return null;
};
