import { describe, expect, it } from "vitest";
import { removeInboxMember, nextRoundRobinAssignee, updateInbox } from "../src/services/inboxes.js";
import { assignRoom, findOrCreateRoom, getRoomDto, rerouteRoom } from "../src/services/rooms.js";
import { removeMember, updateMember } from "../src/services/members.js";
import { addMemberRaw, fullApp, mkContact, mkInbox, mkRoom, tokenFor } from "./helpers.js";

async function rrWorld(n = 3) {
  const f = await fullApp();
  const members = [];
  for (let i = 0; i < n; i++) members.push(await addMemberRaw(f.ctx, f.wsId, { name: `Agent${i}` }));
  const inbox = mkInbox(f.ctx, f.owner, { name: "RR", algorithm: "round_robin", member_ids: members.map((m) => m.memberId) });
  const assigneeOf = (roomId: string) => getRoomDto(f.ctx, f.owner, roomId).assignee_ids[0];
  const newRoom = () => mkRoom(f.ctx, f.wsId, { inboxId: inbox.id }).room.id;
  return { ...f, members, inbox, assigneeOf, newRoom };
}

describe("round robin", () => {
  it("is deterministic: join order, wrapping around", async () => {
    const w = await rrWorld();
    const order = Array.from({ length: 7 }, () => w.assigneeOf(w.newRoom()));
    const ids = w.members.map((m) => m.memberId);
    expect(order).toEqual([ids[0], ids[1], ids[2], ids[0], ids[1], ids[2], ids[0]]);
  });
  it("starts from the first member when no pointer exists and advances after the first pick", async () => {
    const w = await rrWorld();
    expect(w.inbox.last_assigned_member_id).toBeNull();
    const a = w.assigneeOf(w.newRoom());
    expect(a).toBe(w.members[0]!.memberId);
    const row = w.ctx.db.get<{ last_assigned_member_id: string }>("SELECT last_assigned_member_id FROM inboxes WHERE id = ?", w.inbox.id)!;
    expect(row.last_assigned_member_id).toBe(a);
    expect(w.assigneeOf(w.newRoom())).toBe(w.members[1]!.memberId);
  });
  it("a stale last_assigned (member left the inbox) restarts at the first member, then keeps advancing", async () => {
    const w = await rrWorld();
    w.newRoom(); w.newRoom(); // pointer -> member[1]
    removeInboxMember(w.ctx, w.owner, w.inbox.id, w.members[1]!.memberId);
    expect(w.assigneeOf(w.newRoom())).toBe(w.members[0]!.memberId);
    expect(w.assigneeOf(w.newRoom())).toBe(w.members[2]!.memberId);
    expect(w.assigneeOf(w.newRoom())).toBe(w.members[0]!.memberId);
  });
  it("a removed seat that held the pointer is also treated as stale", async () => {
    const w = await rrWorld();
    w.newRoom(); w.newRoom(); w.newRoom(); // pointer -> member[2]
    removeMember(w.ctx, w.owner, w.members[2]!.memberId, () => {});
    expect(w.assigneeOf(w.newRoom())).toBe(w.members[0]!.memberId);
  });
  it("skips inactive seats and seats without a live seat; nobody eligible means unassigned", async () => {
    const w = await rrWorld();
    updateMember(w.ctx, w.owner, w.members[0]!.memberId, { availability: "inactive" });
    updateMember(w.ctx, w.owner, w.members[1]!.memberId, { live_seat: false });
    for (let i = 0; i < 3; i++) expect(w.assigneeOf(w.newRoom())).toBe(w.members[2]!.memberId);
    updateMember(w.ctx, w.owner, w.members[2]!.memberId, { availability: "inactive" });
    expect(w.assigneeOf(w.newRoom())).toBeUndefined();
  });
  it("away seats still receive work", async () => {
    const w = await rrWorld(2);
    updateMember(w.ctx, w.owner, w.members[0]!.memberId, { availability: "away" });
    expect(w.assigneeOf(w.newRoom())).toBe(w.members[0]!.memberId);
  });
  it("hands out turns exactly once under concurrent assignment", async () => {
    const w = await rrWorld();
    const picks = await Promise.all(Array.from({ length: 9 }, async () => w.assigneeOf(w.newRoom())));
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p!, (counts.get(p!) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3]);
    const parallelAuto = await Promise.all(Array.from({ length: 6 }, async () => {
      const room = mkRoom(w.ctx, w.wsId, { inboxId: w.inbox.id }).room;
      return nextRoundRobinAssignee(w.ctx, w.inbox.id) ?? room.id;
    }));
    expect(new Set(parallelAuto).size).toBe(3);
  });
  it("the pick and pointer move atomically with the room insert: a failing insert does not burn a turn", async () => {
    const w = await rrWorld();
    const c = mkContact(w.ctx, w.wsId);
    expect(() => findOrCreateRoom(w.ctx, w.wsId, { contactId: c.id, inboxId: "inb_missing" })).toThrow(/Inbox/);
    expect(w.assigneeOf(w.newRoom())).toBe(w.members[0]!.memberId);
  });
  it("manual inboxes never auto-assign; explicit auto assignment needs a round-robin inbox", async () => {
    const w = await fullApp();
    const a = await addMemberRaw(w.ctx, w.wsId, { name: "A" });
    const manual = mkInbox(w.ctx, w.owner, { name: "Manual", member_ids: [a.memberId] });
    const { room } = mkRoom(w.ctx, w.wsId, { inboxId: manual.id });
    expect(getRoomDto(w.ctx, w.owner, room.id).assignee_ids).toEqual([]);
    expect(() => assignRoom(w.ctx, w.owner, room.id, { auto: true })).toThrow(/no eligible/i);
    updateInbox(w.ctx, w.owner, manual.id, { algorithm: "round_robin" });
    assignRoom(w.ctx, w.owner, room.id, { auto: true });
    expect(getRoomDto(w.ctx, w.owner, room.id).assignee_ids).toEqual([a.memberId]);
    const noInbox = mkRoom(w.ctx, w.wsId).room;
    expect(() => assignRoom(w.ctx, w.owner, noInbox.id, { auto: true })).toThrow(/no inbox/i);
  });
  it("re-routes a removed seat's rooms to the next member (round robin) or leaves them unassigned (manual)", async () => {
    const w = await rrWorld();
    const roomId = w.newRoom(); // -> member[0]
    removeMember(w.ctx, w.owner, w.members[0]!.memberId, (id) => rerouteRoom(w.ctx, id));
    expect(w.assigneeOf(roomId)).toBe(w.members[1]!.memberId);
    const f = await fullApp();
    const a = await addMemberRaw(f.ctx, f.wsId, { name: "A" });
    const manual = mkInbox(f.ctx, f.owner, { member_ids: [a.memberId] });
    const { room } = mkRoom(f.ctx, f.wsId, { inboxId: manual.id, assignees: [a] });
    removeMember(f.ctx, f.owner, a.memberId, (id) => rerouteRoom(f.ctx, id));
    expect(getRoomDto(f.ctx, f.owner, room.id).assignee_ids).toEqual([]);
  });
});

describe("inbox management", () => {
  it("restricts management to owners/managers and hides foreign inboxes from agents", async () => {
    const { ctx, wsId, owner, http } = await fullApp();
    const agent = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const at = await tokenFor(ctx, agent);
    expect((await http.post("/api/inboxes", { name: "X" }, at)).status).toBe(403);
    const mine = mkInbox(ctx, owner, { name: "Mine", member_ids: [agent.memberId] });
    mkInbox(ctx, owner, { name: "Hidden" });
    expect((await http.get("/api/inboxes", at)).body.data.map((i: any) => i.id)).toEqual([mine.id]);
    expect((await http.patch(`/api/inboxes/${mine.id}`, { name: "Renamed" }, at)).status).toBe(403);
    expect((await http.del(`/api/inboxes/${mine.id}`, at)).status).toBe(403);
  });
  it("keeps one default inbound inbox per channel and validates members", async () => {
    const { ctx, owner, http, token } = await fullApp();
    const a = mkInbox(ctx, owner, { name: "A", default_email_inbound: true, default_sms_inbound: true });
    const b = mkInbox(ctx, owner, { name: "B", default_email_inbound: true });
    const list = (await http.get("/api/inboxes", token)).body.data;
    expect(list.find((i: any) => i.id === a.id)).toMatchObject({ default_email_inbound: false, default_sms_inbound: true });
    expect(list.find((i: any) => i.id === b.id).default_email_inbound).toBe(true);
    expect((await http.post("/api/inboxes", { name: "Bad", member_ids: ["mem_nope"] }, token)).body.error.code).toBe("UNKNOWN_MEMBER");
  });
  it("deleting an inbox keeps rooms (inbox cleared) and emits events; members can be added/removed over HTTP", async () => {
    const { ctx, wsId, owner, http, token } = await fullApp();
    const a = await addMemberRaw(ctx, wsId, { name: "A" });
    const inbox = mkInbox(ctx, owner, { name: "Gone" });
    const { room } = mkRoom(ctx, wsId, { inboxId: inbox.id });
    expect((await http.post(`/api/inboxes/${inbox.id}/members/${a.memberId}`, {}, token)).body.member_ids).toEqual([a.memberId]);
    expect((await http.del(`/api/inboxes/${inbox.id}/members/${a.memberId}`, token)).body.member_ids).toEqual([]);
    expect((await http.del(`/api/inboxes/${inbox.id}`, token)).status).toBe(204);
    expect(getRoomDto(ctx, owner, room.id).inbox_id).toBeNull();
    expect(ctx.bus.ofType("inbox:new").length).toBe(1);
    expect(ctx.bus.ofType("inbox:updated").length).toBeGreaterThan(0);
  });
});
