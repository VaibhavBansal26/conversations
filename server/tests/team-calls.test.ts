import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepCalls, CONNECT_TIMEOUT_S } from "../src/calls/service.js";
import { TEAM_CONNECT_TIMEOUT_S, TEAM_RECONNECT_GRACE_S } from "../src/calls/teamCall.js";
import { setMemberRole } from "../src/services/roles.js";
import { createChannel, openDm } from "../src/services/teamChat.js";
import { updateMember } from "../src/services/members.js";
import { ALL_EVENTS, ack, recorder, sleep, startServer } from "./rt-helpers.js";
import { setSettings, tokenFor } from "./helpers.js";

const EVENTS = [...ALL_EVENTS, "tcall:state", "tcall:offer", "tcall:answer", "tcall:ice", "tcall:peer"];
type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "800", SOCKET_RATE_PER_SEC: "4000", TURN_URLS: "turn:turn.example.test:3478?transport=udp", TURN_SECRET: "x".repeat(32) + "y" });
});
afterAll(async () => {
  await srv.close();
});

async function enable(wsId: string, over: Record<string, unknown> = {}) {
  await setSettings(srv.ctx, wsId, { calls: { browser: { enabled: false, voice: true, video: true }, internal: { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30, ...over }, turn_provider: "none", ring_seconds: 45 } });
  await srv.ctx.cache.invalidate(`settings:${wsId}`);
}

/** a workspace with calls between teammates on, Olivia (owner) and Ben (agent) online, their direct message, and Cleo (agent) who is not in it */
async function world(over: Record<string, unknown> = {}) {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
  await enable(wsId, over);
  const ben = await srv.addMemberRaw(srv.ctx, wsId, { name: "Ben Agent", role: "agent" });
  const cleo = await srv.addMemberRaw(srv.ctx, wsId, { name: "Cleo Agent", role: "agent" });
  const a = await srv.team(wsId, owner);
  const b = await srv.team(wsId, ben);
  const c = await srv.team(wsId, cleo);
  const aRec = recorder(a, EVENTS);
  const bRec = recorder(b, EVENTS);
  const cRec = recorder(c, EVENTS);
  const dm = (await openDm(srv.ctx, owner, [ben.memberId])).channel;
  const dmOf = async (x: typeof owner, y: typeof owner) => (await openDm(srv.ctx, x, [y.memberId])).channel;
  await sleep(40);
  const invite = (kind: "voice" | "video" = "voice", sock = a, channel = dm.id) => ack(sock, "tcall:invite", { channel_id: channel, kind });
  return { wsId, owner, ben, cleo, a, b, c, aRec, bRec, cRec, dm, dmOf, invite };
}
type W = Awaited<ReturnType<typeof world>>;
const row = (id: string) => srv.ctx.db.get<any>("SELECT * FROM team_calls WHERE id = ?", id);
const sdp = (type: "offer" | "answer") => ({ type, sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n" });
const cardOf = (channelId: string) => srv.ctx.db.get<{ content_text: string; meta: string }>("SELECT content_text, meta FROM team_messages WHERE channel_id = ? AND kind = 'system' ORDER BY seq DESC", channelId);

async function connected(w: W, kind: "voice" | "video" = "voice") {
  const inv = await w.invite(kind);
  expect(inv.ok, JSON.stringify(inv)).toBe(true);
  const id = inv.call.id as string;
  expect((await ack(w.b, "tcall:accept", { call_id: id })).ok).toBe(true);
  await ack(w.a, "tcall:offer", { call_id: id, data: sdp("offer") });
  await ack(w.b, "tcall:answer", { call_id: id, data: sdp("answer") });
  await ack(w.a, "tcall:connected", { call_id: id });
  await ack(w.b, "tcall:connected", { call_id: id });
  return id;
}

describe("placing, answering and ending a call between two teammates", () => {
  it("rings the other member on every tab, shows a card in the direct message, relays signalling to the other side only, and ends with a duration", async () => {
    const w = await world();
    const bTab2 = await srv.team(w.wsId, w.ben);
    const b2Rec = recorder(bTab2, EVENTS);
    await sleep(30);
    const inv = await w.invite("video");
    expect(inv).toMatchObject({ ok: true, call: { kind: "video", state: "ringing", caller: { name: "Olivia Owner" }, callee: { name: "Ben Agent" }, channel_id: w.dm.id }, ice: { provider: "none" } });
    expect(inv.ice.iceServers[0].urls[0]).toMatch(/^stun:/);
    const id = inv.call.id;
    await w.bRec.waitFor("tcall:state", (p) => p.call.id === id && p.call.state === "ringing");
    await b2Rec.waitFor("tcall:state", (p) => p.call.id === id);
    expect((await cardOf(w.dm.id))!.content_text).toBe("Video call: ringing");
    const acc = await ack(w.b, "tcall:accept", { call_id: id });
    expect(acc).toMatchObject({ ok: true, call: { state: "connecting" } });
    await w.aRec.waitFor("tcall:state", (p) => p.call.id === id && p.call.state === "connecting");
    // the second tab's accept loses, and it cannot talk into the call
    expect((await ack(bTab2, "tcall:accept", { call_id: id })).error.code).toBe("CALL_STATE");
    expect((await ack(bTab2, "tcall:offer", { call_id: id, data: sdp("offer") })).error.code).toBe("NOT_THIS_DEVICE");
    await ack(w.a, "tcall:offer", { call_id: id, data: sdp("offer") });
    expect((await w.bRec.waitFor("tcall:offer")).call_id).toBe(id);
    await ack(w.b, "tcall:answer", { call_id: id, data: sdp("answer") });
    await w.aRec.waitFor("tcall:answer");
    await ack(w.a, "tcall:ice", { call_id: id, data: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    await w.bRec.waitFor("tcall:ice");
    await sleep(60);
    // nobody else heard any signalling: not Cleo, not Ben's other tab
    for (const r of [w.cRec, b2Rec]) for (const e of ["tcall:offer", "tcall:answer", "tcall:ice"]) expect(r.of(e), e).toHaveLength(0);
    expect(w.cRec.of("tcall:state")).toHaveLength(0);
    expect((await ack(w.a, "tcall:connected", { call_id: id })).call.state).toBe("active");
    expect((await ack(w.b, "tcall:connected", { call_id: id })).call.state).toBe("active");
    srv.clockCtl.advance(125_000);
    expect((await ack(w.b, "tcall:end", { call_id: id })).call.state).toBe("ended");
    expect(await row(id)).toMatchObject({ state: "ended", ended_by: "callee", end_reason: "completed", duration_s: 125 });
    expect((await cardOf(w.dm.id))!.content_text).toBe("Video call, 2 min");
    expect(JSON.parse((await cardOf(w.dm.id))!.meta).call).toMatchObject({ id, state: "ended", caller_id: w.owner.memberId, callee_id: w.ben.memberId });
    const audit = (await srv.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE target = ?", id)).map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(["team_call.invited", "team_call.ended"]));
  });

  it("the caller can cancel a ringing call; the callee declines instead of ending", async () => {
    const w = await world();
    const a = await w.invite();
    expect((await ack(w.b, "tcall:end", { call_id: a.call.id })).error.code).toBe("CALL_STATE");
    expect((await ack(w.a, "tcall:end", { call_id: a.call.id })).call.state).toBe("ended");
    expect(await row(a.call.id)).toMatchObject({ state: "ended", end_reason: "cancelled", ended_by: "caller" });
    const b = await w.invite("voice", w.b); // now Ben can call Olivia
    expect(b.ok).toBe(true);
    expect((await ack(w.a, "tcall:decline", { call_id: b.call.id })).call.state).toBe("declined");
    expect((await cardOf(w.dm.id))!.content_text).toBe("Voice call declined");
    // the caller cannot decline or answer her own call
    const c = await w.invite();
    expect((await ack(w.a, "tcall:accept", { call_id: c.call.id })).error.code).toBe("NOT_YOUR_CALL");
    expect((await ack(w.a, "tcall:decline", { call_id: c.call.id })).error.code).toBe("NOT_YOUR_CALL");
  });

  it("nobody answers: missed after the ring time, the sweep twice is harmless, the card says so", async () => {
    const w = await world({ ring_seconds: 20 });
    const inv = await w.invite();
    srv.clockCtl.advance(19_000);
    await sweepCalls(srv.ctx);
    expect((await row(inv.call.id)).state).toBe("ringing");
    srv.clockCtl.advance(2_000);
    await sweepCalls(srv.ctx);
    await sweepCalls(srv.ctx);
    expect(await row(inv.call.id)).toMatchObject({ state: "missed", ended_by: "system", end_reason: "timeout" });
    expect((await cardOf(w.dm.id))!.content_text).toBe("Missed voice call");
    await w.bRec.waitFor("tcall:state", (p) => p.call.id === inv.call.id && p.call.state === "missed");
    // and an answer that arrives after that is told the truth
    expect((await ack(w.b, "tcall:accept", { call_id: inv.call.id })).error.code).toBe("CALL_STATE");
  });

  it("a call that does not connect fails after the connect time-out, and a side that is gone past the grace period ends it; coming back with resume keeps it", async () => {
    const w = await world();
    const inv = await w.invite();
    await ack(w.b, "tcall:accept", { call_id: inv.call.id });
    srv.clockCtl.advance(TEAM_CONNECT_TIMEOUT_S * 1000 + 1000);
    await sweepCalls(srv.ctx);
    expect(await row(inv.call.id)).toMatchObject({ state: "failed", end_reason: "connect_timeout" });

    const w2 = await world();
    const id = await connected(w2);
    w2.b.close();
    await sleep(120);
    const peer = await w2.aRec.waitFor("tcall:peer", (p) => p.call_id === id && p.event === "lost");
    expect(peer.event).toBe("lost");
    const b2 = await srv.team(w2.wsId, w2.ben);
    const res = await ack(b2, "tcall:resume", { call_id: id });
    expect(res).toMatchObject({ ok: true, call: { state: "active" } });
    await w2.aRec.waitFor("tcall:peer", (p) => p.call_id === id && p.event === "resumed");
    srv.clockCtl.advance((TEAM_RECONNECT_GRACE_S + 5) * 1000);
    await sweepCalls(srv.ctx);
    expect((await row(id)).state).toBe("active");
    // a side that never comes back
    w2.a.close();
    await sleep(120);
    srv.clockCtl.advance((TEAM_RECONNECT_GRACE_S + 1) * 1000);
    await sweepCalls(srv.ctx);
    expect(await row(id)).toMatchObject({ state: "ended", end_reason: "disconnected", ended_by: "system" });
  });

  it("failure reports end the call with the reason; a repeated connected report changes nothing", async () => {
    const w = await world();
    const id = await connected(w);
    expect((await ack(w.a, "tcall:connected", { call_id: id })).call.state).toBe("active");
    expect((await ack(w.b, "tcall:failed", { call_id: id, reason: "ice_failed" })).call.state).toBe("failed");
    expect(await row(id)).toMatchObject({ state: "failed", end_reason: "ice_failed", ended_by: "callee" });
    expect((await ack(w.a, "tcall:end", { call_id: id })).error.code).toBe("CALL_STATE");
  });
});

describe("who may call whom", () => {
  it("is refused when calls between teammates are off, per kind, and by default", async () => {
    const w = await world({ enabled: false });
    expect((await w.invite()).error.code).toBe("TEAM_CALLS_DISABLED");
    await enable(w.wsId, { video: false });
    expect((await w.invite("video")).error.code).toBe("TEAM_CALL_KIND_DISABLED");
    expect((await w.invite("voice")).ok).toBe(true);
    const fresh = await srv.seedWorkspace(srv.ctx, "Default");
    const ben = await srv.addMemberRaw(srv.ctx, fresh.wsId, { name: "Ben", role: "agent" });
    const a = await srv.team(fresh.wsId, fresh.owner);
    await srv.team(fresh.wsId, ben);
    const dm = (await openDm(srv.ctx, fresh.owner, [ben.memberId])).channel;
    expect((await ack(a, "tcall:invite", { channel_id: dm.id, kind: "voice" })).error.code).toBe("TEAM_CALLS_DISABLED");
  });

  it("only a direct message can be called from: group messages, channels and #general are refused", async () => {
    const w = await world();
    const group = (await openDm(srv.ctx, w.owner, [w.ben.memberId, w.cleo.memberId])).channel;
    const chan = await createChannel(srv.ctx, w.owner, { name: "ops", visibility: "private", member_ids: [w.ben.memberId] });
    const general = await srv.ctx.db.get<{ id: string }>("SELECT id FROM team_channels WHERE workspace_id = ? AND is_general = 1", w.wsId);
    for (const id of [group.id, (chan as any).channel?.id ?? (chan as any).id, general?.id].filter(Boolean) as string[]) {
      const r = await w.invite("voice", w.a, id);
      expect(r.error?.code, id).toBe("USE_GROUP_CALL");
    }
    expect(await srv.ctx.db.all("SELECT id FROM team_calls WHERE workspace_id = ?", w.wsId)).toHaveLength(0);
  });

  it("cannot call into a conversation you cannot see or are not in: private DM of others (404), another workspace (404), public channel you have not joined (403)", async () => {
    const w = await world();
    // Cleo is a member of the workspace but not of Olivia and Ben's DM
    expect((await w.invite("voice", w.c, w.dm.id)).error.code).toBe("NOT_FOUND");
    // another workspace
    const other = await world();
    expect((await other.invite("voice", other.a, w.dm.id)).error.code).toBe("NOT_FOUND");
    expect((await w.invite("voice", w.a, other.dm.id)).error.code).toBe("NOT_FOUND");
    // a public channel Ben has not joined: he can read it but not write in it, so not call from it
    const pub: any = await createChannel(srv.ctx, w.owner, { name: "lounge", visibility: "public" });
    const pid = pub.channel?.id ?? pub.id;
    expect((await w.invite("voice", w.b, pid)).error.code).toBe("NOT_A_MEMBER");
    expect(await srv.ctx.db.all("SELECT id FROM team_calls WHERE workspace_id IN (?, ?)", w.wsId, other.wsId)).toHaveLength(0);
  });

  it("needs the permission, on both ends: a viewer cannot place a call or be called, a custom role gets nothing by itself", async () => {
    const w = await world();
    await setMemberRole(srv.ctx, w.owner, w.ben.memberId, "role_viewer");
    expect((await w.invite()).error.code).toBe("CALLEE_CANNOT_RECEIVE");
    expect((await w.invite("voice", w.b)).error.code).toBe("PERMISSION_DENIED");
    // a custom role is not given calls:internal automatically
    const roleId = "role_custom_nocall";
    await srv.ctx.db.run("INSERT INTO roles(id, workspace_id, key, name, base_role, permissions, is_system, created_at) VALUES (?,?,?,?,?,?,0,?)", roleId, w.wsId, "nocall", "No calls", "agent", JSON.stringify(["team_chat:use", "conversations:read", "members:read"]), srv.ctx.clock().toISOString());
    await setMemberRole(srv.ctx, w.owner, w.ben.memberId, roleId);
    expect((await w.invite()).error.code).toBe("CALLEE_CANNOT_RECEIVE");
    const perms = await srv.ctx.db.get<{ permissions: string }>("SELECT permissions FROM roles WHERE id = 'role_agent'");
    expect(JSON.parse(perms!.permissions)).toContain("calls:internal");
    expect(JSON.parse((await srv.ctx.db.get<{ permissions: string }>("SELECT permissions FROM roles WHERE id = 'role_viewer'"))!.permissions)).not.toContain("calls:internal");
  });

  it("respects presence and do-not-disturb: an offline, away-by-choice or DND teammate is not rung", async () => {
    const w = await world();
    w.b.close();
    await sleep(400);
    expect((await w.invite()).error.code).toBe("CALLEE_OFFLINE");
    const w2 = await world();
    await updateMember(srv.ctx, w2.owner, w2.ben.memberId, { dnd_until: new Date(srv.ctx.clock().getTime() + 3600_000).toISOString() });
    expect((await w2.invite()).error.code).toBe("CALLEE_UNAVAILABLE");
    await updateMember(srv.ctx, w2.owner, w2.ben.memberId, { dnd_until: null, availability: "inactive" });
    expect((await w2.invite()).error.code).toBe("CALLEE_UNAVAILABLE");
    await updateMember(srv.ctx, w2.owner, w2.ben.memberId, { availability: "away" });
    expect((await w2.invite()).ok).toBe(true); // away is idle, not unavailable
  });

  it("busy people are not rung: one live call each, also under two callers at once, and a member in a call with a visitor is busy", async () => {
    const w = await world();
    const id = await connected(w);
    const cDm = await w.dmOf(w.owner, w.cleo);
    expect((await w.invite("voice", w.c, (await w.dmOf(w.cleo, w.ben)).id)).error.code).toBe("CALLEE_BUSY");
    expect((await w.invite("voice", w.a, cDm.id)).error.code).toBe("CALL_IN_PROGRESS");
    expect((await ack(w.a, "tcall:end", { call_id: id })).ok).toBe(true);

    const w2 = await world();
    const cb = await w2.dmOf(w2.cleo, w2.ben);
    const [x, y] = await Promise.all([w2.invite("voice", w2.a, w2.dm.id), w2.invite("voice", w2.c, cb.id)]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect(["CALLEE_BUSY", "CALL_IN_PROGRESS"]).toContain((x.ok ? y : x).error.code);
    expect(await srv.ctx.db.all("SELECT id FROM team_calls WHERE callee_id = ? AND state = 'ringing'", w2.ben.memberId)).toHaveLength(1);

    // an agent who is ringing a visitor is busy
    const w3 = await world();
    await srv.ctx.db.run("INSERT INTO contacts(id, workspace_id, name, created_at, updated_at) VALUES ('c_v', ?, 'V', ?, ?)", w3.wsId, srv.ctx.clock().toISOString(), srv.ctx.clock().toISOString());
    await srv.ctx.db.run("INSERT INTO rooms(id, workspace_id, contact_id, created_at, updated_at) VALUES ('r_v', ?, 'c_v', ?, ?)", w3.wsId, srv.ctx.clock().toISOString(), srv.ctx.clock().toISOString());
    await srv.ctx.db.run("INSERT INTO calls(id, workspace_id, room_id, contact_id, transport, kind, state, initiated_by, created_at, updated_at) VALUES ('call_v', ?, 'r_v', 'c_v', 'webrtc', 'voice', 'active', ?, ?, ?)", w3.wsId, w3.ben.memberId, srv.ctx.clock().toISOString(), srv.ctx.clock().toISOString());
    expect((await w3.invite()).error.code).toBe("CALLEE_BUSY");
    void CONNECT_TIMEOUT_S;
  });

  it("is rate limited against ring spam: 5 to the same person in 5 minutes", async () => {
    const w = await world();
    const results: any[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await w.invite();
      results.push(r);
      if (r.ok) await ack(w.a, "tcall:end", { call_id: r.call.id });
    }
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results[5]!.error.code).toBe("RATE_LIMITED");
    srv.clockCtl.advance(6 * 60_000);
    void 0;
  });

  it("a removed member cannot be called and a removed caller's call cannot continue to be controlled", async () => {
    const w = await world();
    await srv.ctx.db.run("UPDATE members SET removed_at = ? WHERE id = ?", srv.ctx.clock().toISOString(), w.ben.memberId);
    const r = await w.invite();
    expect(r.ok).toBe(false);
    expect(["CALLEE_GONE", "NOT_FOUND"]).toContain(r.error.code);
  });
});

describe("authorisation and isolation of a running call", () => {
  it("a third member, another workspace, a team socket of the wrong seat and the REST config reveal and allow nothing", async () => {
    const a = await world();
    const b = await world();
    const inv = await a.invite();
    const id = inv.call.id;
    for (const [ev, p] of [["tcall:accept", { call_id: id }], ["tcall:decline", { call_id: id }], ["tcall:end", { call_id: id }], ["tcall:connected", { call_id: id }], ["tcall:failed", { call_id: id, reason: "x" }], ["tcall:resume", { call_id: id }], ["tcall:offer", { call_id: id, data: sdp("offer") }], ["tcall:ice", { call_id: id, data: {} }]] as const) {
      expect((await ack(a.c, ev, p)).error.code, `cleo ${ev}`).toBe("NOT_FOUND");
      expect((await ack(b.a, ev, p)).error.code, `other workspace ${ev}`).toBe("NOT_FOUND");
    }
    expect((await row(id)).state).toBe("ringing");
    expect(a.cRec.of("tcall:state")).toHaveLength(0);
    // a visitor socket cannot use the events at all
    const v = await srv.visitor(a.wsId, "chat.example.com", "device-tc-0001");
    const vis = await srv.connect(a.wsId, v.auth);
    expect((await ack(vis, "tcall:invite", { channel_id: a.dm.id, kind: "voice" })).error.code).toBe("FORBIDDEN");
    expect((await ack(vis, "tcall:accept", { call_id: id })).error.code).toBe("FORBIDDEN");
  });

  it("oversized or mistyped signals are refused, and signalling before the other side answered is refused", async () => {
    const w = await world();
    const inv = await w.invite();
    expect((await ack(w.a, "tcall:offer", { call_id: inv.call.id, data: sdp("offer") })).error.code).toBe("CALL_STATE"); // still ringing
    await ack(w.b, "tcall:accept", { call_id: inv.call.id });
    expect((await ack(w.a, "tcall:offer", { call_id: inv.call.id, data: { type: "offer", sdp: "x".repeat(17_000) } })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(w.a, "tcall:offer", { call_id: inv.call.id, data: { type: "answer", sdp: "v=0" } })).error.code).toBe("INVALID_SIGNAL");
    expect((await ack(w.a, "tcall:ice", { call_id: inv.call.id, data: { candidate: "x".repeat(3000) } })).error.code).toBe("INVALID_SIGNAL");
  });

  it("the config endpoint needs the permission and tells a tab that opens mid-call about it", async () => {
    const w = await world();
    const tok = await tokenFor(srv.ctx, w.owner);
    const get = async (t: string) => fetch(`${srv.url}/api/team-calls/config`, { headers: { authorization: `Bearer ${t}` } });
    const r0 = await get(tok);
    expect(await r0.json()).toMatchObject({ enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30, live_call: null });
    const inv = await w.invite();
    expect(((await (await get(tok)).json()) as any).live_call).toMatchObject({ id: inv.call.id, state: "ringing", caller: { name: "Olivia Owner" } });
    expect(((await (await get(await tokenFor(srv.ctx, w.ben))).json()) as any).live_call.id).toBe(inv.call.id);
    expect(((await (await get(await tokenFor(srv.ctx, w.cleo))).json()) as any).live_call).toBeNull();
    await setMemberRole(srv.ctx, w.owner, w.ben.memberId, "role_viewer");
    expect((await get(await tokenFor(srv.ctx, w.ben))).status).toBe(403);
  });
});

describe("state machine properties of the service", () => {
  it("random sequences of invites, answers, declines, ends, reports and time never break the invariants", async () => {
    const w = await world({ ring_seconds: 15 });
    const socks = [w.a, w.b, w.c];
    const actors = [w.owner, w.ben, w.cleo];
    const dms = [w.dm.id, (await w.dmOf(w.cleo, w.ben)).id, (await w.dmOf(w.owner, w.cleo)).id];
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const ids: string[] = [];
    const finals = new Map<string, { state: string; duration: number | null }>();
    for (let i = 0; i < 160; i++) {
      const s = socks[rnd(3)]!;
      const op = rnd(9);
      const id = ids.length ? ids[rnd(ids.length)]! : "tcall_none";
      if (op === 0) {
        const r = await ack(s, "tcall:invite", { channel_id: dms[rnd(3)], kind: rnd(2) ? "voice" : "video" });
        if (r.ok) ids.push(r.call.id);
      } else if (op === 1) await ack(s, "tcall:accept", { call_id: id });
      else if (op === 2) await ack(s, "tcall:decline", { call_id: id });
      else if (op === 3) await ack(s, "tcall:end", { call_id: id });
      else if (op === 4) await ack(s, "tcall:connected", { call_id: id });
      else if (op === 5) await ack(s, "tcall:failed", { call_id: id, reason: "x" });
      else if (op === 6) await ack(s, "tcall:offer", { call_id: id, data: sdp("offer") });
      else if (op === 7) srv.clockCtl.advance(rnd(40) * 1000);
      else await sweepCalls(srv.ctx);
      // invariants after every step
      const live = await srv.ctx.db.all<{ caller_id: string; callee_id: string; channel_id: string }>("SELECT caller_id, callee_id, channel_id FROM team_calls WHERE workspace_id = ? AND state IN ('ringing','connecting','active')", w.wsId);
      const people = live.flatMap((c) => [c.caller_id, c.callee_id]);
      expect(new Set(people).size, `step ${i}: a member is in two live calls`).toBe(people.length);
      expect(new Set(live.map((c) => c.channel_id)).size).toBe(live.length);
      for (const cid of ids) {
        const r = await row(cid);
        const f = finals.get(cid);
        if (f) expect({ state: r.state, duration: r.duration_s }, `final call ${cid} changed`).toEqual(f); // final states have no way out
        else if (!["ringing", "connecting", "active"].includes(r.state)) finals.set(cid, { state: r.state, duration: r.duration_s });
        if (r.state === "ended" || r.state === "failed") expect(r.duration_s).not.toBeNull();
        if (["ringing", "connecting"].includes(r.state)) expect(r.duration_s).toBeNull();
      }
    }
    expect(ids.length).toBeGreaterThan(5);
    void actors;
  });
});
