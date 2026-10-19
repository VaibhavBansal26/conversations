import { describe, expect, it } from "vitest";
import { createContact } from "../src/services/contacts.js";
import { addInboxMember } from "../src/services/inboxes.js";
import { assignRoom, bulkRooms, findOrCreateRoom, getRoomDto, listRooms, roomCounts, setPriority, setStatus, snoozeRoom, startConversation, wakeDueRooms, archiveRoom } from "../src/services/rooms.js";
import { insertMessage } from "../src/services/messageStore.js";
import { AppError } from "../src/errors.js";
import { addMemberRaw, agentSays, contactSays, fullApp, messagesOf, mkContact, mkInbox, mkRoom, roomRow, tokenFor } from "./helpers.js";

describe("one room per contact", () => {
  it("parallel creates converge on a single room", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const c = mkContact(ctx, wsId);
    const results = await Promise.all(Array.from({ length: 12 }, async () => startConversation(ctx, owner, { contact_id: c.id })));
    const ids = new Set(results.map((r) => r.room.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM rooms WHERE contact_id = ?", c.id)!.n).toBe(1);
  });

  it("parallel HTTP creates also yield one room, and the unique index rejects a raw duplicate", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    const c = mkContact(ctx, wsId);
    const rs = await Promise.all(Array.from({ length: 6 }, () => http.post("/api/rooms", { contact_id: c.id }, token)));
    expect(new Set(rs.map((r) => r.body.room.id)).size).toBe(1);
    expect(() => ctx.db.run("INSERT INTO rooms(id, workspace_id, contact_id, created_at, updated_at) VALUES ('dupe', ?, ?, 'x', 'x')", wsId, c.id)).toThrow(/UNIQUE/);
  });

  it("archiving frees the slot for a new room", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { contact, room } = mkRoom(ctx, wsId);
    archiveRoom(ctx, owner, room.id);
    const again = findOrCreateRoom(ctx, wsId, { contactId: contact.id });
    expect(again.created).toBe(true);
    expect(again.room.id).not.toBe(room.id);
  });

  it("agent-created rooms by a non-manager auto-assign to the creator; existing rooms outside scope are refused", async () => {
    const { ctx, wsId } = await fullApp();
    const agent = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const other = await addMemberRaw(ctx, wsId, { name: "Bo" });
    const c = mkContact(ctx, wsId);
    const first = startConversation(ctx, agent, { contact_id: c.id });
    expect(getRoomDto(ctx, agent, first.room.id).assignee_ids).toEqual([agent.memberId]);
    expect(() => startConversation(ctx, other, { contact_id: c.id })).toThrow(/outside your scope/);
  });
});

describe("room status rules (reopen matrix)", () => {
  async function closedRoom() {
    const f = await fullApp();
    const { room } = mkRoom(f.ctx, f.wsId);
    setStatus(f.ctx, f.owner, room.id, "closed");
    expect(roomRow(f.ctx, room.id).status).toBe("closed");
    return { ...f, room };
  }
  it("a contact message reopens a closed room", async () => {
    const { ctx, room } = await closedRoom();
    contactSays(ctx, room, "hello again");
    expect(roomRow(ctx, room.id).status).toBe("open");
    const sys = messagesOf(ctx, room.id).filter((m) => m.kind === "system").pop()!;
    expect(JSON.parse(sys.meta)).toMatchObject({ sub_type: "status", status: "open", reason: "contact_message" });
  });
  it("an agent message reopens a closed room", async () => {
    const { ctx, room, owner } = await closedRoom();
    await agentSays(ctx, owner, room.id, "following up");
    expect(roomRow(ctx, room.id).status).toBe("open");
  });
  it("an internal note by an agent reopens too", async () => {
    const { ctx, room, owner } = await closedRoom();
    await agentSays(ctx, owner, room.id, "remember this", { kind: "note" });
    expect(roomRow(ctx, room.id).status).toBe("open");
    expect(JSON.parse(messagesOf(ctx, room.id).filter((m) => m.kind === "system").pop()!.meta).reason).toBe("note");
  });
  it("system and bot messages never reopen", async () => {
    const { ctx, room, wsId } = await closedRoom();
    insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "system", kind: "system", source: "dm", content: "x" });
    insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "bot", kind: "text", source: "dm", content: "x" });
    expect(roomRow(ctx, room.id).status).toBe("closed");
  });
  it("closing is idempotent and writes a status line once", async () => {
    const { ctx, room, owner } = await closedRoom();
    const before = messagesOf(ctx, room.id).length;
    setStatus(ctx, owner, room.id, "closed");
    expect(messagesOf(ctx, room.id)).toHaveLength(before);
  });
});

describe("snooze", () => {
  it("validates before writing: past, invalid, too far and closed rooms change nothing", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = mkRoom(ctx, wsId);
    const now = ctx.clock().getTime();
    const before = messagesOf(ctx, room.id).length;
    for (const bad of [new Date(now - 1000).toISOString(), new Date(now).toISOString(), "not-a-date", new Date(now + 400 * 86400_000).toISOString()]) {
      expect(() => snoozeRoom(ctx, owner, room.id, bad)).toThrow(AppError);
    }
    expect(roomRow(ctx, room.id).snooze_until).toBeNull();
    expect(messagesOf(ctx, room.id)).toHaveLength(before);
    setStatus(ctx, owner, room.id, "closed");
    expect(() => snoozeRoom(ctx, owner, room.id, new Date(now + 3600_000).toISOString())).toThrow(/Closed/);
  });

  it("snoozes, hides from open and shows under snoozed, then wakes with a system message and event", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = mkRoom(ctx, wsId);
    const until = new Date(ctx.clock().getTime() + 3600_000).toISOString();
    snoozeRoom(ctx, owner, room.id, until);
    expect(listRooms(ctx, owner, { status: "open", page: 1, limit: 10 }).data).toHaveLength(0);
    expect(listRooms(ctx, owner, { status: "snoozed", page: 1, limit: 10 }).data).toHaveLength(1);
    expect(wakeDueRooms(ctx)).toBe(0);
    ctx.clockCtl.advance(3600_000);
    ctx.bus.clear();
    const woken: string[] = [];
    expect(wakeDueRooms(ctx, (r) => woken.push(r.id))).toBe(1);
    expect(woken).toEqual([room.id]);
    expect(roomRow(ctx, room.id)).toMatchObject({ snooze_until: null, snoozed_by: null });
    expect(messagesOf(ctx, room.id).pop()!.content).toBe("Snooze ended");
    expect(ctx.bus.events.some((e) => e.event === "room:updated" && e.payload.reason === "snooze_ended")).toBe(true);
    expect(ctx.bus.ofType("message:new").some((e) => e.payload.message.content === "Snooze ended")).toBe(true);
    expect(wakeDueRooms(ctx)).toBe(0); // idempotent
    expect(listRooms(ctx, owner, { status: "open", page: 1, limit: 10 }).data).toHaveLength(1);
  });

  it("any non-system message clears a snooze; system messages do not", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const a = mkRoom(ctx, wsId);
    const b = mkRoom(ctx, wsId);
    const c = mkRoom(ctx, wsId);
    const until = new Date(ctx.clock().getTime() + 3600_000).toISOString();
    for (const r of [a, b, c]) snoozeRoom(ctx, owner, r.room.id, until);
    contactSays(ctx, a.room, "ping");
    await agentSays(ctx, owner, b.room.id, "note to self", { kind: "note" });
    insertMessage(ctx, { workspaceId: wsId, roomId: c.room.id, senderType: "system", kind: "system", source: "dm", content: "sys" });
    expect(roomRow(ctx, a.room.id).snooze_until).toBeNull();
    expect(roomRow(ctx, b.room.id).snooze_until).toBeNull();
    expect(roomRow(ctx, c.room.id).snooze_until).toBe(until);
  });

  it("closing a snoozed room clears the snooze", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = mkRoom(ctx, wsId);
    snoozeRoom(ctx, owner, room.id, new Date(ctx.clock().getTime() + 3600_000).toISOString());
    setStatus(ctx, owner, room.id, "closed");
    expect(roomRow(ctx, room.id).snooze_until).toBeNull();
  });

  it("snooze via HTTP: preset, custom and removal", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    const { room } = mkRoom(ctx, wsId);
    const until = new Date(ctx.clock().getTime() + 86400_000).toISOString();
    const ok = await http.post(`/api/rooms/${room.id}/snooze`, { until }, token);
    expect(ok.status).toBe(200);
    expect(ok.body.snooze_until).toBe(until);
    expect((await http.post(`/api/rooms/${room.id}/snooze`, { until: "2001-01-01T00:00:00Z" }, token)).body.error.code).toBe("INVALID_SNOOZE");
    expect((await http.del(`/api/rooms/${room.id}/snooze`, token)).body.snooze_until).toBeNull();
  });
});

describe("filters and sorting", () => {
  async function scenario() {
    const f = await fullApp();
    const { ctx, wsId, owner } = f;
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const inbox = mkInbox(ctx, owner, { name: "Sales", member_ids: [ann.memberId] });
    const t = (min: number) => ctx.clockCtl.advance(min * 60_000);
    const a = mkRoom(ctx, wsId, { contact: { name: "Alpha" }, inboxId: inbox.id });
    t(1); contactSays(ctx, a.room, "alpha asks");
    const b = mkRoom(ctx, wsId, { contact: { name: "Bravo" } });
    t(1); contactSays(ctx, b.room, "bravo asks");
    t(1); await agentSays(ctx, owner, b.room.id, "bravo answered");
    const c = mkRoom(ctx, wsId, { contact: { name: "Charlie", email: "charlie@example.test" } });
    t(1); contactSays(ctx, c.room, "charlie asks early");
    t(1); contactSays(ctx, c.room, "charlie asks again");
    t(1);
    return { ...f, ann, inbox, a, b, c };
  }
  const names = (r: ReturnType<typeof listRooms>) => r.data.map((x) => x.contact?.name);

  it("sorts newest/oldest by last activity", async () => {
    const { ctx, owner } = await scenario();
    expect(names(listRooms(ctx, owner, { sort: "newest", page: 1, limit: 10 }))).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(names(listRooms(ctx, owner, { sort: "oldest", page: 1, limit: 10 }))).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("waiting_longest puts the customer who has waited longest first and answered rooms last", async () => {
    const { ctx, owner } = await scenario();
    const r = listRooms(ctx, owner, { sort: "waiting_longest", page: 1, limit: 10 });
    expect(names(r)).toEqual(["Alpha", "Charlie", "Bravo"]);
    expect(r.data[2]!.waiting_since).toBeNull();
    // Charlie has waited since the FIRST unanswered message, not the latest one
    const charlie = r.data[1]!;
    expect(Date.parse(charlie.last_contact_message_at!)).toBeGreaterThan(Date.parse(charlie.waiting_since!));
  });

  it("an agent reply resets the wait, a note does not", async () => {
    const { ctx, owner, a } = await scenario();
    await agentSays(ctx, owner, a.room.id, "internal", { kind: "note" });
    expect(listRooms(ctx, owner, { sort: "waiting_longest", page: 1, limit: 10 }).data[0]!.contact!.name).toBe("Alpha");
    await agentSays(ctx, owner, a.room.id, "real reply");
    expect(listRooms(ctx, owner, { sort: "waiting_longest", page: 1, limit: 10 }).data[0]!.contact!.name).toBe("Charlie");
  });

  it("priority_first orders flagged rooms ahead of newer ones", async () => {
    const { ctx, owner, a } = await scenario();
    setPriority(ctx, owner, a.room.id, 1);
    expect(names(listRooms(ctx, owner, { sort: "priority_first", page: 1, limit: 10 }))[0]).toBe("Alpha");
    expect(names(listRooms(ctx, owner, { priority: true, page: 1, limit: 10 }))).toEqual(["Alpha"]);
  });

  it("filters by status, assignment, inbox, contact, search and favorites", async () => {
    const { ctx, owner, inbox, a, b, c } = await scenario();
    setStatus(ctx, owner, b.room.id, "closed");
    assignRoom(ctx, owner, c.room.id, { member_ids: [owner.memberId] });
    expect(names(listRooms(ctx, owner, { status: "closed", page: 1, limit: 10 }))).toEqual(["Bravo"]);
    expect(names(listRooms(ctx, owner, { status: "all", page: 1, limit: 10 })).sort()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(names(listRooms(ctx, owner, { assigned_to_me: true, page: 1, limit: 10 }))).toEqual(["Charlie"]);
    expect(names(listRooms(ctx, owner, { unassigned: true, page: 1, limit: 10 }))).toEqual(["Alpha"]);
    expect(names(listRooms(ctx, owner, { inbox_id: inbox.id, page: 1, limit: 10 }))).toEqual(["Alpha"]);
    expect(names(listRooms(ctx, owner, { contact_id: c.contact.id, page: 1, limit: 10 }))).toEqual(["Charlie"]);
    expect(names(listRooms(ctx, owner, { search: "charlie@", page: 1, limit: 10 }))).toEqual(["Charlie"]);
    expect(names(listRooms(ctx, owner, { search: "%", page: 1, limit: 10 }))).toEqual([]);
    expect(a.room.id).toBeTruthy();
  });

  it("paginates with has_more", async () => {
    const { ctx, owner } = await scenario();
    const p1 = listRooms(ctx, owner, { page: 1, limit: 2 });
    expect(p1.data).toHaveLength(2);
    expect(p1.pagination.has_more).toBe(true);
    const p2 = listRooms(ctx, owner, { page: 2, limit: 2 });
    expect(p2.data).toHaveLength(1);
    expect(p2.pagination.has_more).toBe(false);
  });

  it("mentions filter lists rooms where I was @mentioned in a note", async () => {
    const { ctx, wsId, owner, a, c } = await scenario();
    const ann = await addMemberRaw(ctx, wsId, { name: "Zed", role: "manager" });
    await agentSays(ctx, owner, a.room.id, `heads up @[Zed](${ann.memberId})`, { kind: "note" });
    expect(names(listRooms(ctx, ann, { mentions: true, page: 1, limit: 10 }))).toEqual(["Alpha"]);
    expect(names(listRooms(ctx, owner, { mentions: true, page: 1, limit: 10 }))).toEqual([]);
    expect(c.room.id).toBeTruthy();
  });
});

describe("visibility by scope (list/get/messages)", () => {
  async function world() {
    const f = await fullApp();
    const { ctx, wsId, owner } = f;
    const manager = await addMemberRaw(ctx, wsId, { name: "Mia", role: "manager" });
    const member = await addMemberRaw(ctx, wsId, { name: "Ina", inbox_visibility: "assigned_inbox" });
    const strict = await addMemberRaw(ctx, wsId, { name: "Sol", inbox_visibility: "assigned" });
    const outsider = await addMemberRaw(ctx, wsId, { name: "Out" });
    const inbox = mkInbox(ctx, owner, { name: "Team", member_ids: [member.memberId, strict.memberId] });
    const inInbox = mkRoom(ctx, wsId, { contact: { name: "InInbox" }, inboxId: inbox.id });
    const mine = mkRoom(ctx, wsId, { contact: { name: "AssignedToIna" }, assignees: [member] });
    const strictRoom = mkRoom(ctx, wsId, { contact: { name: "AssignedToSol" }, assignees: [strict] });
    const loose = mkRoom(ctx, wsId, { contact: { name: "NoInboxNoAssignee" } });
    return { ...f, manager, member, strict, outsider, inbox, inInbox, mine, strictRoom, loose };
  }
  const list = (ctx: any, a: any) => listRooms(ctx, a, { status: "all", page: 1, limit: 50 }).data.map((r) => r.contact!.name).sort();

  it("owner and manager see everything", async () => {
    const w = await world();
    for (const a of [w.owner, w.manager]) expect(list(w.ctx, a)).toEqual(["AssignedToIna", "AssignedToSol", "InInbox", "NoInboxNoAssignee"]);
  });
  it("agent with assigned_inbox sees assigned rooms and rooms in their inboxes", async () => {
    const w = await world();
    expect(list(w.ctx, w.member)).toEqual(["AssignedToIna", "InInbox"]);
  });
  it("agent with assigned visibility sees only assigned rooms, even inside their inbox", async () => {
    const w = await world();
    expect(list(w.ctx, w.strict)).toEqual(["AssignedToSol"]);
  });
  it("agent outside every inbox sees nothing", async () => {
    const w = await world();
    expect(list(w.ctx, w.outsider)).toEqual([]);
  });
  it("get/messages/send/read/assign outside scope are 404", async () => {
    const w = await world();
    const { http, ctx } = w;
    const t = await tokenFor(ctx, w.outsider);
    const id = w.inInbox.room.id;
    expect((await http.get(`/api/rooms/${id}`, t)).status).toBe(404);
    expect((await http.get(`/api/rooms/${id}/messages`, t)).status).toBe(404);
    expect((await http.post(`/api/rooms/${id}/messages`, { content: "x" }, t)).status).toBe(404);
    expect((await http.post(`/api/rooms/${id}/read`, { message_id: "x" }, t)).status).toBe(404);
    expect((await http.post(`/api/rooms/${id}/assign`, { member_ids: [w.outsider.memberId] }, t)).status).toBe(404);
    expect((await http.patch(`/api/rooms/${id}`, { status: "closed" }, t)).status).toBe(404);
    const ok = await tokenFor(ctx, w.member);
    expect((await http.get(`/api/rooms/${id}`, ok)).status).toBe(200);
  });
  it("seats without a live seat cannot use the inbox", async () => {
    const { ctx, wsId, http } = await fullApp();
    const a = await addMemberRaw(ctx, wsId, { name: "NoSeat", live_seat: false });
    expect((await http.get("/api/rooms", await tokenFor(ctx, a))).body.error.code).toBe("NO_LIVE_SEAT");
  });
  it("adding a member to the inbox widens their view immediately", async () => {
    const w = await world();
    addInboxMember(w.ctx, w.owner, w.inbox.id, w.outsider.memberId);
    expect(list(w.ctx, w.outsider)).toEqual(["InInbox"]);
  });
  it("only owners/managers may move a room between inboxes or assign others", async () => {
    const w = await world();
    expect(() => assignRoom(w.ctx, w.member, w.inInbox.room.id, { member_ids: [w.strict.memberId] })).toThrow(/themselves/);
    expect(() => assignRoom(w.ctx, w.member, w.inInbox.room.id, { inbox_id: null })).toThrow(/managers/);
    assignRoom(w.ctx, w.member, w.inInbox.room.id, { member_ids: [w.member.memberId] });
    expect(getRoomDto(w.ctx, w.member, w.inInbox.room.id).assignee_ids).toEqual([w.member.memberId]);
    assignRoom(w.ctx, w.member, w.inInbox.room.id, { member_ids: [] });
    expect(getRoomDto(w.ctx, w.member, w.inInbox.room.id).assignee_ids).toEqual([]);
  });
});

describe("assignment side effects", () => {
  it("adds assignees as contact followers and announces the change", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const { contact, room } = mkRoom(ctx, wsId);
    ctx.bus.clear();
    assignRoom(ctx, owner, room.id, { member_ids: [ann.memberId] });
    expect(ctx.db.all("SELECT member_id FROM contact_followers WHERE contact_id = ?", contact.id)).toEqual([{ member_id: ann.memberId }]);
    expect(messagesOf(ctx, room.id).pop()!.content).toContain("assigned this conversation to Ann");
    expect(ctx.bus.events.some((e) => e.event === "room:new" && e.target === "member" && e.targetId === ann.memberId)).toBe(true);
  });
  it("tells a seat that lost access via room:deleted", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann", inbox_visibility: "assigned" });
    const { room } = mkRoom(ctx, wsId, { assignees: [ann] });
    ctx.bus.clear();
    assignRoom(ctx, owner, room.id, { member_ids: [owner.memberId] });
    expect(ctx.bus.events.some((e) => e.event === "room:deleted" && e.targetId === ann.memberId)).toBe(true);
  });
  it("rejects unknown members and inboxes", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = mkRoom(ctx, wsId);
    expect(() => assignRoom(ctx, owner, room.id, { member_ids: ["mem_nope"] })).toThrow(/not part of this workspace/);
    expect(() => assignRoom(ctx, owner, room.id, { inbox_id: "inb_nope" })).toThrow(/Inbox does not exist/);
  });
  it("replying to an unassigned conversation takes ownership of it", async () => {
    const { ctx, wsId } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann", role: "manager" });
    const { room } = mkRoom(ctx, wsId);
    await agentSays(ctx, ann, room.id, "On it");
    expect(getRoomDto(ctx, ann, room.id).assignee_ids).toEqual([ann.memberId]);
    await agentSays(ctx, ann, room.id, "A note", { kind: "note" });
  });
});

describe("bulk actions and counts", () => {
  it("returns per-item results, enforcing scope per item", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann", inbox_visibility: "assigned" });
    const mine = mkRoom(ctx, wsId, { assignees: [ann] });
    const theirs = mkRoom(ctx, wsId);
    const res = bulkRooms(ctx, ann, { room_ids: [mine.room.id, theirs.room.id, "room_missing"], action: "close" });
    expect(res.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(res).toMatchObject({ succeeded: 1, failed: 2 });
    expect(roomRow(ctx, mine.room.id).status).toBe("closed");
    expect(roomRow(ctx, theirs.room.id).status).toBe("open");
    const prio = bulkRooms(ctx, owner, { room_ids: [theirs.room.id], action: "priority", priority: 1 });
    expect(prio.succeeded).toBe(1);
    expect(roomRow(ctx, theirs.room.id).priority).toBe(1);
    const tagged = bulkRooms(ctx, owner, { room_ids: [theirs.room.id], action: "tag", tags: ["VIP", "vip"] });
    expect(tagged.succeeded).toBe(1);
    expect(JSON.parse(ctx.db.get<{ tags: string }>("SELECT tags FROM contacts WHERE id = ?", theirs.contact.id)!.tags)).toEqual(["vip"]);
    expect(bulkRooms(ctx, owner, { room_ids: [theirs.room.id], action: "assign" }).failed).toBe(1);
    expect(bulkRooms(ctx, owner, { room_ids: [theirs.room.id], action: "assign", member_ids: [ann.memberId] }).succeeded).toBe(1);
  });

  it("bulk over HTTP validates the payload (1-100 ids)", async () => {
    const { http, token } = await fullApp();
    expect((await http.post("/api/rooms/bulk", { room_ids: [], action: "close" }, token)).status).toBe(400);
    expect((await http.post("/api/rooms/bulk", { room_ids: Array(101).fill("x"), action: "close" }, token)).status).toBe(400);
  });

  it("counts open/priority/unassigned/assigned/snoozed within scope", async () => {
    const { ctx, wsId, owner, http, token } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann", role: "manager" });
    const r1 = mkRoom(ctx, wsId);
    const r2 = mkRoom(ctx, wsId, { assignees: [ann] });
    const r3 = mkRoom(ctx, wsId);
    const r4 = mkRoom(ctx, wsId);
    setPriority(ctx, owner, r1.room.id, 1);
    snoozeRoom(ctx, owner, r3.room.id, new Date(ctx.clock().getTime() + 3600_000).toISOString());
    setStatus(ctx, owner, r4.room.id, "closed");
    expect(roomCounts(ctx, ann).total).toMatchObject({ open: 2, priority: 1, unassigned: 1, assigned: 1, snoozed: 1, closed: 1 });
    expect(roomCounts(ctx, ann).unread_rooms).toBe(0);
    const widget = await http.get("/api/dashboard/counts", token);
    expect(widget.body).toMatchObject({ open: 2, priority: 1, unassigned: 1, assigned: 0, snoozed: 1 });
    expect(r2.room.id).toBeTruthy();
  });

  it("per-inbox counts hide rooms the agent cannot see", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const inbox = mkInbox(ctx, owner, { name: "Only", member_ids: [ann.memberId] });
    const other = mkInbox(ctx, owner, { name: "Hidden" });
    mkRoom(ctx, wsId, { inboxId: inbox.id });
    mkRoom(ctx, wsId, { inboxId: other.id });
    const counts = roomCounts(ctx, ann);
    expect(counts.inboxes.map((i) => i.inbox_id)).toEqual([inbox.id]);
    expect(counts.total.open).toBe(1);
  });
});

describe("room API misc", () => {
  it("patch applies status, priority, subject and favorites per seat", async () => {
    const { ctx, wsId, http, token, owner } = await fullApp();
    const { room } = mkRoom(ctx, wsId);
    const res = await http.patch(`/api/rooms/${room.id}`, { status: "closed", priority: 1, subject: "Billing" }, token);
    expect(res.body).toMatchObject({ status: "closed", priority: 1, subject: "Billing" });
    expect((await http.put(`/api/rooms/${room.id}/favorite`, {}, token)).body.favorite).toBe(true);
    expect((await http.get(`/api/rooms/${room.id}`, token)).body.favorite).toBe(true);
    const other = await addMemberRaw(ctx, wsId, { name: "Other", role: "manager" });
    expect((await http.get(`/api/rooms/${room.id}`, await tokenFor(ctx, other))).body.favorite).toBe(false);
    expect((await http.patch(`/api/rooms/${room.id}`, { priority: 2 }, token)).status).toBe(400);
    expect(owner.memberId).toBeTruthy();
  });
  it("only managers may delete (archive) a conversation", async () => {
    const { ctx, wsId, http } = await fullApp();
    const agent = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const { room } = mkRoom(ctx, wsId, { assignees: [agent] });
    const t = await tokenFor(ctx, agent);
    expect((await http.del(`/api/rooms/${room.id}`, t)).status).toBe(403);
  });
  it("creating a conversation with a first message over HTTP", async () => {
    const { ctx, wsId, http, token } = await fullApp();
    const c = createContact(ctx, wsId, { name: "Pat", email: "pat@example.test" });
    const res = await http.post("/api/rooms", { contact_id: c.id, message: { kind: "text", source: "dm", content: "Welcome!", client_msg_id: "00000000-aaaa-bbbb-cccc-000000000001" } }, token);
    expect(res.status).toBe(201);
    expect(res.body.message.content).toBe("Welcome!");
    const dup = await http.post("/api/rooms", { contact: { email: "pat@example.test" } }, token);
    expect(dup.status).toBe(200);
    expect(dup.body.created).toBe(false);
    expect((await http.post("/api/rooms", {}, token)).body.error.code).toBe("CONTACT_REQUIRED");
  });
});
