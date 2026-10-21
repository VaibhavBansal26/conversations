import { describe, expect, it } from "vitest";
import { createInbox } from "../src/services/inboxes.js";
import { updateDepartment } from "../src/services/departments.js";
import { claimTicket, handoffTicket } from "../src/services/routing.js";
import { liveTicketOf } from "../src/services/tickets.js";
import { addMemberRaw, contactSays, fullApp, mkRoom, setSettings } from "./helpers.js";

async function setup(seats: number, capacity: number, mode: "round_robin" | "least_busy" = "least_busy") {
  const f = await fullApp();
  await setSettings(f.ctx, f.wsId, { routing: { require_online: false } });
  const people = [];
  for (let i = 0; i < seats; i++) people.push(await addMemberRaw(f.ctx, f.wsId, { name: `Seat ${i}`, inbox_visibility: "assigned_inbox" }));
  const dept = await createInbox(f.ctx, f.owner, { name: "Support", member_ids: people.map((p) => p.memberId) });
  await updateDepartment(f.ctx, f.owner, dept.id, { routing_mode: mode, capacity });
  return { ...f, people, dept };
}
async function tickets(w: Awaited<ReturnType<typeof setup>>, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const { room } = await mkRoom(w.ctx, w.wsId, { inboxId: w.dept.id });
    await contactSays(w.ctx, room, `help ${i}`);
    out.push((await liveTicketOf(w.ctx, room.id))!);
  }
  return out;
}
const hand = (w: Awaited<ReturnType<typeof setup>>, id: string) => handoffTicket(w.ctx, id, { reason: "customer_requested_human", by: { type: "system" } });

describe("handoffs at the same moment", () => {
  it("two handoffs for a department with one free slot: exactly one is assigned, the other queued", async () => {
    const w = await setup(1, 1);
    const [a, b] = await tickets(w, 2);
    const [ra, rb] = await Promise.all([hand(w, a!.id), hand(w, b!.id)]);
    expect([ra.outcome, rb.outcome].sort()).toEqual(["assigned", "queued"]);
    const load = (await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE handler = ?", `human:${w.people[0]!.memberId}`))!.n;
    expect(load).toBe(1);
  });

  it("20 handoffs across 3 seats with capacity 5: no seat above 5, 15 assigned, 5 queued, every ticket handled once", async () => {
    const w = await setup(3, 5);
    const ts = await tickets(w, 20);
    const results = await Promise.all(ts.map((t) => hand(w, t.id)));
    expect(results.filter((r) => r.outcome === "assigned")).toHaveLength(15);
    expect(results.filter((r) => r.outcome === "queued")).toHaveLength(5);
    const loads = await w.ctx.db.all<{ handler: string; n: number }>("SELECT handler, COUNT(*) AS n FROM tickets WHERE handler IS NOT NULL GROUP BY handler");
    expect(loads).toHaveLength(3);
    for (const l of loads) expect(Number(l.n)).toBe(5); // least busy keeps them level
    const routed = await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ticket_events WHERE type = 'routed'");
    expect(Number(routed!.n)).toBe(15);
    expect(Number((await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE status = 'waiting_for_human' AND handler IS NULL"))!.n)).toBe(5);
  });

  it("round robin under load hands each seat the same number of tickets", async () => {
    const w = await setup(3, 0, "round_robin");
    const ts = await tickets(w, 12);
    await Promise.all(ts.map((t) => hand(w, t.id)));
    const loads = await w.ctx.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE handler IS NOT NULL GROUP BY handler");
    expect(loads.map((l) => Number(l.n))).toEqual([4, 4, 4]);
  });

  it("the same ticket handed off many times at once is assigned once and explained once", async () => {
    const w = await setup(3, 0);
    const [t] = await tickets(w, 1);
    const rs = await Promise.all(Array.from({ length: 6 }, () => hand(w, t!.id)));
    expect(rs.filter((r) => r.changed)).toHaveLength(1);
    expect(Number((await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ? AND type = 'handoff'", t!.id))!.n)).toBe(1);
    expect(Number((await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_assignees WHERE room_id = ?", t!.room_id))!.n)).toBe(1);
  });

  it("claims racing for one ticket: one winner", async () => {
    const w = await setup(4, 0);
    const [t] = await tickets(w, 1);
    const rs = await Promise.allSettled(w.people.map((p) => claimTicket(w.ctx, p, t!.id)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Number((await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_assignees WHERE room_id = ?", t!.room_id))!.n)).toBe(1);
  });

  it("a seat in two departments is never pushed over its capacity by handoffs into both at once", async () => {
    const f = await fullApp();
    await setSettings(f.ctx, f.wsId, { routing: { require_online: false } });
    const shared = await addMemberRaw(f.ctx, f.wsId, { name: "Shared", inbox_visibility: "assigned" });
    const d1 = await createInbox(f.ctx, f.owner, { name: "One", member_ids: [shared.memberId] });
    const d2 = await createInbox(f.ctx, f.owner, { name: "Two", member_ids: [shared.memberId] });
    await updateDepartment(f.ctx, f.owner, d1.id, { routing_mode: "least_busy", capacity: 3 });
    await updateDepartment(f.ctx, f.owner, d2.id, { routing_mode: "least_busy", capacity: 3 });
    const made = [];
    for (const [i, d] of [d1, d2, d1, d2, d1, d2, d1, d2].entries()) {
      const { room } = await mkRoom(f.ctx, f.wsId, { inboxId: d.id });
      await contactSays(f.ctx, room, `q${i}`);
      made.push((await liveTicketOf(f.ctx, room.id))!);
    }
    await Promise.all(made.map((t) => handoffTicket(f.ctx, t.id, { reason: "customer_requested_human", by: { type: "system" } })));
    const mine = await f.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE handler = ?", `human:${shared.memberId}`);
    // each department allows 3, and the load is counted across departments: the seat may reach 3 in total per department rule but never exceeds 3 here
    expect(Number(mine!.n)).toBeLessThanOrEqual(3);
  });
});
