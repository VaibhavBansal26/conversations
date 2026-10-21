import { describe, expect, it } from "vitest";
import { createInbox } from "../src/services/inboxes.js";
import { updateMember, memberScope } from "../src/services/members.js";
import { updateDepartment } from "../src/services/departments.js";
import { claimTicket, drainQueue, handoffTicket, pickSeat, routeTicket, slaSweep, transferTicket, visitorHandoffText, releaseSeatTickets } from "../src/services/routing.js";
import { liveTicketOf, resolveTicket, closeTicket, updateTicket } from "../src/services/tickets.js";
import { tick } from "../src/jobs/scheduler.js";
import { addMemberRaw, agentSays, contactSays, fullApp, messagesOf, mkInbox, mkRoom, setSettings, tokenFor } from "./helpers.js";
import { getRoomRow } from "../src/services/roomStore.js";
import { assigneeIds } from "../src/services/roomStore.js";
import type { Actor } from "../src/domain/types.js";

type World = Awaited<ReturnType<typeof world>>;

/** A workspace with a department of `n` seats, every seat available (connection is not required unless asked). */
async function world(o: { seats?: number; mode?: "round_robin" | "least_busy" | "skills_based" | "manual_pick" | null; capacity?: number; requireOnline?: boolean; name?: string } = {}) {
  const f = await fullApp();
  if (!o.requireOnline) await setSettings(f.ctx, f.wsId, { routing: { require_online: false } });
  const seats: Actor[] = [];
  for (let i = 0; i < (o.seats ?? 3); i++) seats.push(await addMemberRaw(f.ctx, f.wsId, { name: `Seat ${String.fromCharCode(65 + i)}`, inbox_visibility: "assigned_inbox" }));
  const dept = await createInbox(f.ctx, f.owner, { name: o.name ?? "Support", member_ids: seats.map((s) => s.memberId) });
  if (o.mode !== undefined || o.capacity) await updateDepartment(f.ctx, f.owner, dept.id, { routing_mode: o.mode ?? "round_robin", capacity: o.capacity ?? 0 });
  else await updateDepartment(f.ctx, f.owner, dept.id, { routing_mode: "round_robin" });
  return { ...f, seats, dept };
}

/** A conversation in the department with an open ticket, as if the customer had just written. */
async function ticketIn(w: World, deptId: string | null = w.dept.id, text = "I need help with my invoice", contact: Record<string, unknown> = {}) {
  const { room } = await mkRoom(w.ctx, w.wsId, { inboxId: deptId, contact: contact as never });
  await contactSays(w.ctx, room, text);
  return { room, ticket: (await liveTicketOf(w.ctx, room.id))! };
}
const handoff = (w: World, ticketId: string, o: Partial<Parameters<typeof handoffTicket>[2]> = {}) => handoffTicket(w.ctx, ticketId, { reason: "customer_requested_human", by: { type: "system" }, ...o });
const handlerOf = async (w: World, id: string) => (await w.ctx.db.get<{ handler: string | null }>("SELECT handler FROM tickets WHERE id = ?", id))!.handler;
const events = (w: World, ticketId: string) => w.ctx.db.all<{ type: string; detail: string }>("SELECT type, detail FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, id", ticketId);
const names = (w: World, ids: (string | null)[]) => ids.map((h) => (h ? w.seats.find((s) => `human:${s.memberId}` === h)?.name : null));

describe("round robin", () => {
  it("hands tickets to seats in department order, one after the other, and starts over", async () => {
    const w = await world();
    const got: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const { ticket } = await ticketIn(w);
      await handoff(w, ticket.id);
      got.push(await handlerOf(w, ticket.id));
    }
    expect(names(w, got)).toEqual(["Seat A", "Seat B", "Seat C", "Seat A", "Seat B"]);
  });

  it("skips an unavailable seat but keeps the rotation fair (the seat after the last one used comes next)", async () => {
    const w = await world();
    const a = await ticketIn(w);
    await handoff(w, a.ticket.id); // A
    await updateMember(w.ctx, w.owner, w.seats[1]!.memberId, { availability: "away" }); // B leaves
    const b = await ticketIn(w);
    await handoff(w, b.ticket.id);
    expect(names(w, [await handlerOf(w, b.ticket.id)])).toEqual(["Seat C"]);
    const c = await ticketIn(w);
    await handoff(w, c.ticket.id);
    expect(names(w, [await handlerOf(w, c.ticket.id)])).toEqual(["Seat A"]);
  });

  it("an assigned ticket becomes the seat's, the room follows (department inbox, single assignee) and the system line says so", async () => {
    const w = await world();
    const { room, ticket } = await ticketIn(w, null); // a conversation in no inbox yet
    const r = await handoff(w, ticket.id, { departmentId: w.dept.id });
    expect(r).toMatchObject({ outcome: "assigned", changed: true });
    const fresh = await getRoomRow(w.ctx, w.wsId, room.id);
    expect(fresh.inbox_id).toBe(w.dept.id);
    expect(await assigneeIds(w.ctx, room.id)).toEqual([w.seats[0]!.memberId]);
    const t = (await liveTicketOf(w.ctx, room.id))!;
    expect(t).toMatchObject({ status: "waiting_for_human", department_id: w.dept.id, handler: `human:${w.seats[0]!.memberId}` });
    expect(t.handoff_at).not.toBeNull();
    expect(t.handoff_reason).toBe("customer_requested_human");
    expect((await messagesOf(w.ctx, room.id)).some((m) => m.content_text.startsWith("Routed to Seat A (Support)"))).toBe(true);
    expect((await events(w, t.id)).map((e) => e.type)).toEqual(["opened", "routed", "handoff"]);
  });
});

describe("least busy, capacity and availability", () => {
  it("least_busy picks the seat with the fewest tickets and rotates among equals", async () => {
    const w = await world({ mode: "least_busy" });
    const t1 = await ticketIn(w);
    const t2 = await ticketIn(w);
    const t3 = await ticketIn(w);
    for (const t of [t1, t2, t3]) await handoff(w, t.ticket.id);
    expect(names(w, [await handlerOf(w, t1.ticket.id), await handlerOf(w, t2.ticket.id), await handlerOf(w, t3.ticket.id)])).toEqual(["Seat A", "Seat B", "Seat C"]);
    // A finishes theirs: A is now the least busy
    await resolveTicket(w.ctx, w.owner, t1.ticket.id);
    const t4 = await ticketIn(w);
    await handoff(w, t4.ticket.id);
    expect(names(w, [await handlerOf(w, t4.ticket.id)])).toEqual(["Seat A"]);
  });

  it("never gives a seat more than its capacity: the rest queue, and a resolved ticket frees the next one automatically", async () => {
    const w = await world({ seats: 1, capacity: 1 });
    const a = await ticketIn(w);
    const b = await ticketIn(w);
    await handoff(w, a.ticket.id);
    const rb = await handoff(w, b.ticket.id);
    expect(rb.outcome).toBe("queued");
    expect(rb.queue_position).toBe(1);
    expect(await handlerOf(w, b.ticket.id)).toBeNull();
    expect((await liveTicketOf(w.ctx, b.room.id))!.status).toBe("waiting_for_human");
    await resolveTicket(w.ctx, w.owner, a.ticket.id);
    expect(await handlerOf(w, b.ticket.id)).toBe(`human:${w.seats[0]!.memberId}`);
    expect((await messagesOf(w.ctx, b.room.id)).some((m) => m.content_text.includes("is picking this up now"))).toBe(true);
  });

  it("a member's own capacity wins over the department's", async () => {
    const w = await world({ seats: 2, capacity: 5 });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { members: [{ member_id: w.seats[0]!.memberId, capacity: 1 }] });
    const got: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await ticketIn(w);
      await handoff(w, t.ticket.id);
      got.push(await handlerOf(w, t.ticket.id));
    }
    expect(names(w, got).filter((n) => n === "Seat A")).toHaveLength(1);
    expect(names(w, got).filter((n) => n === "Seat B")).toHaveLength(3);
  });

  it("only active, live, non-DND, non-removed seats take tickets; waiting for the customer does not count against capacity", async () => {
    const w = await world({ seats: 4, capacity: 1 });
    await updateMember(w.ctx, w.owner, w.seats[0]!.memberId, { availability: "inactive" });
    await updateMember(w.ctx, w.owner, w.seats[1]!.memberId, { dnd_until: new Date(w.ctx.clock().getTime() + 3600_000).toISOString() });
    await w.ctx.db.run("UPDATE members SET live_seat = 0 WHERE id = ?", w.seats[2]!.memberId);
    const t = await ticketIn(w);
    await handoff(w, t.ticket.id);
    expect(names(w, [await handlerOf(w, t.ticket.id)])).toEqual(["Seat D"]);
    // D marks it waiting for the customer: it no longer occupies D's capacity
    await agentSays(w.ctx, w.seats[3]!, t.room.id, "which invoice?");
    await updateTicket(w.ctx, w.seats[3]!, t.ticket.id, { status: "pending_customer" });
    const t2 = await ticketIn(w);
    await handoff(w, t2.ticket.id);
    expect(names(w, [await handlerOf(w, t2.ticket.id)])).toEqual(["Seat D"]);
    // DND ends: B is available again
    w.ctx.clockCtl.advance(3601_000);
    const t3 = await ticketIn(w);
    await handoff(w, t3.ticket.id);
    expect(names(w, [await handlerOf(w, t3.ticket.id)])).toEqual(["Seat B"]);
  });

  it("require_online: only connected seats are available", async () => {
    const w = await world({ seats: 2, requireOnline: true });
    const t1 = await ticketIn(w);
    expect((await handoff(w, t1.ticket.id)).outcome).toBe("queued"); // nobody connected
    await w.ctx.presence.connect(memberScope(w.wsId), w.seats[1]!.memberId, "sock-1");
    expect(await drainQueue(w.ctx, w.wsId)).toBe(1);
    expect(names(w, [await handlerOf(w, t1.ticket.id)])).toEqual(["Seat B"]);
  });
});

describe("skills and languages", () => {
  async function skilled() {
    const w = await world({ seats: 3, mode: "skills_based" });
    await updateDepartment(w.ctx, w.owner, w.dept.id, {
      members: [
        { member_id: w.seats[0]!.memberId, skills: ["billing"], languages: ["en"] },
        { member_id: w.seats[1]!.memberId, skills: ["billing", "api"], languages: ["de"] },
        { member_id: w.seats[2]!.memberId, skills: ["api"], languages: ["en", "de"] },
      ],
    });
    return w;
  }
  it("picks the seat that has every required skill, then the best partial match, then falls back to the least busy", async () => {
    const w = await skilled();
    const a = await ticketIn(w);
    await handoff(w, a.ticket.id, { skills: ["billing", "api"] });
    expect(names(w, [await handlerOf(w, a.ticket.id)])).toEqual(["Seat B"]); // the only one with both
    const b = await ticketIn(w);
    await handoff(w, b.ticket.id, { skills: ["billing", "legal"] }); // nobody has legal: best partial match is billing
    expect(["Seat A", "Seat B"]).toContain(names(w, [await handlerOf(w, b.ticket.id)])[0]);
    const c = await ticketIn(w);
    await handoff(w, c.ticket.id, { skills: ["legal"] }); // nobody at all: falls back, and says so
    expect(await handlerOf(w, c.ticket.id)).not.toBeNull();
    const ev = (await events(w, c.ticket.id)).find((e) => e.type === "routed")!;
    expect(JSON.parse(ev.detail).skills_fallback).toBe(true);
  });

  it("uses the visitor's language from the conversation context", async () => {
    const w = await skilled();
    const { room, ticket } = await ticketIn(w);
    await w.ctx.db.run("UPDATE rooms SET meta = ? WHERE id = ?", JSON.stringify({ context: { locale: "de-AT" } }), room.id);
    await handoff(w, ticket.id, { skills: ["billing"] });
    expect(names(w, [await handlerOf(w, ticket.id)])).toEqual(["Seat B"]); // billing + de
  });

  it("pickSeat is deterministic: equal seats alternate after the pointer", () => {
    const seat = (id: string, position: number) => ({ seat: { id, position, skills: "[]", languages: "[]" } as never, load: 0, capacity: 0 });
    const cands = [seat("a", 0), seat("b", 1), seat("c", 2)];
    expect(pickSeat("least_busy", cands, null, { skills: [], language: null }).pick!.seat.id).toBe("a");
    expect(pickSeat("least_busy", cands, { position: 0, id: "a" }, { skills: [], language: null }).pick!.seat.id).toBe("b");
    expect(pickSeat("least_busy", cands, { position: 2, id: "c" }, { skills: [], language: null }).pick!.seat.id).toBe("a");
    expect(pickSeat("round_robin", [], null, { skills: [], language: null }).pick).toBeNull();
    expect(pickSeat("manual_pick", cands, null, { skills: [], language: null }).pick).toBeNull();
  });
});

describe("department hours and overflow", () => {
  const closedHours = { enabled: true, timezone: "UTC", days: [] as { day: number; start: string; end: string }[], holidays: [] as string[] };

  it("a closed department queues the ticket, says so with the next opening, and uses its own auto-reply when set", async () => {
    const w = await world({ seats: 1 });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { hours: { enabled: true, timezone: "UTC", days: [{ day: 2, start: "09:00", end: "17:00" }], holidays: [] } }); // Tuesdays; the test clock is a Monday
    const { room, ticket } = await ticketIn(w);
    const r = await handoff(w, ticket.id);
    expect(r).toMatchObject({ outcome: "closed", next_opening: "tomorrow at 09:00 (UTC)" });
    expect(await handlerOf(w, ticket.id)).toBeNull();
    const said = (await messagesOf(w.ctx, room.id)).filter((m) => m.sender_type === "bot" && m.kind === "text").pop()!;
    expect(said.content_text).toContain("closed right now");
    expect(said.content_text).toContain("tomorrow at 09:00 (UTC)");
    await updateDepartment(w.ctx, w.owner, w.dept.id, { auto_reply_closed: "Back tomorrow, thanks for waiting." });
    const t2 = await ticketIn(w);
    await handoff(w, t2.ticket.id);
    expect((await messagesOf(w.ctx, t2.room.id)).some((m) => m.content_text === "Back tomorrow, thanks for waiting.")).toBe(true);
  });

  it("a closed department overflows into an open one, the ticket and the room move there", async () => {
    const w = await world({ seats: 1 });
    const night = await mkInbox(w.ctx, w.owner, { name: "Night desk", member_ids: [w.seats[0]!.memberId] });
    await updateDepartment(w.ctx, w.owner, night.id, { routing_mode: "round_robin" });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { hours: closedHours, overflow_inbox_id: night.id });
    const { room, ticket } = await ticketIn(w);
    const r = await handoff(w, ticket.id);
    expect(r).toMatchObject({ outcome: "assigned", path: [w.dept.id, night.id] });
    expect((await liveTicketOf(w.ctx, room.id))!.department_id).toBe(night.id);
    expect((await getRoomRow(w.ctx, w.wsId, room.id)).inbox_id).toBe(night.id);
  });

  it("a department with nobody free overflows too; a chain of closed departments ends in the last one without looping", async () => {
    const w = await world({ seats: 1, capacity: 1 });
    const spill = await mkInbox(w.ctx, w.owner, { name: "Spill", member_ids: [w.seats[0]!.memberId] });
    await updateDepartment(w.ctx, w.owner, spill.id, { routing_mode: "round_robin", capacity: 5 });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { overflow_inbox_id: spill.id });
    const a = await ticketIn(w);
    await handoff(w, a.ticket.id); // takes the seat's only slot in Support
    const b = await ticketIn(w);
    const r = await handoff(w, b.ticket.id);
    expect(r).toMatchObject({ outcome: "assigned" });
    expect(r.path).toEqual([w.dept.id, spill.id]);
    // everything closed: queue in the last department of the chain
    await updateDepartment(w.ctx, w.owner, spill.id, { hours: closedHours });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { hours: closedHours });
    const c = await ticketIn(w);
    const rc = await handoff(w, c.ticket.id);
    expect(rc.outcome).toBe("closed");
    expect(rc.path).toEqual([w.dept.id, spill.id]);
    expect((await liveTicketOf(w.ctx, c.room.id))!.department_id).toBe(spill.id);
    // a loop written straight into the database (bypassing validation) is walked once
    await w.ctx.db.run("UPDATE inboxes SET overflow_inbox_id = ? WHERE id = ?", w.dept.id, spill.id);
    const d = await ticketIn(w);
    const rd = await handoff(w, d.ticket.id);
    expect(rd.path).toEqual([w.dept.id, spill.id]);
  });
});

describe("manual pick and claiming", () => {
  it("a manual_pick department queues; the first claim wins, the loser is told", async () => {
    const w = await world({ seats: 2, mode: "manual_pick" });
    const { room, ticket } = await ticketIn(w);
    const r = await handoff(w, ticket.id);
    expect(r.outcome).toBe("manual");
    expect(await handlerOf(w, ticket.id)).toBeNull();
    const results = await Promise.allSettled([claimTicket(w.ctx, w.seats[0]!, ticket.id), claimTicket(w.ctx, w.seats[1]!, ticket.id)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "TICKET_TAKEN" });
    const t = (await liveTicketOf(w.ctx, room.id))!;
    expect(t.status).toBe("open");
    expect([w.seats[0]!.memberId, w.seats[1]!.memberId].map((m) => `human:${m}`)).toContain(t.handler);
    expect(await assigneeIds(w.ctx, room.id)).toEqual([t.handler!.slice(6)]);
    // the same person claiming again is fine, an ended ticket cannot be claimed
    await claimTicket(w.ctx, w.seats.find((s) => `human:${s.memberId}` === t.handler)!, ticket.id);
    await resolveTicket(w.ctx, w.owner, ticket.id);
    await expect(claimTicket(w.ctx, w.seats[0]!, ticket.id)).rejects.toMatchObject({ code: "TICKET_TAKEN" });
  });

  it("claiming needs the ticket to be in your scope", async () => {
    const w = await world({ seats: 1, mode: "manual_pick" });
    const outsider = await addMemberRaw(w.ctx, w.wsId, { name: "Out", inbox_visibility: "assigned" });
    const { ticket } = await ticketIn(w);
    await handoff(w, ticket.id);
    await expect(claimTicket(w.ctx, outsider, ticket.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("idempotency", () => {
  it("handing off twice changes and says nothing the second time", async () => {
    const w = await world({ seats: 2 });
    const { room, ticket } = await ticketIn(w);
    await handoff(w, ticket.id);
    const before = await messagesOf(w.ctx, room.id);
    const evBefore = await events(w, ticket.id);
    const again = await handoff(w, ticket.id);
    expect(again.changed).toBe(false);
    expect((await messagesOf(w.ctx, room.id)).length).toBe(before.length);
    expect((await events(w, ticket.id)).length).toBe(evBefore.length);
    expect(await handlerOf(w, ticket.id)).toBe(`human:${w.seats[0]!.memberId}`);
  });

  it("a queued ticket stays quiet through repeated queue passes while nobody is free", async () => {
    const w = await world({ seats: 1 });
    await updateMember(w.ctx, w.owner, w.seats[0]!.memberId, { availability: "away" });
    const { room, ticket } = await ticketIn(w);
    await handoff(w, ticket.id);
    const n = (await messagesOf(w.ctx, room.id)).length;
    const ev = (await events(w, ticket.id)).length;
    for (let i = 0; i < 3; i++) expect(await drainQueue(w.ctx, w.wsId)).toBe(0);
    expect((await messagesOf(w.ctx, room.id)).length).toBe(n);
    expect((await events(w, ticket.id)).length).toBe(ev);
  });

  it("an ended ticket is not routed", async () => {
    const w = await world({ seats: 1 });
    const { ticket } = await ticketIn(w);
    await resolveTicket(w.ctx, w.owner, ticket.id);
    const r = await handoff(w, ticket.id);
    expect(r.outcome).toBe("ended");
    expect(await handlerOf(w, ticket.id)).toBeNull();
  });
});

describe("seats that go away", () => {
  it("going away hands the unaccepted tickets on (not the ones being worked), coming back drains the queue", async () => {
    const w = await world({ seats: 2 });
    const a = await ticketIn(w);
    const b = await ticketIn(w);
    await handoff(w, a.ticket.id); // Seat A
    await handoff(w, b.ticket.id); // Seat B
    await agentSays(w.ctx, w.seats[0]!, a.room.id, "hello"); // A accepted theirs: open
    expect((await liveTicketOf(w.ctx, a.room.id))!.status).toBe("open");
    await updateMember(w.ctx, w.owner, w.seats[0]!.memberId, { availability: "away" });
    expect(await handlerOf(w, a.ticket.id)).toBe(`human:${w.seats[0]!.memberId}`); // still theirs
    await updateMember(w.ctx, w.owner, w.seats[1]!.memberId, { availability: "away" }); // B leaves with an unaccepted ticket and nobody else is free
    expect(await handlerOf(w, b.ticket.id)).toBeNull();
    expect((await liveTicketOf(w.ctx, b.room.id))!.status).toBe("waiting_for_human");
    expect(await assigneeIds(w.ctx, b.room.id)).toEqual([]);
    const ev = (await events(w, b.ticket.id)).filter((e) => e.type === "queued");
    expect(JSON.parse(ev[ev.length - 1]!.detail)).toMatchObject({ reason: "agent_unavailable", excluded: [w.seats[1]!.memberId] });
    await updateMember(w.ctx, w.owner, w.seats[1]!.memberId, { availability: "active" });
    expect(await handlerOf(w, b.ticket.id)).toBe(`human:${w.seats[1]!.memberId}`);
    expect((await w.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'ticket.reassigned'"))).toBeDefined();
  });

  it("removing a seat hands over everything it had", async () => {
    const w = await world({ seats: 2 });
    const a = await ticketIn(w);
    await handoff(w, a.ticket.id); // Seat A
    await agentSays(w.ctx, w.seats[0]!, a.room.id, "on it");
    expect(await releaseSeatTickets(w.ctx, w.wsId, w.seats[0]!.memberId, "all")).toBe(1);
    expect(await handlerOf(w, a.ticket.id)).toBe(`human:${w.seats[1]!.memberId}`);
    expect((await liveTicketOf(w.ctx, a.room.id))!.status).toBe("waiting_for_human");
  });

  it("the scheduler pass gives waiting tickets to whoever is free", async () => {
    const w = await world({ seats: 1 });
    await w.ctx.db.run("UPDATE members SET availability = 'away' WHERE id = ?", w.seats[0]!.memberId);
    const { ticket } = await ticketIn(w);
    await handoff(w, ticket.id);
    expect(await handlerOf(w, ticket.id)).toBeNull();
    await w.ctx.db.run("UPDATE members SET availability = 'active' WHERE id = ?", w.seats[0]!.memberId);
    await w.ctx.cache.invalidate(`member:${w.wsId}:${w.seats[0]!.memberId}`);
    const out = await tick(w.ctx, { tickets: true });
    expect(out.tickets.assigned).toBe(1);
    expect(await handlerOf(w, ticket.id)).toBe(`human:${w.seats[0]!.memberId}`);
  });
});

describe("service levels", () => {
  it("arms the first-response and resolution times from the department, and escalates a missed first response once", async () => {
    const w = await world({ seats: 2 });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { sla_first_response_s: 300, sla_resolution_s: 3600 });
    const { room, ticket } = await ticketIn(w);
    const t0 = new Date(w.ctx.clock()).getTime();
    expect(Date.parse(ticket.sla_resolution_due_at ?? "")).toBe(t0 + 3600_000); // armed when the ticket opened
    await handoff(w, ticket.id);
    const armed = (await liveTicketOf(w.ctx, room.id))!;
    expect(Date.parse(armed.sla_first_response_due_at!)).toBe(t0 + 300_000);
    expect(armed.handler).toBe(`human:${w.seats[0]!.memberId}`);
    w.ctx.clockCtl.advance(299_000);
    expect(await slaSweep(w.ctx)).toEqual({ escalated: 0, resolution_breaches: 0 });
    w.ctx.clockCtl.advance(2_000);
    expect(await slaSweep(w.ctx)).toEqual({ escalated: 1, resolution_breaches: 0 });
    const t = (await liveTicketOf(w.ctx, room.id))!;
    expect(t.priority).toBe(2);
    expect(t.sla_first_response_breached_at).not.toBeNull();
    expect(t.handler).toBe(`human:${w.seats[1]!.memberId}`); // offered to someone else
    expect(t.reassigned_count).toBe(1);
    expect((await events(w, t.id)).map((e) => e.type)).toContain("sla_breached");
    expect(await slaSweep(w.ctx)).toEqual({ escalated: 0, resolution_breaches: 0 }); // once
    // managers heard about it
    const note = await w.ctx.db.get<{ title: string }>("SELECT title FROM notifications WHERE member_id = ? AND type = 'ticket_sla'", w.owner.memberId);
    expect(note!.title).toContain("Missed first response");
    // a resolution breach is recorded, nothing moves
    w.ctx.clockCtl.advance(3600_000);
    expect(await slaSweep(w.ctx)).toEqual({ escalated: 0, resolution_breaches: 1 });
    expect((await liveTicketOf(w.ctx, room.id))!.handler).toBe(`human:${w.seats[1]!.memberId}`);
  });

  it("a human reply before the deadline means no breach; a ticket without any SLA is never escalated", async () => {
    const w = await world({ seats: 1 });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { sla_first_response_s: 300 });
    const { room, ticket } = await ticketIn(w);
    await handoff(w, ticket.id);
    await agentSays(w.ctx, w.seats[0]!, room.id, "hi");
    w.ctx.clockCtl.advance(3600_000);
    expect((await slaSweep(w.ctx)).escalated).toBe(0);
    const other = await world({ seats: 1 });
    const t = await ticketIn(other);
    await handoff(other, t.ticket.id);
    other.ctx.clockCtl.advance(86400_000);
    expect((await slaSweep(other.ctx)).escalated).toBe(0);
  });

  it("with nobody else to give it to, escalation goes to the overflow department", async () => {
    const w = await world({ seats: 1 });
    const spare = await addMemberRaw(w.ctx, w.wsId, { name: "Spare", inbox_visibility: "assigned" });
    const backup = await mkInbox(w.ctx, w.owner, { name: "Backup", member_ids: [spare.memberId] });
    await updateDepartment(w.ctx, w.owner, backup.id, { routing_mode: "round_robin" });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { sla_first_response_s: 60, overflow_inbox_id: backup.id });
    const { room, ticket } = await ticketIn(w);
    await handoff(w, ticket.id);
    w.ctx.clockCtl.advance(61_000);
    await slaSweep(w.ctx);
    const t = (await liveTicketOf(w.ctx, room.id))!;
    expect(t.department_id).toBe(backup.id);
    expect(t.handler).toBe(`human:${spare.memberId}`);
  });
});

describe("transfer between departments", () => {
  it("routes into the other department, moves the room, leaves a note for the team and tells the visitor", async () => {
    const w = await world({ seats: 1 });
    const bo = await addMemberRaw(w.ctx, w.wsId, { name: "Bo Billing", inbox_visibility: "assigned" });
    const billing = await mkInbox(w.ctx, w.owner, { name: "Billing", member_ids: [bo.memberId] });
    await updateDepartment(w.ctx, w.owner, billing.id, { routing_mode: "round_robin", sla_first_response_s: 120 });
    const { room, ticket } = await ticketIn(w);
    await handoff(w, ticket.id);
    const r = await transferTicket(w.ctx, ticket.id, { to: billing.id, by: { type: "member", id: w.owner.memberId }, note: "refund question" });
    expect(r.outcome).toBe("assigned");
    const t = (await liveTicketOf(w.ctx, room.id))!;
    expect(t).toMatchObject({ department_id: billing.id, handler: `human:${bo.memberId}`, status: "waiting_for_human" });
    expect(Date.parse(t.sla_first_response_due_at!)).toBe(w.ctx.clock().getTime() + 120_000); // the new department's clock
    expect((await getRoomRow(w.ctx, w.wsId, room.id)).inbox_id).toBe(billing.id);
    const msgs = await messagesOf(w.ctx, room.id);
    const note = msgs.filter((m) => m.kind === "note").pop()!;
    expect(note.content_text).toContain("Transferred from Support to Billing.");
    expect(note.content_text).toContain("refund question");
    expect(msgs.filter((m) => m.kind === "text" && m.sender_type === "bot").pop()!.content_text).toContain("Billing team");
    expect((await events(w, t.id)).map((e) => e.type)).toContain("transferred");
    expect(await assigneeIds(w.ctx, room.id)).toEqual([bo.memberId]);
    expect((await w.ctx.db.get("SELECT 1 FROM audit_log WHERE action = 'ticket.transferred'"))).toBeDefined();
  });

  it("refuses an unknown department and an ended ticket", async () => {
    const w = await world({ seats: 1 });
    const { ticket } = await ticketIn(w);
    await expect(transferTicket(w.ctx, ticket.id, { to: "inb_nope", by: { type: "system" } })).rejects.toMatchObject({ code: "UNKNOWN_DEPARTMENT" });
    await resolveTicket(w.ctx, w.owner, ticket.id);
    await expect(transferTicket(w.ctx, ticket.id, { to: w.dept.id, by: { type: "system" } })).rejects.toMatchObject({ code: "TICKET_ENDED" });
  });

  it("over HTTP: needs tickets:write, answers 404 for tickets outside the scope, 422 for a missing department", async () => {
    const w = await world({ seats: 1 });
    const other = await mkInbox(w.ctx, w.owner, { name: "Other" });
    const { ticket } = await ticketIn(w);
    const res = await w.http.post(`/api/tickets/${ticket.id}/transfer`, { department_id: other.id, note: "x" }, w.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: expect.any(String), department_id: other.id });
    expect((await w.http.post(`/api/tickets/${ticket.id}/transfer`, { department_id: "nope" }, w.token)).status).toBe(422);
    const outsider = await addMemberRaw(w.ctx, w.wsId, { name: "Out", inbox_visibility: "assigned" });
    expect((await w.http.post(`/api/tickets/${ticket.id}/transfer`, { department_id: other.id }, await tokenFor(w.ctx, outsider))).status).toBe(404);
    expect((await w.http.post(`/api/tickets/${ticket.id}/claim`, {}, await tokenFor(w.ctx, outsider))).status).toBe(404);
  });
});

describe("what people and visitors are told", () => {
  it("notifies the assignee, or the department and the managers while queued, and emails an offline assignee", async () => {
    const w = await world({ seats: 2 });
    const a = await ticketIn(w);
    await handoff(w, a.ticket.id);
    const mine = await w.ctx.db.all<{ type: string; title: string }>("SELECT type, title FROM notifications WHERE member_id = ? AND type = 'ticket_assigned'", w.seats[0]!.memberId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toContain(`Ticket #${a.ticket.number}`);
    const jobs = await w.ctx.db.all("SELECT 1 FROM jobs WHERE type = 'notify_email'");
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    for (const s of w.seats) await updateMember(w.ctx, w.owner, s.memberId, { availability: "away" });
    const b = await ticketIn(w);
    await handoff(w, b.ticket.id);
    for (const m of [w.seats[0]!, w.seats[1]!, w.owner]) {
      const n = await w.ctx.db.all<{ title: string }>("SELECT title FROM notifications WHERE member_id = ? AND type = 'ticket_queued'", m.memberId);
      expect(n.filter((x) => x.title.includes(`#${b.ticket.number}`)).length, m.name).toBe(1);
    }
  });

  it("the visitor's words follow the outcome: connecting with a typical wait, busy with the queue position, closed", async () => {
    const w = await world({ seats: 1, capacity: 1 });
    // earlier handoffs answered after 2 and 4 minutes: the typical wait is 4 minutes (median of [120, 240] picks the upper middle)
    for (const secs of [120, 240]) {
      const x = await ticketIn(w);
      await handoff(w, x.ticket.id);
      w.ctx.clockCtl.advance(secs * 1000);
      await agentSays(w.ctx, w.seats[0]!, x.room.id, "hi");
      await resolveTicket(w.ctx, w.owner, x.ticket.id);
    }
    const a = await ticketIn(w);
    const ra = await handoff(w, a.ticket.id);
    expect(visitorHandoffText(ra)).toBe("Connecting you with our Support team. Typical wait: about 4 min.");
    const b = await ticketIn(w);
    const rb = await handoff(w, b.ticket.id);
    expect(rb.queue_position).toBe(1);
    expect(visitorHandoffText({ ...rb, queue_position: 3 })).toContain("You are number 3 in the queue.");
    expect(visitorHandoffText(rb)).toContain("Everyone on our Support team is busy right now.");
    const say = (await messagesOf(w.ctx, b.room.id)).filter((m) => m.sender_type === "bot" && m.kind === "text").pop()!;
    expect(say.content_text).toContain("busy right now");
    expect(JSON.parse(say.meta)).toMatchObject({ handoff: true, outcome: "queued", reason: "customer_requested_human" });
    await updateDepartment(w.ctx, w.owner, w.dept.id, { auto_reply_queued: "Please hold." });
    const c = await ticketIn(w);
    expect(visitorHandoffText(await handoff(w, c.ticket.id))).toBe("Please hold.");
  });

  it("the handoff note for the team carries the reason, department, assignee and the caller's summary and never reaches the visitor", async () => {
    const w = await world({ seats: 1 });
    const { room, ticket } = await ticketIn(w);
    await handoff(w, ticket.id, { reason: "sensitive_topic", note: "Customer asks about a chargeback." });
    const note = (await messagesOf(w.ctx, room.id)).filter((m) => m.kind === "note").pop()!;
    expect(note.content_text).toContain("The topic needs a person.");
    expect(note.content_text).toContain("Department: Support");
    expect(note.content_text).toContain("Assigned to: Seat A");
    expect(note.content_text).toContain("chargeback");
    expect(JSON.parse(note.meta).sub_type).toBe("handoff");
  });

  it("a ticket with no department at all is routed across the whole workspace, least busy first", async () => {
    const f = await fullApp();
    await setSettings(f.ctx, f.wsId, { routing: { require_online: false } });
    const a = await addMemberRaw(f.ctx, f.wsId, { name: "Pool A" });
    const w = { ...f, seats: [a], dept: null as never };
    const t1 = await ticketIn(w as never, null);
    const t2 = await ticketIn(w as never, null);
    const r1 = await routeTicket(f.ctx, t1.ticket.id, { reason: "customer_requested_human", by: { type: "system" } });
    const r2 = await routeTicket(f.ctx, t2.ticket.id, { reason: "customer_requested_human", by: { type: "system" } });
    expect([r1.outcome, r2.outcome]).toEqual(["assigned", "assigned"]);
    expect(r1.mode).toBe("pool");
    expect(closeTicket).toBeDefined();
  });
});
