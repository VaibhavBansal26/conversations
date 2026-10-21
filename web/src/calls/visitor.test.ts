// The visitor side of calls (server/public/chat/calls.js) in jsdom, with the WebRTC fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../../server/public/chat/calls.js?raw";
import { FakeMedia, FakePC, type FakeTrack } from "./fakes";

const Calls = (() => {
  const w = window as unknown as { ConversationsCalls?: any };
  // eslint-disable-next-line no-eval
  (0, eval)(source);
  return w.ConversationsCalls;
})();

type Ack = Record<string, unknown>;
class Sock {
  emitted: { event: string; payload: any }[] = [];
  handlers: Record<string, ((p: any) => void)[]> = {};
  replies: Record<string, (p: any) => Ack> = {};
  on(e: string, h: (p: any) => void) {
    (this.handlers[e] ||= []).push(h);
  }
  emit(event: string, payload: any, ack?: (a: Ack) => void) {
    this.emitted.push({ event, payload });
    ack?.(this.replies[event]?.(payload) ?? { ok: true });
  }
  fire(e: string, p?: unknown) {
    (this.handlers[e] || []).forEach((h) => h(p));
  }
  of(event: string) {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

let sock: Sock;
let media: FakeMedia;
let container: HTMLElement;
let ctl: any;
const events: { type: string; payload: any }[] = [];
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const ringing = (over: Record<string, unknown> = {}) => ({ call: { id: "call_1", room_id: "room_1", kind: "video", state: "ringing", agent_name: "Olivia", ...over } });
const ICE = { iceServers: [{ urls: ["stun:stun.example.test"] }, { urls: ["turn:turn.example.test"], username: "u", credential: "c" }] };

beforeEach(() => {
  FakePC.all = [];
  events.length = 0;
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  sock = new Sock();
  media = new FakeMedia();
  sock.replies["call:accept"] = () => ({ ok: true, call: { id: "call_1", state: "connecting", kind: "video" }, ice: ICE });
  ctl = Calls.create({
    doc: document, win: window, container, getSocket: () => sock, getRoomId: () => "room_1", config: { browser: { enabled: true, voice: true, video: true, screen_share: true } },
    emit: (type: string, payload: unknown) => events.push({ type, payload }), RTCPeerConnection: FakePC, mediaDevices: media, onRinging: () => events.push({ type: "ringing_hook", payload: null }),
  });
  ctl.bind(sock);
});
afterEach(() => {
  ctl.destroy();
  vi.useRealTimers();
});

const overlay = () => container.querySelector<HTMLElement>(".call")!;
const button = (cls: string) => container.querySelector<HTMLButtonElement>(`.bar button.${cls}`)!;

describe("incoming call", () => {
  it("shows who is calling with Accept and Decline, focuses Accept, and tells the host", () => {
    sock.fire("call:state", ringing());
    expect(overlay().hidden).toBe(false);
    expect(overlay().textContent).toContain("Olivia is calling you (video)");
    expect(button("accept").textContent).toBe("Accept");
    expect(document.activeElement).toBe(button("accept"));
    expect(events.map((e) => e.type)).toEqual(["call_state", "ringing_hook"]);
    expect(events[0]!.payload).toEqual({ room_id: "room_1", call_id: "call_1", state: "ringing", kind: "video" });
  });

  it("declining tells the server and clears the screen, nothing is requested from the microphone", () => {
    sock.fire("call:state", ringing());
    button("decline").click();
    expect(sock.of("call:decline")).toEqual([{ call_id: "call_1" }]);
    expect(overlay().hidden).toBe(true);
    expect(media.calls).toHaveLength(0);
  });

  it("a call of another conversation or a repeated ring is ignored", () => {
    sock.fire("call:state", ringing({ room_id: "room_other" }));
    expect(container.querySelector(".call")).toBeNull();
    sock.fire("call:state", ringing());
    sock.fire("call:state", ringing({ id: "call_2" }));
    expect(ctl.state().id).toBe("call_1");
  });

  it("when the agent cancels or the call is missed the screen goes away", () => {
    sock.fire("call:state", ringing());
    sock.fire("call:state", ringing({ state: "missed" }));
    expect(overlay().hidden).toBe(true);
    sock.fire("call:state", ringing({ id: "call_2" }));
    sock.fire("call:state", ringing({ id: "call_2", state: "ended" }));
    expect(overlay().textContent).toContain("Call ended");
  });
});

describe("answering", () => {
  async function answered() {
    sock.fire("call:state", ringing());
    button("accept").click();
    await flush();
    return FakePC.all[0]!;
  }

  it("asks for microphone and camera, accepts with the server, builds the peer with the server's ICE servers and shows the controls", async () => {
    const pc = await answered();
    expect(media.calls).toEqual([{ audio: true, video: true }]);
    expect(sock.of("call:accept")).toEqual([{ call_id: "call_1" }]);
    expect(pc.cfg.iceServers).toEqual(ICE.iceServers);
    expect([...container.querySelectorAll(".bar button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Mute microphone", "Turn camera off", "Share your screen", "Audio and video devices", "End call"]);
  });

  it("answers the agent's offer, attaches its tracks, sends candidates, and reports connected once", async () => {
    const pc = await answered();
    sock.fire("call:offer", { call_id: "call_1", data: { type: "offer", sdp: "v=0 agent" } });
    await flush();
    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "v=0 agent" });
    expect(pc.senders.length).toBe(2); // microphone and camera went into the answer
    expect(sock.of("call:answer")).toEqual([{ call_id: "call_1", data: { type: "answer", sdp: "v=0 answer" } }]);
    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "candidate:1 1 udp 1 192.0.2.9 1 typ host" }) } });
    expect(sock.of("call:ice")[0]).toMatchObject({ call_id: "call_1", data: { candidate: expect.any(String) } });
    pc.setState("connected");
    pc.setState("connected");
    expect(sock.of("call:connected")).toHaveLength(1);
    // candidates from the agent: queued before the description, applied after
    sock.fire("call:ice", { call_id: "call_1", data: { candidate: "candidate:7", sdpMid: "0", sdpMLineIndex: 0 } });
    expect(pc.candidates).toHaveLength(1);
  });

  it("queues early candidates until the offer is applied", async () => {
    const pc = await answered();
    sock.fire("call:ice", { call_id: "call_1", data: { candidate: "candidate:early" } });
    expect(pc.candidates).toHaveLength(0);
    sock.fire("call:offer", { call_id: "call_1", data: { type: "offer", sdp: "v=0 agent" } });
    await flush();
    expect(pc.candidates).toHaveLength(1);
  });

  it("a refused microphone declines the call and says why", async () => {
    media.denyAll = true;
    sock.fire("call:state", ringing());
    button("accept").click();
    await flush();
    expect(sock.of("call:decline")).toEqual([{ call_id: "call_1" }]);
    expect(overlay().textContent).toContain("Microphone access was blocked");
    expect(sock.of("call:accept")).toHaveLength(0);
  });

  it("continues with audio only when the camera is refused", async () => {
    media.denyVideo = true;
    await answered();
    expect(container.querySelector(".note")!.textContent).toContain("audio only");
    expect(button("cam")).toBeNull();
  });

  it("mute and camera buttons disable the tracks and show their state", async () => {
    const pc = await answered();
    void pc;
    button("mute").click();
    expect(button("mute").getAttribute("aria-pressed")).toBe("true");
    expect(button("mute").getAttribute("aria-label")).toBe("Unmute microphone");
    button("cam").click();
    expect(button("cam").getAttribute("aria-label")).toBe("Turn camera on");
  });

  it("the end button hangs up: tells the server, stops the media, closes the peer, shows 'Call ended'", async () => {
    const pc = await answered();
    const tracks = ctl._S.local.getTracks() as FakeTrack[];
    button("end").click();
    expect(sock.of("call:end")).toEqual([{ call_id: "call_1" }]);
    expect(pc.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(overlay().textContent).toContain("Call ended");
  });

  it("a server refusal on accept (the call was cancelled meanwhile) releases the microphone and ends", async () => {
    sock.replies["call:accept"] = () => ({ ok: false, error: { code: "CALL_STATE", message: "gone" } });
    sock.fire("call:state", ringing());
    button("accept").click();
    await flush();
    expect(FakePC.all).toHaveLength(0);
    expect(overlay().textContent).toContain("could not connect");
  });
});

describe("negotiation and network changes", () => {
  async function running() {
    sock.fire("call:state", ringing());
    button("accept").click();
    await flush();
    const pc = FakePC.all[0]!;
    sock.fire("call:offer", { call_id: "call_1", data: { type: "offer", sdp: "v=0 agent" } });
    await flush();
    pc.setState("connected");
    return pc;
  }

  it("the polite peer rolls back its own offer when the agent's collides", async () => {
    const pc = await running();
    pc.signalingState = "have-local-offer";
    sock.fire("call:offer", { call_id: "call_1", data: { type: "offer", sdp: "v=0 renegotiate" } });
    await flush();
    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "v=0 renegotiate" });
    expect(sock.of("call:answer")).toHaveLength(2);
  });

  it("after the socket reconnects it resumes the call and gives the peer the fresh ICE servers", async () => {
    const pc = await running();
    sock.replies["call:resume"] = () => ({ ok: true, call: { id: "call_1", state: "active" }, ice: { iceServers: [{ urls: ["turn:fresh"] }] } });
    sock.fire("connect");
    await flush();
    expect(sock.of("call:resume")).toEqual([{ call_id: "call_1" }]);
    expect(pc.config).toEqual({ iceServers: [{ urls: ["turn:fresh"] }] });
    sock.replies["call:resume"] = () => ({ ok: false, error: { code: "CALL_STATE", message: "over" } });
    sock.fire("connect");
    await flush();
    expect(overlay().textContent).toContain("Call ended");
  });

  it("shows reconnecting while the agent's side is lost and reports a failed connection after 15 seconds", async () => {
    vi.useFakeTimers();
    const pc = await (async () => {
      sock.fire("call:state", ringing());
      button("accept").click();
      await vi.advanceTimersByTimeAsync(10);
      const p = FakePC.all[0]!;
      sock.fire("call:offer", { call_id: "call_1", data: { type: "offer", sdp: "x" } });
      await vi.advanceTimersByTimeAsync(10);
      p.setState("connected");
      return p;
    })();
    pc.setState("disconnected");
    expect(container.querySelector(".note")!.textContent).toBe("Reconnecting...");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sock.of("call:failed")).toEqual([{ call_id: "call_1", reason: "ice_failed" }]);
  });

  it("a final state from the server ends it with the right text", async () => {
    await running();
    sock.fire("call:state", ringing({ state: "failed" }));
    expect(overlay().textContent).toContain("could not connect");
  });
});

describe("requesting a call", () => {
  it("offers Request buttons for the kinds that are on and sends call:request, then tells the host", async () => {
    const bar = ctl.requestBar() as HTMLElement;
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Request a voice call", "Request a video call"]);
    bar.querySelector<HTMLButtonElement>('[data-call-request="video"]')!.click();
    await flush();
    expect(sock.of("call:request")).toEqual([{ room_id: "room_1", kind: "video" }]);
    expect(events.find((e) => e.type === "call_requested")!.payload).toEqual({ room_id: "room_1", kind: "video" });
    expect(bar.textContent).toContain("Request sent");
  });

  it("offers nothing when calls are off or the kind is off", () => {
    const off = Calls.create({ doc: document, win: window, container, getSocket: () => sock, getRoomId: () => "room_1", config: { browser: { enabled: false, voice: true, video: true } } });
    expect(off.requestBar()).toBeNull();
    const voiceOnly = Calls.create({ doc: document, win: window, container, getSocket: () => sock, getRoomId: () => "room_1", config: { browser: { enabled: true, voice: true, video: false } } });
    expect([...voiceOnly.requestBar().querySelectorAll("button")].map((b: HTMLElement) => b.dataset.callRequest)).toEqual(["voice"]);
  });
});

describe("translation", () => {
  it("uses the host's dictionary and falls back to English for keys it lacks", () => {
    const t = (k: string, v?: Record<string, string>) => (k === "call_accept" ? "Annehmen" : k === "call_incoming" ? `${v!.name} ruft Sie an` : k);
    const de = Calls.create({ doc: document, win: window, container: document.body.appendChild(document.createElement("div")), getSocket: () => sock, getRoomId: () => "room_1", config: {}, t });
    de.bind(sock);
    sock.fire("call:state", ringing({ kind: "voice" }));
    const text = document.body.textContent!;
    expect(text).toContain("Olivia ruft Sie an");
    expect(text).toContain("Annehmen");
    expect(text).toContain("Decline"); // missing key: English
    de.destroy();
  });
});
