import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { addListEntry, listEntries, limitedKeys, removeListEntry, setWorkspaceTier } from "../ratelimit/admin.js";
import type { Tier } from "../ratelimit/types.js";
import { getBilling } from "../billing/state.js";
import { PLANS, isPlanId } from "../billing/plans.js";
import { recordAudit } from "../services/audit.js";
import { signAccessToken } from "../services/auth.js";
import { findMember } from "../services/members.js";
import { applyLedger } from "../services/workspaces.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";
import { parseJson } from "../util/json.js";
import { adminDto, getAdmin, IMPERSONATION_TTL_SECONDS, type AdminRow, type PlatformAdmin } from "./auth.js";

const actorOf = (a: PlatformAdmin) => ({ type: "platform_admin" as const, id: a.id });

/* ---------------------------------------------------------------- workspaces */

export interface WorkspaceListQuery {
  search?: string;
  plan?: string;
  suspended?: boolean;
  limit: number;
  cursor?: string;
}

/** Newest first, keyset-paged on (created_at, id). `search` matches the name, the id, or an exact member email. */
export async function listWorkspaces(ctx: AppContext, q: WorkspaceListQuery) {
  const limit = Math.min(Math.max(q.limit, 1), 100);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.search) {
    const like = `%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(`(w.name ${ctx.db.ilike} ? ESCAPE '\\' OR w.id = ? OR EXISTS (SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND u.email = ?))`);
    params.push(like, q.search, q.search.toLowerCase());
  }
  if (q.plan) {
    where.push("w.plan = ?");
    params.push(q.plan);
  }
  if (q.suspended !== undefined) where.push(q.suspended ? "w.suspended_at IS NOT NULL" : "w.suspended_at IS NULL");
  if (q.cursor) {
    const c = decodeCursor(q.cursor, 2);
    if (!c) throw badRequest("INVALID_CURSOR", "Invalid cursor");
    where.push("(w.created_at < ? OR (w.created_at = ? AND w.id < ?))");
    params.push(c[0] as string, c[0] as string, c[1] as string);
  }
  const rows = await ctx.db.all<{ id: string; name: string; plan: string; created_at: string; suspended_at: string | null; credit_balance: number; members: number; billing_status: string | null }>(
    `SELECT w.id, w.name, w.plan, w.created_at, w.suspended_at, w.credit_balance,
            (SELECT COUNT(*) FROM members m WHERE m.workspace_id = w.id AND m.removed_at IS NULL) AS members,
            b.status AS billing_status
       FROM workspaces w LEFT JOIN billing_accounts b ON b.workspace_id = w.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY w.created_at DESC, w.id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { data: page.map((r) => ({ ...r, members: Number(r.members), suspended: !!r.suspended_at })), next_cursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null };
}

export async function platformStats(ctx: AppContext) {
  const one = async (sql: string, ...p: (string | number)[]) => Number((await ctx.db.get<{ n: number }>(sql, ...p))!.n);
  const byPlan = await ctx.db.all<{ plan: string; n: number }>("SELECT plan, COUNT(*) n FROM workspaces GROUP BY plan");
  const weekAgo = new Date(ctx.clock().getTime() - 7 * 86_400_000).toISOString();
  return {
    workspaces: await one("SELECT COUNT(*) n FROM workspaces"),
    suspended: await one("SELECT COUNT(*) n FROM workspaces WHERE suspended_at IS NOT NULL"),
    new_last_7_days: await one("SELECT COUNT(*) n FROM workspaces WHERE created_at >= ?", weekAgo),
    members: await one("SELECT COUNT(*) n FROM members WHERE removed_at IS NULL"),
    past_due: await one("SELECT COUNT(*) n FROM billing_accounts WHERE status IN ('past_due','unpaid')"),
    credits_outstanding: await one("SELECT COALESCE(SUM(credit_balance), 0) n FROM workspaces"),
    by_plan: Object.fromEntries(byPlan.map((r) => [r.plan, Number(r.n)])),
  };
}

/** Everything the detail page shows. No card data, no message content, no contact details: support sees the shape of an account, not its conversations. */
export async function workspaceDetail(ctx: AppContext, id: string) {
  const w = await ctx.db.get<{ id: string; name: string; plan: string; credit_balance: number; created_at: string; suspended_at: string | null; suspended_reason: string | null; settings: string; home_region: string | null }>("SELECT * FROM workspaces WHERE id = ?", id);
  if (!w) throw notFound("Workspace");
  const b = await getBilling(ctx, id);
  const members = await ctx.db.all<{ id: string; name: string; email: string; role: string; live_seat: number; created_at: string }>(
    "SELECT m.id, u.name, u.email, m.role, m.live_seat, m.created_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY m.created_at, m.id",
    id,
  );
  const monthAgo = new Date(ctx.clock().getTime() - 30 * 86_400_000).toISOString();
  const usage = await ctx.db.get<{ rooms: number; messages: number }>(
    "SELECT COUNT(*) AS rooms, COALESCE(SUM(messages_in + messages_out), 0) AS messages FROM room_metrics WHERE workspace_id = ? AND created_at >= ?",
    id,
    monthAgo,
  );
  const totals = await ctx.db.get<{ rooms: number; contacts: number }>("SELECT (SELECT COUNT(*) FROM rooms WHERE workspace_id = ?) AS rooms, (SELECT COUNT(*) FROM contacts WHERE workspace_id = ?) AS contacts", id, id);
  const tier = await ctx.db.get<{ tier: string; note: string | null }>("SELECT tier, note FROM rate_limit_overrides WHERE workspace_id = ?", id);
  const plan = isPlanId(w.plan) ? PLANS[w.plan] : PLANS.free;
  return {
    id: w.id,
    name: w.name,
    plan: w.plan,
    created_at: w.created_at,
    suspended: !!w.suspended_at,
    suspended_at: w.suspended_at,
    suspended_reason: w.suspended_reason,
    home_region: w.home_region,
    credit_balance: w.credit_balance,
    seats: { used: members.filter((m) => m.live_seat).length, limit: plan.seats },
    billing: b
      ? { status: b.status, current_period_end: b.current_period_end, cancel_at_period_end: !!b.cancel_at_period_end, grace_until: b.grace_until, has_customer: !!b.stripe_customer_id, auto_recharge: !!b.auto_recharge_enabled, connect_charges_enabled: !!b.connect_charges_enabled }
      : null,
    tier_override: tier ?? null,
    usage_30d: { conversations_started: Number(usage!.rooms), messages_in_those_conversations: Number(usage!.messages) },
    totals: { rooms: Number(totals!.rooms), contacts: Number(totals!.contacts) },
    members: members.map((m) => ({ ...m, live_seat: !!m.live_seat })),
    ledger: await ctx.db.all("SELECT id, kind, delta, balance_after, ref, created_at FROM usage_ledger WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 20", id),
    audit: await ctx.db.all("SELECT id, actor_type, actor_id, action, target, created_at FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 20", id),
  };
}

const must = async (ctx: AppContext, id: string) => {
  const w = await ctx.db.get<{ id: string; name: string; suspended_at: string | null }>("SELECT id, name, suspended_at FROM workspaces WHERE id = ?", id);
  if (!w) throw notFound("Workspace");
  return w;
};

const reasonOf = (r: string | undefined) => {
  const t = r?.trim();
  if (!t || t.length < 3) throw badRequest("REASON_REQUIRED", "Give a reason (it is recorded in the audit log)");
  return t.slice(0, 500);
};

export async function suspendWorkspace(ctx: AppContext, admin: PlatformAdmin, id: string, reason?: string) {
  const w = await must(ctx, id);
  if (w.suspended_at) throw conflict("ALREADY_SUSPENDED", "This workspace is already suspended");
  const why = reasonOf(reason);
  await ctx.db.run("UPDATE workspaces SET suspended_at = ?, suspended_reason = ? WHERE id = ?", nowIso(ctx), why, id);
  await ctx.cache.invalidate(`suspended:${id}`);
  // end every live session now; sockets are dropped on their next event and tokens stop at the next request
  await ctx.db.run("UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'workspace_suspended' WHERE workspace_id = ? AND revoked_at IS NULL", nowIso(ctx), id);
  ctx.bus.toWorkspace(id, "auth:expired", {});
  await recordAudit(ctx, { workspaceId: id, actor: actorOf(admin), action: "admin.workspace_suspended", target: id, detail: { reason: why } });
}

export async function unsuspendWorkspace(ctx: AppContext, admin: PlatformAdmin, id: string, reason?: string) {
  const w = await must(ctx, id);
  if (!w.suspended_at) throw conflict("NOT_SUSPENDED", "This workspace is not suspended");
  await ctx.db.run("UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?", id);
  await ctx.cache.invalidate(`suspended:${id}`);
  await recordAudit(ctx, { workspaceId: id, actor: actorOf(admin), action: "admin.workspace_unsuspended", target: id, detail: { reason: reason?.trim().slice(0, 500) ?? null } });
}

/** Credits added or removed by an operator (goodwill, correction). `idempotencyKey` makes a retried request apply once. */
export async function adjustCredits(ctx: AppContext, admin: PlatformAdmin, id: string, input: { amount: number; note?: string; idempotencyKey?: string }) {
  await must(ctx, id);
  if (!Number.isInteger(input.amount) || input.amount === 0 || Math.abs(input.amount) > 1_000_000) throw badRequest("INVALID_AMOUNT", "Amount must be a non-zero whole number of credits (at most 1,000,000 either way)");
  const note = reasonOf(input.note);
  const r = await applyLedger(ctx, id, input.amount > 0 ? "admin_grant" : "admin_deduct", input.amount, { ref: `${admin.email}: ${note}`.slice(0, 200), idemKey: input.idempotencyKey ? `admin:${input.idempotencyKey}` : undefined });
  if (r.applied) await recordAudit(ctx, { workspaceId: id, actor: actorOf(admin), action: "admin.credits_adjusted", target: id, detail: { amount: input.amount, note, balance: r.balance } });
  return r;
}

/** Set (or clear with null) the region a workspace lives in. Takes effect on every node within the cache TTL. */
export async function setHomeRegion(ctx: AppContext, admin: PlatformAdmin, id: string, region: string | null) {
  await must(ctx, id);
  if (region !== null && !/^[a-z0-9-]{2,32}$/.test(region)) throw badRequest("INVALID_REGION", "Region must be 2 to 32 lowercase letters, digits or dashes");
  await ctx.db.run("UPDATE workspaces SET home_region = ? WHERE id = ?", region, id);
  await ctx.cache.invalidate(`suspended:${id}`);
  await recordAudit(ctx, { workspaceId: id, actor: actorOf(admin), action: "admin.home_region_set", target: id, detail: { region } });
}

export async function overrideTier(ctx: AppContext, admin: PlatformAdmin, id: string, tier: Tier | null, note?: string) {
  await must(ctx, id);
  await setWorkspaceTier(ctx, actorOf(admin), id, tier, note);
}

/**
 * A 15-minute, read-only workspace token for the workspace's owner seat. The reason is mandatory and lands in the WORKSPACE's own audit
 * log (its owners can see that support looked, who, and why). The token cannot write over REST or sockets and cannot be refreshed.
 */
export async function startImpersonation(ctx: AppContext, admin: PlatformAdmin, id: string, input: { reason?: string; member_id?: string }) {
  const w = await must(ctx, id);
  if (w.suspended_at) throw conflict("WORKSPACE_SUSPENDED", "Unsuspend the workspace first");
  const reason = reasonOf(input.reason);
  const seat = input.member_id
    ? await findMember(ctx, id, input.member_id)
    : await ctx.db.get<{ id: string }>("SELECT id FROM members WHERE workspace_id = ? AND role = 'owner' AND removed_at IS NULL ORDER BY created_at LIMIT 1", id).then((m) => (m ? findMember(ctx, id, m.id) : undefined));
  if (!seat) throw notFound("Member");
  const token = await signAccessToken(ctx, { userId: seat.user_id, memberId: seat.id, workspaceId: id, role: seat.role }, undefined, { imp: admin.id, ttlSeconds: IMPERSONATION_TTL_SECONDS });
  await recordAudit(ctx, { workspaceId: id, actor: actorOf(admin), action: "admin.impersonation_started", target: seat.id, detail: { reason, read_only: true, ttl_seconds: IMPERSONATION_TTL_SECONDS } });
  return { token, expires_in: IMPERSONATION_TTL_SECONDS, workspace: { id: w.id, name: w.name }, member: { id: seat.id, name: seat.name, email: seat.email }, read_only: true };
}

/* ---------------------------------------------------------------- audit, rate limits, admins */

export async function platformAudit(ctx: AppContext, q: { workspace_id?: string; action?: string; actor_type?: string; limit: number; cursor?: string }) {
  const limit = Math.min(Math.max(q.limit, 1), 200);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.workspace_id) (where.push("workspace_id = ?"), params.push(q.workspace_id));
  if (q.actor_type) (where.push("actor_type = ?"), params.push(q.actor_type));
  if (q.action) (where.push("action LIKE ?"), params.push(`${q.action.replace(/[%_]/g, "")}%`));
  if (q.cursor) {
    const c = decodeCursor(q.cursor, 2);
    if (!c) throw badRequest("INVALID_CURSOR", "Invalid cursor");
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(c[0] as string, c[0] as string, c[1] as string);
  }
  const rows = await ctx.db.read().all<{ id: string; workspace_id: string | null; actor_type: string; actor_id: string | null; action: string; target: string | null; detail: string; created_at: string }>(
    `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { data: page.map((r) => ({ ...r, detail: parseJson(r.detail, {}) })), next_cursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null };
}

export const rateLimitOverview = async (ctx: AppContext) => ({ lists: await listEntries(ctx), limited: await limitedKeys(ctx, 50) });
export const rateLimitAdd = (ctx: AppContext, admin: PlatformAdmin, kind: "allow" | "deny", entity: string, ttl: number, note?: string) => addListEntry(ctx, actorOf(admin), kind, entity, ttl, note);
export const rateLimitRemove = (ctx: AppContext, admin: PlatformAdmin, kind: "allow" | "deny", entity: string) => removeListEntry(ctx, actorOf(admin), kind, entity);

export async function listAdmins(ctx: AppContext) {
  return { data: (await ctx.db.all<AdminRow>("SELECT * FROM platform_admins ORDER BY created_at, id")).map(adminDto) };
}

export async function setAdminDisabled(ctx: AppContext, admin: PlatformAdmin, id: string, disabled: boolean) {
  const target = await getAdmin(ctx, id);
  if (!target) throw notFound("Admin");
  if (target.id === admin.id) throw conflict("CANNOT_DISABLE_SELF", "You cannot disable your own account");
  if (disabled && target.role === "superadmin") {
    const others = await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM platform_admins WHERE role = 'superadmin' AND disabled_at IS NULL AND id <> ?", id);
    if (!Number(others!.n)) throw conflict("LAST_SUPERADMIN", "This is the last active superadmin");
  }
  await ctx.db.run("UPDATE platform_admins SET disabled_at = ? WHERE id = ?", disabled ? nowIso(ctx) : null, id);
  await recordAudit(ctx, { actor: actorOf(admin), action: disabled ? "admin.disabled" : "admin.enabled", target: id });
}
