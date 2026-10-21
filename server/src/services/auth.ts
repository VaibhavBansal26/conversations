import { createDefaultAgents } from "../agents/config.js";
import { ensureGeneral } from "./teamChat.js";
import { SignJWT, jwtVerify } from "jose";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor, Role } from "../domain/types.js";
import { conflict, unauthorized } from "../errors.js";
import { hashPassword, verifyPassword } from "../util/crypto.js";
import { newId } from "../util/ids.js";
import { getAdmin } from "../admin/auth.js";
import { assertWorkspaceActive } from "../admin/suspension.js";
import { actorFromRow, findMember, memberDto } from "./members.js";
import { workspaceDto } from "./workspaces.js";
import { mfaChallengeToken, sessionLive, startSession, userHasMfa, type SessionMeta } from "./accounts.js";
import { recordAudit } from "./audit.js";

const ISSUER = "conversations";
/** What a support (impersonation) token can see, whatever the impersonated seat can do. No write permission is ever in this list. */
export const SUPPORT_VIEW = ["conversations:read", "contacts:read", "members:read", "settings:read", "analytics:read"];
// Compared against when the email is unknown so login timing does not reveal which emails exist.
const DUMMY_HASH = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);

interface Claims {
  sub: string;
  mid: string;
  wid: string;
  role: Role;
  /** auth session id (absent on tokens minted without a session, e.g. by tests) */
  sid?: string;
  /** platform admin id on a support (impersonation) token */
  imp?: string;
}

export async function signAccessToken(ctx: AppContext, a: Pick<Actor, "userId" | "memberId" | "workspaceId" | "role">, sid?: string, opts: { imp?: string; ttlSeconds?: number } = {}): Promise<string> {
  return await new SignJWT({ mid: a.memberId, wid: a.workspaceId, role: a.role, ...(sid ? { sid } : {}), ...(opts.imp ? { imp: opts.imp } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(a.userId)
    .setIssuer(ISSUER)
    .setIssuedAt(Math.floor(ctx.clock().getTime() / 1000))
    .setExpirationTime(Math.floor(ctx.clock().getTime() / 1000) + (opts.ttlSeconds ?? ctx.config.ACCESS_TOKEN_TTL_SECONDS))
    .sign(new TextEncoder().encode(ctx.config.JWT_SECRET));
}

export async function verifyAccessToken(ctx: AppContext, token: string): Promise<Claims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(ctx.config.JWT_SECRET), {
      issuer: ISSUER,
      algorithms: ["HS256"],
      currentDate: ctx.clock(),
    });
    if (typeof payload.sub !== "string" || typeof payload.mid !== "string" || typeof payload.wid !== "string") throw new Error("claims");
    return { sub: payload.sub, mid: payload.mid, wid: payload.wid, role: payload.role as Role, sid: typeof payload.sid === "string" ? payload.sid : undefined, imp: typeof payload.imp === "string" ? payload.imp : undefined };
  } catch {
    throw unauthorized("Invalid or expired token", "INVALID_TOKEN");
  }
}

/** Resolve a token to a live seat. Role and flags always come from the database, not the token. */
export async function actorFromToken(ctx: AppContext, token: string, expectedWorkspaceId?: string): Promise<Actor> {
  const c = await verifyAccessToken(ctx, token);
  if (expectedWorkspaceId && c.wid !== expectedWorkspaceId) throw unauthorized("Token belongs to another workspace", "WRONG_WORKSPACE");
  const row = await findMember(ctx, c.wid, c.mid);
  if (!row || row.user_id !== c.sub) throw unauthorized("Seat no longer exists", "INVALID_TOKEN");
  // checked before the session so a suspended workspace is told why, instead of seeing its sessions as merely revoked
  await assertWorkspaceActive(ctx, c.wid);
  // a revoked session (logout, password change, refresh-token reuse) stops working at once, not when the access token expires
  if (c.sid && !(await sessionLive(ctx, c.sid))) throw unauthorized("Session ended", "SESSION_REVOKED");
  const actor = actorFromRow(row);
  if (!c.imp) return actor;
  // support access: only while the admin who minted it is still an active admin, and strictly read-only
  const admin = await getAdmin(ctx, c.imp);
  if (!admin || admin.disabled_at) throw unauthorized("Support access ended", "SESSION_REVOKED");
  return { ...actor, impersonatedBy: c.imp, permissions: new Set(SUPPORT_VIEW.filter((p) => actor.permissions.has(p))) };
}

export async function register(ctx: AppContext, input: { email: string; password: string; name: string; workspace_name: string }, meta: SessionMeta = {}, o: { defaultAgents?: boolean } = {}) {
  const email = input.email.trim().toLowerCase();
  if (await ctx.db.get("SELECT 1 FROM users WHERE email = ?", email)) throw conflict("EMAIL_TAKEN", "An account with this email already exists");
  const hash = await hashPassword(input.password);
  const ids = { user: newId("usr"), ws: newId("ws"), member: newId("mem") };
  const now = nowIso(ctx);
  await ctx.db.tx(async () => {
    await ctx.db.run("INSERT INTO workspaces(id, name, settings, created_at) VALUES (?,?,?,?)", ids.ws, input.workspace_name, "{}", now);
    await ctx.db.run("INSERT INTO users(id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)", ids.user, email, hash, input.name, now);
    await ctx.db.run("INSERT INTO members(id, workspace_id, user_id, role, created_at) VALUES (?,?,?,?,?)", ids.member, ids.ws, ids.user, "owner", now);
  });
  await recordAudit(ctx, { workspaceId: ids.ws, actor: { type: "member", id: ids.member }, action: "workspace.create", target: ids.ws });
  await ensureGeneral(ctx, ids.ws, ids.member); // every workspace starts with #general
  // and with Aria and vb on, so a visitor gets an answer from the first message (docs/AI-AGENTS.md)
  if (ctx.config.DEFAULT_AI_AGENTS && o.defaultAgents !== false) await createDefaultAgents(ctx, ids.ws, ids.member);
  return await startSession(ctx, (await findMember(ctx, ids.ws, ids.member))!, meta);
}

export async function login(ctx: AppContext, input: { email: string; password: string; workspace_id?: string }, meta: SessionMeta = {}) {
  const user = await ctx.db.get<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", input.email.trim().toLowerCase());
  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
  const seats = await ctx.db.all<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM members WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at",
    user.id,
  );
  const pick = input.workspace_id ? seats.find((s) => s.workspace_id === input.workspace_id) : seats[0];
  if (!pick) throw unauthorized("No access to this workspace", "NO_WORKSPACE");
  await assertWorkspaceActive(ctx, pick.workspace_id);
  // second factor: the password alone is not enough for an account that enabled it
  if (await userHasMfa(ctx, user.id)) return { mfa_required: true as const, mfa_token: await mfaChallengeToken(ctx, user.id, pick.workspace_id) };
  const out = await startSession(ctx, (await findMember(ctx, pick.workspace_id, pick.id))!, meta);
  await recordAudit(ctx, { workspaceId: pick.workspace_id, actor: { type: "member", id: pick.id }, action: "auth.login" });
  return { ...out, workspaces: seats.map((s) => ({ id: s.workspace_id })) };
}

export async function currentSession(ctx: AppContext, actor: Actor) {
  const row = (await findMember(ctx, actor.workspaceId, actor.memberId))!;
  return { user: { id: row.user_id, name: row.name, email: row.email }, member: await memberDto(ctx, row), workspace: await workspaceDto(ctx, actor.workspaceId) };
}
