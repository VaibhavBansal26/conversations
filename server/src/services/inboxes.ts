import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { findMember } from "./members.js";

export interface InboxRow {
  id: string;
  workspace_id: string;
  name: string;
  icon: string;
  algorithm: "manual" | "round_robin";
  last_assigned_member_id: string | null;
  live_routing_visibility: number;
  default_email_inbound: number;
  default_sms_inbound: number;
  created_at: string;
}

export function inboxDto(ctx: AppContext, i: InboxRow) {
  return {
    id: i.id,
    name: i.name,
    icon: i.icon,
    algorithm: i.algorithm,
    live_routing_visibility: !!i.live_routing_visibility,
    default_email_inbound: !!i.default_email_inbound,
    default_sms_inbound: !!i.default_sms_inbound,
    last_assigned_member_id: i.last_assigned_member_id,
    member_ids: memberIds(ctx, i.id),
    created_at: i.created_at,
  };
}

export const memberIds = (ctx: AppContext, inboxId: string): string[] =>
  ctx.db.all<{ member_id: string }>("SELECT member_id FROM inbox_members WHERE inbox_id = ? ORDER BY position, member_id", inboxId).map((r) => r.member_id);

export const findInbox = (ctx: AppContext, ws: string, id: string) =>
  ctx.db.get<InboxRow>("SELECT * FROM inboxes WHERE id = ? AND workspace_id = ?", id, ws);

export function getInbox(ctx: AppContext, ws: string, id: string): InboxRow {
  const i = findInbox(ctx, ws, id);
  if (!i) throw notFound("Inbox");
  return i;
}

function requireManager(actor: Actor) {
  if (actor.role === "agent") throw forbidden("Only managers can manage inboxes");
}

/** Agents only see inboxes they belong to; managers see all. */
export function listInboxes(ctx: AppContext, actor: Actor): InboxRow[] {
  if (actor.role !== "agent") return ctx.db.all<InboxRow>("SELECT * FROM inboxes WHERE workspace_id = ? ORDER BY name, id", actor.workspaceId);
  return ctx.db.all<InboxRow>(
    "SELECT i.* FROM inboxes i WHERE i.workspace_id = ? AND i.id IN (SELECT inbox_id FROM inbox_members WHERE member_id = ?) ORDER BY i.name, i.id",
    actor.workspaceId, actor.memberId,
  );
}

export interface InboxInput {
  name?: string;
  icon?: string;
  algorithm?: "manual" | "round_robin";
  live_routing_visibility?: boolean;
  default_email_inbound?: boolean;
  default_sms_inbound?: boolean;
  member_ids?: string[];
}

function applyDefaults(ctx: AppContext, ws: string, id: string, i: InboxInput) {
  if (i.default_email_inbound) ctx.db.run("UPDATE inboxes SET default_email_inbound = 0 WHERE workspace_id = ? AND id != ?", ws, id);
  if (i.default_sms_inbound) ctx.db.run("UPDATE inboxes SET default_sms_inbound = 0 WHERE workspace_id = ? AND id != ?", ws, id);
}

function setMembers(ctx: AppContext, ws: string, id: string, ids: string[]) {
  const unique = [...new Set(ids)];
  for (const m of unique) if (!findMember(ctx, ws, m)) throw unprocessable("UNKNOWN_MEMBER", `Member ${m} is not part of this workspace`);
  const current = new Set(memberIds(ctx, id));
  for (const m of current) if (!unique.includes(m)) ctx.db.run("DELETE FROM inbox_members WHERE inbox_id = ? AND member_id = ?", id, m);
  for (const m of unique) if (!current.has(m)) addMemberRow(ctx, id, m);
}

function addMemberRow(ctx: AppContext, inboxId: string, memberId: string) {
  ctx.db.run(
    "INSERT OR IGNORE INTO inbox_members(inbox_id, member_id, position) VALUES (?, ?, COALESCE((SELECT MAX(position) FROM inbox_members WHERE inbox_id = ?), 0) + 1)",
    inboxId, memberId, inboxId,
  );
}

export function createInbox(ctx: AppContext, actor: Actor, input: InboxInput & { name: string }): InboxRow {
  requireManager(actor);
  const id = newId("inb");
  ctx.db.tx(() => {
    ctx.db.run(
      "INSERT INTO inboxes(id, workspace_id, name, icon, algorithm, live_routing_visibility, default_email_inbound, default_sms_inbound, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, actor.workspaceId, input.name.trim(), input.icon ?? "inbox", input.algorithm ?? "manual", input.live_routing_visibility ?? false,
      input.default_email_inbound ?? false, input.default_sms_inbound ?? false, nowIso(ctx),
    );
    applyDefaults(ctx, actor.workspaceId, id, input);
    setMembers(ctx, actor.workspaceId, id, input.member_ids ?? []);
  });
  const row = getInbox(ctx, actor.workspaceId, id);
  ctx.bus.toWorkspace(actor.workspaceId, "inbox:new", inboxDto(ctx, row));
  for (const m of memberIds(ctx, id)) ctx.bus.refreshMemberAccess(actor.workspaceId, m);
  return row;
}

export function updateInbox(ctx: AppContext, actor: Actor, id: string, input: InboxInput): InboxRow {
  requireManager(actor);
  const cur = getInbox(ctx, actor.workspaceId, id);
  const before = memberIds(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE inboxes SET name = ?, icon = ?, algorithm = ?, live_routing_visibility = ?, default_email_inbound = ?, default_sms_inbound = ? WHERE id = ?",
      input.name?.trim() ?? cur.name, input.icon ?? cur.icon, input.algorithm ?? cur.algorithm,
      input.live_routing_visibility ?? !!cur.live_routing_visibility,
      input.default_email_inbound ?? !!cur.default_email_inbound,
      input.default_sms_inbound ?? !!cur.default_sms_inbound, id,
    );
    applyDefaults(ctx, actor.workspaceId, id, input);
    if (input.member_ids) setMembers(ctx, actor.workspaceId, id, input.member_ids);
  });
  const row = getInbox(ctx, actor.workspaceId, id);
  ctx.bus.toWorkspace(actor.workspaceId, "inbox:updated", inboxDto(ctx, row));
  for (const m of new Set([...before, ...memberIds(ctx, id)])) ctx.bus.refreshMemberAccess(actor.workspaceId, m);
  return row;
}

export function addInboxMember(ctx: AppContext, actor: Actor, inboxId: string, memberId: string): InboxRow {
  requireManager(actor);
  getInbox(ctx, actor.workspaceId, inboxId);
  if (!findMember(ctx, actor.workspaceId, memberId)) throw notFound("Member");
  addMemberRow(ctx, inboxId, memberId);
  ctx.bus.refreshMemberAccess(actor.workspaceId, memberId);
  const row = getInbox(ctx, actor.workspaceId, inboxId);
  ctx.bus.toWorkspace(actor.workspaceId, "inbox:updated", inboxDto(ctx, row));
  return row;
}

export function removeInboxMember(ctx: AppContext, actor: Actor, inboxId: string, memberId: string): InboxRow {
  requireManager(actor);
  getInbox(ctx, actor.workspaceId, inboxId);
  ctx.db.run("DELETE FROM inbox_members WHERE inbox_id = ? AND member_id = ?", inboxId, memberId);
  ctx.bus.refreshMemberAccess(actor.workspaceId, memberId);
  const row = getInbox(ctx, actor.workspaceId, inboxId);
  ctx.bus.toWorkspace(actor.workspaceId, "inbox:updated", inboxDto(ctx, row));
  return row;
}

export function deleteInbox(ctx: AppContext, actor: Actor, id: string): void {
  requireManager(actor);
  getInbox(ctx, actor.workspaceId, id);
  const members = memberIds(ctx, id);
  ctx.db.run("DELETE FROM inboxes WHERE id = ?", id);
  for (const m of members) ctx.bus.refreshMemberAccess(actor.workspaceId, m);
  ctx.bus.toWorkspace(actor.workspaceId, "inbox:updated", { id, deleted: true });
}

/**
 * Round-robin pick. Must run inside the caller's transaction: it reads and advances last_assigned
 * atomically, so concurrent assignments never hand the same turn out twice.
 * A stale pointer (member removed / never set) restarts from the first member, deterministically.
 * Seats that are inactive or not on a live seat are skipped.
 */
export function nextRoundRobinAssignee(ctx: AppContext, inboxId: string): string | null {
  const inbox = ctx.db.get<InboxRow>("SELECT * FROM inboxes WHERE id = ?", inboxId);
  if (!inbox || inbox.algorithm !== "round_robin") return null;
  const all = ctx.db.all<{ member_id: string; eligible: number }>(
    `SELECT im.member_id, (m.live_seat = 1 AND m.availability != 'inactive' AND m.removed_at IS NULL) AS eligible
     FROM inbox_members im JOIN members m ON m.id = im.member_id WHERE im.inbox_id = ? ORDER BY im.position, im.member_id`,
    inboxId,
  );
  if (!all.some((m) => m.eligible)) return null;
  const start = all.findIndex((m) => m.member_id === inbox.last_assigned_member_id);
  for (let step = 1; step <= all.length; step++) {
    const cand = all[(start + step + all.length) % all.length]!;
    if (cand.eligible) {
      ctx.db.run("UPDATE inboxes SET last_assigned_member_id = ? WHERE id = ?", cand.member_id, inboxId);
      return cand.member_id;
    }
  }
  return null;
}
