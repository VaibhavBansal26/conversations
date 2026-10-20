import Stripe from "stripe";
import { unauthorized } from "../errors.js";
import type { StripeEvent } from "./types.js";

/**
 * Stripe webhook signature check (HMAC-SHA256 over `timestamp.payload`, constant-time compare, replay window). Uses the SDK's verifier
 * rather than a hand-rolled one; it needs no network and no API key. The raw body must be the exact bytes Stripe sent.
 */
export function verifyStripeSignature(secret: string | undefined, rawBody: string, header: string | undefined, toleranceSeconds: number): StripeEvent {
  if (!secret) throw unauthorized("Stripe webhooks are not configured", "WEBHOOK_NOT_CONFIGURED");
  if (!header) throw unauthorized("Missing Stripe signature", "WEBHOOK_SIGNATURE");
  try {
    return Stripe.webhooks.constructEvent(rawBody, header, secret, toleranceSeconds) as unknown as StripeEvent;
  } catch {
    throw unauthorized("Invalid Stripe signature", "WEBHOOK_SIGNATURE");
  }
}

/** Test helper: the header Stripe would send for this payload. */
export const signStripePayload = (secret: string, payload: string, timestamp?: number): string =>
  Stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) });
