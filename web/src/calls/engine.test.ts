import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallEngine } from "./engine";
import { FakeMedia, FakePC, FakeStream, FakeTransport, type FakeTrack } from "./fakes";

let t: FakeTransport;
let media: FakeMedia;
let engine: CallEngine;
const tick = () => new Promise((r) => setTimeout(r, 0));
const ICE = { iceServers: [{ urls: ["stun:stun.example.test:3478"] }, { urls: ["turn:turn.example.test:3478"], username: "u", credential: "c" }], warning: null };

beforeEach(() => {
  FakePC.all = [];
  t = new FakeTransport();
  media = new FakeMedia();
  t.replies["call:invite"] = (p) => ({ ok: true, call: { id: "call_1", room_id: p.room_id, kind: p.kind, state: "ringing" }, ice: ICE });
  engine = new CallEngine({ transport: t as never, RTCPeerConnection: FakePC as never, mediaDevices: media as never, now: () => Date.now() });
});
afterEach(() => {
  engine.reset();
  vi.useRealTimers();
});

async function active(kind: "voice" | "video" = "video") {
  expect(await engine.start("room_1", kind)).toEqual({ ok: true });
  t.fire("call:state", { call: { id: "call_1", room_id: "room_1", kind, state: "connecting" } });
  await tick();
  await tick();
  const pc = FakePC.all[0]!;
  t.fire("call:answer", { call_id: "call_1", data: { type: "answer", sdp: "v=0 answer" } });
  await tick();
  pc.setState("connected");
  return pc;
}

describe("placing a call", () => {
  it("asks for the microphone (and camera for video) first, then invites, and rings", async () => {
    const r = await engine.start("room_1", "video");
    expect(r).toEqual({ ok: true });
    expect(media.calls).toEqual([{ audio: true, video: true }]);
    expect(t.of("call:invite")).toEqual([{ room_id: "room_1", kind: "video" }]);
    expect(engine.state).toMatchObject({ phase: "ringing", kind: "video", callId: "call_1", roomId: "room_1" });
  });

  it("does nothing when the microphone is refused, and says what to do", async () => {
    media.denyAll = true;
    const r = await engine.start("room_1", "voice");
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("microphone") });
    expect(t.of("call:invite")).toHaveLength(0);
    expect(engine.state.phase).toBe("idle");
  });

  it("falls back to audio only when the camera is refused", async () => {
    media.denyVideo = true;
    expect(await engine.start("room_1", "video")).toEqual({ ok: true });
    expect(engine.state.local!.getVideoTracks()).toHaveLength(0);
    expect(engine.state.message).toMatch(/audio only/);
  });

  it("releases the microphone and explains when the server refuses", async () => {
    t.replies["call:invite"] = () => ({ ok: false, error: { code: "VISITOR_OFFLINE", message: "x" } });
    const r = await engine.start("room_1", "voice");
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("not in the chat") });
    expect(engine.state.phase).toBe("idle");
  });

  it("refuses a second call while one is running", async () => {
    await engine.start("room_1", "voice");
    expect(await engine.start("room_2", "voice")).toMatchObject({ ok: false });
    expect(t.of("call:invite")).toHaveLength(1);
  });

  it("shows a TURN warning from the server", async () => {
    t.replies["call:invite"] = (p) => ({ ok: true, call: { id: "call_1", room_id: p.room_id, kind: p.kind, state: "ringing" }, ice: { ...ICE, warning: "No TURN relay is configured" } });
    await engine.start("room_1", "voice");
    expect(engine.state.warning).toBe("No TURN relay is configured");
  });
});

describe("negotiation", () => {
  it("builds the peer with the server's ICE servers once the visitor accepts, sends the offer and the candidates, applies the answer", async () => {
    await engine.start("room_1", "video");
    t.fire("call:state", { call: { id: "call_1", room_id: "room_1", kind: "video", state: "connecting" } });
    await tick();
    await tick();
    const pc = FakePC.all[0]!;
    expect(pc.cfg.iceServers).toEqual(ICE.iceServers);
    expect(pc.added).toHaveLength(2); // audio and video tracks
    expect(t.of("call:offer")).toEqual([{ call_id: "call_1", data: { type: "offer", sdp: "v=0 offer restart=0" } }]);
    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "candidate:1 1 udp 1 192.0.2.1 1 typ host", sdpMid: "0", sdpMLineIndex: 0 }) } });
    expect(t.of("call:ice")[0]).toMatchObject({ call_id: "call_1", data: { candidate: expect.stringContaining("candidate:1") } });
    t.fire("call:answer", { call_id: "call_1", data: { type: "answer", sdp: "v=0 answer" } });
    await tick();
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "v=0 answer" });
    // a candidate that arrives after the answer is applied at once, one before it is queued
    t.fire("call:ice", { call_id: "call_1", data: { candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 0 } });
    expect(pc.candidates).toHaveLength(1);
  });

  it("ignores signals of another call", async () => {
    const pc = await active();
    const before = pc.remoteDescription;
    t.fire("call:answer", { call_id: "call_other", data: { type: "answer", sdp: "x" } });
    t.fire("call:ice", { call_id: "call_other", data: { candidate: "candidate:9" } });
    await tick();
    expect(pc.remoteDescription).toBe(before);
    expect(pc.candidates).toHaveLength(0);
  });

  it("reports connected once, moves to active, counts seconds, and plays the remote stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    await engine.start("room_1", "voice");
    t.fire("call:state", { call: { id: "call_1", room_id: "room_1", kind: "voice", state: "connecting" } });
    await vi.advanceTimersByTimeAsync(5);
    const pc = FakePC.all[0]!;
    pc.setState("connected");
    pc.setState("connected");
    expect(t.of("call:connected")).toHaveLength(1);
    expect(engine.state.phase).toBe("active");
    const remote = new FakeStream(["audio"]);
    pc.ontrack?.({ streams: [remote], track: remote.tracks[0] as FakeTrack });
    expect(engine.state.remote).toBe(remote);
    await vi.advanceTimersByTimeAsync(3100);
    expect(engine.state.seconds).toBe(3);
  });
});

describe("controls", () => {
  it("mutes and turns the camera off by disabling the tracks, not by stopping them", async () => {
    await active();
    const local = engine.state.local!;
    engine.toggleMute();
    expect(local.getAudioTracks()[0]!.enabled).toBe(false);
    expect(engine.state.muted).toBe(true);
    engine.toggleMute();
    expect(local.getAudioTracks()[0]!.enabled).toBe(true);
    engine.toggleCamera();
    expect(local.getVideoTracks()[0]!.enabled).toBe(false);
    expect((local.getTracks() as unknown as FakeTrack[]).every((x) => !x.stopped)).toBe(true);
  });

  it("shares the screen by swapping the video track, and goes back to the camera", async () => {
    const pc = await active();
    const cam = engine.state.local!.getVideoTracks()[0] as unknown as FakeTrack;
    await engine.toggleShare();
    expect(engine.state.sharing).toBe(true);
    const sender = pc.senders.find((s) => s.track?.kind === "video")!;
    expect(sender.track).not.toBe(cam);
    await engine.toggleShare();
    expect(engine.state.sharing).toBe(false);
    expect(sender.track).toBe(cam);
  });
});

describe("ending", () => {
  it("hangs up: tells the server, stops every track, closes the peer and says the call ended", async () => {
    const pc = await active();
    const tracks = engine.state.local!.getTracks() as unknown as FakeTrack[];
    await engine.end();
    expect(t.of("call:end")).toEqual([{ call_id: "call_1" }]);
    expect(pc.closed).toBe(true);
    expect(tracks.every((x) => x.stopped)).toBe(true);
    expect(engine.state).toMatchObject({ phase: "ended", message: "The call ended.", local: null, remote: null });
    engine.reset();
    expect(engine.state.phase).toBe("idle");
  });

  it.each([
    ["declined", "declined"],
    ["missed", "did not answer"],
    ["failed", "could not connect"],
  ])("a %s call ends with a plain-words message", async (state, text) => {
    await engine.start("room_1", "voice");
    t.fire("call:state", { call: { id: "call_1", room_id: "room_1", kind: "voice", state } });
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.message).toContain(text);
  });

  it("ignores the state of other calls", async () => {
    await engine.start("room_1", "voice");
    t.fire("call:state", { call: { id: "call_other", room_id: "room_1", kind: "voice", state: "ended" } });
    expect(engine.state.phase).toBe("ringing");
  });

  it("stops listening when the call is over", async () => {
    await engine.start("room_1", "voice");
    t.fire("call:state", { call: { id: "call_1", room_id: "room_1", kind: "voice", state: "ended" } });
    expect([...t.handlers.values()].every((s) => s.size === 0)).toBe(true);
  });
});

describe("network changes", () => {
  it("restarts ICE when the connection drops and reports failure if it does not recover", async () => {
    vi.useFakeTimers();
    await engine.start("room_1", "voice");
    t.fire("call:state", { call: { id: "call_1", room_id: "room_1", kind: "voice", state: "connecting" } });
    await vi.advanceTimersByTimeAsync(5);
    const pc = FakePC.all[0]!;
    t.fire("call:answer", { call_id: "call_1", data: { type: "answer", sdp: "v=0 answer" } });
    await vi.advanceTimersByTimeAsync(5);
    pc.setState("connected");
    pc.setState("disconnected");
    await vi.advanceTimersByTimeAsync(5);
    expect(pc.restarted).toBe(1);
    expect(t.of("call:offer").at(-1)).toMatchObject({ data: { sdp: "v=0 offer restart=1" } });
    expect(engine.state.message).toBe("Reconnecting...");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(t.of("call:failed")).toEqual([{ call_id: "call_1", reason: "ice_failed" }]);
  });

  it("a recovered connection cancels the failure report", async () => {
    vi.useFakeTimers();
    await engine.start("room_1", "voice");
    t.fire("call:state", { call: { id: "call_1", room_id: "room_1", kind: "voice", state: "connecting" } });
    await vi.advanceTimersByTimeAsync(5);
    const pc = FakePC.all[0]!;
    pc.setState("connected");
    pc.setState("disconnected");
    pc.setState("connected");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.of("call:failed")).toHaveLength(0);
  });

  it("after the socket reconnects it resumes the call with fresh ICE servers and restarts ICE; if the call is gone it ends", async () => {
    const pc = await active();
    t.replies["call:resume"] = () => ({ ok: true, call: { id: "call_1", state: "active" }, ice: { iceServers: [{ urls: ["turn:fresh.example.test"], username: "u2", credential: "c2" }] } });
    t.fire("connect", undefined);
    await tick();
    await tick();
    expect(t.of("call:resume")).toEqual([{ call_id: "call_1" }]);
    expect(pc.config).toEqual({ iceServers: [{ urls: ["turn:fresh.example.test"], username: "u2", credential: "c2" }] });
    expect(pc.restarted).toBe(1);
    t.replies["call:resume"] = () => ({ ok: false, error: { code: "CALL_STATE", message: "ended" } });
    t.fire("connect", undefined);
    await tick();
    await tick();
    expect(engine.state.phase).toBe("ended");
  });

  it("tells the agent when the visitor drops and restarts ICE when they come back", async () => {
    const pc = await active();
    t.fire("call:peer", { call_id: "call_1", event: "lost" });
    expect(engine.state.message).toMatch(/lost the connection/);
    t.fire("call:peer", { call_id: "call_1", event: "resumed" });
    await tick();
    expect(pc.restarted).toBe(1);
    expect(engine.state.message).toBe("");
  });
});

describe("renegotiation from the visitor (screen share)", () => {
  it("answers an offer when stable; ignores one while it is making its own (impolite)", async () => {
    const pc = await active();
    t.fire("call:offer", { call_id: "call_1", data: { type: "offer", sdp: "v=0 visitor offer" } });
    await tick();
    await tick();
    expect(t.of("call:answer")).toEqual([{ call_id: "call_1", data: { type: "answer", sdp: "v=0 answer" } }]);
    pc.signalingState = "have-local-offer";
    t.fire("call:offer", { call_id: "call_1", data: { type: "offer", sdp: "v=0 collision" } });
    await tick();
    expect(t.of("call:answer")).toHaveLength(1);
  });
});
