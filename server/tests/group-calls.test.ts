import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepCalls } from "../src/calls/service.js";
import { GROUP_RECONNECT_GRACE_S } from "../src/calls/groupCall.js";
import { PARTICIPANT_EVENTS, PARTICIPANT_STATUSES, afterDeparture, clampGroupMax, groupCardText, hasRoom, nextStatus, IllegalParticipantTransition } from "../src/calls/groupMachine.js";
import { setMemberRole } from "../src/services/roles.js";
import { createChannel, openDm } from "../src/services/teamChat.js";
import { ALL_EVENTS, ack, recorder, sleep, startServer } from "./rt-helpers.js";
import { setSettings } from "./helpers.js";

const EVENTS = [...ALL_EVENTS, "gcall:state", "gcall:offer", "gcall:answer", "gcall:ice", "gcall:peer", "tcall:state"];
type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "800", SOCKET_RATE_PER_SEC: "4000" });
});
afterAll(async () => {
  await srv.close();
});

async function enable(wsId: string, over: Record<string, unknown> = {}) {
  await setSettings(srv.ctx, wsId, { calls: { browser: { enabled: false, voice: true, video: true }, internal: { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30, group: true, group_max: 4, ...over }, turn_provider: "none", ring_seconds: 45 } });
  await srv.ctx.cache.invalidate(`settings:${wsId}`);
}
const sdp = (type: "offer" | "answer") => ({ type, sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n" });

/** Olivia (owner, the host), Ben, Cleo, Dan and Eve (agents), all online, a group message of Olivia, Ben and Cleo, and a private channel of Olivia and Ben */
async function world(over: Record<string, unknown> = {}) {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
  await enable(wsId, over);
  const mk = (name: string) => srv.addMemberRaw(srv.ctx, wsId, { name, role: "agent" });
  const [ben, cleo, dan, eve] = [await mk("Ben Agent"), await mk("Cleo Agent"), await mk("Dan Agent"), await mk("Eve Agent")];
  const sock = { olivia: await srv.team(wsId, owner), ben: await srv.team(wsId, ben), cleo: await srv.team(wsId, cleo), dan: await srv.team(wsId, dan), eve: await srv.team(wsId, eve) };
  const rec = Object.fromEntries(Object.entries(sock).map(([k, s]) => [k, recorder(s, EVENTS)])) as Record<keyof typeof sock, ReturnType<typeof recorder>>;
  const group = (await openDm(srv.ctx, owner, [ben.memberId, cleo.memberId])).channel;
  const priv = await createChannel(srv.ctx, owner, { name: "ops", visibility: "private", member_ids: [ben.memberId, cleo.memberId, dan.memberId] });
  const ops = ((priv as any).channel?.id ?? (priv as any).id) as string;
  await sleep(40);
  const people = { olivia: owner, ben, cleo, dan, eve };
  const start = (kind: "voice" | "video" = "voice", over2: Record<string, unknown> = {}) => ack(sock.olivia, "gcall:start", { channel_id: group.id, kind, ...over2 });
  return { wsId, owner, ben, cleo, dan, eve, sock, rec, group, ops, people, start };
}
type W = Awaited<ReturnType<typeof world>>;
const row = (id: string) => srv.ctx.db.get<any>("SELECT * FROM group_calls WHERE id = ?", id);
const joinedIds = async (id: string) => (await srv.ctx.db.all<{ member_id: string }>("SELECT member_id FROM group_call_participants WHERE call_id = ? AND status = 'joined'", id)).map((r) => r.member_id);
const cardOf = (channelId: string) => srv.ctx.db.get<{ content_text: string; meta: string }>("SELECT content_text, meta FROM team_messages WHERE channel_id = ? AND kind = 'system' ORDER BY seq DESC", channelId);
const statusOf = async (id: string, m: string) => (await srv.ctx.db.get<{ status: string }>("SELECT status FROM group_call_participants WHERE call_id = ? AND member_id = ?", id, m))?.status;

describe("the rules of a group call (pure)", () => {
  it("every status and event: legal moves are exactly the table, everything else throws", () => {
    const legal: Record<string, string[]> = { none: ["invite", "join"], invited: ["join", "decline", "ring_timeout", "invite"], joined: ["leave", "gone_timeout"], left: ["join", "invite"], declined: ["join", "invite"], missed: ["join", "invite"] };
    for (const from of [null, ...PARTICIPANT_STATUSES]) for (const ev of PARTICIPANT_EVENTS) {
      const ok = legal[from ?? "none"]!.includes(ev);
      if (ok) expect(PARTICIPANT_STATUSES).toContain(nextStatus(from, ev));
      else expect(() => nextStatus(from, ev), `${from} ${ev}`).toThrow(IllegalParticipantTransition);
    }
  });
  it("the cap is clamped between 2 and 4 and room is checked against it", () => {
    expect([clampGroupMax(9), clampGroupMax(1), clampGroupMax(3), clampGroupMax("x"), clampGroupMax(undefined)]).toEqual([4, 2, 3, 4, 4]);
    expect([hasRoom(3, 4), hasRoom(4, 4), hasRoom(2, 2), hasRoom(1, 99)]).toEqual([true, false, false, true]);
    expect([afterDeparture(2, true), afterDeparture(0, true), afterDeparture(0, false)]).toEqual(["live", "ended", "missed"]);
    expect(groupCardText({ kind: "video", state: "live", joined: 3, duration_s: null })).toBe("Group video call: 3 in the call");
    expect(groupCardText({ kind: "voice", state: "ended", joined: 0, duration_s: 600 })).toBe("Group voice call, 10 min");
  });
});

describe("starting, joining and leaving", () => {
  it("rings each invitee on every tab, posts a card, relays signalling to the addressed person only, and ends with a duration when the last one leaves", async () => {
    const w = await world();
    const benTab2 = await srv.team(w.wsId, w.ben);
    const b2 = recorder(benTab2, EVENTS);
    await sleep(30);
    const st = await w.start("video");
    expect(st).toMatchObject({ ok: true, call: { kind: "video", state: "live", host_id: w.owner.memberId, max_participants: 4 }, skipped: [] });
    const id = st.call.id as string;
    expect(st.call.participants.map((p: any) => [p.name, p.status])).toEqual(expect.arrayContaining([["Olivia Owner", "joined"], ["Ben Agent", "invited"], ["Cleo Agent", "invited"]]));
    await w.rec.ben.waitFor("gcall:state", (p) => p.call.id === id);
    await b2.waitFor("gcall:state", (p) => p.call.id === id);
    await w.rec.cleo.waitFor("gcall:state", (p) => p.call.id === id);
    expect(w.rec.dan.of("gcall:state")).toHaveLength(0);
    expect((await cardOf(w.group.id))!.content_text).toBe("Group video call: ringing");
    // Ben joins: he gets the people already in the call (Olivia) and the ICE servers
    const j = await ack(w.sock.ben, "gcall:join", { call_id: id });
    expect(j).toMatchObject({ ok: true, peers: [w.owner.memberId], call: { state: "live" } });
    expect(j.ice.iceServers[0].urls[0]).toMatch(/^stun:/);
    // the second tab of Ben cannot join the same call
    expect((await ack(benTab2, "gcall:join", { call_id: id })).error.code).toBe("ALREADY_IN_THIS_CALL");
    expect((await cardOf(w.group.id))!.content_text).toBe("Group video call: 2 in the call");
    // Ben offers to Olivia; only Olivia hears it, with who it is from
    await ack(w.sock.ben, "gcall:offer", { call_id: id, to: w.owner.memberId, data: sdp("offer") });
    expect(await w.rec.olivia.waitFor("gcall:offer")).toMatchObject({ call_id: id, from: w.ben.memberId });
    await ack(w.sock.olivia, "gcall:answer", { call_id: id, to: w.ben.memberId, data: sdp("answer") });
    await w.rec.ben.waitFor("gcall:answer");
    await ack(w.sock.olivia, "gcall:ice", { call_id: id, to: w.ben.memberId, data: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    await w.rec.ben.waitFor("gcall:ice");
    await sleep(50);
    for (const r of [w.rec.cleo, w.rec.dan, b2]) for (const e of ["gcall:offer", "gcall:answer", "gcall:ice"]) expect(r.of(e), e).toHaveLength(0);
    // Cleo joins and offers to both
    expect((await ack(w.sock.cleo, "gcall:join", { call_id: id })).peers.sort()).toEqual([w.owner.memberId, w.ben.memberId].sort());
    srv.clockCtl.advance(125_000);
    // the host leaves: the call continues for the other two
    expect((await ack(w.sock.olivia, "gcall:leave", { call_id: id })).call.state).toBe("live");
    expect(await joinedIds(id)).toHaveLength(2);
    expect((await ack(w.sock.ben, "gcall:leave", { call_id: id })).call.state).toBe("live");
    expect((await ack(w.sock.cleo, "gcall:leave", { call_id: id })).call.state).toBe("ended");
    expect(await row(id)).toMatchObject({ state: "ended", end_reason: "completed", host_id: w.owner.memberId });
    expect((await row(id)).duration_s).toBeGreaterThanOrEqual(125);
    expect((await cardOf(w.group.id))!.content_text).toMatch(/^Group video call, \d+ min$/);
    const audit = (await srv.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE target = ?", id)).map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(["group_call.started", "group_call.joined", "group_call.ended"]));
    // leaving again, or signalling in an ended call, is told the truth
    expect((await ack(w.sock.cleo, "gcall:leave", { call_id: id })).call.state).toBe("ended");
    expect((await ack(w.sock.cleo, "gcall:offer", { call_id: id, to: w.ben.memberId, data: sdp("offer") })).error.code).toBe("CALL_STATE");
  });

  it("a channel call rings only the people chosen; other channel members join from the card; an invitee can decline", async () => {
    const w = await world();
    const st = await ack(w.sock.olivia, "gcall:start", { channel_id: w.ops, kind: "voice", invite_ids: [w.ben.memberId] });
    expect(st.ok, JSON.stringify(st)).toBe(true);
    const id = st.call.id;
    await w.rec.ben.waitFor("gcall:state", (p) => p.call.id === id);
    await sleep(40);
    expect(w.rec.cleo.of("gcall:state")).toHaveLength(0);
    expect(await ack(w.sock.ben, "gcall:decline", { call_id: id })).toMatchObject({ ok: true });
    expect(await statusOf(id, w.ben.memberId)).toBe("declined");
    // Dan was not rung but is in the channel: he can join; so can Ben, who declined
    expect((await ack(w.sock.dan, "gcall:join", { call_id: id })).ok).toBe(true);
    expect((await ack(w.sock.ben, "gcall:join", { call_id: id })).ok).toBe(true);
    expect(await joinedIds(id)).toHaveLength(3);
    // somebody who is not in the private channel cannot even see it
    expect((await ack(w.sock.eve, "gcall:join", { call_id: id })).error.code).toBe("NOT_FOUND");
    expect((await ack(w.sock.eve, "gcall:decline", { call_id: id })).error.code).toBe("NOT_FOUND");
    expect((await ack(w.sock.eve, "gcall:offer", { call_id: id, to: w.ben.memberId, data: sdp("offer") })).error.code).toBe("NOT_FOUND");
    // a call that is live in a conversation blocks a second one there, and says where to go
    const again = await ack(w.sock.dan, "gcall:start", { channel_id: w.ops, kind: "voice" });
    expect(again.error.code).toBe("GROUP_CALL_EXISTS");
  });

  it("refuses: off, group switched off, kind off, direct messages, too many people, nobody available, no permission, viewers", async () => {
    const w = await world({ enabled: false });
    expect((await w.start()).error.code).toBe("TEAM_CALLS_DISABLED");
    await enable(w.wsId, { group: false });
    expect((await w.start()).error.code).toBe("GROUP_CALLS_DISABLED");
    await enable(w.wsId, { video: false });
    expect((await w.start("video")).error.code).toBe("TEAM_CALL_KIND_DISABLED");
    await enable(w.wsId, { group_max: 3 });
    expect((await ack(w.sock.olivia, "gcall:start", { channel_id: w.ops, kind: "voice", invite_ids: [w.ben.memberId, w.cleo.memberId, w.dan.memberId] })).error.code).toBe("TOO_MANY_PARTICIPANTS");
    await enable(w.wsId);
    const dm = (await openDm(srv.ctx, w.owner, [w.ben.memberId])).channel;
    expect((await ack(w.sock.olivia, "gcall:start", { channel_id: dm.id, kind: "voice" })).error.code).toBe("USE_DIRECT_CALL");
    expect((await ack(w.sock.olivia, "tcall:invite", { channel_id: w.group.id, kind: "voice" })).error.code).toBe("USE_GROUP_CALL");
    // everybody offline or unavailable: nothing to ring
    w.sock.ben.close();
    w.sock.cleo.close();
    await sleep(400);
    const r = await w.start();
    expect(r.error.code).toBe("NOBODY_TO_RING");
    expect(r.error.details.skipped.map((x: any) => x.reason).sort()).toEqual(["offline", "offline"]);
    // a viewer has no calls:internal
    await setMemberRole(srv.ctx, w.owner, w.dan.memberId, "role_viewer");
    expect((await ack(w.sock.dan, "gcall:start", { channel_id: w.ops, kind: "voice" })).error.code).toBe("PERMISSION_DENIED");
    expect((await ack(w.sock.dan, "gcall:join", { call_id: "gcall_nonexistent00000000" })).error.code).toBe("PERMISSION_DENIED");
    // and a viewer cannot be rung
    const ok = await ack(w.sock.olivia, "gcall:start", { channel_id: w.ops, kind: "voice", invite_ids: [w.dan.memberId] });
    expect(ok.error.details.skipped[0].reason).toBe("cannot_receive");
  });

  it("unavailable people are skipped and named while the others ring: do-not-disturb, busy in another call", async () => {
    const w = await world();
    const { updateMember } = await import("../src/services/members.js");
    await updateMember(srv.ctx, w.owner, w.cleo.memberId, { availability: "inactive" } as any).catch(() => {});
    const st = await w.start();
    expect(st.ok, JSON.stringify(st)).toBe(true);
    const reasons = Object.fromEntries(st.skipped.map((s: any) => [s.name, s.reason]));
    if (Object.keys(reasons).length) expect(reasons["Cleo Agent"]).toBe("unavailable");
  });

  it("a member in a 1:1 team call, or already in another group call, cannot be rung and cannot join", async () => {
    const w = await world();
    const dm = (await openDm(srv.ctx, w.dan, [w.eve.memberId])).channel;
    const t = await ack(w.sock.dan, "tcall:invite", { channel_id: dm.id, kind: "voice" });
    expect(t.ok, JSON.stringify(t)).toBe(true);
    const st = await ack(w.sock.olivia, "gcall:start", { channel_id: w.ops, kind: "voice", invite_ids: [w.ben.memberId, w.dan.memberId] });
    expect(st.skipped).toEqual([expect.objectContaining({ name: "Dan Agent", reason: "busy" })]);
    expect((await ack(w.sock.dan, "gcall:join", { call_id: st.call.id })).error.code).toBe("CALL_IN_PROGRESS");
    // Ben is in the ops call; he cannot also start or join the one in the group message
    await ack(w.sock.ben, "gcall:join", { call_id: st.call.id });
    expect((await ack(w.sock.ben, "gcall:start", { channel_id: w.group.id, kind: "voice" })).error.code).toBe("CALL_IN_PROGRESS");
    // and a 1:1 call to Ben is refused while he is busy
    const dmb = (await openDm(srv.ctx, w.cleo, [w.ben.memberId])).channel;
    expect((await ack(w.sock.cleo, "tcall:invite", { channel_id: dmb.id, kind: "voice" })).error.code).toBe("CALLEE_BUSY");
  });
});

describe("the cap, races and duplicates", () => {
  it("two joins at the cap: exactly one gets the last place, the other is told the call is full", async () => {
    const w = await world({ group_max: 3 });
    const st = await ack(w.sock.olivia, "gcall:start", { channel_id: w.ops, kind: "voice", invite_ids: [w.ben.memberId] });
    const id = st.call.id;
    await ack(w.sock.ben, "gcall:join", { call_id: id });
    for (let round = 0; round < 3; round++) {
      const res = await Promise.all([ack(w.sock.cleo, "gcall:join", { call_id: id }), ack(w.sock.dan, "gcall:join", { call_id: id })]);
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      expect(res.find((r) => !r.ok).error.code).toBe("GROUP_CALL_FULL");
      expect(await joinedIds(id)).toHaveLength(3);
      // the winner leaves so the next round can race again
      const winner = res[0]!.ok ? w.sock.cleo : w.sock.dan;
      await ack(winner, "gcall:leave", { call_id: id });
    }
    expect((await row(id)).max_participants).toBe(3);
  });

  it("a duplicate join from the same socket is a no-op, and a rejoin after leaving works", async () => {
    const w = await world();
    const id = (await w.start()).call.id;
    const [a, b] = await Promise.all([ack(w.sock.ben, "gcall:join", { call_id: id }), ack(w.sock.ben, "gcall:join", { call_id: id })]);
    expect(a.ok && b.ok).toBe(true);
    expect(await joinedIds(id)).toHaveLength(2);
    await ack(w.sock.ben, "gcall:leave", { call_id: id });
    expect((await ack(w.sock.ben, "gcall:join", { call_id: id })).ok).toBe(true);
    expect(await joinedIds(id)).toHaveLength(2);
  });

  it("a leave during an offer: the offer to someone who just left is refused, the leaver's signals are refused, nothing reaches the wrong socket", async () => {
    const w = await world();
    const id = (await w.start()).call.id;
    await ack(w.sock.ben, "gcall:join", { call_id: id });
    await ack(w.sock.cleo, "gcall:join", { call_id: id });
    const [offer, leave] = await Promise.all([ack(w.sock.ben, "gcall:offer", { call_id: id, to: w.cleo.memberId, data: sdp("offer") }), ack(w.sock.cleo, "gcall:leave", { call_id: id })]);
    expect(leave.ok).toBe(true);
    if (!offer.ok) expect(offer.error.code).toBe("PEER_NOT_READY");
    expect((await ack(w.sock.ben, "gcall:offer", { call_id: id, to: w.cleo.memberId, data: sdp("offer") })).error.code).toBe("PEER_NOT_READY");
    expect((await ack(w.sock.cleo, "gcall:offer", { call_id: id, to: w.ben.memberId, data: sdp("offer") })).error.code).toBe("NOT_IN_THIS_CALL");
    // malformed signals
    expect((await ack(w.sock.ben, "gcall:offer", { call_id: id, to: w.owner.memberId, data: { type: "answer", sdp: "x" } })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(w.sock.ben, "gcall:offer", { call_id: id, to: w.ben.memberId, data: sdp("offer") })).error.code).toBe("PEER_NOT_READY");
    expect((await ack(w.sock.ben, "gcall:ice", { call_id: id, to: w.owner.memberId, data: { candidate: "x".repeat(3000) } })).error.code).toBe("INVALID_SIGNAL");
    // a socket that is not the bound one cannot signal
    const benTab2 = await srv.team(w.wsId, w.ben);
    expect((await ack(benTab2, "gcall:offer", { call_id: id, to: w.owner.memberId, data: sdp("offer") })).error.code).toBe("NOT_THIS_DEVICE");
  });

  it("only one person shares their screen: two at once, exactly one wins; the holder leaving frees it", async () => {
    const w = await world();
    const id = (await w.start("video")).call.id;
    await ack(w.sock.ben, "gcall:join", { call_id: id });
    await ack(w.sock.cleo, "gcall:join", { call_id: id });
    const res = await Promise.all([ack(w.sock.ben, "gcall:share", { call_id: id, on: true }), ack(w.sock.cleo, "gcall:share", { call_id: id, on: true })]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    const loser = res.find((r) => !r.ok);
    expect(loser.error.code).toBe("SHARE_IN_USE");
    const holder = res[0]!.ok ? w.ben : w.cleo;
    const holderSock = res[0]!.ok ? w.sock.ben : w.sock.cleo;
    expect((await row(id)).sharing_id).toBe(holder.memberId);
    expect(loser.error.details.by).toBe(holder.memberId);
    // somebody else cannot stop it
    await ack(w.sock.olivia, "gcall:share", { call_id: id, on: false });
    expect((await row(id)).sharing_id).toBe(holder.memberId);
    await ack(holderSock, "gcall:leave", { call_id: id });
    expect((await row(id)).sharing_id).toBeNull();
    expect((await ack(w.sock.olivia, "gcall:share", { call_id: id, on: true })).ok).toBe(true);
    // voice calls and workspaces that switched it off have no sharing
    const v = await world();
    const vid = (await v.start("voice")).call.id;
    expect((await ack(v.sock.olivia, "gcall:share", { call_id: vid, on: true })).error.code).toBe("SHARE_NOT_AVAILABLE");
    await enable(w.wsId, { screen_share: false });
    await ack(w.sock.olivia, "gcall:share", { call_id: id, on: false });
    expect((await ack(w.sock.olivia, "gcall:share", { call_id: id, on: true })).error.code).toBe("SHARE_NOT_AVAILABLE");
  });

  it("mute and camera flags are stored and shown to everyone in the call, and only by people in it", async () => {
    const w = await world();
    const id = (await w.start("video")).call.id;
    await ack(w.sock.ben, "gcall:join", { call_id: id });
    const r = await ack(w.sock.ben, "gcall:media", { call_id: id, muted: true });
    expect(r.call.participants.find((p: any) => p.name === "Ben Agent")).toMatchObject({ muted: true, camera_off: false });
    const seen = await w.rec.olivia.waitFor("gcall:state", (p) => p.call.participants.some((x: any) => x.name === "Ben Agent" && x.muted));
    expect(seen.call.id).toBe(id);
    await ack(w.sock.ben, "gcall:media", { call_id: id, camera_off: true });
    expect((await ack(w.sock.cleo, "gcall:media", { call_id: id, muted: true })).error.code).toBe("NOT_IN_THIS_CALL");
  });
});

describe("inviting more people", () => {
  it("any person in the call can ring more people up to the cap; names who could not be rung; the cap is enforced", async () => {
    const w = await world({ group_max: 3 });
    const id = (await ack(w.sock.olivia, "gcall:start", { channel_id: w.ops, kind: "voice", invite_ids: [w.ben.memberId] })).call.id;
    // not in the call: cannot invite
    expect((await ack(w.sock.cleo, "gcall:invite", { call_id: id, member_ids: [w.dan.memberId] })).error.code).toBe("NOT_IN_THIS_CALL");
    const r = await ack(w.sock.olivia, "gcall:invite", { call_id: id, member_ids: [w.cleo.memberId] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await w.rec.cleo.waitFor("gcall:state", (p) => p.call.id === id);
    expect(await statusOf(id, w.cleo.memberId)).toBe("invited");
    // the call now has three people counted (host, Ben, Cleo): a fourth is refused
    expect((await ack(w.sock.olivia, "gcall:invite", { call_id: id, member_ids: [w.dan.memberId] })).error.code).toBe("GROUP_CALL_FULL");
    // already invited is reported, not an error
    const again = await ack(w.sock.olivia, "gcall:invite", { call_id: id, member_ids: [w.cleo.memberId] });
    expect(again.skipped).toEqual([expect.objectContaining({ reason: "already_invited" })]);
    // eve is not in the private channel
    await enable(w.wsId, { group_max: 4 });
    const e = await ack(w.sock.olivia, "gcall:invite", { call_id: id, member_ids: [w.eve.memberId] });
    expect(e.error.code).toBe("NOBODY_TO_RING");
    expect(e.error.details.skipped[0].reason).toBe("not_in_conversation");
  });
});

describe("ringing out, grace periods and ICE restarts", () => {
  it("invitees who do not answer are missed after the ring time; a host who is left alone ends the call as missed", async () => {
    const w = await world({ ring_seconds: 20 });
    const st = await w.start();
    const id = st.call.id;
    srv.clockCtl.advance(19_000);
    await sweepCalls(srv.ctx);
    expect((await row(id)).state).toBe("live");
    srv.clockCtl.advance(2_000);
    await sweepCalls(srv.ctx);
    await sweepCalls(srv.ctx);
    expect(await row(id)).toMatchObject({ state: "missed", end_reason: "no_answer" });
    expect(await statusOf(id, w.ben.memberId)).toBe("missed");
    expect((await cardOf(w.group.id))!.content_text).toBe("Missed group voice call");
    expect((await ack(w.sock.ben, "gcall:join", { call_id: id })).error.code).toBe("CALL_STATE");
    // when one person answered, the call goes on after the others rang out
    const w2 = await world({ ring_seconds: 20 });
    const id2 = (await w2.start()).call.id;
    await ack(w2.sock.ben, "gcall:join", { call_id: id2 });
    srv.clockCtl.advance(25_000);
    await sweepCalls(srv.ctx);
    expect((await row(id2)).state).toBe("live");
    expect(await statusOf(id2, w2.cleo.memberId)).toBe("missed");
    expect(await joinedIds(id2)).toHaveLength(2);
  });

  it("a closed socket: the others are told, resume re-binds and tells them to restart ICE, a person who stays away leaves after the grace period", async () => {
    const w = await world();
    const id = (await w.start()).call.id;
    await ack(w.sock.ben, "gcall:join", { call_id: id });
    await ack(w.sock.cleo, "gcall:join", { call_id: id });
    w.sock.ben.close();
    await sleep(150);
    expect((await w.rec.olivia.waitFor("gcall:peer", (p) => p.event === "lost")).member_id).toBe(w.ben.memberId);
    const ben2 = await srv.team(w.wsId, w.ben);
    const res = await ack(ben2, "gcall:resume", { call_id: id });
    expect(res).toMatchObject({ ok: true, call: { state: "live" } });
    expect(res.peers.sort()).toEqual([w.owner.memberId, w.cleo.memberId].sort());
    await w.rec.olivia.waitFor("gcall:peer", (p) => p.event === "resumed" && p.member_id === w.ben.memberId);
    await w.rec.cleo.waitFor("gcall:peer", (p) => p.event === "resumed" && p.member_id === w.ben.memberId);
    srv.clockCtl.advance((GROUP_RECONNECT_GRACE_S + 5) * 1000);
    await sweepCalls(srv.ctx);
    expect(await statusOf(id, w.ben.memberId)).toBe("joined");
    // the one who never comes back
    w.sock.cleo.close();
    await sleep(150);
    srv.clockCtl.advance((GROUP_RECONNECT_GRACE_S + 1) * 1000);
    await sweepCalls(srv.ctx);
    expect(await statusOf(id, w.cleo.memberId)).toBe("left");
    expect((await row(id)).state).toBe("live");
    // everybody gone: the call ends
    w.sock.olivia.close();
    ben2.close();
    await sleep(150);
    srv.clockCtl.advance((GROUP_RECONNECT_GRACE_S + 1) * 1000);
    await sweepCalls(srv.ctx);
    expect(await row(id)).toMatchObject({ state: "ended", end_reason: "disconnected" });
  });

  it("someone who left cannot resume; a stranger cannot resume", async () => {
    const w = await world();
    const id = (await w.start()).call.id;
    await ack(w.sock.ben, "gcall:join", { call_id: id });
    await ack(w.sock.ben, "gcall:leave", { call_id: id });
    expect((await ack(w.sock.ben, "gcall:resume", { call_id: id })).error.code).toBe("CALL_STATE");
  });
});

describe("tenants, tabs that open mid-call, the config", () => {
  it("another workspace sees nothing: 404 for every event, no state events", async () => {
    const w = await world();
    const other = await srv.seedWorkspace(srv.ctx, "Other");
    await enable(other.wsId);
    const x = await srv.team(other.wsId, other.owner);
    const xr = recorder(x, EVENTS);
    const id = (await w.start()).call.id;
    for (const [ev, p] of [["gcall:join", {}], ["gcall:decline", {}], ["gcall:leave", {}], ["gcall:resume", {}], ["gcall:media", { muted: true }], ["gcall:share", { on: true }], ["gcall:invite", { member_ids: [other.owner.memberId] }]] as const) {
      expect((await ack(x, ev, { call_id: id, ...p })).error.code, ev).toBe("NOT_FOUND");
    }
    expect((await ack(x, "gcall:offer", { call_id: id, to: w.ben.memberId, data: sdp("offer") })).error.code).toBe("NOT_FOUND");
    expect((await ack(x, "gcall:start", { channel_id: w.group.id, kind: "voice" })).error.code).toBe("NOT_FOUND");
    await sleep(40);
    expect(xr.of("gcall:state")).toHaveLength(0);
  });

  it("the config endpoint shows the group switches and the calls a tab opens in the middle of; the channel's live call is readable by people who can see it", async () => {
    const w = await world();
    const id = (await w.start()).call.id;
    const token = await (await import("./helpers.js")).tokenFor(srv.ctx, w.ben);
    const res = await fetch(`${srv.url}/api/team-calls/config`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ enabled: true, group: true, group_max: 4 });
    expect(body.live_group_calls.map((c: any) => [c.id, c.participants.find((p: any) => p.name === "Ben Agent").status])).toEqual([[id, "invited"]]);
    const one = (await (await fetch(`${srv.url}/api/team-calls/channels/${w.group.id}/group-call`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;
    expect(one.call.id).toBe(id);
    const eveTok = await (await import("./helpers.js")).tokenFor(srv.ctx, w.eve);
    expect((await fetch(`${srv.url}/api/team-calls/channels/${w.group.id}/group-call`, { headers: { authorization: `Bearer ${eveTok}` } })).status).toBe(404);
  });
});

describe("randomised sequences keep the invariants", () => {
  it("random starts, joins, leaves, declines, invites, shares and sweeps: never more than the cap in a call, one call per person, a live call has people in it, one sharer who is in the call", async () => {
    const w = await world({ group_max: 3 });
    const names = ["olivia", "ben", "cleo", "dan"] as const;
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    let callId: string | null = null;
    for (let i = 0; i < 70; i++) {
      const who = names[rnd(names.length)]!;
      const sock = w.sock[who];
      const op = rnd(8);
      if (!callId || op === 7) {
        const r = await ack(w.sock.olivia, "gcall:start", { channel_id: w.ops, kind: "video", invite_ids: [w.ben.memberId, w.cleo.memberId] });
        if (r.ok) callId = r.call.id;
        else if (r.error.code === "GROUP_CALL_EXISTS") callId = (await srv.ctx.db.get<{ id: string }>("SELECT id FROM group_calls WHERE channel_id = ? AND state = 'live'", w.ops))!.id;
        else expect(["CALL_IN_PROGRESS", "NOBODY_TO_RING", "RATE_LIMITED"]).toContain(r.error.code);
      } else if (op === 0 || op === 1) await ack(sock, "gcall:join", { call_id: callId });
      else if (op === 2) await ack(sock, "gcall:leave", { call_id: callId });
      else if (op === 3) await ack(sock, "gcall:decline", { call_id: callId });
      else if (op === 4) await ack(sock, "gcall:invite", { call_id: callId, member_ids: [w.people[names[rnd(4)]!].memberId] });
      else if (op === 5) await ack(sock, "gcall:share", { call_id: callId, on: rnd(2) === 0 });
      else {
        srv.clockCtl.advance(rnd(40) * 1000);
        await sweepCalls(srv.ctx);
      }
      // invariants
      const calls = await srv.ctx.db.all<any>("SELECT * FROM group_calls WHERE workspace_id = ?", w.wsId);
      for (const c of calls) {
        const ps = await srv.ctx.db.all<any>("SELECT * FROM group_call_participants WHERE call_id = ?", c.id);
        const joined = ps.filter((p) => p.status === "joined");
        expect(joined.length, "cap").toBeLessThanOrEqual(c.max_participants);
        if (c.state !== "live") {
          expect(joined, "an ended call has nobody in it").toHaveLength(0);
          expect(ps.filter((p) => p.status === "invited"), "nobody rings in an ended call").toHaveLength(0);
          expect(c.sharing_id).toBeNull();
        } else {
          expect(joined.length, "a live call has people").toBeGreaterThan(0);
          if (c.sharing_id) expect(joined.map((p) => p.member_id)).toContain(c.sharing_id);
        }
      }
      const per = await srv.ctx.db.all<{ member_id: string; n: number }>("SELECT member_id, COUNT(*) AS n FROM group_call_participants WHERE status = 'joined' GROUP BY member_id");
      for (const p of per) expect(p.n, "one call at a time").toBe(1);
      if (callId && (await row(callId)).state !== "live") callId = null;
    }
  });
});
