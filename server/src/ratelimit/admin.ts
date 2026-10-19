import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { newId } from "../util/ids.js";
import { TIERS, type Tier } from "./types.js";

/**
 * Operator hooks behind the (future) platform admin console: block or allow an entity for a while, see what is being limited, override a
 * workspace's plan tier. Every change is written to the append-only audit_log. The functions take an actor description rather than a
 * request so the console, a CLI or a test can call them; authorisation is the caller's job (platform admins only).
 */
export interface AdminActor {
  type: "platform_admin" | "system" | "member";
  id: string;
}

const ENTITY = /^(ip|ws|user|key|visitor):[A-Za-z0-9:._/\-]{1,80}$/;

async function audit(ctx: AppContext, actor: AdminActor, action: string, target: string, detail: Record<string, unknown>, workspaceId?: string) {
  await ctx.db.run(
    "INSERT INTO audit_log(id, workspace_id, actor_type, actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?,?,?)",
    newId("aud"),
    workspaceId ?? null,
    actor.type,
    actor.id,
    action,
    target,
    JSON.stringify(detail),
    ctx.clock().toISOString(),
  );
}

export async function addListEntry(ctx: AppContext, actor: AdminActor, kind: "allow" | "deny", entity: string, ttlSeconds: number, note?: string) {
  if (!ENTITY.test(entity)) throw badRequest("INVALID_ENTITY", "Use ip:<address>, ws:<workspaceId>, user:<memberId>, key:<apiKeyId> or visitor:<sessionId>");
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 30 * 86400) throw badRequest("INVALID_TTL", "ttl must be between 1 second and 30 days");
  await ctx.ratelimit.shared.listAdd(kind, entity, ttlSeconds * 1000, note);
  await ctx.ratelimit.refreshLists();
  await audit(ctx, actor, `ratelimit.${kind}.add`, entity, { ttl_seconds: ttlSeconds, note: note ?? null });
}

export async function removeListEntry(ctx: AppContext, actor: AdminActor, kind: "allow" | "deny", entity: string) {
  const removed = await ctx.ratelimit.shared.listRemove(kind, entity);
  await ctx.ratelimit.refreshLists();
  await audit(ctx, actor, `ratelimit.${kind}.remove`, entity, { removed });
  return removed;
}

export async function listEntries(ctx: AppContext) {
  const [allow, deny] = await Promise.all([ctx.ratelimit.shared.listAll("allow"), ctx.ratelimit.shared.listAll("deny")]);
  return { allow, deny };
}

/** Recently limited keys (hashed key prefixes only; raw keys are never stored) with how often, for the "who is being limited" view. */
export async function limitedKeys(ctx: AppContext, limit = 50) {
  return ctx.ratelimit.shared.recentlyLimited(limit);
}

export async function setWorkspaceTier(ctx: AppContext, actor: AdminActor, workspaceId: string, tier: Tier | null, note?: string) {
  if (tier !== null && !TIERS.includes(tier)) throw badRequest("INVALID_TIER", `tier must be one of ${TIERS.join(", ")}`);
  if (tier === null) await ctx.db.run("DELETE FROM rate_limit_overrides WHERE workspace_id = ?", workspaceId);
  else
    await ctx.db.run(
      "INSERT INTO rate_limit_overrides(workspace_id, tier, note, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET tier = excluded.tier, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      workspaceId,
      tier,
      note ?? null,
      actor.id,
      ctx.clock().toISOString(),
    );
  await ctx.cache.invalidate(`tier:${workspaceId}`);
  await audit(ctx, actor, "ratelimit.tier.set", workspaceId, { tier, note: note ?? null }, workspaceId);
}
