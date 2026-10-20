import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { assertSeatAvailable } from "../billing/state.js";
import { DEFAULT_PREFS, type Actor, type Availability, type InboxVisibility, type NotificationPrefs, type Role } from "../domain/types.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { hashPassword } from "../util/crypto.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";

export interface MemberRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  live_seat: number;
  availability: Availability;
  dnd_until: string | null;
  notification_prefs: string;
  inbox_visibility: InboxVisibility;
  removed_at: string | null;
  created_at: string;
  name: string;
  email: string;
  role_id: string | null;
  role_key: string;
  role_name: string;
  role_permissions: string;
}

// the role row is resolved in the same query: members.role_id (custom or viewer) or the system role named by members.role
const SELECT = `SELECT m.*, u.name AS name, u.email AS email, r.key AS role_key, r.name AS role_name, r.permissions AS role_permissions
  FROM members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = COALESCE(m.role_id, 'role_' || m.role)`;

export const memberScope = (workspaceId: string) => `${workspaceId}:member`;
export const visitorScope = (workspaceId: string) => `${workspaceId}:visitor`;

const loadMember = (ctx: AppContext, workspaceId: string, memberId: string, includeRemoved: boolean) =>
  ctx.db.get<MemberRow>(`${SELECT} WHERE m.id = ? AND m.workspace_id = ? ${includeRemoved ? "" : "AND m.removed_at IS NULL"}`, memberId, workspaceId);

/**
 * Seat lookup, on the hot path of every request and socket event. Cached for a few seconds (CACHE_TTL_MS); every change to a seat
 * invalidates its entry on all nodes (see invalidateMember), so removals and demotions still take effect immediately.
 */
export async function findMember(ctx: AppContext, workspaceId: string, memberId: string, includeRemoved = false): Promise<MemberRow | undefined> {
  if (includeRemoved) return loadMember(ctx, workspaceId, memberId, true);
  return ctx.cache.wrap(`member:${workspaceId}:${memberId}`, () => loadMember(ctx, workspaceId, memberId, false));
}

export const invalidateMember = (ctx: AppContext, workspaceId: string, memberId: string) => ctx.cache.invalidate(`member:${workspaceId}:${memberId}`);

export async function getMember(ctx: AppContext, workspaceId: string, memberId: string): Promise<MemberRow> {
  const m = await findMember(ctx, workspaceId, memberId);
  if (!m) throw notFound("Member");
  return m;
}

export const listMemberRows = async (ctx: AppContext, workspaceId: string): Promise<MemberRow[]> =>
  ctx.db.all<MemberRow>(`${SELECT} WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY m.created_at, m.id`, workspaceId);

export function actorFromRow(m: MemberRow): Actor {
  return {
    memberId: m.id,
    userId: m.user_id,
    workspaceId: m.workspace_id,
    role: m.role,
    name: m.name,
    email: m.email,
    liveSeat: !!m.live_seat,
    inboxVisibility: m.inbox_visibility,
    permissions: new Set(parseJson<string[]>(m.role_permissions, [])),
    roleKey: m.role_key,
  };
}

export const prefsOf = (m: Pick<MemberRow, "notification_prefs">): NotificationPrefs => ({
  ...DEFAULT_PREFS,
  ...parseJson<Partial<NotificationPrefs>>(m.notification_prefs, {}),
});

export const memberDtos = (ctx: AppContext, rows: MemberRow[]) => Promise.all(rows.map((m) => memberDto(ctx, m)));

export async function memberDto(ctx: AppContext, m: MemberRow) {
  return {
    id: m.id,
    user_id: m.user_id,
    name: m.name,
    email: m.email,
    role: m.role_key,
    role_id: m.role_id ?? `role_${m.role}`,
    role_name: m.role_name,
    permissions: parseJson<string[]>(m.role_permissions, []),
    live_seat: !!m.live_seat,
    availability: m.availability,
    dnd_until: m.dnd_until,
    inbox_visibility: m.inbox_visibility,
    notification_prefs: prefsOf(m),
    online: await ctx.presence.isOnline(memberScope(m.workspace_id), m.id),
    created_at: m.created_at,
  };
}

export const isDnd = (ctx: AppContext, m: Pick<MemberRow, "dnd_until">): boolean => !!m.dnd_until && m.dnd_until > nowIso(ctx);

export async function addMember(
  ctx: AppContext,
  actor: Actor,
  input: { email: string; name: string; password?: string; role: Role; live_seat?: boolean; inbox_visibility?: InboxVisibility },
) {
  if (input.live_seat ?? true) await assertSeatAvailable(ctx, actor.workspaceId);
  if (input.role === "owner" || (input.role === "manager" && actor.role !== "owner")) {
    throw forbidden("Only an owner can create owners or managers");
  }
  const email = input.email.trim().toLowerCase();
  let user = await ctx.db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", email);
  if (!user) {
    if (!input.password) throw unprocessable("PASSWORD_REQUIRED", "A temporary password is required for new users");
    const id = newId("usr");
    await ctx.db.run(
      "INSERT INTO users(id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)",
      id,
      email,
      await hashPassword(input.password),
      input.name,
      nowIso(ctx),
    );
    user = { id };
  }
  const existing = await ctx.db.get<{ id: string; removed_at: string | null }>(
    "SELECT id, removed_at FROM members WHERE workspace_id = ? AND user_id = ?",
    actor.workspaceId,
    user.id,
  );
  let id: string;
  if (existing) {
    if (!existing.removed_at) throw conflict("ALREADY_MEMBER", "This user is already a member of the workspace");
    id = existing.id;
    await ctx.db.run(
      "UPDATE members SET removed_at = NULL, role = ?, live_seat = ?, inbox_visibility = ? WHERE id = ?",
      input.role,
      input.live_seat ?? true,
      input.inbox_visibility ?? "assigned_inbox",
      id,
    );
  } else {
    id = newId("mem");
    await ctx.db.run(
      "INSERT INTO members(id, workspace_id, user_id, role, live_seat, inbox_visibility, created_at) VALUES (?,?,?,?,?,?,?)",
      id,
      actor.workspaceId,
      user.id,
      input.role,
      input.live_seat ?? true,
      input.inbox_visibility ?? "assigned_inbox",
      nowIso(ctx),
    );
  }
  await invalidateMember(ctx, actor.workspaceId, id);
  const row = await getMember(ctx, actor.workspaceId, id);
  ctx.bus.toWorkspace(actor.workspaceId, "member:updated", await memberDto(ctx, row));
  return row;
}

export interface MemberPatch {
  role?: Role;
  live_seat?: boolean;
  inbox_visibility?: InboxVisibility;
  availability?: Availability;
  dnd_until?: string | null;
  notification_prefs?: Partial<NotificationPrefs>;
  name?: string;
}

export async function updateMember(ctx: AppContext, actor: Actor, memberId: string, patch: MemberPatch): Promise<MemberRow> {
  const target = await getMember(ctx, actor.workspaceId, memberId);
  const self = target.id === actor.memberId;
  const isMgr = actor.role === "owner" || actor.role === "manager";
  const adminFields = patch.role !== undefined || patch.live_seat !== undefined || patch.inbox_visibility !== undefined;
  if (adminFields) {
    if (!isMgr) throw forbidden("Only managers can change roles and seats");
    if (patch.role !== undefined && actor.role !== "owner") throw forbidden("Only an owner can change roles");
    if (actor.role === "manager" && target.role !== "agent") throw forbidden("Managers can only change agents");
  } else if (!self && !isMgr) {
    throw forbidden();
  }
  if (patch.role && target.role === "owner" && patch.role !== "owner") {
    const owners = (await ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM members WHERE workspace_id = ? AND role = 'owner' AND removed_at IS NULL",
      actor.workspaceId,
    ))!.n;
    if (owners <= 1) throw unprocessable("LAST_OWNER", "A workspace needs at least one owner");
  }
  const prefs = patch.notification_prefs ? { ...prefsOf(target), ...patch.notification_prefs } : prefsOf(target);
  await ctx.db.run(
    `UPDATE members SET role = ?, live_seat = ?, inbox_visibility = ?, availability = ?, dnd_until = ?, notification_prefs = ? WHERE id = ?`,
    patch.role ?? target.role,
    patch.live_seat ?? !!target.live_seat,
    patch.inbox_visibility ?? target.inbox_visibility,
    patch.availability ?? target.availability,
    patch.dnd_until === undefined ? target.dnd_until : patch.dnd_until,
    JSON.stringify(prefs),
    memberId,
  );
  if (patch.name) await ctx.db.run("UPDATE users SET name = ? WHERE id = ?", patch.name, target.user_id);
  await invalidateMember(ctx, actor.workspaceId, memberId);
  const row = await getMember(ctx, actor.workspaceId, memberId);
  if (patch.role || patch.inbox_visibility) await ctx.bus.refreshMemberAccess(actor.workspaceId, memberId);
  ctx.bus.toWorkspace(actor.workspaceId, "member:updated", await memberDto(ctx, row));
  if (patch.availability !== undefined || patch.dnd_until !== undefined) {
    ctx.bus.toWorkspace(actor.workspaceId, "presence:update", {
      member_id: memberId,
      online: await ctx.presence.isOnline(memberScope(actor.workspaceId), memberId),
      availability: row.availability,
    });
  }
  return row;
}

/** Soft-removes a seat; its rooms are unassigned (and re-routed round-robin when the inbox asks for it). */
export async function onlineMemberIds(ctx: AppContext, ws: string): Promise<string[]> {
  const online = new Set(await ctx.presence.onlineIds(memberScope(ws)));
  return (await listMemberRows(ctx, ws)).map((m) => m.id).filter((id) => online.has(id));
}

export async function removeMember(ctx: AppContext, actor: Actor, memberId: string, reassign: (roomId: string) => Promise<void> | void): Promise<void> {
  const target = await getMember(ctx, actor.workspaceId, memberId);
  if (actor.role !== "owner" && !(actor.role === "manager" && target.role === "agent")) throw forbidden();
  if (target.role === "owner") {
    const owners = (await ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM members WHERE workspace_id = ? AND role = 'owner' AND removed_at IS NULL",
      actor.workspaceId,
    ))!.n;
    if (owners <= 1) throw unprocessable("LAST_OWNER", "A workspace needs at least one owner");
  }
  const rooms = await ctx.db.all<{ room_id: string }>("SELECT room_id FROM room_assignees WHERE member_id = ?", memberId);
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE members SET removed_at = ? WHERE id = ?", nowIso(ctx), memberId);
    await ctx.db.run("DELETE FROM room_assignees WHERE member_id = ?", memberId);
    await ctx.db.run("DELETE FROM inbox_members WHERE member_id = ?", memberId);
    await ctx.db.run("DELETE FROM contact_followers WHERE member_id = ?", memberId);
    await ctx.db.run("DELETE FROM room_favorites WHERE member_id = ?", memberId);
  });
  await invalidateMember(ctx, actor.workspaceId, memberId);
  await ctx.cache.invalidate(`counts:${actor.workspaceId}:*`);
  for (const r of rooms) await reassign(r.room_id);
  ctx.bus.disconnectMember(actor.workspaceId, memberId);
  ctx.bus.toWorkspace(actor.workspaceId, "member:removed", { member_id: memberId });
}
