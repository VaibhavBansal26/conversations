import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { can, type Permission } from "../authz/permissions.js";
import { hashPassword, safeEqual, sha256, verifyPassword } from "../util/crypto.js";
import { newId } from "../util/ids.js";
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUrl, totpStep, verifyTotp } from "../util/totp.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "./audit.js";
import { actorFromRow, findMember, invalidateMember, memberDto, type MemberRow } from "./members.js";
import { signAccessToken } from "./auth.js";
import { workspaceDto } from "./workspaces.js";
import { addMinutes } from "../util/time.js";
import { assertSeatAvailable } from "../billing/state.js";
import { assertWorkspaceActive } from "../admin/suspension.js";

/* ===================================================================================================================================== *
 * Sessions and refresh-token rotation
 *
 * A login creates an auth session and a refresh token. The access JWT is short lived (ACCESS_TOKEN_TTL_SECONDS) and carries the session id;
 * the refresh token is random, stored only as a SHA-256, valid once. Using it returns a new access token AND a new refresh token. Presenting a
 * refresh token that was already used means two parties hold it (theft or a bug): the whole session is revoked and the event is audited.
 * ===================================================================================================================================== */

export const REFRESH_TTL_DAYS = 30;
const iso = (d: Date) => d.toISOString();

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

async function newRefresh(ctx: AppContext, sessionId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const now = ctx.clock();
  await ctx.db.run(
    "INSERT INTO refresh_tokens(id, session_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)",
    newId("rt"),
    sessionId,
    sha256(raw),
    iso(now),
    iso(new Date(now.getTime() + REFRESH_TTL_DAYS * 86400_000)),
  );
  return raw;
}

/** Everything a client needs after proving who it is. */
export async function startSession(ctx: AppContext, row: MemberRow, meta: SessionMeta = {}) {
  const sid = newId("ses");
  const now = ctx.clock();
  await ctx.db.run(
    "INSERT INTO auth_sessions(id, user_id, member_id, workspace_id, created_at, last_used_at, expires_at, user_agent, ip_hash) VALUES (?,?,?,?,?,?,?,?,?)",
    sid,
    row.user_id,
    row.id,
    row.workspace_id,
    iso(now),
    iso(now),
    iso(new Date(now.getTime() + REFRESH_TTL_DAYS * 86400_000)),
    meta.userAgent?.slice(0, 200) ?? null,
    meta.ip ? sha256(meta.ip).slice(0, 16) : null,
  );
  return await sessionPayload(ctx, row, sid, await newRefresh(ctx, sid));
}

async function sessionPayload(ctx: AppContext, row: MemberRow, sid: string, refresh: string) {
  return {
    token: await signAccessToken(ctx, { ...actorFromRow(row) }, sid),
    refresh_token: refresh,
    expires_in: ctx.config.ACCESS_TOKEN_TTL_SECONDS,
    session_id: sid,
    user: { id: row.user_id, name: row.name, email: row.email },
    member: await memberDto(ctx, row),
    workspace: await workspaceDto(ctx, row.workspace_id),
  };
}

export async function rotateRefresh(ctx: AppContext, raw: string, meta: SessionMeta = {}) {
  const t = await ctx.db.get<{ id: string; session_id: string; expires_at: string; used_at: string | null }>(
    "SELECT id, session_id, expires_at, used_at FROM refresh_tokens WHERE token_hash = ?",
    sha256(raw),
  );
  if (!t) throw unauthorized("Invalid refresh token", "INVALID_REFRESH");
  const s = await ctx.db.get<{ id: string; user_id: string; member_id: string; workspace_id: string; revoked_at: string | null; expires_at: string }>("SELECT * FROM auth_sessions WHERE id = ?", t.session_id);
  if (!s || s.revoked_at) throw unauthorized("Session ended", "SESSION_REVOKED");
  if (t.used_at) {
    // REUSE: kill the whole session, and say so
    await revokeSession(ctx, s.id, "refresh_token_reuse");
    await recordAudit(ctx, { workspaceId: s.workspace_id, actor: { type: "system" }, action: "auth.refresh_reuse_detected", target: s.id, detail: { user_id: s.user_id } });
    throw unauthorized("This session was ended because a refresh token was reused", "REFRESH_REUSED");
  }
  const now = ctx.clock();
  if (t.expires_at <= iso(now) || s.expires_at <= iso(now)) throw unauthorized("Session expired", "SESSION_EXPIRED");
  await assertWorkspaceActive(ctx, s.workspace_id);
  const row = await findMember(ctx, s.workspace_id, s.member_id);
  if (!row) {
    await revokeSession(ctx, s.id, "seat_removed");
    throw unauthorized("Seat no longer exists", "INVALID_TOKEN");
  }
  const next = await newRefresh(ctx, s.id);
  // the conditional update is the atomic claim: of two concurrent refreshes with the same token only one wins, the other is a reuse
  const claimed = await ctx.db.run("UPDATE refresh_tokens SET used_at = ?, replaced_by = ? WHERE id = ? AND used_at IS NULL", iso(now), sha256(next), t.id);
  if (!claimed.changes) {
    await revokeSession(ctx, s.id, "refresh_token_reuse");
    await recordAudit(ctx, { workspaceId: s.workspace_id, actor: { type: "system" }, action: "auth.refresh_reuse_detected", target: s.id, detail: { user_id: s.user_id, race: true } });
    throw unauthorized("This session was ended because a refresh token was reused", "REFRESH_REUSED");
  }
  await ctx.db.run("UPDATE auth_sessions SET last_used_at = ?, ip_hash = COALESCE(?, ip_hash) WHERE id = ?", iso(now), meta.ip ? sha256(meta.ip).slice(0, 16) : null, s.id);
  return await sessionPayload(ctx, row, s.id, next);
}

export async function revokeSession(ctx: AppContext, sessionId: string, reason: string): Promise<void> {
  await ctx.db.run("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?) WHERE id = ?", nowIso(ctx), reason, sessionId);
  await ctx.cache.invalidate(`sess:${sessionId}`);
}

export async function revokeUserSessions(ctx: AppContext, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const rows = await ctx.db.all<{ id: string }>("SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL", userId);
  let n = 0;
  for (const r of rows) {
    if (r.id === exceptSessionId) continue;
    await revokeSession(ctx, r.id, reason);
    n++;
  }
  return n;
}

/** Is this access token's session still live? Cached for a few seconds; revocation invalidates the entry on every node. */
export async function sessionLive(ctx: AppContext, sessionId: string): Promise<boolean> {
  return ctx.cache.wrap(`sess:${sessionId}`, async () => {
    const s = await ctx.db.get<{ revoked_at: string | null; expires_at: string }>("SELECT revoked_at, expires_at FROM auth_sessions WHERE id = ?", sessionId);
    return !!s && !s.revoked_at && s.expires_at > nowIso(ctx);
  });
}

export async function listSessions(ctx: AppContext, userId: string, currentSid?: string) {
  const rows = await ctx.db.all<{ id: string; created_at: string; last_used_at: string; user_agent: string | null; workspace_id: string }>(
    "SELECT id, created_at, last_used_at, user_agent, workspace_id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC",
    userId,
    nowIso(ctx),
  );
  return rows.map((r) => ({ ...r, current: r.id === currentSid }));
}

/* ===================================================================================================================================== *
 * Two-factor authentication (TOTP, RFC 6238) with recovery codes
 * ===================================================================================================================================== */

const MFA_PURPOSE = "mfa";
const RECOVERY_COUNT = 10;
const recoveryHash = (c: string) => sha256(c.replace(/[\s-]/g, "").toLowerCase());

export async function mfaSetup(ctx: AppContext, actor: Actor) {
  const u = await ctx.db.get<{ totp_enabled_at: string | null }>("SELECT totp_enabled_at FROM users WHERE id = ?", actor.userId);
  if (u?.totp_enabled_at) throw conflict("MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled");
  const secret = newTotpSecret();
  await ctx.db.run("UPDATE users SET totp_pending = ? WHERE id = ?", encryptSecret(ctx.config.JWT_SECRET, secret), actor.userId);
  return { secret, otpauth_url: otpauthUrl("Conversations", actor.email, secret) };
}

export async function mfaEnable(ctx: AppContext, actor: Actor, code: string) {
  const u = await ctx.db.get<{ totp_pending: string | null; totp_enabled_at: string | null }>("SELECT totp_pending, totp_enabled_at FROM users WHERE id = ?", actor.userId);
  if (u?.totp_enabled_at) throw conflict("MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled");
  if (!u?.totp_pending) throw unprocessable("MFA_NOT_STARTED", "Start setup first");
  const secret = decryptSecret(ctx.config.JWT_SECRET, u.totp_pending);
  const step = verifyTotp(secret, code, ctx.clock().getTime());
  if (step === null) throw unprocessable("INVALID_CODE", "That code is not valid");
  const codes = Array.from({ length: RECOVERY_COUNT }, () => `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`);
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?", nowIso(ctx), step, actor.userId);
    await ctx.db.run("DELETE FROM recovery_codes WHERE user_id = ?", actor.userId);
    for (const c of codes) await ctx.db.run("INSERT INTO recovery_codes(user_id, code_hash) VALUES (?,?)", actor.userId, recoveryHash(c));
  });
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "auth.mfa_enabled", target: actor.userId });
  return { recovery_codes: codes };
}

export async function mfaDisable(ctx: AppContext, actor: Actor, input: { password: string; code: string }) {
  const u = await ctx.db.get<{ password_hash: string; totp_secret: string | null; totp_last_step: number }>("SELECT password_hash, totp_secret, totp_last_step FROM users WHERE id = ?", actor.userId);
  if (!u?.totp_secret) throw unprocessable("MFA_NOT_ENABLED", "Two-factor authentication is not enabled");
  if (!(await verifyPassword(input.password, u.password_hash))) throw unauthorized("Invalid password", "INVALID_CREDENTIALS");
  if (!(await consumeSecondFactor(ctx, actor.userId, input.code))) throw unprocessable("INVALID_CODE", "That code is not valid");
  await ctx.db.run("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = ?", actor.userId);
  await ctx.db.run("DELETE FROM recovery_codes WHERE user_id = ?", actor.userId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "auth.mfa_disabled", target: actor.userId });
}

/** Accept a TOTP code (once per time step) or a recovery code (once). */
async function consumeSecondFactor(ctx: AppContext, userId: string, code: string): Promise<boolean> {
  const u = await ctx.db.get<{ totp_secret: string | null; totp_last_step: number }>("SELECT totp_secret, totp_last_step FROM users WHERE id = ?", userId);
  if (!u?.totp_secret) return false;
  const c = code.trim();
  if (/^\d{6}$/.test(c)) {
    const step = verifyTotp(decryptSecret(ctx.config.JWT_SECRET, u.totp_secret), c, ctx.clock().getTime(), u.totp_last_step);
    if (step === null) return false;
    // conditional update: two requests racing with the same code cannot both succeed
    const r = await ctx.db.run("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?", step, userId, step);
    return r.changes > 0;
  }
  const r = await ctx.db.run("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL", nowIso(ctx), userId, recoveryHash(c));
  return r.changes > 0;
}

export async function mfaChallengeToken(ctx: AppContext, userId: string, workspaceId: string | undefined): Promise<string> {
  const now = Math.floor(ctx.clock().getTime() / 1000);
  return new SignJWT({ purpose: MFA_PURPOSE, wid: workspaceId ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("conversations")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(ctx.config.JWT_SECRET));
}

export async function mfaComplete(ctx: AppContext, mfaToken: string, code: string, meta: SessionMeta) {
  let userId: string;
  let wid: string | null;
  try {
    const { payload } = await jwtVerify(mfaToken, new TextEncoder().encode(ctx.config.JWT_SECRET), { issuer: "conversations", algorithms: ["HS256"], currentDate: ctx.clock() });
    if (payload.purpose !== MFA_PURPOSE || typeof payload.sub !== "string") throw new Error("purpose");
    userId = payload.sub;
    wid = (payload.wid as string | null) ?? null;
  } catch {
    throw unauthorized("The sign-in step expired, start again", "MFA_TOKEN_INVALID");
  }
  if (!(await consumeSecondFactor(ctx, userId, code))) throw unauthorized("That code is not valid", "INVALID_CODE");
  const seats = await ctx.db.all<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM members WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at", userId);
  const pick = wid ? seats.find((s) => s.workspace_id === wid) : seats[0];
  if (!pick) throw unauthorized("No access to this workspace", "NO_WORKSPACE");
  const out = await startSession(ctx, (await findMember(ctx, pick.workspace_id, pick.id))!, meta);
  await recordAudit(ctx, { workspaceId: pick.workspace_id, actor: { type: "member", id: pick.id }, action: "auth.login", detail: { mfa: true } });
  return { ...out, workspaces: seats.map((s) => ({ id: s.workspace_id })) };
}

export const userHasMfa = async (ctx: AppContext, userId: string): Promise<boolean> => !!(await ctx.db.get("SELECT 1 FROM users WHERE id = ? AND totp_enabled_at IS NOT NULL", userId));
export const currentTotpStep = (ctx: AppContext) => totpStep(ctx.clock().getTime());

/* ===================================================================================================================================== *
 * Password reset and change
 * ===================================================================================================================================== */

const RESET_TTL_MIN = 60;
const siteLink = (ctx: AppContext, path: string) => `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}${path}`;
const fromDomain = (ctx: AppContext) => ctx.config.SYSTEM_EMAIL_FROM.split("@")[1] ?? "localhost";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function systemEmail(ctx: AppContext, to: string, subject: string, text: string, html: string) {
  await ctx.email.send({ from: { address: ctx.config.SYSTEM_EMAIL_FROM, name: "Conversations" }, to, subject, text, html, messageId: `<${newId("sys")}@${fromDomain(ctx)}>` });
}

/** Always succeeds from the caller's point of view: the response never reveals whether the address has an account. */
export async function requestPasswordReset(ctx: AppContext, emailRaw: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  const u = await ctx.db.get<{ id: string; name: string }>("SELECT id, name FROM users WHERE email = ?", email);
  if (!u) return;
  const raw = randomBytes(32).toString("base64url");
  const now = ctx.clock();
  await ctx.db.run("INSERT INTO password_resets(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)", sha256(raw), u.id, iso(now), iso(addMinutes(now, RESET_TTL_MIN)));
  const link = siteLink(ctx, `/reset-password?token=${raw}`);
  await systemEmail(ctx, email, "Reset your password", `Hi ${u.name},\n\nUse this link within an hour to choose a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`, `<p>Hi ${esc(u.name)},</p><p><a href="${link}">Choose a new password</a> (valid for an hour).</p><p>If you did not ask for this, ignore this email.</p>`);
  await recordAudit(ctx, { actor: { type: "anonymous" }, action: "auth.password_reset_requested", target: u.id });
}

export async function resetPassword(ctx: AppContext, token: string, password: string): Promise<void> {
  const row = await ctx.db.get<{ user_id: string; expires_at: string; used_at: string | null }>("SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?", sha256(token));
  if (!row || row.used_at || row.expires_at <= nowIso(ctx)) throw unprocessable("INVALID_RESET_TOKEN", "This reset link is invalid or has expired");
  const claimed = await ctx.db.run("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", nowIso(ctx), sha256(token));
  if (!claimed.changes) throw unprocessable("INVALID_RESET_TOKEN", "This reset link is invalid or has expired");
  await ctx.db.run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), row.user_id);
  // a new password ends every session: whoever knew the old one is out
  const n = await revokeUserSessions(ctx, row.user_id, "password_reset");
  await ctx.db.run("UPDATE password_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ?", nowIso(ctx), row.user_id);
  await recordAudit(ctx, { actor: { type: "anonymous" }, action: "auth.password_reset", target: row.user_id, detail: { sessions_revoked: n } });
}

export async function changePassword(ctx: AppContext, actor: Actor, sessionId: string | undefined, input: { current: string; next: string }): Promise<void> {
  const u = await ctx.db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", actor.userId);
  if (!u || !(await verifyPassword(input.current, u.password_hash))) throw unauthorized("The current password is wrong", "INVALID_CREDENTIALS");
  await ctx.db.run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(input.next), actor.userId);
  const n = await revokeUserSessions(ctx, actor.userId, "password_change", sessionId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "auth.password_changed", target: actor.userId, detail: { other_sessions_revoked: n } });
}

/* ===================================================================================================================================== *
 * Invitations
 * ===================================================================================================================================== */

const INVITE_TTL_DAYS = 7;

export async function inviteMember(ctx: AppContext, actor: Actor, input: { email: string; name?: string; role_id: string }) {
  await assertSeatAvailable(ctx, actor.workspaceId);
  const email = input.email.trim().toLowerCase();
  const role = await ctx.db.get<{ id: string; key: string; permissions: string }>("SELECT id, key, permissions FROM roles WHERE id = ? AND (workspace_id IS NULL OR workspace_id = ?)", input.role_id, actor.workspaceId);
  if (!role) throw notFound("Role");
  const over = parseJson<string[]>(role.permissions, []).filter((p) => !can(actor, p as Permission));
  if (over.length) throw forbidden(`You cannot grant permissions you do not have: ${over.join(", ")}`, "PRIVILEGE_ESCALATION");
  if (role.id === "role_owner" && actor.roleKey !== "owner") throw forbidden("Only an owner can invite an owner");
  const existing = await ctx.db.get<{ id: string }>("SELECT m.id FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ? AND m.removed_at IS NULL", actor.workspaceId, email);
  if (existing) throw conflict("ALREADY_MEMBER", "This person is already on the team");
  const raw = randomBytes(32).toString("base64url");
  const now = ctx.clock();
  const id = newId("inv");
  try {
    await ctx.db.run(
      "INSERT INTO invitations(id, workspace_id, email, name, role_id, token_hash, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      actor.workspaceId,
      email,
      input.name?.trim() ?? "",
      role.id,
      sha256(raw),
      actor.memberId,
      iso(now),
      iso(new Date(now.getTime() + INVITE_TTL_DAYS * 86400_000)),
    );
  } catch (e) {
    if (e instanceof Error && /unique|duplicate/i.test(e.message)) throw conflict("ALREADY_INVITED", "There is already a pending invitation for this address; revoke it to send a new one");
    throw e;
  }
  const ws = await workspaceDto(ctx, actor.workspaceId);
  const link = siteLink(ctx, `/accept-invitation?token=${raw}`);
  await systemEmail(ctx, email, `${actor.name} invited you to ${ws.name}`, `${actor.name} invited you to join ${ws.name} on Conversations as ${role.key}.\n\nAccept within ${INVITE_TTL_DAYS} days: ${link}`, `<p>${esc(actor.name)} invited you to join <strong>${esc(ws.name)}</strong> as ${esc(role.key)}.</p><p><a href="${link}">Accept the invitation</a> (valid for ${INVITE_TTL_DAYS} days).</p>`);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "invitation.create", target: id, detail: { email_hash: sha256(email).slice(0, 12), role: role.key } });
  return { id, email, role_id: role.id, expires_at: iso(new Date(now.getTime() + INVITE_TTL_DAYS * 86400_000)) };
}

export async function listInvitations(ctx: AppContext, workspaceId: string) {
  return ctx.db.all<{ id: string; email: string; role_id: string; created_at: string; expires_at: string }>(
    "SELECT id, email, role_id, created_at, expires_at FROM invitations WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    workspaceId,
    nowIso(ctx),
  );
}

export async function revokeInvitation(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  const r = await ctx.db.run("UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL", nowIso(ctx), id, actor.workspaceId);
  if (!r.changes) throw notFound("Invitation");
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "invitation.revoke", target: id });
}

async function liveInvitation(ctx: AppContext, token: string) {
  const inv = await ctx.db.get<{ id: string; workspace_id: string; email: string; name: string; role_id: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }>(
    "SELECT * FROM invitations WHERE token_hash = ?",
    sha256(token),
  );
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at <= nowIso(ctx)) throw unprocessable("INVALID_INVITATION", "This invitation is invalid or has expired");
  return inv;
}

export async function describeInvitation(ctx: AppContext, token: string) {
  const inv = await liveInvitation(ctx, token);
  const ws = await workspaceDto(ctx, inv.workspace_id);
  const hasAccount = !!(await ctx.db.get("SELECT 1 FROM users WHERE email = ?", inv.email));
  return { email: inv.email, workspace_name: ws.name, name: inv.name, has_account: hasAccount };
}

/** Accept: new users choose a password, existing users prove theirs. The seat gets exactly the role the inviter chose. */
export async function acceptInvitation(ctx: AppContext, input: { token: string; name?: string; password: string }, meta: SessionMeta) {
  const inv = await liveInvitation(ctx, input.token);
  const claimed = await ctx.db.run("UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL", nowIso(ctx), inv.id);
  if (!claimed.changes) throw unprocessable("INVALID_INVITATION", "This invitation is invalid or has expired");
  let user = await ctx.db.get<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", inv.email);
  if (user) {
    if (!(await verifyPassword(input.password, user.password_hash))) {
      await ctx.db.run("UPDATE invitations SET accepted_at = NULL WHERE id = ?", inv.id); // a wrong password must not burn the invitation
      throw unauthorized("Invalid password", "INVALID_CREDENTIALS");
    }
  } else {
    const id = newId("usr");
    await ctx.db.run("INSERT INTO users(id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)", id, inv.email, await hashPassword(input.password), (input.name || inv.name || inv.email.split("@")[0]!).trim(), nowIso(ctx));
    user = { id, password_hash: "" };
  }
  const role = (await ctx.db.get<{ id: string; base_role: string }>("SELECT id, base_role FROM roles WHERE id = ?", inv.role_id))!;
  const legacy = ["role_owner", "role_manager", "role_agent"].includes(role.id);
  const prior = await ctx.db.get<{ id: string; removed_at: string | null }>("SELECT id, removed_at FROM members WHERE workspace_id = ? AND user_id = ?", inv.workspace_id, user.id);
  let memberId: string;
  if (prior) {
    memberId = prior.id;
    await ctx.db.run("UPDATE members SET removed_at = NULL, role = ?, role_id = ? WHERE id = ?", role.base_role, legacy ? null : role.id, memberId);
  } else {
    memberId = newId("mem");
    await ctx.db.run("INSERT INTO members(id, workspace_id, user_id, role, role_id, created_at) VALUES (?,?,?,?,?,?)", memberId, inv.workspace_id, user.id, role.base_role, legacy ? null : role.id, nowIso(ctx));
  }
  await invalidateMember(ctx, inv.workspace_id, memberId);
  const row = (await findMember(ctx, inv.workspace_id, memberId))!;
  ctx.bus.toWorkspace(inv.workspace_id, "member:updated", await memberDto(ctx, row));
  await recordAudit(ctx, { workspaceId: inv.workspace_id, actor: { type: "member", id: memberId }, action: "invitation.accept", target: inv.id });
  return await startSession(ctx, row, meta);
}

/* helpers used by the login flow */
export const constantTimeEquals = safeEqual;
export const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
export { AppError };
