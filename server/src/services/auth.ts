import { SignJWT, jwtVerify } from "jose";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor, Role } from "../domain/types.js";
import { conflict, unauthorized } from "../errors.js";
import { hashPassword, verifyPassword } from "../util/crypto.js";
import { newId } from "../util/ids.js";
import { actorFromRow, findMember, memberDto, type MemberRow } from "./members.js";
import { workspaceDto } from "./workspaces.js";

const ISSUER = "conversations";
// Compared against when the email is unknown so login timing does not reveal which emails exist.
const DUMMY_HASH = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);

interface Claims {
  sub: string;
  mid: string;
  wid: string;
  role: Role;
}

export async function signAccessToken(ctx: AppContext, a: Pick<Actor, "userId" | "memberId" | "workspaceId" | "role">): Promise<string> {
  return await new SignJWT({ mid: a.memberId, wid: a.workspaceId, role: a.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(a.userId)
    .setIssuer(ISSUER)
    .setIssuedAt(Math.floor(ctx.clock().getTime() / 1000))
    .setExpirationTime(Math.floor(ctx.clock().getTime() / 1000) + ctx.config.ACCESS_TOKEN_TTL_SECONDS)
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
    return { sub: payload.sub, mid: payload.mid, wid: payload.wid, role: payload.role as Role };
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
  return actorFromRow(row);
}

async function session(ctx: AppContext, row: MemberRow) {
  return {
    token: await signAccessToken(ctx, actorFromRow(row)),
    expires_in: ctx.config.ACCESS_TOKEN_TTL_SECONDS,
    user: { id: row.user_id, name: row.name, email: row.email },
    member: await memberDto(ctx, row),
    workspace: await workspaceDto(ctx, row.workspace_id),
  };
}

export async function register(ctx: AppContext, input: { email: string; password: string; name: string; workspace_name: string }) {
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
  return await session(ctx, (await findMember(ctx, ids.ws, ids.member))!);
}

export async function login(ctx: AppContext, input: { email: string; password: string; workspace_id?: string }) {
  const user = await ctx.db.get<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", input.email.trim().toLowerCase());
  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
  const seats = await ctx.db.all<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM members WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at",
    user.id,
  );
  const pick = input.workspace_id ? seats.find((s) => s.workspace_id === input.workspace_id) : seats[0];
  if (!pick) throw unauthorized("No access to this workspace", "NO_WORKSPACE");
  const out = await session(ctx, (await findMember(ctx, pick.workspace_id, pick.id))!);
  return { ...out, workspaces: seats.map((s) => ({ id: s.workspace_id })) };
}

export async function currentSession(ctx: AppContext, actor: Actor) {
  const row = (await findMember(ctx, actor.workspaceId, actor.memberId))!;
  return { user: { id: row.user_id, name: row.name, email: row.email }, member: await memberDto(ctx, row), workspace: await workspaceDto(ctx, actor.workspaceId) };
}
