import { describe, expect, it } from "vitest";
import { deleteMessage, editMessage, listMessagesForAgent, pageMessages, parseMentions, searchMessages, sendAgentMessage } from "../src/services/messages.js";
import { getRoomDto, markRead, unreadCount } from "../src/services/rooms.js";
import { insertMessage } from "../src/services/messageStore.js";
import { assignRoom } from "../src/services/rooms.js";
import { addMemberRaw, agentSays, contactSays, fullApp, messagesOf, mkRoom, roomRow, setSettings } from "./helpers.js";

const QID = (n: number) => `qid-${String(n).padStart(8, "0")}`;

describe("server-side idempotency on (room, client_msg_id)", () => {
  it("returns the original message for a repeated client_msg_id", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const a = await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "dm", content: "once", client_msg_id: QID(1) });
    const b = await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "dm", content: "twice?", client_msg_id: QID(1) });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.message.id).toBe(a.message.id);
    expect(b.message.content).toBe("once");
    expect((await messagesOf(ctx, room.id)).filter((m) => m.kind === "text")).toHaveLength(1);
  });

  it("is safe under concurrent duplicate sends", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "dm", content: "race", client_msg_id: QID(2) })),
    );
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await messagesOf(ctx, room.id)).filter((m) => m.content === "race")).toHaveLength(1);
  });

  it("scopes the key per room and keeps different qids distinct", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const a = await mkRoom(ctx, wsId);
    const b = await mkRoom(ctx, wsId);
    const m1 = await sendAgentMessage(ctx, owner, a.room.id, { kind: "text", source: "dm", content: "x", client_msg_id: QID(3) });
    const m2 = await sendAgentMessage(ctx, owner, b.room.id, { kind: "text", source: "dm", content: "x", client_msg_id: QID(3) });
    const m3 = await sendAgentMessage(ctx, owner, a.room.id, { kind: "text", source: "dm", content: "y", client_msg_id: QID(4) });
    expect(new Set([m1.message.id, m2.message.id, m3.message.id]).size).toBe(3);
  });

  it("the unique index backstops a raced insert and visitors/contacts are idempotent too", async () => {
    const { ctx, wsId } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    await contactSays(ctx, room, "a", "dm", { clientMsgId: QID(5) });
    await expect(() => contactSays(ctx, room, "b", "dm", { clientMsgId: QID(5) })).rejects.toThrow(/UNIQUE/);
  });

  it("over HTTP: 201 first, 200 on replay, and rejects malformed ids", async () => {
    const { ctx, wsId, http, token } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const body = { content: "hello", client_msg_id: QID(6) };
    const first = await http.post(`/api/rooms/${room.id}/messages`, body, token);
    const again = await http.post(`/api/rooms/${room.id}/messages`, body, token);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);
    expect((await http.post(`/api/rooms/${room.id}/messages`, { content: "x", client_msg_id: "bad id!" }, token)).status).toBe(400);
  });
});

describe("ordering and pagination", () => {
  it("keeps insertion order when timestamps are identical (seq tiebreaker)", async () => {
    const { ctx, wsId } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    for (let i = 0; i < 10; i++) await contactSays(ctx, room, `m${i}`); // the clock never advances
    const rows = (await messagesOf(ctx, room.id)).filter((m) => m.kind === "text");
    expect(new Set(rows.map((r) => r.created_at)).size).toBe(1);
    expect(rows.map((r) => r.content)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    const seqs = rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(10);
    const page = await pageMessages(ctx, room.id, { limit: 50 });
    expect(page.data.filter((m) => m.kind === "text").map((m) => m.content)).toEqual(rows.map((r) => r.content));
  });

  function seed(count: number) {
    return async () => {
      const f = await fullApp();
      const { room } = await mkRoom(f.ctx, f.wsId);
      const ids: string[] = [];
      for (let i = 0; i < count; i++) ids.push((await contactSays(f.ctx, room, `msg ${i}`)).id);
      return { ...f, room, ids };
    };
  }

  it("an empty room returns an empty page (only the creation line exists)", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const res = await listMessagesForAgent(ctx, owner, room.id, { limit: 30 });
    expect(res.data.map((m) => m.kind)).toEqual(["system"]);
    expect(res.pagination).toMatchObject({ has_more_before: false, has_more_after: false });
  });

  it("exactly `limit` messages: no further pages", async () => {
    const { ctx, owner, room } = await seed(4)();
    // 1 system line + 4 messages = 5 rows
    const exact = await pageMessages(ctx, room.id, { limit: 5 });
    expect(exact.data).toHaveLength(5);
    expect(exact.pagination).toMatchObject({ has_more_before: false, has_more_after: false });
    const lessOne = await pageMessages(ctx, room.id, { limit: 4 });
    expect(lessOne.data).toHaveLength(4);
    expect(lessOne.pagination.has_more_before).toBe(true);
    expect(owner.memberId).toBeTruthy();
  });

  it("walks backwards with before and forwards with after without gaps or duplicates", async () => {
    const { ctx, room } = await seed(23)();
    const seen: string[] = [];
    let page = await pageMessages(ctx, room.id, { limit: 7 });
    seen.unshift(...page.data.map((m) => m.id));
    while (page.pagination.has_more_before) {
      page = await pageMessages(ctx, room.id, { limit: 7, before: page.pagination.before_cursor! });
      seen.unshift(...page.data.map((m) => m.id));
    }
    expect(seen).toHaveLength(24);
    expect(new Set(seen).size).toBe(24);
    const forward: string[] = [];
    let f = await pageMessages(ctx, room.id, { limit: 5, after: seen[0]! });
    forward.push(...f.data.map((m) => m.id));
    while (f.pagination.has_more_after) {
      f = await pageMessages(ctx, room.id, { limit: 5, after: f.pagination.after_cursor! });
      forward.push(...f.data.map((m) => m.id));
    }
    expect(forward).toEqual(seen.slice(1));
  });

  it("cursor boundaries: before the first message is empty, after the last is empty", async () => {
    const { ctx, room, ids } = await seed(3)();
    const all = (await pageMessages(ctx, room.id, { limit: 50 })).data;
    expect((await pageMessages(ctx, room.id, { limit: 10, before: all[0]!.id })).data).toEqual([]);
    const tail = await pageMessages(ctx, room.id, { limit: 10, after: ids[2]! });
    expect(tail.data).toEqual([]);
    expect(tail.pagination).toMatchObject({ has_more_after: false, has_more_before: true });
  });

  it("deleted messages are skipped and do not disturb cursors", async () => {
    const { ctx, owner, room, ids } = await seed(6)();
    await deleteMessage(ctx, owner, ids[2]!);
    const all = (await pageMessages(ctx, room.id, { limit: 50 })).data.map((m) => m.id);
    expect(all).not.toContain(ids[2]);
    const before = (await pageMessages(ctx, room.id, { limit: 50, before: ids[3]! })).data.map((m) => m.id);
    expect(before).not.toContain(ids[2]);
    // a deleted message can still be used as a cursor
    expect((await pageMessages(ctx, room.id, { limit: 50, after: ids[2]! })).data[0]!.id).toBe(ids[3]);
  });

  it("rejects both cursors, foreign cursors and out-of-range limits", async () => {
    const { ctx, http, token, room, ids } = await seed(2)();
    const other = await mkRoom(ctx, room.workspace_id);
    const foreign = await contactSays(ctx, other.room, "elsewhere");
    await expect(() => pageMessages(ctx, room.id, { limit: 5, before: ids[0], after: ids[1] })).rejects.toThrow(/either/);
    await expect(() => pageMessages(ctx, room.id, { limit: 5, before: foreign.id })).rejects.toThrow(/not found/);
    expect((await http.get(`/api/rooms/${room.id}/messages?limit=51`, token)).status).toBe(400);
    expect((await http.get(`/api/rooms/${room.id}/messages?limit=0`, token)).status).toBe(400);
    expect((await http.get(`/api/rooms/${room.id}/messages?before=${foreign.id}`, token)).status).toBe(422);
  });
});

describe("message search", () => {
  async function world() {
    const f = await fullApp();
    const a = await mkRoom(f.ctx, f.wsId, { contact: { name: "Aya" } });
    const b = await mkRoom(f.ctx, f.wsId, { contact: { name: "Bo" } });
    await contactSays(f.ctx, a.room, "Where is my invoice #42?");
    await contactSays(f.ctx, a.room, "100% sure it's 50_50");
    await contactSays(f.ctx, b.room, "Robert'); DROP TABLE messages;--");
    await agentSays(f.ctx, f.owner, b.room.id, "secret plan", { kind: "note" });
    return { ...f, a, b };
  }
  it("finds literal substrings case-insensitively", async () => {
    const { ctx, owner } = await world();
    expect(await searchMessages(ctx, owner, { q: "INVOICE", limit: 10 })).toHaveLength(1);
    expect((await searchMessages(ctx, owner, { q: "#42", limit: 10 }))[0]!.contact_name).toBe("Aya");
  });
  it("returns nothing for no match", async () => {
    const { ctx, owner } = await world();
    expect(await searchMessages(ctx, owner, { q: "zebra", limit: 10 })).toEqual([]);
  });
  it("treats %, _, quotes and SQL fragments as plain text", async () => {
    const { ctx, owner } = await world();
    expect(await searchMessages(ctx, owner, { q: "%", limit: 10 })).toHaveLength(1);
    expect(await searchMessages(ctx, owner, { q: "50_50", limit: 10 })).toHaveLength(1);
    expect(await searchMessages(ctx, owner, { q: "5_50", limit: 10 })).toHaveLength(0);
    expect(await searchMessages(ctx, owner, { q: "'); DROP TABLE messages;--", limit: 10 })).toHaveLength(1);
    expect(await searchMessages(ctx, owner, { q: "\\", limit: 10 })).toHaveLength(0);
  });
  it("respects scope and room filter, excludes deleted and system lines", async () => {
    const { ctx, wsId, owner, a, b } = await world();
    const outsider = await addMemberRaw(ctx, wsId, { name: "Out" });
    expect(await searchMessages(ctx, outsider, { q: "invoice", limit: 10 })).toEqual([]);
    expect(await searchMessages(ctx, owner, { q: "invoice", room_id: b.room.id, limit: 10 })).toEqual([]);
    expect(await searchMessages(ctx, owner, { q: "Conversation started", limit: 10 })).toEqual([]);
    const hit = (await searchMessages(ctx, owner, { q: "invoice", limit: 10 }))[0]!;
    await deleteMessage(ctx, owner, hit.id);
    expect(await searchMessages(ctx, owner, { q: "invoice", limit: 10 })).toEqual([]);
    expect(a.room.id).toBeTruthy();
  });
  it("is exposed over HTTP and validates q", async () => {
    const { http, token } = await world();
    expect((await http.get("/api/messages/search?q=invoice", token)).body.data).toHaveLength(1);
    expect((await http.get("/api/messages/search?q=", token)).status).toBe(400);
    expect((await http.get("/api/messages/search?q=%25", token)).body.data).toHaveLength(1);
  });
});

describe("edit and delete", () => {
  it("lets an agent edit their own chat message within the window, not after, not others'", async () => {
    const { ctx, wsId, owner } = await fullApp();
    await setSettings(ctx, wsId, { edit_window_seconds: 60 });
    const { room } = await mkRoom(ctx, wsId);
    const m = await agentSays(ctx, owner, room.id, "typo");
    ctx.clockCtl.advance(59_000);
    const edited = await editMessage(ctx, owner, m.id, { content: "fixed" });
    expect(edited.content).toBe("fixed");
    expect(edited.edited_at).toBeTruthy();
    ctx.clockCtl.advance(2_000);
    await expect(() => editMessage(ctx, owner, m.id, { content: "late" })).rejects.toThrow(/edit window/);
    const other = await addMemberRaw(ctx, wsId, { name: "Mia", role: "manager" });
    const m2 = await agentSays(ctx, owner, room.id, "mine");
    await expect(() => editMessage(ctx, other, m2.id, { content: "hijack" })).rejects.toThrow(/your own/);
  });
  it("disables editing when the window is 0 and refuses sent sms/email and contact messages", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const m = await agentSays(ctx, owner, room.id, "x");
    await setSettings(ctx, wsId, { edit_window_seconds: 0 });
    await expect(() => editMessage(ctx, owner, m.id, { content: "y" })).rejects.toThrow(/disabled/);
    await setSettings(ctx, wsId, { edit_window_seconds: 900 });
    const c = await contactSays(ctx, room, "theirs");
    await expect(() => editMessage(ctx, owner, c.id, { content: "y" })).rejects.toThrow(/your own/);
    const emailish = (
      await insertMessage(ctx, { workspaceId: wsId, roomId: room.id, senderType: "agent", senderId: owner.memberId, kind: "text", source: "email", content: "e" })
    ).message;
    await expect(() => editMessage(ctx, owner, emailish.id, { content: "y" })).rejects.toThrow(/cannot be recalled/);
  });
  it("lets agents delete their own messages and managers delete any; system lines are protected", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const agent = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const { room } = await mkRoom(ctx, wsId, { assignees: [agent] });
    const mine = await agentSays(ctx, agent, room.id, "mine");
    const theirs = await contactSays(ctx, room, "contact says");
    await deleteMessage(ctx, agent, mine.id);
    await expect(Promise.resolve().then(() => deleteMessage(ctx, agent, theirs.id))).rejects.toThrow(/your own/);
    await deleteMessage(ctx, owner, theirs.id);
    const sys = (await messagesOf(ctx, room.id)).find((m) => m.kind === "system")!;
    await expect(() => deleteMessage(ctx, owner, sys.id)).rejects.toThrow(/System messages/);
    expect((await roomRow(ctx, room.id)).last_message_id).not.toBe(theirs.id);
  });
  it("points the room's last message at the previous survivor and emits message:deleted", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const first = await contactSays(ctx, room, "first");
    const second = await agentSays(ctx, owner, room.id, "second");
    ctx.bus.clear();
    await deleteMessage(ctx, owner, second.id);
    // the auto-assignment system line written after the reply is not a "last message"
    expect((await roomRow(ctx, room.id)).last_message_id).toBe(first.id);
    expect(ctx.bus.ofType("message:deleted")[0]!.payload).toEqual({ message_id: second.id, room_id: room.id });
  });
  it("edit/delete over HTTP", async () => {
    const { ctx, wsId, http, token } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const sent = await http.post(`/api/rooms/${room.id}/messages`, { content: "oops" }, token);
    expect((await http.patch(`/api/messages/${sent.body.id}`, { content: "fixed" }, token)).body.content).toBe("fixed");
    expect((await http.del(`/api/messages/${sent.body.id}`, token)).status).toBe(204);
    expect((await http.del(`/api/messages/${sent.body.id}`, token)).status).toBe(404);
  });
});

describe("notes, kinds and validation", () => {
  it("rejects invalid kind/source combinations", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const send = (input: any) => sendAgentMessage(ctx, owner, room.id, input);
    await expect(send({ kind: "note", source: "sms", content: "x" })).rejects.toThrow(/always dm/);
    await expect(send({ kind: "image", source: "dm" })).rejects.toThrow(/needs an attachment/);
    await expect(send({ kind: "text", source: "dm", content: "x", attachment_ids: ["att_1"] })).rejects.toThrow(/Attachments are only/);
    await expect(send({ kind: "ref", source: "dm", content: "x" })).rejects.toThrow(/ref_message_id/);
    await expect(send({ kind: "ref", source: "dm", content: "x", ref_message_id: "msg_nope" })).rejects.toThrow(/Quoted message/);
    await expect(send({ kind: "text", source: "dm", content: "   " })).rejects.toThrow(/empty/);
    await expect(send({ kind: "system", source: "dm", content: "x" })).rejects.toThrow(/System messages/);
    await expect(send({ kind: "gif", source: "dm", content: "not a url" })).rejects.toThrow(/https URL/);
  });
  it("quotes (ref) an existing message and exposes the quote", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const orig = await contactSays(ctx, room, "Original question");
    const reply = await sendAgentMessage(ctx, owner, room.id, { kind: "ref", source: "dm", content: "Answer", ref_message_id: orig.id });
    const dto = (await (await listMessagesForAgent(ctx, owner, room.id, { limit: 50 })).data.find((m) => m.id === reply.message.id))!;
    expect(dto.ref).toMatchObject({ id: orig.id, snippet: "Original question", sender_type: "contact" });
  });
  it("parses @mentions to seat ids (token and handle forms), ignoring unknown and out-of-scope seats", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann", email: "ann@acme.test", role: "manager" });
    const bo = await addMemberRaw(ctx, wsId, { name: "Bo", email: "bo@acme.test", inbox_visibility: "assigned" });
    const { room } = await mkRoom(ctx, wsId);
    const ids = await parseMentions(ctx, wsId, room, `hi @[Ann](${ann.memberId}) and @ann, @bo and @nobody and @[X](mem_ffffffffffffffffffffffff)`);
    expect(ids).toEqual([ann.memberId]);
    await assignRoom(ctx, owner, room.id, { member_ids: [bo.memberId] });
    expect((await parseMentions(ctx, wsId, room, "@bo")).sort()).toEqual([bo.memberId]);
  });
  it("notes are team-only on the realtime channel and notify mentioned seats", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const ann = await addMemberRaw(ctx, wsId, { name: "Ann", role: "manager" });
    const { room } = await mkRoom(ctx, wsId);
    ctx.bus.clear();
    await agentSays(ctx, owner, room.id, `look @[Ann](${ann.memberId})`, { kind: "note" });
    await ctx.background.settle();
    const ev = ctx.bus.ofType("message:new").find((e) => e.payload.message.kind === "note")!;
    expect(ev.visitor).toBeUndefined();
    const n = await ctx.db.all("SELECT type, member_id FROM notifications WHERE room_id = ?", room.id);
    expect(n).toEqual([{ type: "mention", member_id: ann.memberId }]);
    ctx.bus.clear();
    await agentSays(ctx, owner, room.id, "to the customer");
    expect(ctx.bus.ofType("message:new").find((e) => e.payload.message.content === "to the customer")!.visitor).toBeDefined();
  });
  it("sanitises html content on send", async () => {
    const { ctx, wsId, owner } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const m = await agentSays(ctx, owner, room.id, '<p onclick="x()">hi</p><script>bad()</script>', { format: "html" });
    expect(m.content).toBe("<p>hi</p>");
    const t = await agentSays(ctx, owner, room.id, "<b>not bold</b>");
    expect(t.content).toBe("&lt;b&gt;not bold&lt;/b&gt;");
  });
  it("rate limits sends per seat", async () => {
    const { ctx, wsId, http, token } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await http.post(`/api/rooms/${room.id}/messages`, { content: `m${i}` }, token)).status;
    expect(last).toBe(429);
  });
});

describe("unread math (computed from read cursors)", () => {
  async function world() {
    const f = await fullApp();
    const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann", role: "manager" });
    const bo = await addMemberRaw(f.ctx, f.wsId, { name: "Bo", role: "manager" });
    const { room } = await mkRoom(f.ctx, f.wsId);
    return { ...f, ann, bo, room };
  }
  it("counts contact messages, excluding notes, system lines and my own messages", async () => {
    const { ctx, owner, ann, room } = await world();
    await contactSays(ctx, room, "one");
    await contactSays(ctx, room, "two");
    await agentSays(ctx, owner, room.id, "internal", { kind: "note" });
    await agentSays(ctx, owner, room.id, "owner reply"); // auto-assigns to owner
    expect(await unreadCount(ctx, room.id, owner.memberId)).toBe(2); // owner's own reply excluded
    expect(await unreadCount(ctx, room.id, ann.memberId)).toBe(0); // assigned to owner, so not Ann's
  });
  it("counts for everyone while the room is unassigned; only for the assignee once assigned", async () => {
    const { ctx, owner, ann, bo, room } = await world();
    await contactSays(ctx, room, "hello");
    expect([await unreadCount(ctx, room.id, owner.memberId), await unreadCount(ctx, room.id, ann.memberId), await unreadCount(ctx, room.id, bo.memberId)]).toEqual([
      1, 1, 1,
    ]);
    await assignRoom(ctx, owner, room.id, { member_ids: [ann.memberId] });
    expect([await unreadCount(ctx, room.id, owner.memberId), await unreadCount(ctx, room.id, ann.memberId), await unreadCount(ctx, room.id, bo.memberId)]).toEqual([
      0, 1, 0,
    ]);
  });
  it("other agents' replies are unread for me when I am assigned", async () => {
    const { ctx, ann, bo, owner, room } = await world();
    await assignRoom(ctx, owner, room.id, { member_ids: [ann.memberId, bo.memberId] });
    await agentSays(ctx, bo, room.id, "from bo");
    expect(await unreadCount(ctx, room.id, ann.memberId)).toBe(1);
    expect(await unreadCount(ctx, room.id, bo.memberId)).toBe(0);
  });
  it("mark-read moves the cursor, only forward; backwards is a no-op; unrelated cursors stay put", async () => {
    const { ctx, owner, ann, room } = await world();
    const m1 = await contactSays(ctx, room, "1");
    const m2 = await contactSays(ctx, room, "2");
    const m3 = await contactSays(ctx, room, "3");
    let r = await markRead(ctx, owner, room.id, m2.id);
    expect(r).toMatchObject({ last_read_seq: m2.seq, unread_count: 1, moved: true });
    r = await markRead(ctx, owner, room.id, m1.id);
    expect(r).toMatchObject({ last_read_seq: m2.seq, unread_count: 1, moved: false });
    r = await markRead(ctx, owner, room.id, m2.id);
    expect(r.moved).toBe(false);
    r = await markRead(ctx, owner, room.id, m3.id);
    expect(r).toMatchObject({ unread_count: 0, moved: true });
    expect(await unreadCount(ctx, room.id, ann.memberId)).toBe(3);
    await contactSays(ctx, room, "4");
    expect(await unreadCount(ctx, room.id, owner.memberId)).toBe(1);
  });
  it("marking the last message (cursor at/after the end) leaves zero unread and later messages count again", async () => {
    const { ctx, owner, room } = await world();
    await contactSays(ctx, room, "a");
    const last = await contactSays(ctx, room, "b");
    expect((await markRead(ctx, owner, room.id, last.id)).unread_count).toBe(0);
    expect((await markRead(ctx, owner, room.id, last.id)).unread_count).toBe(0);
  });
  it("is a single bounded UPDATE: no message rows are read or written, and foreign messages are rejected", async () => {
    const { ctx, owner, room, wsId } = await world();
    for (let i = 0; i < 300; i++) await contactSays(ctx, room, `bulk ${i}`);
    const last = (await messagesOf(ctx, room.id)).pop()!;
    const before = (await ctx.db.get<{ n: number }>("SELECT total_changes() n"))!.n;
    await markRead(ctx, owner, room.id, last.id);
    const after = (await ctx.db.get<{ n: number }>("SELECT total_changes() n"))!.n;
    expect(after - before).toBe(1);
    expect(await ctx.db.get("SELECT COUNT(*) n FROM messages WHERE room_id = ? AND deleted_at IS NOT NULL", room.id)).toEqual({ n: 0 });
    const other = await mkRoom(ctx, wsId);
    const foreign = await contactSays(ctx, other.room, "elsewhere");
    await expect(() => markRead(ctx, owner, room.id, foreign.id)).rejects.toThrow(/not found/);
  });
  it("emits a receipt only when the cursor actually moves", async () => {
    const { ctx, owner, room } = await world();
    const m = await contactSays(ctx, room, "x");
    ctx.bus.clear();
    await markRead(ctx, owner, room.id, m.id);
    await markRead(ctx, owner, room.id, m.id);
    const receipts = ctx.bus.ofType("message:receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.payload).toMatchObject({ room_id: room.id, up_to_seq: m.seq, reader: { type: "agent", id: owner.memberId } });
    expect(receipts[0]!.visitor).toMatchObject({ reader: { type: "agent" } });
    expect(ctx.bus.ofType("room:unread")[0]!.payload).toEqual({ room_id: room.id, unread_count: 0 });
  });
  it("room list and HTTP expose the computed unread count", async () => {
    const { ctx, http, token, owner, room } = await world();
    await contactSays(ctx, room, "a");
    await contactSays(ctx, room, "b");
    expect((await getRoomDto(ctx, owner, room.id)).unread_count).toBe(2);
    expect((await http.get("/api/rooms", token)).body.data[0].unread_count).toBe(2);
    const msgs = (await http.get(`/api/rooms/${room.id}/messages`, token)).body.data;
    const res = await http.post(`/api/rooms/${room.id}/read`, { message_id: msgs[msgs.length - 1].id }, token);
    expect(res.body.unread_count).toBe(0);
    expect(await roomRow(ctx, room.id)).toBeTruthy();
    expect((await http.get("/api/inboxes/counts", token)).body.unread_rooms).toBe(0);
  });
});
