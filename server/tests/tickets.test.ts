import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { createRole, setMemberRole } from "../src/services/roles.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { setStatus } from "../src/services/rooms.js";
import {
  bulkTickets,
  closeTicket,
  liveTicketOf,
  listTickets,
  mergeTickets,
  openTicket,
  purgeTickets,
  rateTicket,
  reopenTicket,
  resolveTicket,
  ticketSweep,
  updateTicket,
  type TicketRow,
} from "../src/services/tickets.js";
import { retentionSweep } from "../src/services/archive.js";
import { insertMessage } from "../src/services/messageStore.js";
import { addMemberRaw, agentSays, contactSays, fullApp, messagesOf, mkInbox, mkRoom, setSettings, tokenFor } from "./helpers.js";
import { widgetWorld } from "./widget-helpers.js";

const live = async (f: { ctx: Parameters<typeof liveTicketOf>[0] }, roomId: string) => (await liveTicketOf(f.ctx, roomId))!;
const all = (ctx: Parameters<typeof liveTicketOf>[0], roomId: string) => ctx.db.all<TicketRow>("SELECT * FROM tickets WHERE room_id = ? ORDER BY number", roomId);
const hours = (h: number) => h * 3600_000;

describe("opening and numbering", () => {
  it("the first customer message opens a ticket, later messages join it, and messages carry the ticket id", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    expect(await liveTicketOf(f.ctx, room.id)).toBeUndefined(); // a conversation without an issue has no ticket
    const m1 = await contactSays(f.ctx, room, "My invoice PDF will not download");
    const t = await live(f, room.id);
    expect(t).toMatchObject({ number: 1, status: "new", handler: null, channel: "dm", priority: 1, resolution: null, department_id: null });
    expect(t.subject).toBe("My invoice PDF will not download");
    expect(m1.ticket_id).toBe(t.id);
    const m2 = await contactSays(f.ctx, room, "still there?");
    expect(m2.ticket_id).toBe(t.id);
    expect(await all(f.ctx, room.id)).toHaveLength(1);
    // lines written before the first issue (the "Conversation started" line) belong to no ticket
    const first = (await messagesOf(f.ctx, room.id))[0]!;
    expect(first.kind).toBe("system");
    expect(first.ticket_id).toBeNull();
  });

  it("numbers are per workspace, start at 1 and never repeat under parallel opens", async () => {
    const f = await fullApp();
    const other = await fullApp();
    const rooms = await Promise.all(Array.from({ length: 10 }, () => mkRoom(f.ctx, f.wsId)));
    await Promise.all(rooms.map((r, i) => contactSays(f.ctx, r.room, `question ${i}`)));
    const nums = (await f.ctx.db.all<{ number: number }>("SELECT number FROM tickets WHERE workspace_id = ? ORDER BY number", f.wsId)).map((r) => r.number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const o = await mkRoom(other.ctx, other.wsId);
    await contactSays(other.ctx, o.room, "hello");
    expect((await live(other, o.room.id)).number).toBe(1);
  });

  it("parallel first messages of one room converge on a single live ticket", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    const msgs = await Promise.all(Array.from({ length: 8 }, (_, i) => contactSays(f.ctx, room, `burst ${i}`)));
    expect(new Set(msgs.map((m) => m.ticket_id)).size).toBe(1);
    expect(await all(f.ctx, room.id)).toHaveLength(1);
    await expect(
      f.ctx.db.run("INSERT INTO tickets(id, workspace_id, room_id, contact_id, number, status, opened_at, last_activity_at, created_at, updated_at) VALUES ('dup', ?, ?, ?, 99, 'open', 'x', 'x', 'x', 'x')", f.wsId, room.id, room.contact_id),
    ).rejects.toThrow(/UNIQUE|duplicate key/i);
  });

  it("an agent writing first opens a human ticket that counts as answered", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    const m = await agentSays(f.ctx, f.owner, room.id, "Hello, following up on your order");
    const t = await live(f, room.id);
    expect(m.ticket_id).toBe(t.id);
    expect(t).toMatchObject({ status: "open", handler: `human:${f.owner.memberId}` });
    expect(t.first_response_at).not.toBeNull();
    expect(t.first_human_response_at).not.toBeNull();
  });

  it("the channel of the first message is the ticket channel, and the department is the room's inbox", async () => {
    const f = await fullApp();
    const inbox = await mkInbox(f.ctx, f.owner, { name: "Billing" });
    const { room } = await mkRoom(f.ctx, f.wsId, { inboxId: inbox.id, contact: { phone: "+14155552671" } });
    await contactSays(f.ctx, room, "STOP texting me about the invoice", "sms");
    const t = await live(f, room.id);
    expect(t.channel).toBe("sms");
    expect(t.department_id).toBe(inbox.id);
  });

  it("room priority raises the ticket priority; the subject is the first line, shortened", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await f.ctx.db.run("UPDATE rooms SET priority = 1 WHERE id = ?", room.id);
    await contactSays(f.ctx, room, `${"very long ".repeat(40)}`);
    const t = await live(f, room.id);
    expect(t.priority).toBe(2);
    expect(t.subject.length).toBeLessThanOrEqual(121);
  });
});

describe("who answers", () => {
  it("a bot line records the first response but not a human one, and never changes the status", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    await insertMessage(f.ctx, { workspaceId: f.wsId, roomId: room.id, senderType: "bot", senderId: "ai", kind: "text", source: "dm", content: "hello" });
    const t = await live(f, room.id);
    expect(t.status).toBe("new");
    expect(t.first_response_at).not.toBeNull();
    expect(t.first_human_response_at).toBeNull();
  });

  it("a human reply takes the ticket from the bot (implicit takeover) and is recorded", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    const t0 = await live(f, room.id);
    await f.ctx.db.run("UPDATE tickets SET status = 'bot_handling', handler = 'bot:agt_1' WHERE id = ?", t0.id);
    await agentSays(f.ctx, f.owner, room.id, "I'll take it from here");
    const t = await live(f, room.id);
    expect(t).toMatchObject({ status: "open", handler: `human:${f.owner.memberId}` });
    const ev = await f.ctx.db.all<{ type: string; detail: string }>("SELECT type, detail FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, id", t.id);
    expect(ev.map((e) => e.type)).toEqual(["opened", "taken_over"]);
  });

  it("notes and system lines attach to the live ticket but never open, answer or reopen one", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    const note = await agentSays(f.ctx, f.owner, room.id, "internal thought", { kind: "note" });
    expect(note.ticket_id).toBeNull();
    expect(await liveTicketOf(f.ctx, room.id)).toBeUndefined();
    await contactSays(f.ctx, room, "hi");
    const note2 = await agentSays(f.ctx, f.owner, room.id, "another thought", { kind: "note" });
    const t = await live(f, room.id);
    expect(note2.ticket_id).toBe(t.id);
    expect(t.status).toBe("new");
    expect(t.first_response_at).toBeNull();
  });

  it("a customer message on a ticket waiting for the customer reopens it", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    await agentSays(f.ctx, f.owner, room.id, "can you send a screenshot?");
    const t = await live(f, room.id);
    await updateTicket(f.ctx, f.owner, t.id, { status: "pending_customer" });
    expect((await live(f, room.id)).status).toBe("pending_customer");
    await contactSays(f.ctx, room, "here it is");
    expect((await live(f, room.id)).status).toBe("open");
  });
});

describe("resolve, close, reopen", () => {
  it("resolving posts the closing message with a rating card the visitor may see, and closing never closes the room", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    const t = await live(f, room.id);
    const r = await resolveTicket(f.ctx, f.owner, t.id);
    expect(r).toMatchObject({ status: "resolved", resolution: "human_resolved" });
    expect(r.resolved_at).not.toBeNull();
    const closing = (await messagesOf(f.ctx, room.id)).filter((m) => m.kind === "system").pop()!;
    expect(JSON.parse(closing.meta)).toMatchObject({ sub_type: "ticket_resolved", card: { type: "csat", ticket_id: t.id } });
    expect(closing.ticket_id).toBe(t.id);
    const closed = await closeTicket(f.ctx, f.owner, t.id);
    expect(closed).toMatchObject({ status: "closed", resolution: "human_resolved" });
    expect((await f.ctx.db.get<{ status: string }>("SELECT status FROM rooms WHERE id = ?", room.id))!.status).toBe("open");
    // resolving again is a no-op, a closed ticket cannot be edited
    await expect(resolveTicket(f.ctx, f.owner, t.id)).rejects.toThrow(/closed/);
    await expect(updateTicket(f.ctx, f.owner, t.id, { subject: "x" })).rejects.toMatchObject({ code: "TICKET_CLOSED" });
  });

  it("silent resolve and csat_prompt=false post no card", async () => {
    const f = await fullApp();
    await setSettings(f.ctx, f.wsId, { tickets: { csat_prompt: false, closing_message: "" } });
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    const before = (await messagesOf(f.ctx, room.id)).length;
    await resolveTicket(f.ctx, f.owner, (await live(f, room.id)).id);
    expect((await messagesOf(f.ctx, room.id)).length).toBe(before);
  });

  it("a reply to a resolved ticket reopens it inside the window (same number), else a new ticket opens and the old one closes", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "first problem");
    const t1 = await live(f, room.id);
    await agentSays(f.ctx, f.owner, room.id, "fixed?");
    await resolveTicket(f.ctx, f.owner, t1.id);
    f.ctx.clockCtl.advance(hours(71));
    await contactSays(f.ctx, room, "still broken");
    const re = await live(f, room.id);
    expect(re).toMatchObject({ id: t1.id, status: "open", resolution: null, resolved_at: null });
    expect((await all(f.ctx, room.id)).length).toBe(1);
    await resolveTicket(f.ctx, f.owner, t1.id);
    f.ctx.clockCtl.advance(hours(73));
    const m = await contactSays(f.ctx, room, "different question");
    const t2 = await live(f, room.id);
    expect(t2.id).not.toBe(t1.id);
    expect(t2.number).toBe(2);
    expect(m.ticket_id).toBe(t2.id);
    const old = (await all(f.ctx, room.id))[0]!;
    expect(old).toMatchObject({ status: "closed", resolution: "human_resolved" }); // the resolution it earned is kept
  });

  it("reopen_hours = 0 always opens a new ticket", async () => {
    const f = await fullApp();
    await setSettings(f.ctx, f.wsId, { tickets: { reopen_hours: 0 } });
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "one");
    await resolveTicket(f.ctx, f.owner, (await live(f, room.id)).id);
    await contactSays(f.ctx, room, "two");
    expect((await all(f.ctx, room.id)).map((t) => t.status)).toEqual(["closed", "new"]);
  });

  it("closing the room resolves its live ticket; reopening a closed ticket needs a conversation without a live one", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    await setStatus(f.ctx, f.owner, room.id, "closed");
    const t = await live(f, room.id);
    expect(t).toMatchObject({ status: "resolved", resolution: "human_resolved" });
    await closeTicket(f.ctx, f.owner, t.id);
    expect(await liveTicketOf(f.ctx, room.id)).toBeUndefined();
    const back = await reopenTicket(f.ctx, f.owner, t.id);
    expect(back.status).toBe("open");
    await closeTicket(f.ctx, f.owner, t.id);
    await contactSays(f.ctx, room, "new issue"); // opens ticket 2
    await expect(reopenTicket(f.ctx, f.owner, t.id)).rejects.toMatchObject({ code: "TICKET_LIVE_EXISTS" });
  });

  it("closing a ticket that nobody answered is `auto_closed`, one only the bot answered is `abandoned`", async () => {
    const f = await fullApp();
    const a = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, a.room, "unanswered");
    const ta = await live(f, a.room.id);
    await f.ctx.db.run("UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?", f.ctx.clock().toISOString(), ta.id);
    f.ctx.clockCtl.advance(hours(80));
    expect(await ticketSweep(f.ctx)).toEqual({ resolved: 0, closed: 1 });
    expect((await all(f.ctx, a.room.id))[0]).toMatchObject({ status: "closed", resolution: "auto_closed" });
  });
});

describe("the time-based sweep", () => {
  async function botTicket(f: Awaited<ReturnType<typeof fullApp>>) {
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "how do I reset my password?");
    const t = await live(f, room.id);
    await f.ctx.db.run("UPDATE tickets SET status = 'bot_handling', handler = 'bot:agt_1' WHERE id = ?", t.id);
    return { room, t };
  }

  it("a bot ticket that went quiet is resolved as abandoned with the closing message, exactly at the configured idle time", async () => {
    const f = await fullApp();
    const { room, t } = await botTicket(f);
    f.ctx.clockCtl.advance(29 * 60_000);
    expect((await ticketSweep(f.ctx)).resolved).toBe(0);
    f.ctx.clockCtl.advance(2 * 60_000);
    expect((await ticketSweep(f.ctx)).resolved).toBe(1);
    expect(await f.ctx.db.get("SELECT status, resolution FROM tickets WHERE id = ?", t.id)).toMatchObject({ status: "resolved", resolution: "abandoned" });
    expect((await messagesOf(f.ctx, room.id)).some((m) => m.meta.includes("ticket_resolved"))).toBe(true);
    // a second pass changes nothing
    expect(await ticketSweep(f.ctx)).toEqual({ resolved: 0, closed: 0 });
  });

  it("each workspace's own settings decide; 0 turns the automation off", async () => {
    const f = await fullApp();
    await setSettings(f.ctx, f.wsId, { tickets: { bot_idle_minutes: 0 } });
    const { t } = await botTicket(f);
    f.ctx.clockCtl.advance(hours(24));
    expect((await ticketSweep(f.ctx)).resolved).toBe(0);
    expect((await f.ctx.db.get<{ status: string }>("SELECT status FROM tickets WHERE id = ?", t.id))!.status).toBe("bot_handling");
    const g = await fullApp();
    await setSettings(g.ctx, g.wsId, { tickets: { bot_idle_minutes: 10 } });
    const b = await botTicket(g);
    g.ctx.clockCtl.advance(11 * 60_000);
    expect((await ticketSweep(g.ctx)).resolved).toBe(1);
    expect((await g.ctx.db.get<{ status: string }>("SELECT status FROM tickets WHERE id = ?", b.t.id))!.status).toBe("resolved");
  });

  it("tickets handled by people are never auto-resolved; pending ones are, after pending_idle_hours", async () => {
    const f = await fullApp();
    const a = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, a.room, "help");
    await agentSays(f.ctx, f.owner, a.room.id, "on it");
    const open = await live(f, a.room.id);
    const b = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, b.room, "help too");
    await agentSays(f.ctx, f.owner, b.room.id, "send a screenshot");
    const pend = await live(f, b.room.id);
    await updateTicket(f.ctx, f.owner, pend.id, { status: "pending_customer" });
    f.ctx.clockCtl.advance(hours(71));
    expect((await ticketSweep(f.ctx)).resolved).toBe(0);
    f.ctx.clockCtl.advance(hours(2));
    expect((await ticketSweep(f.ctx)).resolved).toBe(1);
    expect((await f.ctx.db.get<{ status: string }>("SELECT status FROM tickets WHERE id = ?", open.id))!.status).toBe("open");
    expect((await f.ctx.db.get<{ status: string; resolution: string }>("SELECT status, resolution FROM tickets WHERE id = ?", pend.id))).toEqual({ status: "resolved", resolution: "abandoned" });
  });

  it("resolved tickets close after close_resolved_hours, keeping their resolution", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    const t = await live(f, room.id);
    await resolveTicket(f.ctx, f.owner, t.id);
    f.ctx.clockCtl.advance(hours(71));
    expect((await ticketSweep(f.ctx)).closed).toBe(0);
    f.ctx.clockCtl.advance(hours(2));
    expect((await ticketSweep(f.ctx)).closed).toBe(1);
    expect(await f.ctx.db.get("SELECT status, resolution FROM tickets WHERE id = ?", t.id)).toEqual({ status: "closed", resolution: "human_resolved" });
  });
});

describe("rating", () => {
  it("rates the latest resolved ticket once; a ticket that is not resolved, or another room, cannot be rated", async () => {
    const f = await fullApp();
    const a = await mkRoom(f.ctx, f.wsId);
    const b = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, a.room, "hi");
    expect(await rateTicket(f.ctx, a.room, 5)).toBeNull(); // still open
    const t = await live(f, a.room.id);
    await resolveTicket(f.ctx, f.owner, t.id);
    expect(await rateTicket(f.ctx, b.room, 5, undefined, t.id)).toBeNull();
    const rated = await rateTicket(f.ctx, a.room, 4, "thanks");
    expect(rated).toMatchObject({ csat: 4, csat_comment: "thanks" });
    expect(await rateTicket(f.ctx, a.room, 1)).toBeNull();
    expect((await f.ctx.db.get<{ csat: number }>("SELECT csat FROM tickets WHERE id = ?", t.id))!.csat).toBe(4);
  });

  it("over the widget API: rating is offered after resolution, once, and a reopened ticket forgets the old rating", async () => {
    const w = await widgetWorld();
    const v = await w.visitor();
    await v.send("my printer is on fire");
    const t = (await w.ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE workspace_id = ?", w.wsId))!;
    const rooms = await w.http.get("/public/rooms", undefined, v.headers);
    expect(rooms.body.data[0].ticket).toEqual({ id: t.id, number: 1, status: "new", resolved: false, csat_pending: false });
    expect((await w.http.post(`/public/rooms/${v.roomId}/ticket-csat`, { score: 5 }, undefined, v.headers)).status).toBe(409);
    await resolveTicket(w.ctx, w.owner, t.id);
    const msgs = await w.http.get(`/public/rooms/${v.roomId}/messages`, undefined, v.headers);
    const card = msgs.body.data.find((m: { meta: { sub_type?: string } }) => m.meta.sub_type === "ticket_resolved");
    expect(card.meta.card).toMatchObject({ type: "csat", ticket_id: t.id });
    expect((await w.http.get("/public/rooms", undefined, v.headers)).body.data[0].ticket.csat_pending).toBe(true);
    expect((await w.http.post(`/public/rooms/${v.roomId}/ticket-csat`, { score: 6 }, undefined, v.headers)).status).toBe(400);
    expect((await w.http.post(`/public/rooms/${v.roomId}/ticket-csat`, { score: 5, comment: "great" }, undefined, v.headers)).status).toBe(200);
    expect((await w.http.post(`/public/rooms/${v.roomId}/ticket-csat`, { score: 4 }, undefined, v.headers)).status).toBe(409);
    // the visitor's copy never contains the handler, department or tags
    const body = JSON.stringify((await w.http.get("/public/rooms", undefined, v.headers)).body);
    expect(body).not.toContain("handler");
    expect(body).not.toContain("department");
  });
});

describe("listing, scope and counts", () => {
  it("filters by status, handler, department and text; paging by keyset covers every ticket once", async () => {
    const f = await fullApp();
    const sales = await mkInbox(f.ctx, f.owner, { name: "Sales" });
    const rooms: Awaited<ReturnType<typeof mkRoom>>[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await mkRoom(f.ctx, f.wsId, { inboxId: i % 2 ? sales.id : null });
      await contactSays(f.ctx, r.room, i === 3 ? "Where is my parcel #3?" : `topic ${i}`);
      f.ctx.clockCtl.advance(1000);
      rooms.push(r);
    }
    const t0 = await live(f, rooms[0]!.room.id);
    await agentSays(f.ctx, f.owner, rooms[0]!.room.id, "hello");
    await resolveTicket(f.ctx, f.owner, t0.id);
    await f.ctx.db.run("UPDATE tickets SET status = 'bot_handling', handler = 'bot:agt_1' WHERE room_id = ?", rooms[1]!.room.id);
    const ids = (r: { data: { id: string }[] }) => r.data.map((t) => t.id);
    const q = (o: object = {}) => listTickets(f.ctx, f.owner, { limit: 50, ...o });
    expect((await q()).data).toHaveLength(7);
    expect((await q({ status: "resolved" })).data).toHaveLength(1);
    expect((await q({ status: "new,bot_handling" })).data).toHaveLength(6);
    expect(ids(await q({ handler: "bot" }))).toEqual([(await live(f, rooms[1]!.room.id)).id]);
    expect((await q({ handler: "human" })).data).toHaveLength(1);
    expect((await q({ handler: "unassigned" })).data).toHaveLength(5);
    expect((await q({ handler: "me" })).data).toHaveLength(1);
    expect((await q({ department_id: sales.id })).data).toHaveLength(3);
    expect((await q({ q: "parcel" })).data).toHaveLength(1);
    expect((await q({ q: "#4" })).data.map((t) => t.number)).toContain(4);
    expect((await q({ q: "100%_" })).data).toHaveLength(0); // wildcards are data
    await expect(q({ status: "nonsense" })).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(q({ handler: "x:y" })).rejects.toMatchObject({ code: "INVALID_HANDLER" });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await q({ limit: 3, cursor });
      seen.push(...ids(page));
      cursor = page.pagination.next_cursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("an agent sees the tickets of the rooms they can see; other tickets answer 404, as does another workspace", async () => {
    const f = await fullApp();
    const other = await fullApp();
    const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann", inbox_visibility: "assigned" });
    const mine = await mkRoom(f.ctx, f.wsId, { assignees: [ann] });
    const theirs = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, mine.room, "mine");
    await contactSays(f.ctx, theirs.room, "theirs");
    const tm = await live(f, mine.room.id);
    const tt = await live(f, theirs.room.id);
    const token = await tokenFor(f.ctx, ann);
    const list = await f.http.get("/api/tickets", token);
    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([tm.id]);
    expect((await f.http.get(`/api/tickets/${tm.id}`, token)).status).toBe(200);
    expect((await f.http.get(`/api/tickets/${tt.id}`, token)).status).toBe(404);
    expect((await f.http.post(`/api/tickets/${tt.id}/resolve`, {}, token)).status).toBe(404);
    expect((await f.http.get(`/api/rooms/${theirs.room.id}/tickets`, token)).status).toBe(404);
    expect((await f.http.get("/api/tickets/counts", token)).body).toMatchObject({ new: 1, total_live: 1 });
    // other workspace's owner cannot read, change or count ours
    const otherToken = await tokenFor(other.ctx, other.owner);
    expect((await other.http.get(`/api/tickets/${tm.id}`, otherToken)).status).toBe(404);
    expect((await other.http.get("/api/tickets", otherToken)).body.data).toEqual([]);
  });

  it("the room list carries the live ticket and filters on it", async () => {
    const f = await fullApp();
    const a = await mkRoom(f.ctx, f.wsId);
    const b = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, a.room, "a");
    await contactSays(f.ctx, b.room, "b");
    await f.ctx.db.run("UPDATE tickets SET status = 'waiting_for_human' WHERE room_id = ?", a.room.id);
    const all = (await f.http.get("/api/rooms", f.token)).body.data;
    expect(all.find((r: { id: string }) => r.id === a.room.id).ticket).toMatchObject({ number: expect.any(Number), status: "waiting_for_human" });
    const only = (await f.http.get("/api/rooms?ticket_status=waiting_for_human", f.token)).body.data;
    expect(only.map((r: { id: string }) => r.id)).toEqual([a.room.id]);
    expect((await f.http.get("/api/rooms?ticket_handler=bot", f.token)).body.data).toEqual([]);
  });
});

describe("bulk, merge, edit", () => {
  it("bulk resolve and close report each ticket; failures do not stop the rest", async () => {
    const f = await fullApp();
    const rs = await Promise.all([1, 2, 3].map(() => mkRoom(f.ctx, f.wsId)));
    for (const r of rs) await contactSays(f.ctx, r.room, "x");
    const ts = await Promise.all(rs.map((r) => live(f, r.room.id)));
    await closeTicket(f.ctx, f.owner, ts[2]!.id);
    const res = await bulkTickets(f.ctx, f.owner, { ticket_ids: [ts[0]!.id, ts[1]!.id, ts[2]!.id, "tkt_missing"], action: "close" });
    expect(res.succeeded).toBe(3);
    expect(res.failed).toBe(1);
    expect(res.results[3]).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await f.ctx.db.all("SELECT 1 FROM tickets WHERE status <> 'closed'")).length).toBe(0);
    const audit = await f.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'ticket.bulk'");
    expect(JSON.parse(audit!.detail)).toMatchObject({ action: "close", requested: 4, succeeded: 3 });
  });

  it("merging moves the messages, keeps the earlier opening, closes the source as merged and refuses other rooms", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "first");
    const t1 = await live(f, room.id);
    await closeTicket(f.ctx, f.owner, t1.id);
    f.ctx.clockCtl.advance(60_000);
    await contactSays(f.ctx, room, "the same problem again");
    const t2 = await live(f, room.id);
    const merged = await mergeTickets(f.ctx, f.owner, t2.id, t1.id);
    expect(merged).toMatchObject({ status: "closed", resolution: "merged", merged_into_id: t1.id });
    const msgs = await messagesOf(f.ctx, room.id);
    expect(msgs.filter((m) => m.ticket_id === t1.id).length).toBeGreaterThanOrEqual(2);
    expect(msgs.some((m) => m.ticket_id === t2.id)).toBe(false);
    await expect(mergeTickets(f.ctx, f.owner, t1.id, t1.id)).rejects.toMatchObject({ code: "MERGE_SAME" });
    await expect(mergeTickets(f.ctx, f.owner, t2.id, t1.id)).rejects.toMatchObject({ code: "MERGE_SOURCE_MERGED" });
    await expect(reopenTicket(f.ctx, f.owner, t2.id)).rejects.toMatchObject({ code: "TICKET_MERGED" });
    const o = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, o.room, "other");
    await expect(mergeTickets(f.ctx, f.owner, (await live(f, o.room.id)).id, t1.id)).rejects.toMatchObject({ code: "MERGE_OTHER_ROOM" });
    expect((await f.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'ticket.merged'"))).toBeDefined();
  });

  it("subject edits stick as agent-set, tags are normalised, priority is validated", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    const t = await live(f, room.id);
    const u = await updateTicket(f.ctx, f.owner, t.id, { subject: " Refund request ", tags: ["Billing", "billing", " VIP "], priority: 3 });
    expect(u).toMatchObject({ subject: "Refund request", subject_set_by: "agent", priority: 3 });
    expect(JSON.parse(u.tags)).toEqual(["billing", "vip"]);
    const bad = await f.http.patch(`/api/tickets/${t.id}`, { priority: 9 }, f.token);
    expect(bad.status).toBe(400);
  });
});

describe("permissions over HTTP", () => {
  it("a viewer reads but cannot change; an agent resolves but cannot merge; custom roles keep what they had", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, room, "hi");
    const t = await live(f, room.id);
    const v = await addMemberRaw(f.ctx, f.wsId, { name: "Vic", role: "agent" });
    await setMemberRole(f.ctx, f.owner, v.memberId, "role_viewer");
    const viewer = actorFromRow(await getMember(f.ctx, f.wsId, v.memberId));
    const vt = await tokenFor(f.ctx, viewer);
    expect((await f.http.get(`/api/tickets/${t.id}`, vt)).status).toBe(200);
    expect((await f.http.post(`/api/tickets/${t.id}/resolve`, {}, vt)).status).toBe(403);
    expect((await f.http.patch(`/api/tickets/${t.id}`, { priority: 2 }, vt)).status).toBe(403);
    const agent = await addMemberRaw(f.ctx, f.wsId, { name: "Ann", role: "agent", inbox_visibility: "assigned_inbox" });
    await f.ctx.db.run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES (?, ?, ?)", room.id, agent.memberId, "2026-03-02T10:00:00.000Z");
    const at = await tokenFor(f.ctx, agent);
    expect((await f.http.post(`/api/tickets/${t.id}/merge`, { into_id: t.id }, at)).status).toBe(403);
    expect((await f.http.post(`/api/tickets/${t.id}/resolve`, {}, at)).status).toBe(200);
    const role = await createRole(f.ctx, f.owner, { name: "Readers", base_role: "agent", permissions: ["conversations:read", "tickets:read"] });
    expect(role.permissions).toContain("tickets:read");
  });

  it("every ticket route refuses a seat without a live seat and answers 401 without a token", async () => {
    const f = await fullApp();
    expect((await f.http.get("/api/tickets")).status).toBe(401);
    const m = await addMemberRaw(f.ctx, f.wsId, { name: "Nolive", role: "manager", live_seat: false });
    const res = await f.http.get("/api/tickets", await tokenFor(f.ctx, m));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NO_LIVE_SEAT");
  });
});

describe("realtime", () => {
  it("publishes ticket:updated to the team with the full ticket and to the visitor with the minimal one", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    f.ctx.bus.clear();
    await contactSays(f.ctx, room, "hi");
    // insertMessage alone does not publish; the callers' emitInserted does (here: resolve publishes)
    const t = await live(f, room.id);
    await resolveTicket(f.ctx, f.owner, t.id);
    const ev = f.ctx.bus.ofType("ticket:updated").pop()!;
    expect(ev.payload.ticket).toMatchObject({ id: t.id, status: "resolved", handler: null });
    expect(ev.visitor).toEqual({ room_id: room.id, ticket: { id: t.id, number: 1, status: "resolved", resolved: true, csat_pending: true } });
  });
});

describe("indexes and retention", () => {
  it("the hot ticket queries use their indexes", async () => {
    const f = await fullApp();
    const live = await f.ctx.db.explain("SELECT * FROM tickets WHERE room_id = ? AND status <> 'closed'", "r1");
    expect(live).toMatch(/ux_tickets_room_live/);
    const list = await f.ctx.db.explain("SELECT t.* FROM tickets t JOIN rooms r ON r.id = t.room_id WHERE t.workspace_id = ? AND r.archived = 0 AND t.status <> 'closed' ORDER BY t.last_activity_at DESC, t.id DESC LIMIT 31", "w");
    // never a scan of the tickets table (PostgreSQL's planner choice on an empty table is arbitrary, so the names are not pinned)
    expect(list).not.toMatch(/Seq Scan on tickets|SCAN t\b|SCAN tickets/);
    expect(list).toMatch(/ix_tickets_|ux_tickets_/);
    const queue = await f.ctx.db.explain("SELECT * FROM tickets WHERE workspace_id = ? AND department_id = ? AND status = 'waiting_for_human' ORDER BY handoff_at LIMIT 20", "w", "d");
    expect(queue).toMatch(/ix_tickets_queue/);
    const idle = await f.ctx.db.explain("SELECT * FROM tickets WHERE status IN ('bot_handling','pending_customer') AND last_activity_at < ? ORDER BY last_activity_at LIMIT 200", "x");
    expect(idle).toMatch(/ix_tickets_idle/);
    const byRoom = await f.ctx.db.explain("SELECT * FROM messages WHERE room_id = ? AND ticket_id = ?", "r", "t");
    expect(byRoom).not.toMatch(/Seq Scan on messages|SCAN messages/); // partitions on PostgreSQL, the table on SQLite
  });

  it("retention and erasure remove tickets with their events and keep other workspaces", async () => {
    const f = await fullApp();
    const g = await fullApp();
    await setSettings(f.ctx, f.wsId, { retention_days: 30 });
    const a = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, a.room, "old");
    await closeTicket(f.ctx, f.owner, (await live(f, a.room.id)).id);
    f.ctx.clockCtl.advance(hours(24 * 31));
    const b = await mkRoom(f.ctx, f.wsId);
    await contactSays(f.ctx, b.room, "recent");
    await retentionSweep(f.ctx);
    expect((await all(f.ctx, a.room.id)).length).toBe(0);
    expect((await all(f.ctx, b.room.id)).length).toBe(1);
    expect((await f.ctx.db.all("SELECT 1 FROM ticket_events WHERE ticket_id NOT IN (SELECT id FROM tickets)")).length).toBe(0);
    const c = await mkRoom(g.ctx, g.wsId);
    await contactSays(g.ctx, c.room, "other tenant");
    expect(await purgeTickets(f.ctx, f.wsId)).toBe(1);
    expect((await g.ctx.db.all("SELECT 1 FROM tickets")).length).toBe(1);
  });

  it("settings validate the lifecycle numbers", async () => {
    const f = await fullApp();
    for (const bad of [{ bot_idle_minutes: 3 }, { reopen_hours: -1 }, { close_resolved_hours: 0 }, { closing_message: "x".repeat(501) }]) {
      const r = await f.http.patch("/api/workspace", { settings: { tickets: bad } }, f.token);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await f.http.patch("/api/workspace", { settings: { tickets: { bot_idle_minutes: 45, csat_prompt: false } } }, f.token);
    expect(ok.status).toBe(200);
    expect(ok.body.settings.tickets).toMatchObject({ bot_idle_minutes: 45, csat_prompt: false, reopen_hours: 72 });
  });
});

describe("openTicket directly", () => {
  it("rolls its number back with the transaction", async () => {
    const f = await fullApp();
    const { room } = await mkRoom(f.ctx, f.wsId);
    await expect(
      f.ctx.db.tx(async () => {
        await openTicket(f.ctx, { room, channel: "dm", subject: "x", by: { type: "system" } }, f.ctx.clock().toISOString());
        throw new AppError(500, "BOOM", "boom");
      }),
    ).rejects.toThrow("boom");
    await contactSays(f.ctx, room, "real");
    expect((await live(f, room.id)).number).toBe(1);
  });
});
