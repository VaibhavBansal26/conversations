import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GroupCallEngine, type GroupCallDto, type GroupParticipant } from "./groupEngine";
import { FakeMedia, FakePC, FakeStream, FakeTransport } from "./fakes";

const ME = "mem_me";
const ICE = { iceServers: [{ urls: ["stun:stun.example.test:3478"] }], warning: null };
const tick = () => new Promise((r) => setTimeout(r, 0));
const P = (id: string, status: GroupParticipant["status"], over: Partial<GroupParticipant> = {}): GroupParticipant => ({ member_id: id, name: id === ME ? "Me" : id.replace("mem_", "").toUpperCase(), status, joined_at: status === "joined" ? "2026-01-01T00:00:00Z" : null, muted: false, camera_off: false, ...over });
const call = (ps: GroupParticipant[], over: Partial<GroupCallDto> = {}): GroupCallDto => ({ id: "gcall_1", channel_id: "tch_1", kind: "video", state: "live", host_id: "mem_ben", max_participants: 4, sharing_id: null, participants: ps, ...over });

let t: FakeTransport;
let media: FakeMedia;
let engine: GroupCallEngine;
const levelMap = new Map<unknown, number>();
beforeEach(() => {
  FakePC.all = [];
  levelMap.clear();
  t = new FakeTransport();
  media = new FakeMedia();
  engine = new GroupCallEngine({ transport: t as never, selfId: () => ME, RTCPeerConnection: FakePC as never, mediaDevices: media as never, now: () => Date.now(), levelOf: (s) => levelMap.get(s) ?? 0 });
});
afterEach(() => engine.reset());

const joinWithPeers = async (peers: string[]) => {
  t.replies["gcall:join"] = () => ({ ok: true, call: call([P(ME, "joined"), ...peers.map((p) => P(p, "joined"))]), ice: ICE, peers });
  engine.handleState(call([P(ME, "invited"), ...peers.map((p) => P(p, "joined"))]));
  expect(engine.state.phase).toBe("ringing_in");
  expect(await engine.join()).toEqual({ ok: true });
  await tick();
};

describe("starting and ringing", () => {
  it("starts in a conversation with the chosen people, enters the call alone and reports who could not be rung", async () => {
    t.replies["gcall:start"] = (p) => ({ ok: true, call: call([P(ME, "joined"), P("mem_ben", "invited")], { kind: p.kind, host_id: ME }), ice: ICE, skipped: [{ member_id: "mem_cleo", name: "Cleo", reason: "offline" }] });
    const r = await engine.start("tch_1", "video", "Ops", ["mem_ben", "mem_cleo"]);
    expect(r).toMatchObject({ ok: true, skipped: [{ reason: "offline" }] });
    expect(t.of("gcall:start")).toEqual([{ channel_id: "tch_1", kind: "video", invite_ids: ["mem_ben", "mem_cleo"] }]);
    expect(media.calls).toEqual([{ audio: true, video: true }]);
    expect(engine.state).toMatchObject({ phase: "in_call", title: "Ops" });
    expect(engine.state.tiles.map((x) => [x.name, x.link])).toEqual([["You", "self"]]);
    expect(FakePC.all).toHaveLength(0);
  });
  it("explains a refusal in words and releases the microphone; refuses a second call", async () => {
    t.replies["gcall:start"] = () => ({ ok: false, error: { code: "GROUP_CALL_EXISTS", message: "x" } });
    expect(await engine.start("tch_1", "voice", "Ops")).toMatchObject({ ok: false, message: expect.stringMatching(/join it/) });
    expect(engine.state.phase).toBe("idle");
    media.denyAll = true;
    expect(await engine.start("tch_1", "voice", "Ops")).toMatchObject({ ok: false, message: expect.stringContaining("microphone") });
  });
  it("an invitation rings with the host's name; becoming joined on another tab or missed stops the ringing", async () => {
    engine.handleState(call([P(ME, "invited"), P("mem_ben", "joined")]));
    expect(engine.state).toMatchObject({ phase: "ringing_in", title: "BEN", callId: "gcall_1" });
    engine.handleState(call([P(ME, "joined"), P("mem_ben", "joined")]));
    expect(engine.state).toMatchObject({ phase: "ended", message: "Answered on another device." });
    engine.reset();
    engine.handleState(call([P(ME, "invited"), P("mem_ben", "joined")]));
    engine.handleState(call([P(ME, "missed"), P("mem_ben", "joined")]));
    expect(engine.state.message).toMatch(/missed/);
    engine.reset();
    engine.handleState(call([P(ME, "invited"), P("mem_ben", "joined")]));
    await engine.decline();
    expect(t.of("gcall:decline")).toEqual([{ call_id: "gcall_1" }]);
  });
});

describe("the mesh", () => {
  it("the newcomer offers to everyone already in the call, one connection each, with its tracks", async () => {
    await joinWithPeers(["mem_ben", "mem_cleo"]);
    expect(FakePC.all).toHaveLength(2);
    const offers = t.of("gcall:offer");
    expect(offers.map((o) => o.to).sort()).toEqual(["mem_ben", "mem_cleo"]);
    expect(FakePC.all.every((p) => p.added.length === 2)).toBe(true);
    expect(engine.state.tiles.map((x) => x.name)).toEqual(["You", "BEN", "CLEO"]);
  });
  it("an existing participant answers an offer on a new link, with its tracks, to the person who sent it", async () => {
    t.replies["gcall:start"] = () => ({ ok: true, call: call([P(ME, "joined")], { host_id: ME }), ice: ICE, skipped: [] });
    await engine.start("tch_1", "video", "Ops");
    engine.handleState(call([P(ME, "joined"), P("mem_dan", "joined")], { host_id: ME }));
    t.fire("gcall:offer", { call_id: "gcall_1", from: "mem_dan", data: { type: "offer", sdp: "v=0 offer" } });
    await tick();
    await tick();
    expect(FakePC.all).toHaveLength(1);
    expect(t.of("gcall:answer")).toEqual([{ call_id: "gcall_1", to: "mem_dan", data: { type: "answer", sdp: "v=0 answer" } }]);
    expect(FakePC.all[0]!.added).toHaveLength(2);
    // candidates before the description wait; later ones are added at once
    t.fire("gcall:ice", { call_id: "gcall_1", from: "mem_dan", data: { candidate: "candidate:1 1 udp 1 192.0.2.1 1 typ host" } });
    expect(FakePC.all[0]!.candidates).toHaveLength(1);
  });
  it("ignores signals for another call and from nobody it knows", async () => {
    await joinWithPeers(["mem_ben"]);
    t.fire("gcall:offer", { call_id: "gcall_other", from: "mem_zed", data: { type: "offer", sdp: "x" } });
    t.fire("gcall:ice", { call_id: "gcall_1", from: "mem_zed", data: { candidate: "x" } });
    await tick();
    expect(FakePC.all).toHaveLength(1);
  });
  it("a person who leaves has their link closed; the call ending ends it for me; a left state of mine ends it", async () => {
    await joinWithPeers(["mem_ben", "mem_cleo"]);
    engine.handleState(call([P(ME, "joined"), P("mem_ben", "joined"), P("mem_cleo", "left")]));
    expect(FakePC.all.filter((p) => p.closed)).toHaveLength(1);
    expect(engine.state.tiles.map((x) => x.name)).toEqual(["You", "BEN"]);
    engine.handleState(call([P(ME, "joined"), P("mem_ben", "joined")], { state: "ended" }));
    expect(engine.state).toMatchObject({ phase: "ended", message: "The call ended." });
    expect(FakePC.all.every((p) => p.closed)).toBe(true);
  });
  it("restarts ICE only on the links where it is the offerer: when one fails and when the other side resumes", async () => {
    await joinWithPeers(["mem_ben"]);
    await FakePC.all[0]!.setRemoteDescription({ type: "answer", sdp: "x" }); // the first offer was answered
    FakePC.all[0]!.setState("failed");
    await tick();
    expect(FakePC.all[0]!.restarted).toBe(1);
    expect(engine.state.tiles[1]!.link).toBe("reconnecting");
    t.fire("gcall:peer", { call_id: "gcall_1", member_id: "mem_ben", event: "resumed" });
    await tick();
    expect(FakePC.all[0]!.restarted).toBe(2);
    expect(t.of("gcall:offer").length).toBeGreaterThanOrEqual(2);
    await FakePC.all[0]!.setRemoteDescription({ type: "answer", sdp: "x" });
    // a socket reconnect re-binds and restarts
    t.replies["gcall:resume"] = () => ({ ok: true, ice: ICE, call: call([P(ME, "joined"), P("mem_ben", "joined")]), peers: ["mem_ben"] });
    t.fire("connect", {});
    await tick();
    await tick();
    expect(t.of("gcall:resume")).toEqual([{ call_id: "gcall_1" }]);
    expect(FakePC.all[0]!.restarted).toBe(3);
  });
  it("a closed-for-good resume ends the call with a reason", async () => {
    await joinWithPeers(["mem_ben"]);
    t.replies["gcall:resume"] = () => ({ ok: false, error: { code: "CALL_STATE", message: "x" } });
    t.fire("connect", {});
    await tick();
    await tick();
    expect(engine.state).toMatchObject({ phase: "ended" });
  });
});

describe("controls", () => {
  it("mute and camera are applied to the tracks and told to the server", async () => {
    await joinWithPeers(["mem_ben"]);
    engine.toggleMute();
    engine.toggleCamera();
    expect(engine.state.local!.getAudioTracks()[0]!.enabled).toBe(false);
    expect(engine.state.local!.getVideoTracks()[0]!.enabled).toBe(false);
    expect(t.of("gcall:media")).toEqual([{ call_id: "gcall_1", muted: true }, { call_id: "gcall_1", camera_off: true }]);
    expect(engine.state.tiles[0]).toMatchObject({ muted: true, cameraOff: true });
  });
  it("highlights the loudest person who is not muted; nobody when it is quiet", async () => {
    await joinWithPeers(["mem_ben", "mem_cleo"]);
    const ben = new FakeStream(["audio"]) as unknown as MediaStream;
    const cleo = new FakeStream(["audio"]) as unknown as MediaStream;
    FakePC.all[0]!.ontrack?.({ streams: [ben], track: {} as never });
    FakePC.all[1]!.ontrack?.({ streams: [cleo], track: {} as never });
    const pick = () => (engine as unknown as { pickSpeaker(): void }).pickSpeaker();
    pick();
    expect(engine.state.speakingId).toBeNull();
    levelMap.set(ben, 0.3);
    levelMap.set(cleo, 0.1);
    pick();
    expect(engine.state.speakingId).toBe("mem_ben");
    expect(engine.state.tiles.find((x) => x.speaking)!.name).toBe("BEN");
    // Ben is muted in the call state: Cleo is the speaker
    engine.handleState(call([P(ME, "joined"), P("mem_ben", "joined", { muted: true }), P("mem_cleo", "joined")]));
    pick();
    expect(engine.state.speakingId).toBe("mem_cleo");
    levelMap.set(cleo, 0.01);
    pick();
    expect(engine.state.speakingId).toBeNull();
  });
  it("screen share: the server decides first; a refusal says who holds it and touches nothing; a grant replaces the video on every link and stopping puts the camera back", async () => {
    await joinWithPeers(["mem_ben", "mem_cleo"]);
    t.replies["gcall:share"] = (p) => (p.on ? { ok: false, error: { code: "SHARE_IN_USE", message: "Ben is sharing their screen" } } : { ok: true });
    expect(await engine.toggleShare()).toMatchObject({ ok: false, message: expect.stringMatching(/Someone else/) });
    expect(engine.state.sharing).toBe(false);
    t.replies["gcall:share"] = () => ({ ok: true });
    expect(await engine.toggleShare()).toEqual({ ok: true });
    expect(engine.state.sharing).toBe(true);
    for (const pc of FakePC.all) expect(pc.senders.find((s) => s.track?.kind === "video")!.track).not.toBe(engine.state.local!.getVideoTracks()[0]);
    await engine.toggleShare();
    expect(engine.state.sharing).toBe(false);
    for (const pc of FakePC.all) expect(pc.senders.find((s) => s.track?.kind === "video")!.track).toBe(engine.state.local!.getVideoTracks()[0]);
    expect(t.of("gcall:share").map((x) => x.on)).toEqual([true, true, false]);
  });
  it("somebody else starting to share stops mine without telling the server again", async () => {
    await joinWithPeers(["mem_ben"]);
    await engine.toggleShare();
    engine.handleState(call([P(ME, "joined"), P("mem_ben", "joined")], { sharing_id: "mem_ben" }));
    await tick();
    expect(engine.state.sharing).toBe(false);
    expect(engine.state.tiles.find((x) => x.memberId === "mem_ben")!.presenting).toBe(true);
  });
  it("inviting reports who could not be rung; leaving tells the server and closes everything", async () => {
    await joinWithPeers(["mem_ben"]);
    t.replies["gcall:invite"] = () => ({ ok: true, call: call([P(ME, "joined")]), skipped: [{ member_id: "mem_dan", name: "Dan", reason: "busy" }] });
    expect(await engine.invite(["mem_dan"])).toMatchObject({ ok: true, skipped: [{ reason: "busy" }] });
    await engine.leave();
    expect(t.of("gcall:leave")).toEqual([{ call_id: "gcall_1" }]);
    expect(engine.state).toMatchObject({ phase: "ended", message: "You left the call." });
    expect(FakePC.all.every((p) => p.closed)).toBe(true);
  });
  it("a join that is refused (full) says so and keeps nothing open", async () => {
    t.replies["gcall:join"] = () => ({ ok: false, error: { code: "GROUP_CALL_FULL", message: "x" } });
    engine.handleState(call([P(ME, "invited"), P("mem_ben", "joined")]));
    expect(await engine.join()).toMatchObject({ ok: false, message: "This call is full." });
    expect(engine.state.phase).toBe("ended");
    expect(FakePC.all).toHaveLength(0);
  });
});
