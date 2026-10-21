import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamCallEngine, type TeamCallDto } from "./teamEngine";
import { FakeMedia, FakePC, FakeTransport } from "./fakes";

const ME = "mem_me";
const OTHER = "mem_ben";
const ICE = { iceServers: [{ urls: ["stun:stun.example.test:3478"] }, { urls: ["turn:turn.example.test:3478"], username: "u", credential: "c" }], warning: null };
const tick = () => new Promise((r) => setTimeout(r, 0));
const dto = (over: Partial<TeamCallDto> = {}, iAmCaller = true): TeamCallDto => ({
  id: "tcall_1", channel_id: "tch_1", kind: "video", state: "ringing", caller: iAmCaller ? { id: ME, name: "Me" } : { id: OTHER, name: "Ben" }, callee: iAmCaller ? { id: OTHER, name: "Ben" } : { id: ME, name: "Me" }, ...over,
});

let t: FakeTransport;
let media: FakeMedia;
let engine: TeamCallEngine;
beforeEach(() => {
  FakePC.all = [];
  t = new FakeTransport();
  media = new FakeMedia();
  t.replies["tcall:invite"] = (p) => ({ ok: true, call: dto({ kind: p.kind }), ice: ICE });
  t.replies["tcall:accept"] = () => ({ ok: true, call: dto({ state: "connecting" }, false), ice: ICE });
  engine = new TeamCallEngine({ transport: t as never, selfId: () => ME, RTCPeerConnection: FakePC as never, mediaDevices: media as never, now: () => Date.now() });
});
afterEach(() => {
  engine.reset();
  vi.useRealTimers();
});

describe("placing a call", () => {
  it("asks for the microphone (and camera for video), invites into the direct message and rings", async () => {
    expect(await engine.call("tch_1", "video", "Ben")).toEqual({ ok: true });
    expect(media.calls).toEqual([{ audio: true, video: true }]);
    expect(t.of("tcall:invite")).toEqual([{ channel_id: "tch_1", kind: "video" }]);
    expect(engine.state).toMatchObject({ phase: "ringing_out", role: "caller", peerName: "Ben", callId: "tcall_1", channelId: "tch_1", kind: "video" });
  });

  it("explains a refusal with the words of the reason and releases the microphone", async () => {
    for (const [code, text] of [["CALLEE_OFFLINE", /not online/], ["CALLEE_BUSY", /another call/], ["CALLEE_UNAVAILABLE", /not available/], ["USE_GROUP_CALL", /more than two/], ["RATE_LIMITED", /a lot/]] as const) {
      t.replies["tcall:invite"] = () => ({ ok: false, error: { code, message: "x" } });
      const r = await engine.call("tch_1", "voice", "Ben");
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(text) });
      expect(engine.state.phase).toBe("idle");
    }
  });

  it("does nothing without a microphone, falls back to audio when the camera is refused, and refuses a second call", async () => {
    media.denyAll = true;
    expect(await engine.call("tch_1", "voice", "Ben")).toMatchObject({ ok: false, message: expect.stringContaining("microphone") });
    expect(t.of("tcall:invite")).toHaveLength(0);
    media.denyAll = false;
    media.denyVideo = true;
    expect(await engine.call("tch_1", "video", "Ben")).toEqual({ ok: true });
    expect(engine.state.local!.getVideoTracks()).toHaveLength(0);
    expect(await engine.call("tch_2", "voice", "Cleo")).toMatchObject({ ok: false });
  });

  it("when the callee answers, the caller builds the peer with the server's ICE servers and offers", async () => {
    await engine.call("tch_1", "video", "Ben");
    engine.handleState(dto({ state: "connecting" }));
    await tick();
    await tick();
    expect(engine.state.phase).toBe("connecting");
    const pc = FakePC.all[0]!;
    expect(pc.cfg.iceServers).toEqual(ICE.iceServers);
    expect(pc.added).toHaveLength(2);
    expect(t.of("tcall:offer")[0]).toMatchObject({ call_id: "tcall_1", data: { type: "offer" } });
    t.fire("tcall:answer", { call_id: "tcall_1", data: { type: "answer", sdp: "v=0 answer" } });
    await tick();
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "v=0 answer" });
    pc.setState("connected");
    expect(engine.state.phase).toBe("active");
    expect(t.of("tcall:connected")).toEqual([{ call_id: "tcall_1" }]);
    pc.setState("connected");
    expect(t.of("tcall:connected")).toHaveLength(1);
  });

  it("a declined, missed or cancelled call ends the ringing with the right words", async () => {
    for (const [state, text] of [["declined", "Ben declined the call."], ["missed", "Ben did not answer."], ["failed", "The call could not connect."]] as const) {
      await engine.call("tch_1", "voice", "Ben");
      engine.handleState(dto({ state }));
      expect(engine.state).toMatchObject({ phase: "ended", message: text });
      engine.reset();
    }
  });

  it("cancelling while it rings tells the server and closes", async () => {
    await engine.call("tch_1", "voice", "Ben");
    await engine.end();
    expect(t.of("tcall:end")).toEqual([{ call_id: "tcall_1" }]);
    expect(engine.state.phase).toBe("ended");
  });
});

describe("a call that rings here", () => {
  const ring = (over: Partial<TeamCallDto> = {}) => engine.handleState(dto(over, false));

  it("shows who is calling, in any tab, and only for the callee", () => {
    ring();
    expect(engine.state).toMatchObject({ phase: "ringing_in", role: "callee", peerName: "Ben", kind: "video", callId: "tcall_1" });
    // someone else's call is not mine
    const other = new TeamCallEngine({ transport: t as never, selfId: () => "mem_cleo", RTCPeerConnection: FakePC as never, mediaDevices: media as never });
    other.handleState(dto({}, false));
    expect(other.state.phase).toBe("idle");
  });

  it("a second ring while busy is ignored", async () => {
    ring();
    ring({ id: "tcall_2" });
    expect(engine.state.callId).toBe("tcall_1");
  });

  it("accepting asks for the microphone, answers with the server, builds the peer and waits for the offer; the offer is answered with its tracks", async () => {
    ring();
    expect(await engine.accept()).toEqual({ ok: true });
    expect(media.calls).toEqual([{ audio: true, video: true }]);
    expect(t.of("tcall:accept")).toEqual([{ call_id: "tcall_1" }]);
    const pc = FakePC.all[0]!;
    expect(pc.cfg.iceServers).toEqual(ICE.iceServers);
    expect(engine.state.phase).toBe("connecting");
    expect(t.of("tcall:offer")).toHaveLength(0); // the callee does not offer first
    t.fire("tcall:ice", { call_id: "tcall_1", data: { candidate: "candidate:early" } });
    expect(pc.candidates).toHaveLength(0); // queued until the offer is applied
    t.fire("tcall:offer", { call_id: "tcall_1", data: { type: "offer", sdp: "v=0 caller" } });
    await tick();
    await tick();
    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "v=0 caller" });
    expect(pc.senders.length).toBe(2); // microphone and camera went into the answer
    expect(pc.candidates).toHaveLength(1);
    expect(t.of("tcall:answer")).toEqual([{ call_id: "tcall_1", data: { type: "answer", sdp: "v=0 answer" } }]);
    pc.setState("connected");
    expect(engine.state.phase).toBe("active");
    expect(t.of("tcall:connected")).toHaveLength(1);
  });

  it("a refused microphone declines the call and says why", async () => {
    media.denyAll = true;
    ring();
    expect(await engine.accept()).toMatchObject({ ok: false });
    expect(t.of("tcall:decline")).toEqual([{ call_id: "tcall_1" }]);
    expect(t.of("tcall:accept")).toHaveLength(0);
    expect(engine.state).toMatchObject({ phase: "ended", message: expect.stringContaining("microphone") });
  });

  it("declining tells the server", async () => {
    ring();
    await engine.decline();
    expect(t.of("tcall:decline")).toEqual([{ call_id: "tcall_1" }]);
    expect(engine.state).toMatchObject({ phase: "ended", message: "You declined the call." });
  });

  it("the caller cancelling, or the ring running out, stops the ringing with the right words", () => {
    ring();
    engine.handleState(dto({ state: "ended", end_reason: "cancelled" }, false));
    expect(engine.state.message).toBe("Ben cancelled the call.");
    engine.reset();
    ring();
    engine.handleState(dto({ state: "missed" }, false));
    expect(engine.state.message).toBe("Missed call from Ben.");
  });

  it("another tab of mine answering stops the ringing here (answered on another device)", () => {
    ring();
    engine.handleState(dto({ state: "connecting" }, false));
    expect(engine.state).toMatchObject({ phase: "ended", message: "Answered on another device." });
  });

  it("if the call is no longer ringing when I accept, I am told", async () => {
    t.replies["tcall:accept"] = () => ({ ok: false, error: { code: "CALL_STATE", message: "x" } });
    ring();
    expect(await engine.accept()).toMatchObject({ ok: false });
    expect(engine.state.message).toBe("The call is no longer ringing.");
  });

  it("the callee is the polite peer: it rolls back its own offer when the caller's offer collides", async () => {
    ring();
    await engine.accept();
    const pc = FakePC.all[0]!;
    t.fire("tcall:offer", { call_id: "tcall_1", data: { type: "offer", sdp: "v=0 first" } });
    await tick();
    await tick();
    pc.signalingState = "have-local-offer";
    t.fire("tcall:offer", { call_id: "tcall_1", data: { type: "offer", sdp: "v=0 second" } });
    await tick();
    await tick();
    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "v=0 second" });
    expect(t.of("tcall:answer")).toHaveLength(2);
  });
});

describe("during the call", () => {
  async function active(role: "caller" | "callee" = "caller") {
    if (role === "caller") {
      await engine.call("tch_1", "video", "Ben");
      engine.handleState(dto({ state: "connecting" }));
      await tick();
      await tick();
    } else {
      engine.handleState(dto({}, false));
      await engine.accept();
    }
    const pc = FakePC.all[0]!;
    pc.setState("connected");
    return pc;
  }

  it("mute and camera disable the tracks and show their state", async () => {
    await active();
    engine.toggleMute();
    expect(engine.state.muted).toBe(true);
    expect(engine.state.local!.getAudioTracks()[0]!.enabled).toBe(false);
    engine.toggleCamera();
    expect(engine.state.local!.getVideoTracks()[0]!.enabled).toBe(false);
    engine.toggleMute();
    expect(engine.state.local!.getAudioTracks()[0]!.enabled).toBe(true);
  });

  it("screen sharing replaces the camera track and stopping puts it back", async () => {
    const pc = await active();
    const cam = engine.state.local!.getVideoTracks()[0]!;
    await engine.toggleShare();
    expect(engine.state.sharing).toBe(true);
    expect(pc.senders.find((s) => s.track?.kind === "video")!.track).not.toBe(cam);
    await engine.toggleShare();
    expect(engine.state.sharing).toBe(false);
    expect(pc.senders.find((s) => s.track?.kind === "video")!.track).toBe(cam);
  });

  it("the caller restarts ICE when the connection drops; the callee waits for the offer", async () => {
    const pc = await active("caller");
    pc.setState("disconnected");
    await tick();
    await tick();
    expect(pc.restarted).toBe(1);
    expect(engine.state.message).toBe("Reconnecting...");
    const callee = new TeamCallEngine({ transport: t as never, selfId: () => ME, RTCPeerConnection: FakePC as never, mediaDevices: media as never });
    callee.handleState(dto({}, false));
    await callee.accept();
    const cpc = FakePC.all[1]!;
    cpc.setState("disconnected");
    await tick();
    expect(cpc.restarted).toBe(0);
    callee.reset();
  });

  it("a connection that does not recover in 15 seconds is reported failed", async () => {
    vi.useFakeTimers();
    const pc = await (async () => {
      await engine.call("tch_1", "voice", "Ben");
      engine.handleState(dto({ state: "connecting" }));
      await vi.advanceTimersByTimeAsync(10);
      const p = FakePC.all[0]!;
      p.setState("connected");
      return p;
    })();
    pc.setState("failed");
    await vi.advanceTimersByTimeAsync(15_100);
    expect(t.of("tcall:failed")).toEqual([{ call_id: "tcall_1", reason: "ice_failed" }]);
  });

  it("after a socket reconnect the call is resumed with fresh credentials and the caller restarts ICE", async () => {
    const pc = await active("caller");
    t.replies["tcall:resume"] = () => ({ ok: true, call: dto({ state: "active" }), ice: { iceServers: [{ urls: ["turn:new.example.test"] }] } });
    t.fire("connect", undefined);
    await tick();
    await tick();
    expect(t.of("tcall:resume")).toEqual([{ call_id: "tcall_1" }]);
    expect(pc.config).toEqual({ iceServers: [{ urls: ["turn:new.example.test"] }] });
    expect(pc.restarted).toBeGreaterThan(0);
    t.replies["tcall:resume"] = () => ({ ok: false, error: { code: "CALL_STATE", message: "x" } });
    t.fire("connect", undefined);
    await tick();
    await tick();
    expect(engine.state).toMatchObject({ phase: "ended", message: "The call ended while you were offline." });
  });

  it("the other side losing the connection is shown, and resuming clears it", async () => {
    await active("caller");
    t.fire("tcall:peer", { call_id: "tcall_1", event: "lost" });
    expect(engine.state.message).toMatch(/Ben lost the connection/);
    t.fire("tcall:peer", { call_id: "tcall_1", event: "resumed" });
    expect(engine.state.message).toBe("");
    t.fire("tcall:peer", { call_id: "other", event: "lost" });
    expect(engine.state.message).toBe("");
  });

  it("the other side ending the call closes everything and releases the devices", async () => {
    const pc = await active("callee");
    const tracks = engine.state.local!.getTracks() as unknown as { stopped: boolean }[];
    engine.handleState(dto({ state: "ended" }, false));
    expect(engine.state.phase).toBe("ended");
    expect(pc.closed).toBe(true);
    expect(tracks.every((x) => x.stopped)).toBe(true);
  });

  it("ending the call closes the peer, tells the server once and keeps the last words until closed", async () => {
    const pc = await active("caller");
    await engine.end();
    expect(t.of("tcall:end")).toEqual([{ call_id: "tcall_1" }]);
    expect(pc.closed).toBe(true);
    expect(engine.state).toMatchObject({ phase: "ended", message: "The call ended." });
    engine.reset();
    expect(engine.state.phase).toBe("idle");
  });

  it("only this call's signalling is handled: another call's offer, answer and candidates are ignored", async () => {
    await engine.call("tch_1", "video", "Ben");
    engine.handleState(dto({ state: "connecting" }));
    await tick();
    await tick();
    const pc = FakePC.all[0]!;
    t.fire("tcall:answer", { call_id: "tcall_other", data: { type: "answer", sdp: "x" } });
    t.fire("tcall:ice", { call_id: "tcall_other", data: { candidate: "c" } });
    await tick();
    expect(pc.remoteDescription).toBeNull();
    expect(pc.candidates).toHaveLength(0);
  });
});
