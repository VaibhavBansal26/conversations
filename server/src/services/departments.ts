import { z } from "zod";
import { can } from "../authz/permissions.js";
import type { AppContext } from "../context.js";
import { DepartmentInfoSchema, OfficeHoursSchema } from "../domain/settings.js";
import type { Actor } from "../domain/types.js";
import { forbidden, unprocessable } from "../errors.js";
import { parseJson } from "../util/json.js";
import { addDays, zonedDate } from "../util/time.js";
import { recordAudit } from "./audit.js";
import { getInbox, inboxDto, memberIds, type InboxRow } from "./inboxes.js";
import { isDnd, listMemberRows, memberScope, type MemberRow } from "./members.js";
import { isOpen, nextOpening } from "./office.js";
import { drainQueue } from "./routing.js";
import { getSettings } from "./workspaces.js";

/**
 * Departments (docs/AI-AGENTS.md, ADR 0028): an inbox plus routing configuration. Everything here is additive on the inbox tables, so an inbox
 * that nobody configured behaves exactly as before: `algorithm = round_robin` reads as the round_robin mode, `manual` as manual_pick.
 */
export const ROUTING_MODES = ["round_robin", "least_busy", "skills_based", "manual_pick"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const DepartmentHoursSchema = OfficeHoursSchema.extend({
  /** local dates (in `timezone`) on which the department is closed, whatever the weekly schedule says */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")).max(100).default([]),
});
export type DepartmentHours = z.infer<typeof DepartmentHoursSchema>;

export function parseHours(raw: string | null | undefined): DepartmentHours {
  const r = DepartmentHoursSchema.safeParse(parseJson<unknown>(raw, {}));
  return r.success ? r.data : DepartmentHoursSchema.parse({});
}

/** Closed on a holiday; otherwise the weekly schedule when enabled; otherwise no restriction from the department. */
export function departmentOpenAt(hours: DepartmentHours, at: Date): boolean {
  if (hours.holidays.length && hours.holidays.includes(zonedDate(at, hours.timezone))) return false;
  return isOpen(hours, at);
}

/** "tomorrow at 09:00 (Europe/Berlin)", or null when the department is not restricted or never opens within three weeks. */
export function departmentNextOpening(hours: DepartmentHours, at: Date): string | null {
  if (hours.enabled) return nextOpening(hours, at, hours.holidays);
  if (!hours.holidays.length) return null;
  const today = zonedDate(at, hours.timezone);
  for (let n = 1; n <= 21; n++) if (!hours.holidays.includes(addDays(today, n))) return n === 1 ? "tomorrow" : `on ${addDays(today, n)}`;
  return null;
}

export const effectiveMode = (i: Pick<InboxRow, "routing_mode" | "algorithm">): RoutingMode => i.routing_mode ?? (i.algorithm === "round_robin" ? "round_robin" : "manual_pick");

export interface SeatRow extends MemberRow {
  position: number;
  skills: string;
  languages: string;
  member_capacity: number | null;
}

/** Department members with their routing attributes, in the department's own order. */
export async function seatsOf(ctx: AppContext, inboxId: string): Promise<SeatRow[]> {
  const ws = (await ctx.db.get<{ workspace_id: string }>("SELECT workspace_id FROM inboxes WHERE id = ?", inboxId))?.workspace_id;
  if (!ws) return [];
  const members = new Map((await listMemberRows(ctx, ws)).map((m) => [m.id, m]));
  const rows = await ctx.db.all<{ member_id: string; position: number; skills: string; languages: string; capacity: number | null }>(
    "SELECT member_id, position, skills, languages, capacity FROM inbox_members WHERE inbox_id = ? ORDER BY position, member_id",
    inboxId,
  );
  return rows.flatMap((r) => {
    const m = members.get(r.member_id);
    return m ? [{ ...m, position: r.position, skills: r.skills, languages: r.languages, member_capacity: r.capacity }] : [];
  });
}

/** The seat can take a new ticket now: a live seat, active, not in do-not-disturb and (when the workspace asks for it) connected. */
export function seatAvailable(ctx: AppContext, m: Pick<MemberRow, "live_seat" | "availability" | "dnd_until" | "removed_at" | "id">, online: ReadonlySet<string> | null): boolean {
  if (!m.live_seat || m.availability !== "active" || m.removed_at || isDnd(ctx, m)) return false;
  return online === null || online.has(m.id);
}

/** Tickets a seat is working on right now: assigned and waiting for them to accept, or open. Waiting for the customer does not count. */
export async function loadOf(ctx: AppContext, workspaceId: string, memberIdsIn: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(memberIdsIn.map((id) => [id, 0]));
  if (!memberIdsIn.length) return out;
  const rows = await ctx.db.all<{ handler: string; n: number }>(
    `SELECT handler, COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND status IN ('waiting_for_human','open') AND handler IN (${memberIdsIn.map(() => "?").join(",")}) GROUP BY handler`,
    workspaceId,
    ...memberIdsIn.map((id) => `human:${id}`),
  );
  for (const r of rows) out.set(r.handler.slice("human:".length), Number(r.n));
  return out;
}

export interface Candidate {
  seat: SeatRow;
  load: number;
  /** 0 = unlimited */
  capacity: number;
}

export async function onlineSet(ctx: AppContext, workspaceId: string): Promise<ReadonlySet<string> | null> {
  if (!(await getSettings(ctx, workspaceId)).routing.require_online) return null;
  return new Set(await ctx.presence.onlineIds(memberScope(workspaceId)));
}

/** Seats of a department that are available and under their capacity, with their current load. */
export async function candidatesOf(ctx: AppContext, dept: InboxRow, opts: { exclude?: ReadonlySet<string> } = {}): Promise<Candidate[]> {
  const seats = await seatsOf(ctx, dept.id);
  const online = await onlineSet(ctx, dept.workspace_id);
  const free = seats.filter((s) => !opts.exclude?.has(s.id) && seatAvailable(ctx, s, online));
  const loads = await loadOf(ctx, dept.workspace_id, free.map((s) => s.id));
  return free
    .map((seat) => ({ seat, load: loads.get(seat.id) ?? 0, capacity: seat.member_capacity ?? dept.capacity }))
    .filter((c) => c.capacity === 0 || c.load < c.capacity);
}

/** Median wait (seconds) from handoff to the first human reply over the department's latest handed-off tickets, or null when there is no data. */
export async function estimateWaitSeconds(ctx: AppContext, workspaceId: string, deptId: string | null): Promise<number | null> {
  const since = new Date(ctx.clock().getTime() - 7 * 86400_000).toISOString();
  const rows = await ctx.db.read().all<{ handoff_at: string; first_human_response_at: string }>(
    `SELECT handoff_at, first_human_response_at FROM tickets WHERE workspace_id = ? AND ${deptId ? "department_id = ?" : "department_id IS NULL"} AND handoff_at IS NOT NULL AND first_human_response_at IS NOT NULL AND handoff_at > ? ORDER BY handoff_at DESC LIMIT 20`,
    ...(deptId ? [workspaceId, deptId, since] : [workspaceId, since]),
  );
  const waits = rows.map((r) => (Date.parse(r.first_human_response_at) - Date.parse(r.handoff_at)) / 1000).filter((n) => n >= 0).sort((a, b) => a - b);
  if (!waits.length) return null;
  return Math.round(waits[Math.floor(waits.length / 2)]!);
}

export async function queueLength(ctx: AppContext, workspaceId: string, deptId: string | null): Promise<number> {
  const r = await ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND ${deptId ? "department_id = ?" : "department_id IS NULL"} AND status = 'waiting_for_human' AND handler IS NULL`,
    ...(deptId ? [workspaceId, deptId] : [workspaceId]),
  );
  return Number(r?.n ?? 0);
}

export interface DepartmentStatus {
  id: string;
  name: string;
  open: boolean;
  next_opening: string | null;
  available_agents: number;
  queue_length: number;
  estimated_wait_s: number | null;
}

export async function departmentStatus(ctx: AppContext, dept: InboxRow): Promise<DepartmentStatus> {
  const hours = parseHours(dept.hours);
  const now = ctx.clock();
  const open = departmentOpenAt(hours, now);
  return {
    id: dept.id,
    name: dept.name,
    open,
    next_opening: open ? null : departmentNextOpening(hours, now),
    available_agents: (await candidatesOf(ctx, dept)).length,
    queue_length: await queueLength(ctx, dept.workspace_id, dept.id),
    estimated_wait_s: await estimateWaitSeconds(ctx, dept.workspace_id, dept.id),
  };
}

/* ---------- configuration (departments:manage) ---------- */

const skill = z.string().trim().min(1).max(40);
const language = z.string().trim().toLowerCase().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/, "Use a language code such as en or pt-br");
export const DepartmentMemberInput = z.object({
  member_id: z.string().min(1).max(64),
  skills: z.array(skill).max(20).optional(),
  languages: z.array(language).max(10).optional(),
  capacity: z.number().int().min(0).max(100).nullable().optional(),
});
export const DepartmentPatchSchema = z.object({
  description: z.string().max(300).optional(),
  routing_mode: z.enum(ROUTING_MODES).nullable().optional(),
  capacity: z.number().int().min(0).max(100).optional(),
  hours: DepartmentHoursSchema.optional(),
  sla_first_response_s: z.number().int().min(30).max(30 * 86400).nullable().optional(),
  sla_resolution_s: z.number().int().min(60).max(365 * 86400).nullable().optional(),
  overflow_inbox_id: z.string().min(1).max(64).nullable().optional(),
  auto_reply_closed: z.string().max(500).optional(),
  auto_reply_queued: z.string().max(500).optional(),
  live_routing_visibility: z.boolean().optional(),
  visitor_info: DepartmentInfoSchema.optional(),
  members: z.array(DepartmentMemberInput).max(200).optional(),
});
export type DepartmentPatch = z.infer<typeof DepartmentPatchSchema>;

const requireManage = (actor: Actor) => {
  if (!can(actor, "departments:manage")) throw forbidden("You need the departments permission", "PERMISSION_DENIED");
};

export async function departmentDto(ctx: AppContext, i: InboxRow) {
  const seats = await seatsOf(ctx, i.id);
  return {
    ...(await inboxDto(ctx, i)),
    routing_mode: i.routing_mode,
    effective_routing_mode: effectiveMode(i),
    capacity: i.capacity,
    hours: parseHours(i.hours),
    sla_first_response_s: i.sla_first_response_s,
    sla_resolution_s: i.sla_resolution_s,
    overflow_inbox_id: i.overflow_inbox_id,
    auto_reply_closed: i.auto_reply_closed,
    auto_reply_queued: i.auto_reply_queued,
    visitor_info: DepartmentInfoSchema.catch({}).parse(parseJson<unknown>(i.visitor_info, {})),
    members: seats.map((s) => ({
      member_id: s.id,
      name: s.name,
      skills: parseJson<string[]>(s.skills, []),
      languages: parseJson<string[]>(s.languages, []),
      capacity: s.member_capacity,
    })),
    status: await departmentStatus(ctx, i),
  };
}

export async function listDepartments(ctx: AppContext, actor: Actor) {
  requireManage(actor);
  const rows = await ctx.db.all<InboxRow>("SELECT * FROM inboxes WHERE workspace_id = ? ORDER BY name, id", actor.workspaceId);
  return Promise.all(rows.map((r) => departmentDto(ctx, r)));
}

export async function getDepartment(ctx: AppContext, actor: Actor, id: string) {
  requireManage(actor);
  return departmentDto(ctx, await getInbox(ctx, actor.workspaceId, id));
}

/** Overflow chains must not loop: walk from the target; reaching the department itself is a loop. */
async function assertNoOverflowLoop(ctx: AppContext, workspaceId: string, id: string, target: string): Promise<void> {
  const seen = new Set<string>([id]);
  let cur: string | null = target;
  for (let i = 0; cur && i < 50; i++) {
    if (seen.has(cur)) throw unprocessable("OVERFLOW_LOOP", "That overflow department leads back to this one");
    seen.add(cur);
    cur = (await ctx.db.get<{ overflow_inbox_id: string | null }>("SELECT overflow_inbox_id FROM inboxes WHERE id = ? AND workspace_id = ?", cur, workspaceId))?.overflow_inbox_id ?? null;
  }
}

export async function updateDepartment(ctx: AppContext, actor: Actor, id: string, patch: DepartmentPatch) {
  requireManage(actor);
  const cur = await getInbox(ctx, actor.workspaceId, id);
  if (patch.overflow_inbox_id) {
    if (patch.overflow_inbox_id === id) throw unprocessable("OVERFLOW_LOOP", "A department cannot overflow into itself");
    if (!(await ctx.db.get("SELECT 1 FROM inboxes WHERE id = ? AND workspace_id = ?", patch.overflow_inbox_id, actor.workspaceId))) throw unprocessable("UNKNOWN_DEPARTMENT", "The overflow department does not exist");
    await assertNoOverflowLoop(ctx, actor.workspaceId, id, patch.overflow_inbox_id);
  }
  if (patch.members) {
    const have = new Set(await memberIds(ctx, id));
    for (const m of patch.members) if (!have.has(m.member_id)) throw unprocessable("NOT_A_MEMBER", `Member ${m.member_id} is not part of this department`);
  }
  await ctx.db.tx(async () => {
    await ctx.db.run(
      `UPDATE inboxes SET description = ?, routing_mode = ?, capacity = ?, hours = ?, sla_first_response_s = ?, sla_resolution_s = ?, overflow_inbox_id = ?, auto_reply_closed = ?, auto_reply_queued = ?, live_routing_visibility = ?, visitor_info = ? WHERE id = ?`,
      patch.description?.trim() ?? cur.description,
      patch.routing_mode === undefined ? cur.routing_mode : patch.routing_mode,
      patch.capacity ?? cur.capacity,
      patch.hours ? JSON.stringify(patch.hours) : cur.hours,
      patch.sla_first_response_s === undefined ? cur.sla_first_response_s : patch.sla_first_response_s,
      patch.sla_resolution_s === undefined ? cur.sla_resolution_s : patch.sla_resolution_s,
      patch.overflow_inbox_id === undefined ? cur.overflow_inbox_id : patch.overflow_inbox_id,
      patch.auto_reply_closed?.trim() ?? cur.auto_reply_closed,
      patch.auto_reply_queued?.trim() ?? cur.auto_reply_queued,
      patch.live_routing_visibility ?? !!cur.live_routing_visibility,
      patch.visitor_info ? JSON.stringify(patch.visitor_info) : cur.visitor_info,
      id,
    );
    for (const m of patch.members ?? []) {
      const have = await ctx.db.get<{ skills: string; languages: string; capacity: number | null }>("SELECT skills, languages, capacity FROM inbox_members WHERE inbox_id = ? AND member_id = ?", id, m.member_id);
      await ctx.db.run(
        "UPDATE inbox_members SET skills = ?, languages = ?, capacity = ? WHERE inbox_id = ? AND member_id = ?",
        m.skills ? JSON.stringify([...new Set(m.skills.map((x) => x.trim()).filter(Boolean))]) : have!.skills,
        m.languages ? JSON.stringify([...new Set(m.languages.map((x) => x.trim().toLowerCase()).filter(Boolean))]) : have!.languages,
        m.capacity === undefined ? have!.capacity : m.capacity,
        id,
        m.member_id,
      );
    }
  });
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "department.updated", target: id, detail: { fields: Object.keys(patch) } });
  const row = await getInbox(ctx, actor.workspaceId, id);
  ctx.bus.toWorkspace(actor.workspaceId, "inbox:updated", await inboxDto(ctx, row));
  // capacity, members or hours changed: tickets that were waiting may be assignable now
  await drainQueue(ctx, actor.workspaceId, id);
  return departmentDto(ctx, row);
}
