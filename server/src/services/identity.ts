import { can } from "../authz/permissions.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, forbidden, unauthorized, unprocessable } from "../errors.js";
import { hmacHex, openSecret, randomToken, safeEqual, sealSecret } from "../util/crypto.js";
import { normalizeEmail } from "../util/phone.js";
import { recordAudit } from "./audit.js";

/**
 * Signed visitor identity ("identity verification"). The host app's backend computes
 *   identity_hash = hex(HMAC_SHA256(secret, external_id + "|" + email))      (missing parts are empty strings, email lower-cased and trimmed)
 * and hands it to the chat with the external id and email. A visitor who cannot produce the hash cannot claim a known user's history.
 * Matrix (docs/MOBILE-BRIDGE.md, docs/SECURITY.md):
 *   no secret configured, hash sent     422 IDENTITY_NOT_CONFIGURED (integration mistake, loud on purpose)
 *   secret, hash valid                  identified + verified session (no OTP)
 *   secret, hash wrong                  401 IDENTITY_HASH_INVALID (tampered or signed with another secret)
 *   secret, no hash, enforce off        legacy behaviour: typed email/phone identify the contact and may need the OTP; external_id is ignored
 *   secret, no hash, enforce on         email, phone and external_id are ignored: the visitor stays anonymous
 */
const PURPOSE = "workspace-identity-v1";
export const IDENTITY_HASH_RE = /^[0-9a-f]{64}$/;

export const identityMessage = (externalId: string | undefined | null, email: string | undefined | null) => `${(externalId ?? "").trim()}|${(email ?? "").trim().toLowerCase()}`;
export const signIdentity = (secret: string, externalId?: string | null, email?: string | null) => hmacHex(secret, identityMessage(externalId, email));

interface IdentityRow {
  workspace_id: string;
  secret: string;
  enforce: number;
  rotated_at: string;
  created_at: string;
}

export async function identityConfig(ctx: AppContext, workspaceId: string): Promise<{ secret: string; enforce: boolean; rotated_at: string } | null> {
  const row = await ctx.db.get<IdentityRow>("SELECT * FROM workspace_identity WHERE workspace_id = ?", workspaceId);
  if (!row) return null;
  const secret = openSecret(ctx.config.JWT_SECRET, PURPOSE, row.secret);
  // an unreadable secret (JWT_SECRET was rotated) is treated as "not configured" rather than silently accepting everything
  return secret ? { secret, enforce: !!row.enforce, rotated_at: row.rotated_at } : null;
}

export async function identityStatus(ctx: AppContext, actor: Actor) {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage identity verification");
  const row = await ctx.db.get<IdentityRow>("SELECT * FROM workspace_identity WHERE workspace_id = ?", actor.workspaceId);
  return { configured: !!row, enforce: !!row?.enforce, rotated_at: row?.rotated_at ?? null };
}

/** Create or replace the secret. The plain value is returned once and never again. */
export async function rotateIdentitySecret(ctx: AppContext, actor: Actor) {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage identity verification");
  const secret = `cvi_${randomToken(32)}`;
  const now = nowIso(ctx);
  const sealed = sealSecret(ctx.config.JWT_SECRET, PURPOSE, secret);
  const updated = await ctx.db.run("UPDATE workspace_identity SET secret = ?, rotated_at = ? WHERE workspace_id = ?", sealed, now, actor.workspaceId);
  if (!updated.changes) await ctx.db.run("INSERT INTO workspace_identity(workspace_id, secret, enforce, rotated_at, created_at) VALUES (?,?,?,?,?)", actor.workspaceId, sealed, false, now, now);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "identity.secret_rotated" });
  return { secret, enforce: !!(await identityStatus(ctx, actor)).enforce, rotated_at: now };
}

export async function setIdentityEnforce(ctx: AppContext, actor: Actor, enforce: boolean) {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage identity verification");
  const res = await ctx.db.run("UPDATE workspace_identity SET enforce = ? WHERE workspace_id = ?", enforce, actor.workspaceId);
  if (!res.changes) throw new AppError(409, "IDENTITY_NOT_CONFIGURED", "Create an identity secret first");
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "identity.enforce_changed", detail: { enforce } });
  return await identityStatus(ctx, actor);
}

export interface IdentityInput {
  external_id?: string;
  email?: string;
  identity_hash?: string;
}

export type IdentityDecision =
  | { mode: "verified"; externalId?: string; email?: string }
  | { mode: "legacy" } // typed details behave as before
  | { mode: "anonymous" }; // enforcement on and nothing signed

export async function decideIdentity(ctx: AppContext, workspaceId: string, input: IdentityInput): Promise<IdentityDecision> {
  const cfg = await identityConfig(ctx, workspaceId);
  const hash = input.identity_hash?.trim().toLowerCase();
  const externalId = input.external_id?.trim() || undefined;
  const email = normalizeEmail(input.email) ?? undefined;
  if (hash) {
    if (!cfg) throw unprocessable("IDENTITY_NOT_CONFIGURED", "This workspace has no identity secret; remove identity_hash or create one in Settings > Widget > Identity");
    if (!externalId && !email) throw unprocessable("IDENTITY_REQUIRED", "identity_hash needs an external_id or an email");
    if (!IDENTITY_HASH_RE.test(hash) || !safeEqual(signIdentity(cfg.secret, externalId, email), hash)) throw unauthorized("The identity hash does not match", "IDENTITY_HASH_INVALID");
    return { mode: "verified", externalId, email };
  }
  return cfg?.enforce ? { mode: "anonymous" } : { mode: "legacy" };
}
