import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parseBody, type Env } from "../http.js";
import { cancelPaymentRequest, createPaymentRequest, listPaymentRequests, refreshConnect, startConnectOnboarding } from "../billing/payments.js";
import { updateAutomation } from "../billing/credits.js";
import { billingSummary, openPortal, startSubscription, startTopUp } from "../billing/service.js";

export const Subscribe = z.object({ plan: z.string().min(1).max(20) });
export const TopUp = z.object({ pack: z.string().max(40).optional(), credits: z.number().int().optional() }).refine((v) => v.pack || v.credits, "Choose a pack or a number of credits");
export const Automation = z.object({
  auto_recharge_enabled: z.boolean().optional(),
  auto_recharge_threshold: z.number().int().min(0).max(1_000_000).optional(),
  auto_recharge_credits: z.number().int().optional(),
  low_balance_threshold: z.number().int().min(0).max(1_000_000).optional(),
});
export const PaymentRequest = z.object({
  amount: z.number().int(),
  currency: z.string().length(3).optional(),
  description: z.string().min(1).max(200),
  source: z.enum(["dm", "sms", "email"]).optional(),
  expires_in_hours: z.number().int().min(1).max(24).optional(),
  client_msg_id: z.string().max(100).optional(),
});

/** Plans, credits, payment methods (Stripe Checkout and the customer portal) and customer payment requests (Stripe Connect). */
export function billingRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.get("/billing", async (c) => c.json(await billingSummary(ctx, c.get("actor").workspaceId)));
  r.post("/billing/checkout/subscription", async (c) => c.json(await startSubscription(ctx, c.get("actor"), (await parseBody(c, Subscribe)).plan)));
  r.post("/billing/checkout/topup", async (c) => c.json(await startTopUp(ctx, c.get("actor"), await parseBody(c, TopUp))));
  r.post("/billing/portal", async (c) => c.json(await openPortal(ctx, c.get("actor"))));
  r.patch("/billing/automation", async (c) => {
    const a = c.get("actor");
    await updateAutomation(ctx, a.workspaceId, a.memberId, await parseBody(c, Automation));
    return c.json(await billingSummary(ctx, a.workspaceId));
  });
  r.post("/billing/connect/onboard", async (c) => c.json(await startConnectOnboarding(ctx, c.get("actor"))));
  r.post("/billing/connect/refresh", async (c) => c.json(await refreshConnect(ctx, c.get("actor").workspaceId)));

  r.get("/rooms/:id/payment-requests", async (c) => c.json(await listPaymentRequests(ctx, c.get("actor"), c.req.param("id"))));
  r.post("/rooms/:id/payment-requests", async (c) => c.json(await createPaymentRequest(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, PaymentRequest)), 201));
  r.post("/payment-requests/:id/cancel", async (c) => c.json(await cancelPaymentRequest(ctx, c.get("actor"), c.req.param("id"))));
  return r;
}
