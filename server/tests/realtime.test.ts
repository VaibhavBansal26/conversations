import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignRoom, findOrCreateRoom, setStatus } from "../src/services/rooms.js";
import { removeMember, updateMember } from "../src/services/members.js";
import { addInboxMember } from "../src/services/inboxes.js";
import { verifyOtp } from "../src/services/visitors.js";
import { ALL_EVENTS, ack, recorder, sleep, startServer } from "./rt-helpers.js";
import { mkContact, mkInbox, mkRoom } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "40", SOCKET_RATE_PER_SEC: "1000" });
});
afterAll(async () => {
  await srv.close();
});

async function world(name = "Acme") {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, name);
  return { wsId, owner };
}

describe("socket authentication and tenancy", () => {
  it("accepts a team JWT and rejects missing/garbage tokens", async () => {
    const { wsId, owner } = await world();
    const ok = await srv.team(wsId, owner);
    expect(ok.connected).toBe(true);
    await expect(srv.connect(wsId, {})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(srv.connect(wsId, { token: "garbage" })).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
  it("rejects a JWT issued for another workspace on this namespace (cross-tenant)", async () => {
    const a = await world("A");
    const b = await world("B");
    await expect(srv.connect(b.wsId, { token: await (await import("./helpers.js")).tokenFor(srv.ctx, a.owner) })).rejects.toMatchObject({ code: "WRONG_WORKSPACE" });
  });
  it("rejects unknown workspaces and malformed namespace ids", async () => {
    const { owner } = await world();
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, owner);
    await expect(srv.connect("ws_000000000000000000000000", { token })).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
    for (const bad of ["abc", "ws_xyz", "ws_" + "g".repeat(24), "../admin", "ws_" + "a".repeat(23)]) {
      await expect(srv.connect(bad, { token }), bad).rejects.toBeTruthy();
    }
  });
  it("accepts a visitor session for its own workspace only", async () => {
    const a = await world("A");
    const b = await world("B");
    const v = await srv.visitor(a.wsId);
    const ok = await srv.connect(a.wsId, v.auth);
    expect(ok.connected).toBe(true);
    // the same valid token against another tenant's namespace must fail
    await expect(srv.connect(b.wsId, v.auth)).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });
  it("rejects expired sessions, wrong devices, bad origins and revoked tokens for visitors", async () => {
    const { wsId, owner } = await world();
    const v = await srv.visitor(wsId);
    await expect(srv.connect(wsId, { ...v.auth, deviceId: "some-other-device" })).rejects.toMatchObject({ code: "SESSION_DEVICE_MISMATCH" });
    await expect(srv.connect(wsId, v.auth, { origin: "https://evil.example.org" })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect((await srv.connect(wsId, v.auth, { origin: "https://chat.example.com" })).connected).toBe(true);
    const v2 = await srv.visitor(wsId, "chat.example.com", "device-rt-0002");
    srv.ctx.db.run("UPDATE tokens SET status = 'revoked' WHERE id = ?", v2.tokenRow.id);
    await expect(srv.connect(wsId, v2.auth, { origin: "https://chat.example.com" })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    const v3 = await srv.visitor(wsId, "other.example.com", "device-rt-0003");
    srv.ctx.db.run("UPDATE visitor_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", v3.session.id);
    await expect(srv.connect(wsId, v3.auth)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(owner.memberId).toBeTruthy();
  });
});

describe("realtime chat flow", () => {
  async function chat() {
    const { wsId, owner } = await world();
    const v = await srv.visitor(wsId);
    const agent = await srv.team(wsId, owner);
    const agentRec = recorder(agent, ALL_EVENTS);
    const vis = await srv.connect(wsId, v.auth);
    const visRec = recorder(vis, ALL_EVENTS);
    const room = await ack(vis, "room:create", {});
    expect(room.ok).toBe(true);
    await sleep(50);
    return { wsId, owner, v, agent, agentRec, vis, visRec, roomId: room.room.id as string };
  }

  it("visitor message reaches the agent; agent reply reaches the visitor; receipts flow both ways", async () => {
    const c = await chat();
    const sent = await ack(c.vis, "message:send", { room_id: c.roomId, kind: "text", source: "dm", content: "Hello, I need help", client_msg_id: "rt-visitor-0001" });
    expect(sent).toMatchObject({ ok: true, created: true, message: { content: "Hello, I need help", client_msg_id: "rt-visitor-0001" } });
    const atAgent = await c.agentRec.waitFor("message:new", (p) => p.message.content === "Hello, I need help");
    expect(atAgent.message.sender.type).toBe("contact");
    expect(atAgent.room).toMatchObject({ id: c.roomId, status: "open" });

    const reply = await ack(c.agent, "message:send", { room_id: c.roomId, kind: "text", source: "dm", content: "Happy to help!", client_msg_id: "rt-agent-0001" });
    expect(reply.ok).toBe(true);
    const atVisitor = await c.visRec.waitFor("message:new", (p) => p.message.content === "Happy to help!");
    expect(atVisitor.message.sender).toMatchObject({ type: "agent", name: "Olivia Owner" });

    const read = await ack(c.vis, "message:read", { room_id: c.roomId, message_id: atVisitor.message.id });
    expect(read).toMatchObject({ ok: true, moved: true });
    const receiptAtAgent = await c.agentRec.waitFor("message:receipt", (p) => p.reader.type === "contact");
    expect(receiptAtAgent.up_to_message_id).toBe(atVisitor.message.id);

    const agentRead = await ack(c.agent, "message:read", { room_id: c.roomId, message_id: atAgent.message.id });
    expect(agentRead.ok).toBe(true);
    const receiptAtVisitor = await c.visRec.waitFor("message:receipt", (p) => p.reader.type === "agent");
    expect(receiptAtVisitor.up_to_seq).toBe(atAgent.message.seq);
    expect(receiptAtVisitor.reader).toEqual({ type: "agent" });
  });

  it("is idempotent on client_msg_id over sockets (duplicate send returns the original, no second broadcast)", async () => {
    const c = await chat();
    const payload = { room_id: c.roomId, kind: "text", source: "dm", content: "once", client_msg_id: "rt-dup-000001" };
    const [a, b] = await Promise.all([ack(c.vis, "message:send", payload), ack(c.vis, "message:send", payload)]);
    expect(a.message.id).toBe(b.message.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    await sleep(80);
    expect(c.agentRec.of("message:new").filter((p) => p.message.content === "once")).toHaveLength(1);
  });

  it("keeps internal notes away from visitors and from typing indicators marked internal", async () => {
    const c = await chat();
    await ack(c.agent, "message:send", { room_id: c.roomId, kind: "note", source: "dm", content: "secret note", client_msg_id: "rt-note-00001" });
    await ack(c.agent, "message:send", { room_id: c.roomId, kind: "text", source: "dm", content: "public reply", client_msg_id: "rt-pub-000001" });
    await c.visRec.waitFor("message:new", (p) => p.message.content === "public reply");
    expect(c.visRec.of("message:new").some((p) => p.message.content === "secret note")).toBe(false);
    c.agent.emit("typing", { room_id: c.roomId, typing: true, internal: true });
    c.agent.emit("typing", { room_id: c.roomId, typing: true });
    await c.visRec.waitFor("typing");
    await sleep(80);
    expect(c.visRec.of("typing")).toHaveLength(1);
    expect(c.visRec.of("typing")[0].who).toEqual({ type: "agent", name: "Olivia Owner" });
  });

  it("relays visitor typing to the team, and message:updated / message:deleted to everyone concerned", async () => {
    const c = await chat();
    c.vis.emit("typing", { room_id: c.roomId, typing: true });
    expect((await c.agentRec.waitFor("typing")).who.type).toBe("contact");
    const sent = await ack(c.agent, "message:send", { room_id: c.roomId, kind: "text", source: "dm", content: "oops", client_msg_id: "rt-edit-00001" });
    const { editMessage, deleteMessage } = await import("../src/services/messages.js");
    editMessage(srv.ctx, c.owner, sent.message.id, { content: "fixed" });
    expect((await c.visRec.waitFor("message:updated", (p) => p.message.id === sent.message.id)).message.content).toBe("fixed");
    deleteMessage(srv.ctx, c.owner, sent.message.id);
    expect(await c.visRec.waitFor("message:deleted", (p) => p.message_id === sent.message.id)).toEqual({ message_id: sent.message.id, room_id: c.roomId });
    expect((await c.agentRec.waitFor("message:deleted", (p) => p.message_id === sent.message.id)).room_id).toBe(c.roomId);
  });

  it("visitors cannot send notes, other sources, or use team-only events", async () => {
    const c = await chat();
    expect(await ack(c.vis, "message:send", { room_id: c.roomId, kind: "note", source: "dm", content: "x" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await ack(c.vis, "message:send", { room_id: c.roomId, kind: "text", source: "sms", content: "x" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await ack(c.vis, "room:update", { room_id: c.roomId, status: "closed" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await ack(c.vis, "room:assign", { room_id: c.roomId, member_ids: [] })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await ack(c.vis, "presence:list")).toMatchObject({ ok: false });
    expect(await ack(c.agent, "otp:verify", { code: "12345" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("verifies OTP over the socket and widens the visitor's rooms", async () => {
    const { wsId } = await world();
    const a = await srv.visitor(wsId, "chat.example.com", "device-rt-0010", { email: "pat@example.test" });
    const sa = await srv.connect(wsId, a.auth);
    const roomA = await ack(sa, "room:create", {});
    const b = await srv.visitor(wsId, "chat.example.com", "device-rt-0011", { email: "pat@example.test" });
    const sb = await srv.connect(wsId, b.auth);
    const rec = recorder(sb, ALL_EVENTS);
    expect(await ack(sb, "room:create", {})).toMatchObject({ ok: false, error: { code: "VERIFICATION_REQUIRED" } });
    expect(await ack(sb, "otp:verify", { code: "12345" })).toMatchObject({ ok: false, error: { code: "NO_ACTIVE_OTP" } });
    expect(await ack(sb, "otp:verify", { code: "abc" })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    // issue a code the same way the REST endpoint does
    const { sendOtp } = await import("../src/services/visitors.js");
    await sendOtp(srv.ctx, b.session);
    const code = /code is (\d{5})/.exec(srv.ctx.email.sent.at(-1)!.text)![1]!;
    expect(await ack(sb, "otp:verify", { code })).toMatchObject({ ok: true, verified: true });
    await rec.waitFor("session:verified");
    const msg = await ack(sb, "message:send", { room_id: roomA.room.id, kind: "text", source: "dm", content: "now I can chat" });
    expect(msg.ok).toBe(true);
    void verifyOtp;
  });
});

describe("per-event authorization (scope is re-checked on every event)", () => {
  async function scoped() {
    const { wsId, owner } = await world();
    const ann = await srv.addMemberRaw(srv.ctx, wsId, { name: "Ann", inbox_visibility: "assigned_inbox" });
    const bob = await srv.addMemberRaw(srv.ctx, wsId, { name: "Bob", inbox_visibility: "assigned" });
    const inbox = mkInbox(srv.ctx, owner, { name: "Team", member_ids: [ann.memberId] });
    const ownerS = await srv.team(wsId, owner);
    const annS = await srv.team(wsId, ann);
    const bobS = await srv.team(wsId, bob);
    return { wsId, owner, ann, bob, inbox, ownerS, annS, bobS, ownerR: recorder(ownerS, ALL_EVENTS), annR: recorder(annS, ALL_EVENTS), bobR: recorder(bobS, ALL_EVENTS) };
  }

  it("only seats that can see a room receive its events", async () => {
    const w = await scoped();
    const { room } = mkRoom(srv.ctx, w.wsId, { inboxId: w.inbox.id });
    await sleep(40);
    const { sendAgentMessage } = await import("../src/services/messages.js");
    await sendAgentMessage(srv.ctx, w.owner, room.id, { kind: "text", source: "dm", content: "to the inbox", client_msg_id: "rt-scope-0001" });
    await w.annR.waitFor("message:new", (p) => p.message.content === "to the inbox");
    await w.ownerR.waitFor("message:new", (p) => p.message.content === "to the inbox");
    await sleep(60);
    expect(w.bobR.of("message:new").some((p) => p.message.content === "to the inbox")).toBe(false);
    expect(w.bobR.of("room:new")).toHaveLength(0);
  });

  it("assignment grants live access (room:new) and unassignment revokes it (room:deleted, no more events)", async () => {
    const w = await scoped();
    const { room } = mkRoom(srv.ctx, w.wsId);
    await sleep(40);
    assignRoom(srv.ctx, w.owner, room.id, { member_ids: [w.bob.memberId] });
    await w.bobR.waitFor("room:new", (p) => p.room.id === room.id);
    const { sendAgentMessage } = await import("../src/services/messages.js");
    await sendAgentMessage(srv.ctx, w.owner, room.id, { kind: "text", source: "dm", content: "bob can see this", client_msg_id: "rt-assign-001" });
    await w.bobR.waitFor("message:new", (p) => p.message.content === "bob can see this");
    assignRoom(srv.ctx, w.owner, room.id, { member_ids: [w.owner.memberId] });
    await w.bobR.waitFor("room:deleted", (p) => p.room_id === room.id);
    await sendAgentMessage(srv.ctx, w.owner, room.id, { kind: "text", source: "dm", content: "bob must not see this", client_msg_id: "rt-assign-002" });
    await sleep(80);
    expect(w.bobR.of("message:new").some((p) => p.message.content === "bob must not see this")).toBe(false);
  });

  it("joining an inbox later opens its existing rooms to the member's live sockets", async () => {
    const w = await scoped();
    const other = mkInbox(srv.ctx, w.owner, { name: "Other" });
    const { room } = mkRoom(srv.ctx, w.wsId, { inboxId: other.id });
    await sleep(40);
    addInboxMember(srv.ctx, w.owner, other.id, w.ann.memberId);
    const { sendAgentMessage } = await import("../src/services/messages.js");
    await sleep(40);
    await sendAgentMessage(srv.ctx, w.owner, room.id, { kind: "text", source: "dm", content: "welcome to the inbox", client_msg_id: "rt-inbox-001" });
    await w.annR.waitFor("message:new", (p) => p.message.content === "welcome to the inbox");
  });

  it("events on rooms outside scope fail with NOT_FOUND (message:send, message:read, room:update, room:assign, typing)", async () => {
    const w = await scoped();
    const { room } = mkRoom(srv.ctx, w.wsId, { assignees: [w.ann] });
    const { room: other } = mkRoom(srv.ctx, w.wsId, { assignees: [w.owner] });
    const probes: [string, object][] = [
      ["message:send", { room_id: other.id, kind: "text", source: "dm", content: "x" }],
      ["message:read", { room_id: other.id, message_id: "msg_x" }],
      ["room:update", { room_id: other.id, status: "closed" }],
      ["room:assign", { room_id: other.id, member_ids: [w.ann.memberId] }],
      ["typing", { room_id: other.id, typing: true }],
    ];
    for (const [event, payload] of probes) {
      const r = await ack(w.annS, event, payload);
      expect(r, event).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    expect(srv.ctx.db.get<{ status: string }>("SELECT status FROM rooms WHERE id = ?", other.id)!.status).toBe("open");
    // inside scope everything works
    expect((await ack(w.annS, "room:update", { room_id: room.id, priority: 1 })).ok).toBe(true);
    // agents may assign themselves but not colleagues
    expect(await ack(w.annS, "room:assign", { room_id: room.id, member_ids: [w.owner.memberId] })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("a demoted/removed seat loses access on its very next event, and removed seats are disconnected", async () => {
    const w = await scoped();
    const { room } = mkRoom(srv.ctx, w.wsId, { assignees: [w.bob] });
    expect((await ack(w.bobS, "room:update", { room_id: room.id, priority: 1 })).ok).toBe(true);
    srv.ctx.db.run("UPDATE room_assignees SET member_id = ? WHERE room_id = ?", w.owner.memberId, room.id); // lose access behind the socket's back
    expect(await ack(w.bobS, "room:update", { room_id: room.id, priority: 0 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const gone = new Promise((r) => w.bobS.once("disconnect", r));
    removeMember(srv.ctx, w.owner, w.bob.memberId, () => {});
    await gone;
    expect(w.bobS.connected).toBe(false);
    updateMember(srv.ctx, w.owner, w.ann.memberId, { inbox_visibility: "assigned" });
  });

  it("agents can only update status/priority/snooze through room:update when allowed, with validation", async () => {
    const w = await scoped();
    const { room } = mkRoom(srv.ctx, w.wsId, { assignees: [w.ann] });
    expect((await ack(w.annS, "room:update", { room_id: room.id, status: "closed" })).room.status).toBe("closed");
    expect((await ack(w.annS, "room:update", { room_id: room.id, status: "open" })).room.status).toBe("open");
    expect(await ack(w.annS, "room:update", { room_id: room.id })).toMatchObject({ ok: false, error: { code: "NOTHING_TO_UPDATE" } });
    expect(await ack(w.annS, "room:update", { room_id: room.id, snooze_until: "2001-01-01T00:00:00Z" })).toMatchObject({ ok: false, error: { code: "INVALID_SNOOZE" } });
    const until = new Date(Date.now() + 3600_000).toISOString();
    expect((await ack(w.annS, "room:update", { room_id: room.id, snooze_until: until })).room.snooze_until).toBe(until);
    expect((await ack(w.annS, "room:update", { room_id: room.id, snooze_until: null })).room.snooze_until).toBeNull();
    expect(await ack(w.annS, "room:update", { room_id: room.id, priority: 5 })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("room:create by an agent starts a conversation and reports duplicates", async () => {
    const w = await scoped();
    const c = mkContact(srv.ctx, w.wsId, { name: "Dana" });
    const r = await ack(w.annS, "room:create", { contact_id: c.id });
    expect(r).toMatchObject({ ok: true, created: true });
    expect((await ack(w.annS, "room:create", { contact_id: c.id })).created).toBe(false);
    expect(await ack(w.annS, "room:create", {})).toMatchObject({ ok: false, error: { code: "CONTACT_REQUIRED" } });
    expect(findOrCreateRoom.length).toBeGreaterThan(0);
  });
});

describe("robustness: malformed payloads and rate limiting", () => {
  it("answers malformed payloads with VALIDATION_ERROR instead of crashing", async () => {
    const { wsId, owner } = await world();
    const s = await srv.team(wsId, owner);
    for (const bad of [undefined, null, 42, "text", [], {}, { room_id: 5 }, { room_id: "x".repeat(200), content: "x" }, { room_id: "r", kind: "bogus" }, { room_id: "r", content: "x".repeat(20001) }, { room_id: "r", client_msg_id: "short" }]) {
      const r = await ack(s, "message:send", bad);
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: expect.stringMatching(/VALIDATION_ERROR/) } });
    }
    expect(s.connected).toBe(true);
    expect(await ack(s, "message:read", { room_id: "r" })).toMatchObject({ ok: false });
    expect(await ack(s, "typing", { room_id: "r", typing: "yes" })).toMatchObject({ ok: false });
    // no ack callback and unknown events are tolerated
    s.emit("message:send", { nope: true });
    s.emit("totally:unknown", {});
    expect((await ack(s, "presence:list")).ok).toBe(true);
  });

  it("rate limits events per socket", async () => {
    const limited = await startServer({ SOCKET_RATE_BURST: "5", SOCKET_RATE_PER_SEC: "0.1" });
    try {
      const { wsId, owner } = await limited.seedWorkspace(limited.ctx);
      const s = await limited.team(wsId, owner);
      const results = [];
      for (let i = 0; i < 8; i++) results.push(await ack(s, "presence:list"));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results.slice(5).every((r) => r.error?.code === "RATE_LIMITED")).toBe(true);
      const other = await limited.team(wsId, owner); // a different socket has its own bucket
      expect((await ack(other, "presence:list")).ok).toBe(true);
    } finally {
      await limited.close();
    }
  });
});

describe("presence (refcounted across tabs, with a grace period)", () => {
  it("stays online while any tab is open; goes offline only after the grace period", async () => {
    const { wsId, owner } = await world();
    const ann = await srv.addMemberRaw(srv.ctx, wsId, { name: "Ann" });
    const watcher = await srv.team(wsId, owner);
    const rec = recorder(watcher, ALL_EVENTS);
    const tab1 = await srv.team(wsId, ann);
    await rec.waitFor("presence:update", (p) => p.member_id === ann.memberId && p.online === true);
    const tab2 = await srv.team(wsId, ann);
    await sleep(50);
    expect(rec.of("presence:update").filter((p) => p.member_id === ann.memberId && p.online)).toHaveLength(1);
    expect((await ack(watcher, "presence:list")).online).toContain(ann.memberId);
    tab1.close();
    await sleep(350); // longer than the 150ms grace
    expect(rec.of("presence:update").some((p) => p.member_id === ann.memberId && p.online === false)).toBe(false);
    expect((await ack(watcher, "presence:list")).online).toContain(ann.memberId);
    tab2.close();
    await rec.waitFor("presence:update", (p) => p.member_id === ann.memberId && p.online === false, 1500);
    expect((await ack(watcher, "presence:list")).online).not.toContain(ann.memberId);
  });
  it("a quick reconnect inside the grace period never flashes offline", async () => {
    const { wsId, owner } = await world();
    const ann = await srv.addMemberRaw(srv.ctx, wsId, { name: "Ann" });
    const watcher = await srv.team(wsId, owner);
    const rec = recorder(watcher, ALL_EVENTS);
    const t1 = await srv.team(wsId, ann);
    await rec.waitFor("presence:update", (p) => p.member_id === ann.memberId);
    t1.close();
    await sleep(40);
    await srv.team(wsId, ann);
    await sleep(300);
    expect(rec.of("presence:update").some((p) => p.member_id === ann.memberId && p.online === false)).toBe(false);
  });
  it("tells the team when a visitor comes and goes", async () => {
    const { wsId, owner } = await world();
    const v = await srv.visitor(wsId, "chat.example.com", "device-rt-0042");
    const vs = await srv.connect(wsId, v.auth);
    const room = await ack(vs, "room:create", {});
    const watcher = await srv.team(wsId, owner);
    const rec = recorder(watcher, ALL_EVENTS);
    vs.close();
    await sleep(40);
    const vs2 = await srv.connect(wsId, v.auth);
    vs2.close();
    await rec.waitFor("visitor:presence", (p) => p.room_id === room.room.id && p.online === false, 1500);
  });
  it("owner-visible presence endpoint reflects online seats", async () => {
    const { wsId, owner } = await world();
    const s = await srv.team(wsId, owner);
    expect(s.connected).toBe(true);
    const { createApp } = await import("../src/app.js");
    const res = await createApp(srv.ctx).request("/api/presence", { headers: { authorization: `Bearer ${await (await import("./helpers.js")).tokenFor(srv.ctx, owner)}` } });
    expect((await res.json()).online).toContain(owner.memberId);
  });
});

describe("notifications and room events pushed to seats", () => {
  it("delivers notification:new with the unread badge count to the assignee only", async () => {
    const { wsId, owner } = await world();
    const ann = await srv.addMemberRaw(srv.ctx, wsId, { name: "Ann" });
    const annS = await srv.team(wsId, ann);
    const ownerS = await srv.team(wsId, owner);
    const annR = recorder(annS, ALL_EVENTS);
    const ownerR = recorder(ownerS, ALL_EVENTS);
    const { room } = mkRoom(srv.ctx, wsId, { assignees: [ann] });
    await sleep(40);
    const { contactSays } = await import("./helpers.js");
    const { onContactMessage } = await import("../src/services/postProcess.js");
    const m = contactSays(srv.ctx, room, "please help");
    onContactMessage(srv.ctx, room, m);
    await srv.ctx.background.settle();
    const n = await annR.waitFor("notification:new");
    expect(n).toMatchObject({ unread_count: 1, notification: { type: "message", room_id: room.id } });
    await sleep(40);
    expect(ownerR.of("notification:new")).toHaveLength(0);
    setStatus(srv.ctx, owner, room.id, "closed");
    await annR.waitFor("room:updated", (p) => p.room.status === "closed");
  });
});
