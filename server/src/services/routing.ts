import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "./audit.js";
import { addFollower } from "./contacts.js";
import {
  candidatesOf,
  departmentNextOpening,
  departmentOpenAt,
  effectiveMode,
  estimateWaitSeconds,
  parseHours,
  seatsOf,
  type Candidate,
  type RoutingMode,
} from "./departments.js";
import type { InboxRow } from "./inboxes.js";
import { listMemberRows, type MemberRow } from "./members.js";
import { insertMessage, emitInserted, postSystemMessage } from "./messageStore.js";
import { notifyTicket } from "./notifications.js";
import { metricsAssignee } from "./roomMetrics.js";
import { assigneeIds, getRoomRow, type RoomRow } from "./roomStore.js";
import { publishRoomUpdated } from "./rooms.js";
import { getSettings } from "./workspaces.js";
import { getVisibleTicket, publishTickets, recordTicketEvent, type TicketActor, type TicketRow } from "./tickets.js";
import { textToHtml } from "../util/html.js";

/**
 * The handoff engine (docs/AI-AGENTS.md, ADR 0028). A ticket that needs a person is routed to a department's seat by the department's mode,
 * or queued when nobody can take it. Every decision is made inside one transaction that holds a per-workspace lock, so two handoffs at the
 * same moment can never give one seat more than its capacity nor assign a ticket twice; routing a ticket that is already routed is a no-op.
 */

export type RouteOutcome = "assigned" | "queued" | "closed" | "manual" | "ended";

export interface RouteResult {
  outcome: RouteOutcome;
  ticket: TicketRow;
  department: InboxRow | null;
  assignee: MemberRow | null;
  /** departments the ticket passed through before it settled (overflow), in order */
  path: string[];
  mode: RoutingMode | "pool";
  /** the ticket changed (assigned, queued somewhere new, moved): false for a repeated call */
  changed: boolean;
  queue_position: number | null;
  wait_s: number | null;
  next_opening: string | null;
}

export interface RouteOptions {
  reason: string;
  by: TicketActor;
  /** route into this department instead of the ticket's own (a transfer) */
  departmentId?: string | null;
  exclude?: ReadonlySet<string>;
  /** skills the person must have (skills_based) and the visitor's language */
  skills?: string[];
  language?: string | null;
  /** route even when the ticket already has a human handler (reassignment, transfer) */
  force?: boolean;
  /** a transfer restarts the first-response clock of the new department */
  resetSla?: boolean;
}

async function loadDepartment(ctx: AppContext, ws: string, id: string | null): Promise<InboxRow | null> {
  if (!id) return null;
  return (await ctx.db.get<InboxRow>("SELECT * FROM inboxes WHERE id = ? AND workspace_id = ?", id, ws)) ?? null;
}

/**
 * A person to take the ticket, by the department's mode. Pure over the candidates. `pointer` is the seat this department handed a ticket to last
 * (as department order position and id): round robin and ties continue after it, even when that seat is busy or away right now.
 */
export function pickSeat(
  mode: RoutingMode,
  cands: Candidate[],
  pointer: { position: number; id: string } | null,
  want: { skills: string[]; language: string | null },
): { pick: Candidate | null; skillsFallback: boolean } {
  if (!cands.length || mode === "manual_pick") return { pick: null, skillsFallback: false };
  const byPosition = [...cands].sort((a, b) => a.seat.position - b.seat.position || a.seat.id.localeCompare(b.seat.id));
  const after = (c: Candidate) => !!pointer && (c.seat.position > pointer.position || (c.seat.position === pointer.position && c.seat.id > pointer.id));
  const order = (list: Candidate[]) => {
    const i = list.findIndex(after);
    return i < 0 ? list : [...list.slice(i), ...list.slice(0, i)];
  };
  if (mode === "round_robin") return { pick: order(byPosition)[0]!, skillsFallback: false };
  let pool = byPosition;
  let skillsFallback = false;
  if (mode === "skills_based" && (want.skills.length || want.language)) {
    const have = (c: Candidate) => parseJson<string[]>(c.seat.skills, []);
    const langs = (c: Candidate) => parseJson<string[]>(c.seat.languages, []);
    const score = (c: Candidate) => want.skills.filter((s) => have(c).includes(s)).length + (want.language && langs(c).includes(want.language) ? 1 : 0);
    const needed = want.skills.length + (want.language ? 1 : 0);
    const exact = byPosition.filter((c) => score(c) === needed);
    if (exact.length) pool = exact;
    else {
      const best = Math.max(...byPosition.map(score));
      if (best > 0) pool = byPosition.filter((c) => score(c) === best);
      else skillsFallback = true;
    }
  }
  // least busy; ties go to whoever comes after the pointer, so equal seats alternate
  const rotated = order(pool);
  const min = Math.min(...rotated.map((c) => c.load));
  return { pick: rotated.find((c) => c.load === min)!, skillsFallback };
}

async function roomOf(ctx: AppContext, t: TicketRow): Promise<RoomRow> {
  return getRoomRow(ctx, t.workspace_id, t.room_id);
}

/** Language of the visitor (primary subtag) as the widget reported it. */
function languageOf(room: Pick<RoomRow, "meta">, ticket: Pick<TicketRow, "meta">): string | null {
  const room_ = parseJson<{ context?: { locale?: string } }>(room.meta, {});
  const t = parseJson<{ language?: string }>(ticket.meta, {});
  const raw = t.language ?? room_.context?.locale;
  return raw ? raw.toLowerCase().split(/[-_]/)[0]! : null;
}

/** Route one ticket. See the module comment; the returned result says what happened and why (also stored as a ticket event). */
export async function routeTicket(ctx: AppContext, ticketId: string, opts: RouteOptions): Promise<RouteResult> {
  const first = await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", ticketId);
  if (!first) throw notFound("Ticket");
  const ws = first.workspace_id;
  const now = nowIso(ctx);
  let prevAssignees: string[] = [];

  const result = await ctx.db.tx(async (): Promise<RouteResult> => {
    // the workspace's routing mutex: PostgreSQL serialises routing transactions here, SQLite's single writer already does
    await ctx.db.get(`SELECT next_number FROM ticket_counters WHERE workspace_id = ?${ctx.db.forUpdate}`, ws);
    const t = (await ctx.db.get<TicketRow>(`SELECT * FROM tickets WHERE id = ?${ctx.db.forUpdate}`, ticketId))!;
    const room = await roomOf(ctx, t);
    prevAssignees = await assigneeIds(ctx, t.room_id);
    const base = { ticket: t, department: null as InboxRow | null, assignee: null as MemberRow | null, path: [] as string[], mode: "pool" as RoutingMode | "pool", changed: false, queue_position: null, wait_s: null, next_opening: null };
    if (t.status === "resolved" || t.status === "closed") return { ...base, outcome: "ended" };
    const h = t.handler?.startsWith("human:") ? t.handler.slice(6) : null;
    if (h && !opts.force && !opts.exclude?.has(h) && (t.status === "waiting_for_human" || t.status === "open" || t.status === "pending_customer")) {
      return { ...base, outcome: "assigned", assignee: (await listMemberRows(ctx, ws)).find((m) => m.id === h) ?? null, department: await loadDepartment(ctx, ws, t.department_id) };
    }

    const exclude = opts.exclude ?? new Set<string>();
    const wsSettings = await getSettings(ctx, ws);
    const defaultId = wsSettings.widget.default_inbox_id;
    let deptId: string | null = opts.departmentId !== undefined ? opts.departmentId : (t.department_id ?? defaultId);
    const path: string[] = [];
    let dept: InboxRow | null = null;
    let picked: Candidate | null = null;
    let mode: RoutingMode | "pool" = "pool";
    let outcome: RouteOutcome = "queued";
    let skillsFallback = false;
    let closedReason: string | null = null;

    for (let hop = 0; hop < 6; hop++) {
      dept = await loadDepartment(ctx, ws, deptId);
      if (!dept) break;
      if (path.includes(dept.id)) break; // an overflow loop (also refused when configured): stay where we are
      path.push(dept.id);
      mode = effectiveMode(dept);
      const open = departmentOpenAt(parseHours(dept.hours), ctx.clock());
      const overflow = dept.overflow_inbox_id && !path.includes(dept.overflow_inbox_id) ? dept.overflow_inbox_id : null;
      if (!open) {
        closedReason = "closed";
        outcome = "closed";
        if (overflow) {
          deptId = overflow;
          continue;
        }
        break;
      }
      closedReason = null;
      if (mode === "manual_pick") {
        outcome = "manual";
        break;
      }
      const cands = await candidatesOf(ctx, dept, { exclude });
      const want = { skills: opts.skills ?? parseJson<{ required_skills?: string[] }>(t.meta, {}).required_skills ?? [], language: opts.language ?? languageOf(room, t) };
      const pointerSeat = dept.last_assigned_member_id ? (await seatsOf(ctx, dept.id)).find((x) => x.id === dept!.last_assigned_member_id) : undefined;
      const { pick, skillsFallback: fb } = pickSeat(mode, cands, pointerSeat ? { position: pointerSeat.position, id: pointerSeat.id } : null, want);
      skillsFallback = fb;
      if (pick) {
        picked = pick;
        outcome = "assigned";
        break;
      }
      outcome = "queued";
      if (overflow) {
        deptId = overflow;
        continue;
      }
      break;
    }
    // no department anywhere: the whole workspace is the pool, least busy first
    if (!dept) {
      const online = (await getSettings(ctx, ws)).routing.require_online ? new Set(await ctx.presence.onlineIds(`${ws}:member`)) : null;
      const seats = (await listMemberRows(ctx, ws)).filter((m) => m.live_seat && m.availability === "active" && !m.removed_at && !exclude.has(m.id) && !(m.dnd_until && m.dnd_until > now) && (!online || online.has(m.id)));
      const loads = new Map<string, number>();
      for (const s of seats) loads.set(s.id, Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND handler = ? AND status IN ('waiting_for_human','open')", ws, `human:${s.id}`))!.n));
      const best = [...seats].sort((a, b) => (loads.get(a.id)! - loads.get(b.id)!) || a.id.localeCompare(b.id))[0];
      if (best) {
        picked = { seat: { ...best, position: 0, skills: "[]", languages: "[]", member_capacity: null }, load: loads.get(best.id)!, capacity: 0 };
        outcome = "assigned";
      }
    }

    const finalDept = dept;
    const assigneeId = picked?.seat.id ?? null;
    const status: TicketRow["status"] = "waiting_for_human";
    const handlerChanged = (t.handler ?? null) !== (assigneeId ? `human:${assigneeId}` : null);
    const deptChanged = (t.department_id ?? null) !== (finalDept?.id ?? null);
    const statusChanged = t.status !== status;
    const changed = handlerChanged || deptChanged || statusChanged;
    if (!changed) {
      return { ...base, outcome, department: finalDept, assignee: picked?.seat ?? null, path, mode, queue_position: assigneeId ? null : await queuePosition(ctx, t), wait_s: null, next_opening: null };
    }

    const firstHandoff = !t.handoff_at;
    const slaFirst = finalDept?.sla_first_response_s ?? null;
    const slaRes = finalDept?.sla_resolution_s ?? null;
    const updated = (await ctx.db.get<TicketRow>(
      `UPDATE tickets SET status = ?, handler = ?, department_id = ?, handoff_at = COALESCE(handoff_at, ?), handoff_reason = COALESCE(?, handoff_reason),
         reassigned_count = reassigned_count + ?,
         sla_first_response_due_at = CASE WHEN ? = 1 OR sla_first_response_due_at IS NULL THEN ? ELSE sla_first_response_due_at END,
         sla_resolution_due_at = CASE WHEN ? = 1 OR sla_resolution_due_at IS NULL THEN ? ELSE sla_resolution_due_at END,
         sla_first_response_breached_at = CASE WHEN ? = 1 THEN NULL ELSE sla_first_response_breached_at END,
         last_activity_at = ?, updated_at = ? WHERE id = ? RETURNING *`,
      status,
      assigneeId ? `human:${assigneeId}` : null,
      finalDept?.id ?? null,
      now,
      opts.reason,
      !firstHandoff && handlerChanged && t.handler?.startsWith("human:") ? 1 : 0,
      opts.resetSla || firstHandoff ? 1 : 0,
      slaFirst ? new Date(Date.parse(now) + slaFirst * 1000).toISOString() : null,
      opts.resetSla ? 1 : 0,
      slaRes ? new Date(Date.parse(t.opened_at) + slaRes * 1000).toISOString() : null,
      opts.resetSla || firstHandoff ? 1 : 0,
      now,
      now,
      t.id,
    ))!;
    // the room follows: department inbox, and the seat as the only assignee (nobody while queued)
    await ctx.db.run("UPDATE rooms SET inbox_id = ?, updated_at = ? WHERE id = ?", finalDept?.id ?? null, now, room.id);
    const had = prevAssignees.filter((m) => m !== assigneeId);
    for (const m of had) await ctx.db.run("DELETE FROM room_assignees WHERE room_id = ? AND member_id = ?", room.id, m);
    if (assigneeId && !prevAssignees.includes(assigneeId)) {
      await ctx.db.run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES (?,?,?)", room.id, assigneeId, now);
      await addFollower(ctx, room.contact_id, assigneeId);
    }
    if (assigneeId !== (prevAssignees[0] ?? null) || had.length) await metricsAssignee(ctx, room.id, assigneeId);
    if (assigneeId && finalDept && picked) await ctx.db.run("UPDATE inboxes SET last_assigned_member_id = ? WHERE id = ?", assigneeId, finalDept.id);
    await recordTicketEvent(
      ctx,
      updated,
      outcome === "assigned" ? "routed" : outcome === "queued" || outcome === "manual" ? "queued" : "queued_closed",
      opts.by,
      {
        reason: opts.reason,
        mode,
        department_id: finalDept?.id ?? null,
        assignee_id: assigneeId,
        path,
        candidates: picked ? undefined : 0,
        closed: closedReason,
        skills_fallback: skillsFallback || undefined,
        excluded: [...exclude],
      },
      now,
    );
    return {
      ticket: updated,
      department: finalDept,
      assignee: picked?.seat ?? null,
      outcome,
      path,
      mode,
      changed: true,
      queue_position: assigneeId ? null : await queuePosition(ctx, updated),
      wait_s: null,
      next_opening: outcome === "closed" && finalDept ? departmentNextOpening(parseHours(finalDept.hours), ctx.clock()) : null,
    };
  });

  if (result.outcome === "ended" || !result.changed) return result;

  // after commit: the visitor-independent side effects (events, system line, notifications)
  const room = await roomOf(ctx, result.ticket);
  const lost: string[] = [];
  for (const m of prevAssignees) if (m !== result.assignee?.id) lost.push(m);
  const newlyVisible = result.assignee && !prevAssignees.includes(result.assignee.id) ? [result.assignee.id] : [];
  await publishRoomUpdated(ctx, room, { lost, newlyVisible });
  await publishTickets(ctx, [result.ticket.id]);
  result.wait_s = await estimateWaitSeconds(ctx, ws, result.department?.id ?? null);
  if (result.assignee) {
    await postSystemMessage(ctx, room.id, ws, `Routed to ${result.assignee.name}${result.department ? ` (${result.department.name})` : ""}`, {
      sub_type: "assignee",
      assignee_ids: [result.assignee.id],
      actor_name: "Routing",
      reason: opts.reason,
    });
  }
  await notifyRouting(ctx, result, room, opts.reason);
  return result;
}

async function queuePosition(ctx: AppContext, t: TicketRow): Promise<number | null> {
  if (t.status !== "waiting_for_human" || t.handler) return null;
  const r = await ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND ${t.department_id ? "department_id = ?" : "department_id IS NULL"} AND status = 'waiting_for_human' AND handler IS NULL AND (handoff_at < ? OR (handoff_at = ? AND id <= ?))`,
    ...(t.department_id ? [t.workspace_id, t.department_id] : [t.workspace_id]),
    t.handoff_at ?? t.updated_at,
    t.handoff_at ?? t.updated_at,
    t.id,
  );
  return Number(r?.n ?? 1);
}

/** In-app notification (and the existing offline email) for the assignee, or for the department and the managers while the ticket waits in the queue. */
async function notifyRouting(ctx: AppContext, r: RouteResult, room: RoomRow, reason: string): Promise<void> {
  const members = await listMemberRows(ctx, room.workspace_id);
  const title = `Ticket #${r.ticket.number}: ${r.ticket.subject}`.slice(0, 120);
  if (r.assignee) {
    const m = members.find((x) => x.id === r.assignee!.id);
    if (m) await notifyTicket(ctx, m, { type: "ticket_assigned", room, title: `Assigned to you: ${title}`, body: handoffReasonText(reason), email: true });
    return;
  }
  const dept = r.department;
  const team = new Set<string>(dept ? (await seatsOf(ctx, dept.id)).map((s) => s.id) : []);
  for (const m of members) {
    if (!m.live_seat || !(team.has(m.id) || m.role === "owner" || m.role === "manager")) continue;
    await notifyTicket(ctx, m, {
      type: "ticket_queued",
      room,
      title: `Waiting for a person: ${title}`,
      body: `${handoffReasonText(reason)}${dept ? ` Department: ${dept.name}.` : ""}${r.outcome === "closed" ? " The department is closed." : ""}`,
      email: team.has(m.id),
    });
  }
}

export const handoffReasonText = (reason: string): string =>
  ({
    customer_requested_human: "The customer asked for a person.",
    low_confidence: "The AI agent could not answer confidently.",
    no_answer: "The AI agent found no answer.",
    repeated_rephrase: "The customer had to rephrase repeatedly.",
    negative_sentiment: "The customer sounds upset.",
    high_urgency: "The message looks urgent.",
    sensitive_topic: "The topic needs a person.",
    tool_failure: "The AI agent hit a technical problem.",
    vip_contact: "A VIP contact.",
    outside_hours: "The AI agent is outside its working hours.",
    agent_disabled: "The AI agent is switched off.",
    max_turns: "The AI agent reached its turn limit.",
    transfer: "Transferred from another department.",
    agent_unavailable: "The previous person became unavailable.",
    agent_removed: "The previous person was removed.",
    sla_escalation: "The first-response time was missed.",
    queue_drain: "A person became available.",
  })[reason] ?? `Reason: ${reason.replace(/_/g, " ")}.`;

/* ---------- handoff ---------- */

export interface HandoffInput {
  reason: string;
  by: TicketActor;
  departmentId?: string | null;
  skills?: string[];
  language?: string | null;
  /** internal note for the person who gets it (summary, collected fields, what was tried): posted as a note */
  note?: string;
  /** say what is happening to the visitor (default true) */
  tell?: boolean;
}

/** The text a visitor reads after a handoff: where they are, how long it may take, or that nobody is there and what happens next. */
export function visitorHandoffText(r: RouteResult): string {
  const d = r.department;
  const team = d ? `our ${d.name} team` : "a teammate";
  if (r.outcome === "closed") {
    if (d?.auto_reply_closed.trim()) return d.auto_reply_closed.trim();
    return `${d ? `Our ${d.name} team is` : "We are"} closed right now.${r.next_opening ? ` We reopen ${r.next_opening}.` : ""} Your message is saved and the first person back will reply here.`;
  }
  if (r.outcome === "assigned") {
    const wait = r.wait_s ? ` Typical wait: about ${Math.max(1, Math.round(r.wait_s / 60))} min.` : "";
    return `Connecting you with ${team}.${wait}`;
  }
  if (d?.auto_reply_queued.trim()) return d.auto_reply_queued.trim();
  const pos = r.queue_position && r.queue_position > 1 ? ` You are number ${r.queue_position} in the queue.` : "";
  const wait = r.wait_s ? ` Typical wait: about ${Math.max(1, Math.round(r.wait_s / 60))} min.` : "";
  return `Everyone on ${team} is busy right now.${pos}${wait} You can keep writing here: the next free person will reply.`;
}

async function postVisitorLine(ctx: AppContext, room: RoomRow, text: string, meta: Record<string, unknown>): Promise<void> {
  const r = await insertMessage(ctx, {
    workspaceId: room.workspace_id,
    roomId: room.id,
    senderType: "bot",
    senderId: "routing",
    senderName: "Assistant",
    kind: "text",
    source: "dm",
    content: textToHtml(text),
    contentText: text,
    meta: { handoff: true, ...meta },
  });
  await emitInserted(ctx, r);
}

async function postHandoffNote(ctx: AppContext, room: RoomRow, text: string, meta: Record<string, unknown>): Promise<void> {
  const r = await insertMessage(ctx, { workspaceId: room.workspace_id, roomId: room.id, senderType: "bot", senderId: "routing", senderName: "Assistant", kind: "note", source: "dm", content: textToHtml(text), contentText: text, meta: { sub_type: "handoff", ...meta } });
  await emitInserted(ctx, r);
}

/**
 * A ticket needs a person: mark it, route it, tell the visitor what is happening, leave the person a note. Idempotent: handing off a ticket that
 * is already with a person (or already queued) changes nothing and says nothing again.
 */
export async function handoffTicket(ctx: AppContext, ticketId: string, input: HandoffInput): Promise<RouteResult> {
  const r = await routeTicket(ctx, ticketId, { reason: input.reason, by: input.by, departmentId: input.departmentId, skills: input.skills, language: input.language });
  if (!r.changed || r.outcome === "ended") return r;
  const room = await roomOf(ctx, r.ticket);
  await recordTicketEvent(ctx, r.ticket, "handoff", input.by, { reason: input.reason, outcome: r.outcome, department_id: r.department?.id ?? null });
  await recordAudit(ctx, {
    workspaceId: r.ticket.workspace_id,
    actor: input.by.type === "member" ? { type: "member", id: input.by.id } : { type: "system" },
    action: "ticket.handoff",
    target: r.ticket.id,
    detail: { reason: input.reason, outcome: r.outcome, department_id: r.department?.id ?? null, assignee_id: r.assignee?.id ?? null },
  });
  const noteLines = [`Handoff: ${handoffReasonText(input.reason)}`, r.department ? `Department: ${r.department.name}` : null, r.assignee ? `Assigned to: ${r.assignee.name}` : r.outcome === "closed" ? "Nobody: the department is closed." : "Nobody is available: queued.", input.note].filter(Boolean);
  await postHandoffNote(ctx, room, noteLines.join("\n"), { reason: input.reason, ticket_id: r.ticket.id });
  if (input.tell !== false) await postVisitorLine(ctx, room, visitorHandoffText(r), { reason: input.reason, outcome: r.outcome, department_id: r.department?.id ?? null, ticket_id: r.ticket.id });
  return r;
}

/** Mid-conversation transfer to another department (agent action; the AI agent has the same through its set_department tool). */
export async function transferTicket(ctx: AppContext, ticketId: string, input: { to: string; by: TicketActor; note?: string; tell?: boolean }): Promise<RouteResult> {
  const t = await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", ticketId);
  if (!t) throw notFound("Ticket");
  const to = await loadDepartment(ctx, t.workspace_id, input.to);
  if (!to) throw unprocessable("UNKNOWN_DEPARTMENT", "That department does not exist");
  if (t.status === "resolved" || t.status === "closed") throw new AppError(409, "TICKET_ENDED", "Reopen the ticket before transferring it");
  const from = await loadDepartment(ctx, t.workspace_id, t.department_id);
  const r = await routeTicket(ctx, ticketId, { reason: "transfer", by: input.by, departmentId: to.id, force: true, resetSla: true });
  const room = await roomOf(ctx, r.ticket);
  await recordTicketEvent(ctx, r.ticket, "transferred", input.by, { from: from?.id ?? null, to: to.id, note: input.note ?? null });
  await recordAudit(ctx, {
    workspaceId: t.workspace_id,
    actor: input.by.type === "member" ? { type: "member", id: input.by.id } : { type: "system" },
    action: "ticket.transferred",
    target: t.id,
    detail: { from: from?.id ?? null, to: to.id },
  });
  await postHandoffNote(ctx, room, [`Transferred from ${from?.name ?? "no department"} to ${to.name}.`, input.note].filter(Boolean).join("\n"), { reason: "transfer", ticket_id: t.id });
  if (input.tell !== false) await postVisitorLine(ctx, room, visitorHandoffText(r), { reason: "transfer", outcome: r.outcome, department_id: to.id, ticket_id: t.id });
  return r;
}

/** A person takes a ticket from the queue (manual_pick departments, or any waiting ticket). The first claim wins. */
export async function claimTicket(ctx: AppContext, actor: Actor, ticketId: string): Promise<TicketRow> {
  const t = await getVisibleTicket(ctx, actor, ticketId);
  if (t.status === "open" && t.handler === `human:${actor.memberId}`) return t; // already yours
  const now = nowIso(ctx);
  const prev = await assigneeIds(ctx, t.room_id);
  const row = await ctx.db.tx(async () => {
    await ctx.db.get(`SELECT next_number FROM ticket_counters WHERE workspace_id = ?${ctx.db.forUpdate}`, t.workspace_id);
    const claimed = await ctx.db.get<TicketRow>(
      `UPDATE tickets SET handler = ?, status = 'open', handoff_at = COALESCE(handoff_at, ?), last_activity_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('new','bot_handling','waiting_for_human') AND (handler IS NULL OR handler = ?) RETURNING *`,
      `human:${actor.memberId}`,
      now,
      now,
      now,
      t.id,
      `human:${actor.memberId}`,
    );
    if (!claimed) return null;
    for (const m of prev.filter((x) => x !== actor.memberId)) await ctx.db.run("DELETE FROM room_assignees WHERE room_id = ? AND member_id = ?", t.room_id, m);
    if (!prev.includes(actor.memberId)) {
      await ctx.db.run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES (?,?,?)", t.room_id, actor.memberId, now);
      await addFollower(ctx, t.contact_id, actor.memberId);
    }
    await metricsAssignee(ctx, t.room_id, actor.memberId);
    await recordTicketEvent(ctx, claimed, "claimed", { type: "member", id: actor.memberId }, { from: t.handler }, now);
    return claimed;
  });
  if (!row) throw new AppError(409, "TICKET_TAKEN", "Someone else already took this ticket, or it is no longer waiting");
  const room = await roomOf(ctx, row);
  await publishRoomUpdated(ctx, room, { lost: prev.filter((m) => m !== actor.memberId), newlyVisible: [actor.memberId] });
  await publishTickets(ctx, [row.id]);
  return row;
}

/* ---------- queue, seats, service levels ---------- */

/** Give waiting tickets to people who can take them now, oldest first. Idempotent and cheap when nothing changed. */
export async function drainQueue(ctx: AppContext, workspaceId: string, deptId?: string): Promise<number> {
  const waiting = await ctx.db.all<{ id: string }>(
    `SELECT id FROM tickets WHERE workspace_id = ? AND status = 'waiting_for_human' AND handler IS NULL ${deptId ? "AND department_id = ?" : ""} ORDER BY handoff_at, id LIMIT 50`,
    ...(deptId ? [workspaceId, deptId] : [workspaceId]),
  );
  let assigned = 0;
  for (const w of waiting) {
    const r = await routeTicket(ctx, w.id, { reason: "queue_drain", by: { type: "system" }, force: true });
    if (r.outcome === "assigned" && r.changed) {
      assigned++;
      const room = await roomOf(ctx, r.ticket);
      await postVisitorLine(ctx, room, `${r.assignee?.name.split(" ")[0] ?? "A teammate"} is picking this up now.`, { reason: "queue_drain", outcome: "assigned", ticket_id: r.ticket.id });
    }
  }
  return assigned;
}

/**
 * A seat stopped being able to take work (went away, do-not-disturb, removed): tickets assigned to it that it has not accepted yet go back through
 * routing without it. Tickets it already accepted (`open`) stay with it, except when the seat was removed (`all`).
 */
export async function releaseSeatTickets(ctx: AppContext, workspaceId: string, memberId: string, mode: "waiting_only" | "all"): Promise<number> {
  const rows = await ctx.db.all<{ id: string }>(
    `SELECT id FROM tickets WHERE workspace_id = ? AND handler = ? AND status IN (${mode === "all" ? "'waiting_for_human','open','pending_customer'" : "'waiting_for_human'"}) ORDER BY handoff_at, id LIMIT 200`,
    workspaceId,
    `human:${memberId}`,
  );
  let n = 0;
  for (const t of rows) {
    const reason = mode === "all" ? "agent_removed" : "agent_unavailable";
    const r = await routeTicket(ctx, t.id, { reason, by: { type: "system" }, exclude: new Set([memberId]), force: true });
    if (r.changed) {
      n++;
      await recordAudit(ctx, { workspaceId, actor: { type: "system" }, action: "ticket.reassigned", target: t.id, detail: { reason, from: memberId, to: r.assignee?.id ?? null, outcome: r.outcome } });
    }
  }
  return n;
}

/** Called after a seat's availability or do-not-disturb changed. */
export async function onSeatChanged(ctx: AppContext, workspaceId: string, member: Pick<MemberRow, "id" | "availability" | "dnd_until" | "live_seat">): Promise<void> {
  const unavailable = member.availability !== "active" || !member.live_seat || (!!member.dnd_until && member.dnd_until > nowIso(ctx));
  if (unavailable) await releaseSeatTickets(ctx, workspaceId, member.id, "waiting_only");
  else await drainQueue(ctx, workspaceId);
}

/**
 * Service levels. A ticket still waiting for its first human reply after the department's first-response time is escalated once: its priority
 * goes up a step, it is offered to someone else (excluding who failed to answer) or to the overflow department, and managers hear about it.
 * A ticket past its resolution time is only recorded (and reported), never moved.
 */
export async function slaSweep(ctx: AppContext, opts: { limit?: number } = {}): Promise<{ escalated: number; resolution_breaches: number }> {
  const now = nowIso(ctx);
  const out = { escalated: 0, resolution_breaches: 0 };
  const late = await ctx.db.all<TicketRow>(
    `SELECT * FROM tickets WHERE status IN ('new','waiting_for_human') AND first_human_response_at IS NULL AND sla_first_response_breached_at IS NULL AND sla_first_response_due_at IS NOT NULL AND sla_first_response_due_at < ? ORDER BY sla_first_response_due_at LIMIT ?`,
    now,
    opts.limit ?? 100,
  );
  for (const t of late) {
    const marked = await ctx.db.get<TicketRow>("UPDATE tickets SET sla_first_response_breached_at = ?, priority = CASE WHEN priority < 3 THEN priority + 1 ELSE priority END, updated_at = ? WHERE id = ? AND sla_first_response_breached_at IS NULL RETURNING *", now, now, t.id);
    if (!marked) continue;
    out.escalated++;
    await recordTicketEvent(ctx, marked, "sla_breached", { type: "system" }, { kind: "first_response", due: t.sla_first_response_due_at }, now);
    await recordAudit(ctx, { workspaceId: t.workspace_id, actor: { type: "system" }, action: "ticket.sla_breached", target: t.id, detail: { kind: "first_response", department_id: t.department_id } });
    const exclude = new Set<string>(t.handler?.startsWith("human:") ? [t.handler.slice(6)] : []);
    const dept = await loadDepartment(ctx, t.workspace_id, t.department_id);
    const departmentId = dept?.overflow_inbox_id && !exclude.size ? dept.overflow_inbox_id : t.department_id;
    // an escalation leaves the clock running for the next person: `resetSla` stays off, the breach is already recorded
    const r = await routeTicket(ctx, t.id, { reason: "sla_escalation", by: { type: "system" }, exclude, force: true, departmentId });
    await publishTickets(ctx, [t.id]);
    const room = await roomOf(ctx, r.ticket);
    for (const m of await listMemberRows(ctx, t.workspace_id)) {
      if (m.live_seat && (m.role === "owner" || m.role === "manager")) await notifyTicket(ctx, m, { type: "ticket_sla", room, title: `Missed first response: #${t.number} ${t.subject}`.slice(0, 120), body: handoffReasonText("sla_escalation"), email: false });
    }
  }
  const slow = await ctx.db.all<TicketRow>(
    `SELECT * FROM tickets WHERE status IN ('new','bot_handling','waiting_for_human','open','pending_customer') AND sla_resolution_breached_at IS NULL AND sla_resolution_due_at IS NOT NULL AND sla_resolution_due_at < ? ORDER BY sla_resolution_due_at LIMIT ?`,
    now,
    opts.limit ?? 100,
  );
  for (const t of slow) {
    const marked = await ctx.db.get<TicketRow>("UPDATE tickets SET sla_resolution_breached_at = ?, updated_at = ? WHERE id = ? AND sla_resolution_breached_at IS NULL RETURNING *", now, now, t.id);
    if (!marked) continue;
    out.resolution_breaches++;
    await recordTicketEvent(ctx, marked, "sla_breached", { type: "system" }, { kind: "resolution", due: t.sla_resolution_due_at }, now);
  }
  return out;
}

