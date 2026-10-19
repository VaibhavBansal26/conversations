import { createHmac, createPublicKey, createVerify } from "node:crypto";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { AppError, unauthorized } from "../errors.js";
import { safeEqual, sha256 } from "../util/crypto.js";

/** Twilio: base64(HMAC-SHA1(authToken, fullUrl + params sorted by name, each name immediately followed by its value)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  return safeEqual(twilioSignature(authToken, url, params), header);
}

/** SendGrid signed event webhook: ECDSA P-256/SHA-256 over (timestamp + raw body), DER signature in base64. */
export function verifySendgridSignature(publicKeyB64: string, rawBody: string, signatureB64: string | undefined, timestamp: string | undefined): boolean {
  if (!signatureB64 || !timestamp) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return createVerify("sha256")
      .update(timestamp + rawBody)
      .verify({ key, dsaEncoding: "der" }, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Remember a webhook key; returns false when it was already seen (duplicate / replay). */
export async function claimEvent(ctx: AppContext, provider: string, key: string): Promise<boolean> {
  return (await ctx.db.run("INSERT OR IGNORE INTO webhook_events(provider, event_key, created_at) VALUES (?,?,?)", provider, key, nowIso(ctx))).changes > 0;
}

function unconfigured(ctx: AppContext, what: string): void {
  if (ctx.config.NODE_ENV === "production") throw new AppError(503, "WEBHOOK_NOT_CONFIGURED", `${what} verification is not configured`);
  ctx.log.warn(`${what} not configured: accepting unsigned webhook (development only)`);
}

export function requireTwilio(ctx: AppContext, path: string, params: Record<string, string>, header: string | undefined): void {
  const token = ctx.config.TWILIO_AUTH_TOKEN;
  if (!token) return unconfigured(ctx, "Twilio signature");
  const url = ctx.config.PUBLIC_URL.replace(/\/$/, "") + path;
  if (!verifyTwilioSignature(token, url, params, header)) throw unauthorized("Invalid webhook signature", "INVALID_SIGNATURE");
}

export function requireSharedSecret(ctx: AppContext, provided: string | undefined): void {
  const secret = ctx.config.WEBHOOK_SHARED_SECRET;
  if (!secret) return unconfigured(ctx, "Webhook secret");
  if (!provided || !safeEqual(secret, provided)) throw unauthorized("Invalid webhook secret", "INVALID_SIGNATURE");
}

/** Event webhook: ECDSA signature when a public key is configured, else the shared-secret fallback. Stale and replayed requests are refused. */
export async function requireSendgridEvents(ctx: AppContext, raw: string, h: { signature?: string; timestamp?: string; secret?: string }): Promise<void> {
  const pub = ctx.config.SENDGRID_WEBHOOK_PUBLIC_KEY;
  if (!pub) return requireSharedSecret(ctx, h.secret);
  if (!verifySendgridSignature(pub, raw, h.signature, h.timestamp)) throw unauthorized("Invalid webhook signature", "INVALID_SIGNATURE");
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(ctx.clock().getTime() / 1000 - ts) > ctx.config.WEBHOOK_TOLERANCE_SECONDS) {
    throw unauthorized("Webhook timestamp is outside the tolerated window", "STALE_WEBHOOK");
  }
  if (!(await claimEvent(ctx, "sendgrid_sig", sha256(`${h.signature}|${h.timestamp}`)))) throw unauthorized("Webhook was already processed", "REPLAYED_WEBHOOK");
}
