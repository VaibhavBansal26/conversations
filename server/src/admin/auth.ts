import { SignJWT, jwtVerify } from "jose";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { conflict, forbidden, unauthorized, unprocessable } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { hashPassword, verifyPassword } from "../util/crypto.js";
import { newId } from "../util/ids.js";
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUrl, verifyTotp } from "../util/totp.js";

export type AdminRole = "superadmin" | "support";

export interface AdminRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: AdminRole;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number;
  disabled_at: string | null;
  last_login_at: string | null;
  created_at: string;
}

export interface PlatformAdmin {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

// Platform tokens have their own issuer and audience: a workspace access token can never open the console and vice versa.
const ISSUER = "conversations-platform";
const AUD_ACCESS = "platform-admin";
const AUD_STEP = "platform-admin-step";
export const ADMIN_TOKEN_TTL_SECONDS = 30 * 60;
const DUMMY_HASH = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);
const key = (ctx: AppContext) => new TextEncoder().encode(`platform:${ctx.config.JWT_SECRET}`);
const nowSec = (ctx: AppContext) => Math.floor(ctx.clock().getTime() / 1000);

async function sign(ctx: AppContext, sub: string, aud: string, ttl: number, extra: Record<string, unknown> = {}) {
  return await new SignJWT(extra).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt(nowSec(ctx)).setExpirationTime(nowSec(ctx) + ttl).sign(key(ctx));
}

async function verify(ctx: AppContext, token: string, aud: string): Promise<{ sub: string; step?: string }> {
  try {
    const { payload } = await jwtVerify(token, key(ctx), { issuer: ISSUER, audience: aud, algorithms: ["HS256"], currentDate: ctx.clock() });
    if (typeof payload.sub !== "string") throw new Error("sub");
    return { sub: payload.sub, step: payload.step as string | undefined };
  } catch {
    throw unauthorized("Invalid or expired token", aud === AUD_ACCESS ? "INVALID_TOKEN" : "MFA_TOKEN_INVALID");
  }
}

const dto = (a: AdminRow): PlatformAdmin => ({ id: a.id, email: a.email, name: a.name, role: a.role });
export const adminDto = (a: AdminRow) => ({ ...dto(a), mfa_enabled: !!a.totp_enabled_at, disabled: !!a.disabled_at, last_login_at: a.last_login_at, created_at: a.created_at });

export const getAdmin = (ctx: AppContext, id: string) => ctx.db.get<AdminRow>("SELECT * FROM platform_admins WHERE id = ?", id);

/** Used by the CLI (`npm run admin:create`); there is deliberately no HTTP endpoint that creates an admin. */
export async function createPlatformAdmin(ctx: AppContext, input: { email: string; name: string; password: string; role?: AdminRole }): Promise<AdminRow> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 12) throw unprocessable("WEAK_PASSWORD", "Admin passwords must be at least 12 characters");
  if (await ctx.db.get("SELECT 1 FROM platform_admins WHERE email = ?", email)) throw conflict("EMAIL_TAKEN", "An admin with this email already exists");
  const id = newId("adm");
  await ctx.db.run("INSERT INTO platform_admins(id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)", id, email, input.name.trim(), await hashPassword(input.password), input.role ?? "superadmin", nowIso(ctx));
  await recordAudit(ctx, { actor: { type: "system" }, action: "admin.created", target: id, detail: { role: input.role ?? "superadmin" } });
  return (await getAdmin(ctx, id))!;
}

/**
 * Step 1. Verifies the password and always answers with a step token: `mfa_setup_required` when the admin has not enrolled yet (then the
 * only things that token can do are set up and enable), otherwise `mfa_required`. Never an access token.
 */
export async function adminLogin(ctx: AppContext, input: { email: string; password: string }) {
  const a = await ctx.db.get<AdminRow>("SELECT * FROM platform_admins WHERE email = ?", input.email.trim().toLowerCase());
  const ok = await verifyPassword(input.password, a?.password_hash ?? DUMMY_HASH);
  if (!a || !ok || a.disabled_at) throw unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
  const enrolled = !!a.totp_enabled_at;
  return { [enrolled ? "mfa_required" : "mfa_setup_required"]: true as const, mfa_token: await sign(ctx, a.id, AUD_STEP, 300, { step: enrolled ? "verify" : "enrol" }) };
}

async function stepAdmin(ctx: AppContext, mfaToken: string, step: "verify" | "enrol"): Promise<AdminRow> {
  const t = await verify(ctx, mfaToken, AUD_STEP);
  if (t.step !== step) throw unauthorized("The sign-in step expired, start again", "MFA_TOKEN_INVALID");
  const a = await getAdmin(ctx, t.sub);
  if (!a || a.disabled_at) throw unauthorized("Invalid credentials", "INVALID_CREDENTIALS");
  return a;
}

export async function adminMfaSetup(ctx: AppContext, mfaToken: string) {
  const a = await stepAdmin(ctx, mfaToken, "enrol");
  if (a.totp_enabled_at) throw conflict("MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled");
  const secret = newTotpSecret();
  await ctx.db.run("UPDATE platform_admins SET totp_pending = ? WHERE id = ?", encryptSecret(ctx.config.JWT_SECRET, secret), a.id);
  return { secret, otpauth_url: otpauthUrl("Conversations platform", a.email, secret) };
}

/** Confirms enrolment with a first code and signs in. */
export async function adminMfaEnable(ctx: AppContext, mfaToken: string, code: string) {
  const a = await stepAdmin(ctx, mfaToken, "enrol");
  if (a.totp_enabled_at) throw conflict("MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled");
  if (!a.totp_pending) throw unprocessable("MFA_NOT_STARTED", "Start setup first");
  const step = verifyTotp(decryptSecret(ctx.config.JWT_SECRET, a.totp_pending), code, ctx.clock().getTime());
  if (step === null) throw unprocessable("INVALID_CODE", "That code is not valid");
  await ctx.db.run("UPDATE platform_admins SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?", nowIso(ctx), step, a.id);
  await recordAudit(ctx, { actor: { type: "platform_admin", id: a.id }, action: "admin.mfa_enabled", target: a.id });
  return await signIn(ctx, a);
}

/** Step 2. A TOTP code is accepted once per 30-second step (the conditional update is the atomic claim). */
export async function adminMfaVerify(ctx: AppContext, mfaToken: string, code: string) {
  const a = await stepAdmin(ctx, mfaToken, "verify");
  if (!a.totp_secret) throw unauthorized("Invalid credentials", "INVALID_CREDENTIALS");
  const step = /^\d{6}$/.test(code.trim()) ? verifyTotp(decryptSecret(ctx.config.JWT_SECRET, a.totp_secret), code.trim(), ctx.clock().getTime(), a.totp_last_step) : null;
  if (step === null) throw unauthorized("That code is not valid", "INVALID_CODE");
  const claimed = await ctx.db.run("UPDATE platform_admins SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?", step, a.id, step);
  if (!claimed.changes) throw unauthorized("That code is not valid", "INVALID_CODE");
  return await signIn(ctx, a);
}

async function signIn(ctx: AppContext, a: AdminRow) {
  await ctx.db.run("UPDATE platform_admins SET last_login_at = ? WHERE id = ?", nowIso(ctx), a.id);
  await recordAudit(ctx, { actor: { type: "platform_admin", id: a.id }, action: "admin.login", target: a.id });
  return { token: await sign(ctx, a.id, AUD_ACCESS, ADMIN_TOKEN_TTL_SECONDS, { role: a.role }), expires_in: ADMIN_TOKEN_TTL_SECONDS, admin: dto(a) };
}

/** Resolve a bearer token to a live admin. Role and disabled state always come from the database, so disabling an admin ends their access at once. */
export async function adminFromToken(ctx: AppContext, token: string): Promise<PlatformAdmin> {
  const t = await verify(ctx, token, AUD_ACCESS);
  const a = await getAdmin(ctx, t.sub);
  if (!a || a.disabled_at || !a.totp_enabled_at) throw unauthorized("This admin account is not active", "INVALID_TOKEN");
  return dto(a);
}

export const requireSuperadmin = (a: PlatformAdmin): void => {
  if (a.role !== "superadmin") throw forbidden("Only a superadmin can do this", "ADMIN_ROLE_REQUIRED");
};

/** Short-lived, read-only workspace token for support. `imp` names the admin; the workspace's own audit log records who looked and why. */
export const IMPERSONATION_TTL_SECONDS = 15 * 60;
