import { describe, expect, it } from "vitest";
import { addMemberRaw, fullApp, mkInbox, tokenFor } from "./helpers.js";
import { departmentNextOpening, departmentOpenAt, effectiveMode, getDepartment, listDepartments, parseHours, updateDepartment, departmentStatus } from "../src/services/departments.js";
import { getInbox } from "../src/services/inboxes.js";
import { zonedDate, addDays } from "../src/util/time.js";

const hours = (over: object = {}) => parseHours(JSON.stringify({ enabled: true, timezone: "Europe/Berlin", days: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), ...over }));
const at = (iso: string) => new Date(iso);

describe("department hours", () => {
  // 2026-03-02 is a Monday; Berlin is UTC+1 in early March
  it("is open from the start minute up to, not including, the end minute", () => {
    const h = hours();
    expect(departmentOpenAt(h, at("2026-03-02T07:59:00Z"))).toBe(false); // 08:59 local
    expect(departmentOpenAt(h, at("2026-03-02T08:00:00Z"))).toBe(true); // 09:00 local
    expect(departmentOpenAt(h, at("2026-03-02T15:59:00Z"))).toBe(true); // 16:59
    expect(departmentOpenAt(h, at("2026-03-02T16:00:00Z"))).toBe(false); // 17:00
    expect(departmentOpenAt(h, at("2026-03-07T12:00:00Z"))).toBe(false); // Saturday
  });

  it("follows the time zone and daylight saving (Berlin switches to +2 on 2026-03-29)", () => {
    const h = hours();
    expect(departmentOpenAt(h, at("2026-03-30T06:59:00Z"))).toBe(false); // Monday 08:59 at +2
    expect(departmentOpenAt(h, at("2026-03-30T07:00:00Z"))).toBe(true); // 09:00 at +2
    const tokyo = hours({ timezone: "Asia/Tokyo" });
    expect(departmentOpenAt(tokyo, at("2026-03-02T00:00:00Z"))).toBe(true); // Monday 09:00 in Tokyo
    expect(departmentOpenAt(tokyo, at("2026-03-01T23:59:00Z"))).toBe(false); // 08:59
  });

  it("a holiday closes the whole local day, whatever the schedule, and is judged in the department's own zone", () => {
    const h = hours({ holidays: ["2026-03-02"] });
    expect(departmentOpenAt(h, at("2026-03-02T10:00:00Z"))).toBe(false);
    expect(departmentOpenAt(h, at("2026-03-03T10:00:00Z"))).toBe(true);
    const tokyo = hours({ timezone: "Asia/Tokyo", holidays: ["2026-03-03"] });
    // 2026-03-02T16:00Z is already March 3 in Tokyo (01:00) but a Monday evening in UTC
    expect(zonedDate(at("2026-03-02T16:00:00Z"), "Asia/Tokyo")).toBe("2026-03-03");
    expect(departmentOpenAt(tokyo, at("2026-03-03T01:00:00Z"))).toBe(false);
  });

  it("with no schedule the department is always open, except on holidays", () => {
    const h = parseHours(JSON.stringify({ enabled: false, holidays: ["2026-12-25"] }));
    expect(departmentOpenAt(h, at("2026-12-24T12:00:00Z"))).toBe(true);
    expect(departmentOpenAt(h, at("2026-12-25T12:00:00Z"))).toBe(false);
    expect(departmentNextOpening(h, at("2026-12-25T12:00:00Z"))).toBe("tomorrow");
    expect(departmentOpenAt(parseHours(""), at("2026-12-25T12:00:00Z"))).toBe(true);
    expect(departmentOpenAt(parseHours("not json"), at("2026-12-25T12:00:00Z"))).toBe(true);
  });

  it("names the next opening and skips holidays", () => {
    const h = hours({ holidays: ["2026-03-03"] });
    expect(departmentNextOpening(h, at("2026-03-02T18:00:00Z"))).toBe("Wednesday at 09:00 (Europe/Berlin)"); // Tuesday is a holiday
    expect(departmentNextOpening(hours(), at("2026-03-02T18:00:00Z"))).toBe("tomorrow at 09:00 (Europe/Berlin)");
    expect(departmentNextOpening(hours(), at("2026-03-02T06:00:00Z"))).toBe("today at 09:00 (Europe/Berlin)");
    expect(departmentNextOpening(hours({ days: [] }), at("2026-03-02T06:00:00Z"))).toBeNull();
    expect(addDays("2026-02-28", 2)).toBe("2026-03-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("routing mode inheritance", () => {
  it("an unconfigured inbox keeps its old behaviour", () => {
    expect(effectiveMode({ routing_mode: null, algorithm: "round_robin" })).toBe("round_robin");
    expect(effectiveMode({ routing_mode: null, algorithm: "manual" })).toBe("manual_pick");
    expect(effectiveMode({ routing_mode: "least_busy", algorithm: "manual" })).toBe("least_busy");
  });
});

describe("configuring departments", () => {
  it("lists every inbox with its configuration, members and live status", async () => {
    const f = await fullApp();
    const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann" });
    const d = await mkInbox(f.ctx, f.owner, { name: "Billing", member_ids: [ann.memberId] });
    const list = await listDepartments(f.ctx, f.owner);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: d.id, name: "Billing", effective_routing_mode: "manual_pick", capacity: 0, sla_first_response_s: null, hours: { enabled: false, holidays: [] } });
    expect(list[0]!.members).toEqual([{ member_id: ann.memberId, name: "Ann", skills: [], languages: [], capacity: null }]);
    expect(list[0]!.status).toMatchObject({ open: true, queue_length: 0, available_agents: 0 }); // nobody is connected
  });

  it("saves every field, member skills and capacity, and writes an audit entry", async () => {
    const f = await fullApp();
    const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann" });
    const bo = await addMemberRaw(f.ctx, f.wsId, { name: "Bo" });
    const d = await mkInbox(f.ctx, f.owner, { name: "Support", member_ids: [ann.memberId, bo.memberId] });
    const fallback = await mkInbox(f.ctx, f.owner, { name: "Fallback" });
    const out = await updateDepartment(f.ctx, f.owner, d.id, {
      description: " Technical questions ",
      routing_mode: "skills_based",
      capacity: 4,
      hours: { enabled: true, timezone: "Europe/Berlin", days: [{ day: 1, start: "09:00", end: "17:00" }], holidays: ["2026-12-25"] },
      sla_first_response_s: 300,
      sla_resolution_s: 86400,
      overflow_inbox_id: fallback.id,
      auto_reply_closed: "We are closed",
      auto_reply_queued: "Hang on",
      live_routing_visibility: true,
      members: [{ member_id: ann.memberId, skills: ["billing", "billing", "api"], languages: ["DE", "en-gb"], capacity: 2 }],
    });
    expect(out).toMatchObject({ description: "Technical questions", routing_mode: "skills_based", effective_routing_mode: "skills_based", capacity: 4, sla_first_response_s: 300, sla_resolution_s: 86400, overflow_inbox_id: fallback.id, live_routing_visibility: true });
    expect(out.members.find((m) => m.member_id === ann.memberId)).toMatchObject({ skills: ["billing", "api"], languages: ["de", "en-gb"], capacity: 2 });
    expect(out.members.find((m) => m.member_id === bo.memberId)).toMatchObject({ skills: [], capacity: null });
    expect((await getInbox(f.ctx, f.wsId, d.id)).routing_mode).toBe("skills_based");
    const audit = await f.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'department.updated'");
    expect(JSON.parse(audit!.detail).fields).toContain("hours");
    // `null` goes back to following the inbox's algorithm, and a clear of the SLA is allowed
    const back = await updateDepartment(f.ctx, f.owner, d.id, { routing_mode: null, sla_first_response_s: null, overflow_inbox_id: null });
    expect(back).toMatchObject({ routing_mode: null, effective_routing_mode: "manual_pick", sla_first_response_s: null, overflow_inbox_id: null });
  });

  it("refuses overflow loops (self, direct, long chain), unknown departments, strangers as members and bad values", async () => {
    const f = await fullApp();
    const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann" });
    const a = await mkInbox(f.ctx, f.owner, { name: "A" });
    const b = await mkInbox(f.ctx, f.owner, { name: "B", member_ids: [ann.memberId] });
    const c = await mkInbox(f.ctx, f.owner, { name: "C" });
    await expect(updateDepartment(f.ctx, f.owner, a.id, { overflow_inbox_id: a.id })).rejects.toMatchObject({ code: "OVERFLOW_LOOP" });
    await updateDepartment(f.ctx, f.owner, a.id, { overflow_inbox_id: b.id });
    await updateDepartment(f.ctx, f.owner, b.id, { overflow_inbox_id: c.id });
    await expect(updateDepartment(f.ctx, f.owner, c.id, { overflow_inbox_id: a.id })).rejects.toMatchObject({ code: "OVERFLOW_LOOP" });
    await expect(updateDepartment(f.ctx, f.owner, a.id, { overflow_inbox_id: "inb_missing" })).rejects.toMatchObject({ code: "UNKNOWN_DEPARTMENT" });
    await expect(updateDepartment(f.ctx, f.owner, a.id, { members: [{ member_id: ann.memberId, skills: ["x"] }] })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    for (const bad of [{ capacity: -1 }, { capacity: 1000 }, { sla_first_response_s: 5 }, { hours: { holidays: ["25/12/2026"] } }, { routing_mode: "random" }, { members: [{ member_id: ann.memberId, languages: ["not a code!"] }] }]) {
      const r = await f.http.patch(`/api/departments/${b.id}`, bad, f.token);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("needs departments:manage (managers and owners), 404 across workspaces, and the status list is for any seat with tickets:read, across all departments", async () => {
    const f = await fullApp();
    const other = await fullApp();
    const d = await mkInbox(f.ctx, f.owner, { name: "Sales", member_ids: [] });
    const agent = await addMemberRaw(f.ctx, f.wsId, { name: "Ann", role: "agent" });
    const manager = await addMemberRaw(f.ctx, f.wsId, { name: "Mia", role: "manager" });
    const at = await tokenFor(f.ctx, agent);
    const mt = await tokenFor(f.ctx, manager);
    expect((await f.http.get("/api/departments", at)).status).toBe(403);
    expect((await f.http.patch(`/api/departments/${d.id}`, { description: "x" }, at)).status).toBe(403);
    expect((await f.http.get("/api/departments", mt)).status).toBe(200);
    expect((await f.http.patch(`/api/departments/${d.id}`, { description: "x" }, mt)).body.description).toBe("x");
    expect((await other.http.get(`/api/departments/${d.id}`, await tokenFor(other.ctx, other.owner))).status).toBe(404);
    expect((await other.http.patch(`/api/departments/${d.id}`, { description: "y" }, await tokenFor(other.ctx, other.owner))).status).toBe(404);
    // the status list is names and counts for every department, also for an agent who is in none of them (the transfer menu needs it)
    const st = (await f.http.get("/api/department-status", at)).body.data;
    expect(st).toEqual([expect.objectContaining({ id: d.id, name: "Sales", open: true, available_agents: 0, queue_length: 0 })]);
    expect((await other.http.get("/api/department-status", await tokenFor(other.ctx, other.owner))).body.data).toEqual([]);
    expect((await departmentStatus(f.ctx, await getInbox(f.ctx, f.wsId, d.id))).queue_length).toBe(0);
    expect((await getDepartment(f.ctx, f.owner, d.id)).id).toBe(d.id);
  });
});
