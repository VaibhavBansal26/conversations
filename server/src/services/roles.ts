import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { ALL_PERMISSIONS, SYSTEM_ROLES, can, isPermission, type Permission } from "../authz/permissions.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "./audit.js";
import { getMember, invalidateMember, memberDto } from "./members.js";

export interface RoleRow {
  id: string;
  workspace_id: string | null;
  key: string;
  name: string;
  description: string;
  base_role: "owner" | "manager" | "agent";
  permissions: string;
  is_system: number;
  created_at: string;
}

export const roleDto = (r: RoleRow) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  base_role: r.base_role,
  system: !!r.is_system,
  permissions: parseJson<string[]>(r.permissions, []),
  created_at: r.created_at,
});

export async function listRoles(ctx: AppContext, workspaceId: string) {
  const rows = await ctx.db.all<RoleRow>("SELECT * FROM roles WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY is_system DESC, name, id", workspaceId);
  return rows.map(roleDto);
}

async function getRole(ctx: AppContext, workspaceId: string, id: string): Promise<RoleRow> {
  const r = await ctx.db.get<RoleRow>("SELECT * FROM roles WHERE id = ? AND (workspace_id IS NULL OR workspace_id = ?)", id, workspaceId);
  if (!r) throw notFound("Role");
  return r;
}

function validatePermissions(actor: Actor, perms: unknown): Permission[] {
  if (!Array.isArray(perms) || !perms.every(isPermission)) throw unprocessable("INVALID_PERMISSIONS", `permissions must be a list of: ${ALL_PERMISSIONS.join(", ")}`);
  const set = [...new Set(perms)] as Permission[];
  // nobody can mint a role more powerful than themselves
  const over = set.filter((p) => !can(actor, p));
  if (over.length) throw forbidden(`You cannot grant permissions you do not have: ${over.join(", ")}`, "PRIVILEGE_ESCALATION");
  return set;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "role";

export async function createRole(ctx: AppContext, actor: Actor, input: { name: string; description?: string; base_role: "manager" | "agent"; permissions: string[] }) {
  const permissions = validatePermissions(actor, input.permissions);
  const key = slug(input.name);
  if (SYSTEM_ROLES.some((s) => s.key === key)) throw conflict("ROLE_KEY_RESERVED", "That name is reserved for a built-in role");
  if (await ctx.db.get("SELECT 1 FROM roles WHERE workspace_id = ? AND key = ?", actor.workspaceId, key)) throw conflict("ROLE_EXISTS", "A role with this name already exists");
  const id = newId("role");
  await ctx.db.run("INSERT INTO roles(id, workspace_id, key, name, description, base_role, permissions, is_system, created_at) VALUES (?,?,?,?,?,?,?,0,?)", id, actor.workspaceId, key, input.name.trim(), input.description ?? "", input.base_role, JSON.stringify(permissions), nowIso(ctx));
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "role.create", target: id, detail: { name: input.name, base_role: input.base_role, permissions } });
  return roleDto(await getRole(ctx, actor.workspaceId, id));
}

export async function updateRole(ctx: AppContext, actor: Actor, id: string, patch: { name?: string; description?: string; base_role?: "manager" | "agent"; permissions?: string[] }) {
  const role = await getRole(ctx, actor.workspaceId, id);
  if (role.is_system) throw forbidden("Built-in roles cannot be changed", "ROLE_IMMUTABLE");
  const permissions = patch.permissions ? validatePermissions(actor, patch.permissions) : parseJson<string[]>(role.permissions, []);
  await ctx.db.run("UPDATE roles SET name = ?, description = ?, base_role = ?, permissions = ? WHERE id = ?", patch.name?.trim() ?? role.name, patch.description ?? role.description, patch.base_role ?? role.base_role, JSON.stringify(permissions), id);
  // the seats holding this role keep their `members.role` in step with the base role, and caches/sockets pick the change up immediately
  const holders = await ctx.db.all<{ id: string }>("SELECT id FROM members WHERE workspace_id = ? AND role_id = ? AND removed_at IS NULL", actor.workspaceId, id);
  if (patch.base_role) await ctx.db.run("UPDATE members SET role = ? WHERE workspace_id = ? AND role_id = ?", patch.base_role, actor.workspaceId, id);
  for (const h of holders) {
    await invalidateMember(ctx, actor.workspaceId, h.id);
    await ctx.bus.refreshMemberAccess(actor.workspaceId, h.id);
  }
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "role.update", target: id, detail: { permissions, base_role: patch.base_role ?? role.base_role, holders: holders.length } });
  return roleDto(await getRole(ctx, actor.workspaceId, id));
}

export async function deleteRole(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  const role = await getRole(ctx, actor.workspaceId, id);
  if (role.is_system) throw forbidden("Built-in roles cannot be deleted", "ROLE_IMMUTABLE");
  const used = await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id = ? AND role_id = ? AND removed_at IS NULL", actor.workspaceId, id);
  if (Number(used?.n) > 0) throw conflict("ROLE_IN_USE", "Move the members holding this role to another role first");
  await ctx.db.run("DELETE FROM roles WHERE id = ?", id);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "role.delete", target: id, detail: { name: role.name } });
}

/** Give a seat a role: one of the four built-in roles or a custom role of this workspace. */
export async function setMemberRole(ctx: AppContext, actor: Actor, memberId: string, roleId: string) {
  const target = await getMember(ctx, actor.workspaceId, memberId);
  const role = await getRole(ctx, actor.workspaceId, roleId);
  const perms = parseJson<string[]>(role.permissions, []);
  const over = perms.filter((p) => !can(actor, p as Permission));
  if (over.length) throw forbidden(`You cannot grant permissions you do not have: ${over.join(", ")}`, "PRIVILEGE_ESCALATION");
  if (role.id === "role_owner" && actor.roleKey !== "owner") throw forbidden("Only an owner can make an owner");
  if (target.role === "owner" && actor.roleKey !== "owner") throw forbidden("Only an owner can change an owner");
  if (target.role === "owner" && role.id !== "role_owner") {
    const owners = Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id = ? AND role = 'owner' AND removed_at IS NULL", actor.workspaceId))?.n);
    if (owners <= 1) throw unprocessable("LAST_OWNER", "A workspace needs at least one owner");
  }
  // owner/manager/agent are stored as the legacy column alone; viewer and custom roles also record role_id
  const legacy = ["role_owner", "role_manager", "role_agent"].includes(role.id);
  await ctx.db.run("UPDATE members SET role = ?, role_id = ? WHERE id = ?", role.base_role, legacy ? null : role.id, memberId);
  await invalidateMember(ctx, actor.workspaceId, memberId);
  await ctx.bus.refreshMemberAccess(actor.workspaceId, memberId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "member.role", target: memberId, detail: { from: target.role_key, to: role.key } });
  const row = await getMember(ctx, actor.workspaceId, memberId);
  ctx.bus.toWorkspace(actor.workspaceId, "member:updated", await memberDto(ctx, row));
  return row;
}
