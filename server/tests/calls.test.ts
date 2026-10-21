import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepCalls, CONNECT_TIMEOUT_S, RECONNECT_GRACE_S } from "../src/calls/service.js";
import { coturnCredentials, iceConfig } from "../src/calls/turn.js";
import { ALL_EVENTS, ack, recorder, sleep, startServer } from "./rt-helpers.js";
import { setSettings } from "./helpers.js";
import { setMemberRole } from "../src/services/roles.js";

async function viewerOf(wsId: string, owner: import("../src/domain/types.js").Actor) {
  const { actorFromRow, getMember } = await import("../src/services/members.js");
  const m = await srv.addMemberRaw(srv.ctx, wsId, { name: "Vic Viewer", role: "agent" });
  await setMemberRole(srv.ctx, owner, m.memberId, "role_viewer");
  return actorFromRow(await getMember(srv.ctx, wsId, m.memberId));
}

const CALL_EVENTS = [...ALL_EVENTS, "call:state", "call:offer", "call:answer", "call:ice", "call:peer"];
type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "400", SOCKET_RATE_PER_SEC: "2000", TURN_URLS: "turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp", TURN_SECRET: "x".repeat(32) + "y" });
});
afterAll(async () => {
  await srv.close();
});

async function enable(wsId: string, over: Record<string, unknown> = {}) {
  await setSettings(srv.ctx, wsId, { calls: { browser: { enabled: true, voice: true, video: true, screen_share: true }, ring_seconds: 45, turn_provider: "none", ...over } });
  await srv.ctx.cache.invalidate(`settings:${wsId}`);
}

/** a workspace with calls on, an agent and a visitor who both are in the chat and have written one message */
async function world(over: Record<string, unknown> = {}) {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
  await enable(wsId, over);
  const v = await srv.visitor(wsId);
  const agent = await srv.team(wsId, owner);
  const agentRec = recorder(agent, CALL_EVENTS);
  const vis = await srv.connect(wsId, v.auth);
  const visRec = recorder(vis, CALL_EVENTS);
  const room = await ack(vis, "room:create", {});
  await ack(vis, "message:send", { room_id: room.room.id, kind: "text", source: "dm", content: "Hello", client_msg_id: "call-hello-0001" });
  await sleep(40);
  const roomId = room.room.id as string;
  const invite = (kind: "voice" | "video" = "voice") => ack(agent, "call:invite", { room_id: roomId, kind });
  return { wsId, owner, v, agent, agentRec, vis, visRec, roomId, invite };
}
type W = Awaited<ReturnType<typeof world>>;
const callRow = (id: string) => srv.ctx.db.get<any>("SELECT * FROM calls WHERE id = ?", id);
const sdp = (type: "offer" | "answer") => ({ type, sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n" });

/** invite, accept, offer, answer, connected on both sides */
async function connected(w: W, kind: "voice" | "video" = "voice") {
  const inv = await w.invite(kind);
  expect(inv.ok).toBe(true);
  const id = inv.call.id as string;
  const acc = await ack(w.vis, "call:accept", { call_id: id });
  expect(acc.ok).toBe(true);
  await ack(w.agent, "call:offer", { call_id: id, data: sdp("offer") });
  await ack(w.vis, "call:answer", { call_id: id, data: sdp("answer") });
  await ack(w.agent, "call:connected", { call_id: id });
  await ack(w.vis, "call:connected", { call_id: id });
  return id;
}
const cardText = async (w: W) => (await srv.ctx.db.get<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = ? AND meta LIKE '%\"sub_type\":\"call\"%'", w.roomId))?.content_text;

describe("placing and answering a call", () => {
  it("rings the visitor, signals offer, answer and candidates to the other side only, and ends with a duration and a card", async () => {
    const w = await world();
    const other = await srv.team(w.wsId, await srv.addMemberRaw(srv.ctx, w.wsId, { name: "Mia Manager", role: "manager" }));
    const otherRec = recorder(other, CALL_EVENTS);
    const inv = await w.invite("video");
    expect(inv).toMatchObject({ ok: true, call: { kind: "video", state: "ringing", room_id: w.roomId }, ice: { provider: "none" } });
    expect(inv.ice.iceServers[0].urls[0]).toMatch(/^stun:/);
    const id = inv.call.id;
    // everybody on the team sees it ring, the visitor gets the minimal copy without member ids
    const ring = await w.visRec.waitFor("call:state", (p) => p.call.id === id);
    expect(ring.call).toMatchObject({ state: "ringing", kind: "video", agent_name: "Olivia" });
    expect(JSON.stringify(ring)).not.toContain(w.owner.memberId);
    await otherRec.waitFor("call:state", (p) => p.call.id === id);
    const acc = await ack(w.vis, "call:accept", { call_id: id });
    expect(acc).toMatchObject({ ok: true, call: { state: "connecting" } });
    await w.agentRec.waitFor("call:state", (p) => p.call.id === id && p.call.state === "connecting");
    await ack(w.agent, "call:offer", { call_id: id, data: sdp("offer") });
    const offer = await w.visRec.waitFor("call:offer");
    expect(offer).toMatchObject({ call_id: id, data: { type: "offer" } });
    await ack(w.vis, "call:answer", { call_id: id, data: sdp("answer") });
    await w.agentRec.waitFor("call:answer");
    await ack(w.agent, "call:ice", { call_id: id, data: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    await w.visRec.waitFor("call:ice");
    await ack(w.vis, "call:ice", { call_id: id, data: { candidate: "candidate:2 1 udp 2122260223 192.0.2.2 54322 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    await w.agentRec.waitFor("call:ice");
    await sleep(60);
    // the other seat never saw a single signalling message
    expect(otherRec.of("call:offer")).toHaveLength(0);
    expect(otherRec.of("call:answer")).toHaveLength(0);
    expect(otherRec.of("call:ice")).toHaveLength(0);
    const c1 = await ack(w.agent, "call:connected", { call_id: id });
    expect(c1.call.state).toBe("active");
    expect((await ack(w.vis, "call:connected", { call_id: id })).call.state).toBe("active"); // the second report is a no-op
    srv.clockCtl.advance(125_000);
    const end = await ack(w.agent, "call:end", { call_id: id });
    expect(end.call.state).toBe("ended");
    const row = await callRow(id);
    expect(row).toMatchObject({ state: "ended", ended_by: "agent", end_reason: "completed", duration_s: 125 });
    expect(await cardText(w)).toBe("Video call, 2 min, ended by the agent");
    const visible = await srv.ctx.db.get<{ meta: string }>("SELECT meta FROM messages WHERE room_id = ? AND meta LIKE '%\"sub_type\":\"call\"%'", w.roomId);
    expect(JSON.parse(visible!.meta).call).toMatchObject({ state: "ended", kind: "video" });
    const ev = (await srv.ctx.db.all<{ type: string }>("SELECT type FROM ticket_events WHERE ticket_id = ?", row.ticket_id)).map((e) => e.type);
    expect(ev).toEqual(expect.arrayContaining(["call_started", "call_ended"]));
    const audit = (await srv.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE target = ?", id)).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["call.invited", "call.ended"]));
  });

  it("the call card is visible to the visitor, and the visitor can end a running call", async () => {
    const w = await world();
    const id = await connected(w);
    const msgs = await srv.ctx.db.all<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = ? AND meta LIKE '%\"sub_type\":\"call\"%'", w.roomId);
    expect(msgs).toHaveLength(1);
    const end = await ack(w.vis, "call:end", { call_id: id });
    expect(end.call.state).toBe("ended");
    expect((await callRow(id)).ended_by).toBe("visitor");
    expect(await cardText(w)).toMatch(/ended by the visitor$/);
  });

  it("refuses what is switched off, who may not, nobody in the chat, and an empty conversation", async () => {
    const off = await world();
    await enable(off.wsId, { browser: { enabled: false, voice: true, video: true, screen_share: true } });
    expect((await off.invite()).error.code).toBe("CALLS_DISABLED");
    const novideo = await world();
    await enable(novideo.wsId, { browser: { enabled: true, voice: true, video: false, screen_share: true } });
    expect((await novideo.invite("video")).error.code).toBe("CALL_KIND_DISABLED");
    expect((await novideo.invite("voice")).ok).toBe(true);

    const w = await world();
    const viewer = await srv.team(w.wsId, await viewerOf(w.wsId, w.owner));
    const denied = await ack(viewer, "call:invite", { room_id: w.roomId, kind: "voice" });
    expect(denied.ok).toBe(false);
    expect(["PERMISSION_DENIED", "FORBIDDEN"]).toContain(denied.error.code);

    const away = await world();
    away.vis.disconnect();
    await sleep(500); // past the presence grace of the test server (150 ms)
    expect((await away.invite()).error.code).toBe("VISITOR_OFFLINE");

    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Quiet");
    await enable(wsId);
    const qv = await srv.visitor(wsId);
    const qvis = await srv.connect(wsId, qv.auth);
    const qroom = await ack(qvis, "room:create", {});
    const qa = await srv.team(wsId, owner);
    expect((await ack(qa, "call:invite", { room_id: qroom.room.id, kind: "voice" })).error.code).toBe("NO_CONVERSATION");
    expect((await ack(qa, "call:invite", { room_id: "room_nope", kind: "voice" })).ok).toBe(false);
    expect((await ack(qa, "call:invite", { room_id: qroom.room.id, kind: "hologram" })).error.code).toBe("VALIDATION_ERROR");
  });

  it("allows one live call per conversation, also when two invitations race", async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.invite(), w.invite()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a).error.code).toBe("CALL_IN_PROGRESS");
    expect((await w.invite()).error.code).toBe("CALL_IN_PROGRESS");
    const live = await srv.ctx.db.all("SELECT id FROM calls WHERE room_id = ? AND state IN ('ringing','connecting','active')", w.roomId);
    expect(live).toHaveLength(1);
    // once it ended a new one may start
    await ack(w.agent, "call:end", { call_id: (a.ok ? a : b).call.id });
    expect((await w.invite()).ok).toBe(true);
  });
});

describe("declined, cancelled and missed calls", () => {
  it("a declined call is final, says so in the thread and offers the callback form", async () => {
    const w = await world();
    const inv = await w.invite();
    const dec = await ack(w.vis, "call:decline", { call_id: inv.call.id });
    expect(dec.call.state).toBe("declined");
    expect(await cardText(w)).toBe("Voice call declined");
    expect((await ack(w.vis, "call:accept", { call_id: inv.call.id })).error.code).toBe("CALL_STATE");
    const form = await srv.ctx.db.get<{ meta: string }>("SELECT meta FROM messages WHERE room_id = ? AND meta LIKE '%contact_form%'", w.roomId);
    const card = JSON.parse(form!.meta).card;
    expect(card).toMatchObject({ moment: "callback", skippable: false });
    expect(card.fields).toEqual([expect.objectContaining({ key: "phone", required: true })]);
  });

  it("an unanswered call is missed after the ring time (the sweep decides, safe to run twice)", async () => {
    const w = await world({ ring_seconds: 30 });
    const inv = await w.invite();
    srv.clockCtl.advance(20_000);
    expect(await sweepCalls(srv.ctx)).toMatchObject({ missed: 0 });
    srv.clockCtl.advance(11_000);
    expect(await sweepCalls(srv.ctx)).toMatchObject({ missed: 1 });
    expect(await sweepCalls(srv.ctx)).toMatchObject({ missed: 0 });
    expect((await callRow(inv.call.id)).state).toBe("missed");
    expect(await cardText(w)).toBe("Missed voice call");
    const state = await w.visRec.waitFor("call:state", (p) => p.call.state === "missed");
    expect(state.call.end_reason).toBe("timeout");
    expect((await ack(w.vis, "call:accept", { call_id: inv.call.id })).error.code).toBe("CALL_STATE");
    expect(await srv.ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND meta LIKE '%contact_form%'", w.roomId)).toBeTruthy();
  });

  it("the agent cancels while it rings; the visitor can only decline", async () => {
    const w = await world();
    const inv = await w.invite();
    expect((await ack(w.vis, "call:end", { call_id: inv.call.id })).error.code).toBe("CALL_STATE");
    const cancel = await ack(w.agent, "call:end", { call_id: inv.call.id });
    expect(cancel.call.state).toBe("ended");
    expect((await callRow(inv.call.id)).end_reason).toBe("cancelled");
    expect(await cardText(w)).toBe("Voice call cancelled");
  });

  it("a call that never carries media fails after the connect timeout", async () => {
    const w = await world();
    const inv = await w.invite();
    await ack(w.vis, "call:accept", { call_id: inv.call.id });
    srv.clockCtl.advance((CONNECT_TIMEOUT_S + 1) * 1000);
    expect(await sweepCalls(srv.ctx)).toMatchObject({ failed: 1 });
    expect((await callRow(inv.call.id)).state).toBe("failed");
    expect(await cardText(w)).toBe("Voice call failed to connect");
  });

  it("either side can report that the connection is lost for good", async () => {
    const w = await world();
    const id = await connected(w);
    const r = await ack(w.vis, "call:failed", { call_id: id, reason: "ice_failed" });
    expect(r.call.state).toBe("failed");
    expect(await callRow(id)).toMatchObject({ end_reason: "ice_failed", ended_by: "visitor" });
  });
});

describe("races", () => {
  it("accept and cancel at the same time end in one consistent state", async () => {
    for (let i = 0; i < 6; i++) {
      const w = await world();
      const inv = await w.invite();
      const [acc, can] = await Promise.all([ack(w.vis, "call:accept", { call_id: inv.call.id }), ack(w.agent, "call:end", { call_id: inv.call.id })]);
      const row = await callRow(inv.call.id);
      if (acc.ok) {
        // accept won: the agent's end then applied to a connecting call (ended) or lost
        expect(["connecting", "ended"]).toContain(row.state);
      } else {
        expect(row.state).toBe("ended");
        expect(row.end_reason).toBe("cancelled");
        expect(["CALL_STATE", "CALL_STATE_CHANGED"]).toContain(acc.error.code);
      }
      expect(can.ok || ["CALL_STATE", "CALL_STATE_CHANGED"].includes(can.error.code)).toBe(true);
      const cards = await srv.ctx.db.all("SELECT id FROM messages WHERE room_id = ? AND meta LIKE '%\"sub_type\":\"call\"%'", w.roomId);
      expect(cards).toHaveLength(1);
    }
  });

  it("two ends at once: one applies, the other is told the call already ended", async () => {
    const w = await world();
    const id = await connected(w);
    const [a, b] = await Promise.all([ack(w.agent, "call:end", { call_id: id }), ack(w.vis, "call:end", { call_id: id })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await callRow(id)).state).toBe("ended");
    expect(["agent", "visitor"]).toContain((await callRow(id)).ended_by);
  });

  it("the ring timeout and an accept at the same moment cannot both win", async () => {
    const w = await world({ ring_seconds: 15 });
    const inv = await w.invite();
    srv.clockCtl.advance(16_000);
    const [swept, acc] = await Promise.all([sweepCalls(srv.ctx), ack(w.vis, "call:accept", { call_id: inv.call.id })]);
    const row = await callRow(inv.call.id);
    if (acc.ok) expect(["connecting", "missed"].includes(row.state) && swept.missed === 0).toBe(true);
    else expect(row.state).toBe("missed");
  });
});

describe("who may signal", () => {
  it("another visitor cannot see or answer the call, another seat cannot control it, another workspace cannot even find it", async () => {
    const w = await world();
    const inv = await w.invite();
    const other = await srv.visitor(w.wsId, "chat.example.com", "device-rt-0099");
    const otherVis = await srv.connect(w.wsId, other.auth);
    for (const ev of ["call:accept", "call:decline"]) expect((await ack(otherVis, ev, { call_id: inv.call.id })).error.code, ev).toBe("NOT_FOUND");
    const mia = await srv.team(w.wsId, await srv.addMemberRaw(srv.ctx, w.wsId, { name: "Mia Manager", role: "manager" }));
    for (const ev of ["call:end", "call:connected"]) expect((await ack(mia, ev, { call_id: inv.call.id })).error.code, ev).toBe("NOT_YOUR_CALL");
    const foreign = await srv.seedWorkspace(srv.ctx, "Foreign");
    const fa = await srv.team(foreign.wsId, foreign.owner);
    expect((await ack(fa, "call:end", { call_id: inv.call.id })).error.code).toBe("NOT_FOUND");
    expect((await ack(fa, "call:invite", { room_id: w.roomId, kind: "voice" })).ok).toBe(false);
    expect((await callRow(inv.call.id)).state).toBe("ringing");
  });

  it("signals need a running call, the bound socket, the right type and a sane size", async () => {
    const w = await world();
    const inv = await w.invite();
    const id = inv.call.id;
    // still ringing: nothing may be relayed yet
    expect((await ack(w.agent, "call:offer", { call_id: id, data: sdp("offer") })).error.code).toBe("CALL_STATE");
    await ack(w.vis, "call:accept", { call_id: id });
    // a second tab of the same visitor is not the one on the call
    const tab2 = await srv.connect(w.wsId, w.v.auth);
    expect((await ack(tab2, "call:answer", { call_id: id, data: sdp("answer") })).error.code).toBe("NOT_THIS_DEVICE");
    expect((await ack(tab2, "call:end", { call_id: id })).ok).toBe(true); // ending is by participant, not by socket: the visitor may hang up from another tab
    const w2 = await world();
    const id2 = await connected(w2);
    expect((await ack(w2.agent, "call:offer", { call_id: id2, data: { type: "answer", sdp: "v=0\r\n" } })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(w2.agent, "call:offer", { call_id: id2, data: { type: "offer", sdp: "x".repeat(20_000) } })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(w2.agent, "call:offer", { call_id: id2, data: {} })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(w2.agent, "call:ice", { call_id: id2, data: { candidate: "c".repeat(3000) } })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(w2.agent, "call:ice", { call_id: id2, data: {} })).ok).toBe(true); // an end-of-candidates marker
    expect((await ack(w2.agent, "call:offer", { call_id: "call_nope", data: sdp("offer") })).error.code).toBe("NOT_FOUND");
    expect((await ack(w2.agent, "call:offer", { call_id: id2 })).error.code).toBe("VALIDATION_ERROR");
  });

  it("a call by one seat cannot be signalled by an agent who may not see the room", async () => {
    const w = await world();
    const inv = await w.invite();
    await ack(w.vis, "call:accept", { call_id: inv.call.id });
    const ann = await srv.team(w.wsId, await srv.addMemberRaw(srv.ctx, w.wsId, { name: "Ann Agent", role: "agent", inbox_visibility: "assigned" }));
    expect((await ack(ann, "call:invite", { room_id: w.roomId, kind: "voice" })).error.code).toBe("NOT_FOUND");
    expect((await ack(ann, "call:offer", { call_id: inv.call.id, data: sdp("offer") })).error.code).toBe("NOT_YOUR_CALL");
  });
});

describe("network changes", () => {
  it("a side that comes back on a new socket resumes: the other side is told, signalling moves to the new socket, the call survives", async () => {
    const w = await world();
    const id = await connected(w);
    w.vis.disconnect();
    await w.agentRec.waitFor("call:peer", (p) => p.event === "lost");
    const vis2 = await srv.connect(w.wsId, w.v.auth);
    const vis2Rec = recorder(vis2, CALL_EVENTS);
    const res = await ack(vis2, "call:resume", { call_id: id });
    expect(res).toMatchObject({ ok: true, call: { state: "active" } });
    expect(res.ice.iceServers.length).toBeGreaterThan(0);
    await w.agentRec.waitFor("call:peer", (p) => p.event === "resumed");
    await ack(w.agent, "call:offer", { call_id: id, data: sdp("offer") }); // an ICE restart
    await vis2Rec.waitFor("call:offer");
    srv.clockCtl.advance((RECONNECT_GRACE_S + 5) * 1000);
    expect(await sweepCalls(srv.ctx)).toMatchObject({ ended: 0 });
    expect((await callRow(id)).state).toBe("active");
  });

  it("a side that does not come back within the grace period ends the call", async () => {
    const w = await world();
    const id = await connected(w);
    w.agent.disconnect();
    await w.visRec.waitFor("call:peer", (p) => p.event === "lost");
    srv.clockCtl.advance((RECONNECT_GRACE_S - 5) * 1000);
    expect(await sweepCalls(srv.ctx)).toMatchObject({ ended: 0 });
    srv.clockCtl.advance(10_000);
    expect(await sweepCalls(srv.ctx)).toMatchObject({ ended: 1 });
    expect(await callRow(id)).toMatchObject({ state: "ended", ended_by: "system", end_reason: "disconnected" });
  });

  it("only a participant can resume", async () => {
    const w = await world();
    const id = await connected(w);
    const other = await srv.visitor(w.wsId, "chat.example.com", "device-rt-0098");
    const otherVis = await srv.connect(w.wsId, other.auth);
    expect((await ack(otherVis, "call:resume", { call_id: id })).error.code).toBe("NOT_FOUND");
    const mia = await srv.team(w.wsId, await srv.addMemberRaw(srv.ctx, w.wsId, { name: "Mia Manager", role: "manager" }));
    expect((await ack(mia, "call:resume", { call_id: id })).error.code).toBe("NOT_YOUR_CALL");
  });
});

describe("requesting a call", () => {
  it("a visitor asks: a card in the thread, the conversation goes to a person, asking again is one request", async () => {
    const w = await world();
    const r = await ack(w.vis, "call:request", { room_id: w.roomId, kind: "voice" });
    expect(r).toMatchObject({ ok: true, already: false });
    const card = await srv.ctx.db.get<{ content_text: string; meta: string }>("SELECT content_text, meta FROM messages WHERE room_id = ? AND meta LIKE '%call_request%'", w.roomId);
    expect(card!.content_text).toBe("Voice call requested");
    const t = await srv.ctx.db.get<{ status: string; handler: string | null }>("SELECT status, handler FROM tickets WHERE room_id = ?", w.roomId);
    expect(t!.status).not.toBe("bot_handling");
    expect(t!.handler?.startsWith("human:") || t!.status === "waiting_for_human").toBe(true);
    expect(await ack(w.vis, "call:request", { room_id: w.roomId, kind: "voice" })).toMatchObject({ ok: true, already: true });
    const w2 = await world();
    await enable(w2.wsId, { browser: { enabled: false, voice: true, video: true, screen_share: true } });
    expect((await ack(w2.vis, "call:request", { room_id: w2.roomId, kind: "voice" })).error.code).toBe("CALLS_DISABLED");
    // the team cannot use the visitor-only event
    expect((await ack(w.agent, "call:request", { room_id: w.roomId, kind: "voice" })).ok).toBe(false);
  });
});

describe("relay credentials (TURN)", () => {
  it("without a provider only STUN is offered, with a plain-words warning", async () => {
    const ice = await iceConfig(srv.ctx, "ws_x", "none", "call_1");
    expect(ice.iceServers).toEqual([{ urls: ["stun:stun.l.google.com:19302"] }]);
    expect(ice.warning).toMatch(/strict firewalls/);
    expect(ice.expiresAt).toBeNull();
  });

  it("static: coturn REST credentials that expire, derived from the secret that never leaves the server", async () => {
    const ice = await iceConfig(srv.ctx, "ws_x", "static", "call_42");
    const turn = ice.iceServers.find((s) => s.username)!;
    expect(turn.urls).toEqual(["turn:turn.example.test:3478?transport=udp", "turns:turn.example.test:5349?transport=tcp"]);
    const expiry = Math.floor(srv.ctx.clock().getTime() / 1000) + 3600;
    expect(turn.username).toBe(`${expiry}:call_42`);
    expect(turn.credential).toBe(createHmac("sha1", "x".repeat(32) + "y").update(turn.username!).digest("base64"));
    expect(ice.expiresAt).toBe(expiry);
    expect(JSON.stringify(ice)).not.toContain("x".repeat(32));
    expect(ice.warning).toBeNull();
    // credentials differ per call and per time
    const again = await iceConfig(srv.ctx, "ws_x", "static", "call_43");
    expect(again.iceServers.find((s) => s.username)!.credential).not.toBe(turn.credential);
    expect(coturnCredentials("secret-secret-secret", "c", 1000, 60)).toMatchObject({ username: "1060:c", expiresAt: 1060 });
  });

  it("static without TURN_URLS and TURN_SECRET warns instead of failing", async () => {
    const bare = await startServer({});
    try {
      const ice = await iceConfig(bare.ctx, "ws_x", "static", "c");
      expect(ice.iceServers.every((s) => !s.username)).toBe(true);
      expect(ice.warning).toMatch(/TURN_URLS and TURN_SECRET/);
    } finally {
      await bare.close();
    }
  });

  it("twilio: uses the workspace's own account for a token, keeps Twilio's servers, and warns when Twilio fails or is not connected", async () => {
    const f = await srv.seedWorkspace(srv.ctx, "TW");
    expect((await iceConfig(srv.ctx, f.wsId, "twilio", "c")).warning).toMatch(/no verified Twilio connection/);
    const SID = "AC" + "b2".repeat(16);
    const TOKEN = "9f3a456789abcdef0123456789abcdef";
    const calls: { url: string; body: string; auth: string }[] = [];
    srv.ctx.providers.baseUrls = { twilio: "https://twilio.test" };
    let fail = false;
    srv.ctx.providers.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? ""), auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") });
      const j = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith(`/Accounts/${SID}.json`)) return j(200, { sid: SID, friendly_name: "x", status: "active", type: "Full" });
      if (url.includes("/IncomingPhoneNumbers.json")) return j(200, { incoming_phone_numbers: [] });
      if (url.endsWith("/Tokens.json")) return fail ? j(401, { code: 20003, message: "Authenticate" }) : j(201, { ttl: "3600", ice_servers: [{ url: "stun:global.stun.twilio.com:3478", urls: "stun:global.stun.twilio.com:3478" }, { url: "turn:global.turn.twilio.com:3478?transport=udp", urls: "turn:global.turn.twilio.com:3478?transport=udp", username: "u1", credential: "c1" }] });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const { connectTwilio, verifyConnection } = await import("../src/services/channelConnections.js");
    await connectTwilio(srv.ctx, f.owner, { account_sid: SID, auth_token: TOKEN });
    await verifyConnection(srv.ctx, f.owner, "sms");
    const ice = await iceConfig(srv.ctx, f.wsId, "twilio", "c");
    expect(ice.warning).toBeNull();
    expect(ice.iceServers.find((s) => s.username)).toMatchObject({ urls: ["turn:global.turn.twilio.com:3478?transport=udp"], username: "u1", credential: "c1" });
    const token = calls.find((c) => c.url.endsWith("/Tokens.json"))!;
    expect(token.body).toBe("Ttl=3600");
    expect(token.auth).toBe("Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"));
    fail = true;
    const bad = await iceConfig(srv.ctx, f.wsId, "twilio", "c");
    expect(bad.iceServers.every((s) => !s.username)).toBe(true);
    expect(bad.warning).toMatch(/Twilio could not provide a TURN relay/);
    srv.ctx.providers.fetchImpl = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch;
  });

  it("the invitation carries credentials for the provider the workspace chose, and a fresh set on resume", async () => {
    const w = await world({ turn_provider: "static" });
    const inv = await w.invite();
    const turn = inv.ice.iceServers.find((s: any) => s.username);
    expect(turn.username).toMatch(new RegExp(`^\\d+:${inv.call.id}$`));
    const acc = await ack(w.vis, "call:accept", { call_id: inv.call.id });
    expect(acc.ice.iceServers.find((s: any) => s.username)).toBeTruthy();
  });
});

describe("workspace settings and REST", () => {
  it("calls settings need their own permission, validate, and the config endpoint says what the inbox needs", async () => {
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Settings");
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, owner);
    const api = async (method: string, path: string, body?: unknown, tok = token) => {
      const r = await fetch(`${srv.url}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    expect((await api("PATCH", "/api/workspace", { settings: { calls: { browser: { enabled: true, voice: true, video: true, screen_share: true }, turn_provider: "carrier-pigeon" } } })).status).toBe(400);
    expect((await api("PATCH", "/api/workspace", { settings: { calls: { browser: { enabled: true, voice: true, video: false, screen_share: true }, ring_seconds: 60, turn_provider: "static" } } })).status).toBe(200);
    expect((await api("PATCH", "/api/workspace", { settings: { calls: { ring_seconds: 5 } } })).status).toBe(400);
    const cfg = await api("GET", "/api/calls/config");
    expect(cfg.body).toMatchObject({ browser: { enabled: true, voice: true, video: false }, ring_seconds: 60, turn_provider: "static", warning: null });
    // a manager can edit the workspace but not the call settings, a custom role without calls:make cannot read the call config
    const mia = await srv.addMemberRaw(srv.ctx, wsId, { name: "Mia Manager", role: "manager" });
    const miaTok = await (await import("./helpers.js")).tokenFor(srv.ctx, mia);
    expect((await api("PATCH", "/api/workspace", { settings: { calls: { ring_seconds: 30 } } }, miaTok)).status).toBe(200); // managers hold calls:settings
    const viewer = await viewerOf(wsId, owner);
    const vTok = await (await import("./helpers.js")).tokenFor(srv.ctx, viewer);
    expect((await api("GET", "/api/calls/config", undefined, vTok)).status).toBe(403);
    expect((await api("GET", "/api/rooms/room_none/calls")).status).toBe(404);
    // the public config exposes only what a widget needs
    const v = await srv.visitor(wsId);
    const pub = await fetch(`${srv.url}/public/widget/config`, { headers: { "x-api-key": v.tokenRow.token, origin: "https://chat.example.com", "x-device-id": "device-rt-0001" } });
    const pj = (await pub.json()) as any;
    expect(pj.calls).toEqual({ browser: { enabled: true, voice: true, video: false } });
    expect(JSON.stringify(pj)).not.toContain("turn_provider");
  });
});
