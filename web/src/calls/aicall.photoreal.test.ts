// The visitor side of the optional photoreal avatar (server/public/chat/aicall.js) in jsdom with a fake RTCPeerConnection. NOTHING here talks to a real
// avatar provider: the stream, its look and its lip-sync are not verified by these tests, only what this page does with the session the server gives it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../../server/public/chat/aicall.js?raw";
import { FakeMedia, FakePC, FakeStream } from "./fakes";
import { installSpeech, type FakeSynth } from "./fakeSpeech";

const Ai = (() => {
  const w = window as unknown as { ConversationsAiCall?: any };
  // eslint-disable-next-line no-eval
  (0, eval)(source);
  return w.ConversationsAiCall;
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
const CALL = { id: "call_pr1", room_id: "room_1", transport: "ai", kind: "ai_video", state: "active", agent_name: "Aria" };
const GREETING = "Hi, I'm Aria (AI assistant), not a person. This call is not recorded. How can I help you today?";
const SESSION = { id: "avs_1", offer: { type: "offer", sdp: "v=0 offer from the provider" }, ice_servers: [{ urls: ["stun:stun.avatar.test:3478"] }] };
const AI = (avatar: unknown, label = "AI assistant") => ({ agent: { name: "Aria", label, avatar_url: null, avatar_alt: "" }, greeting: GREETING, disclosure: "x", engine: "browser", fallback_reason: null, realtime: null, speech_lang: "en-us", max_duration_s: 600, idle_timeout_s: 120, max_utterance_chars: 600, avatar });
const cfg = { ai: { enabled: true, voice: true, video: true, realtime: false, engine: "browser", agent: { name: "Aria", label: "AI assistant", avatar_url: null, languages: [] } } };

let sock: Sock;
let synth: FakeSynth;
let container: HTMLElement;
let ctl: any;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};
const overlay = () => container.querySelector<HTMLElement>(".aicall")!;
const face = () => container.querySelector<HTMLElement>(".aicall .face")!;
async function start(avatar: unknown, label?: string) {
  sock.replies["aicall:start"] = () => ({ ok: true, call: CALL, ai: AI(avatar, label) });
  const p = ctl.start("video");
  await flush();
  await p;
  await flush();
}
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.useFakeTimers();
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  sock = new Sock();
  synth = installSpeech(window);
  FakePC.all = [];
  ctl = Ai.create({ doc: document, win: window, container, getSocket: () => sock, getRoomId: () => "room_1", config: cfg, emit: () => {}, mediaDevices: new FakeMedia(), RTCPeerConnection: FakePC, onFallback: () => {} });
  ctl.bind(sock);
});
afterEach(() => {
  ctl.destroy();
  vi.useRealTimers();
});

describe("a photoreal avatar session", () => {
  it("receives only: the peer connection has no microphone or camera track; the answer goes to this server, never to the provider", async () => {
    await start({ mode: "photoreal", reason: null, session: SESSION });
    expect(FakePC.all).toHaveLength(1);
    const pc = FakePC.all[0]!;
    expect(pc.cfg).toEqual({ iceServers: SESSION.ice_servers });
    expect(pc.added).toEqual([]);
    expect(pc.senders).toEqual([]);
    expect(pc.remoteDescription).toEqual(SESSION.offer);
    expect(sock.of("aicall:avatar")).toEqual([{ call_id: "call_pr1", op: "answer", data: { type: "answer", sdp: "v=0 answer" } }]);
    pc.onicecandidate?.({ candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } as never });
    expect(sock.of("aicall:avatar")[1]).toEqual({ call_id: "call_pr1", op: "ice", data: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } });
  });

  it("keeps the AI label, the 'not a person' badge and adds a disclosure that this is a computer-generated video", async () => {
    await start({ mode: "photoreal", reason: null, session: SESSION });
    FakePC.all[0]!.ontrack?.({ streams: [new FakeStream(["video", "audio"]) as never], track: {} as never });
    expect(face().dataset.mode).toBe("video");
    expect(face().querySelector("video.face-video")).not.toBeNull();
    expect(face().querySelector(".face-label")!.textContent).toBe("AI assistant");
    expect(face().getAttribute("aria-label")).toContain("AI assistant");
    expect(overlay().textContent).toContain("AI assistant, not a person");
    expect(overlay().querySelector("[data-photoreal-note]")!.textContent).toMatch(/computer-generated video of an AI assistant, not a real person/);
    expect(overlay().textContent).toContain("not a person"); // the greeting caption
    // a label the server would never send (it requires two characters) still leaves a label on the face
    ctl.destroy();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    ctl = Ai.create({ doc: document, win: window, container, getSocket: () => sock, getRoomId: () => "room_1", config: cfg, emit: () => {}, mediaDevices: new FakeMedia(), RTCPeerConnection: FakePC, onFallback: () => {} });
    await start({ mode: "photoreal", reason: null, session: SESSION }, "");
    expect(face().querySelector(".face-label")!.textContent).toBe("AI");
  });

  it("the avatar speaks, not the browser: the greeting waits for the video, then the server is told it is connected; answers are not spoken by the browser", async () => {
    await start({ mode: "photoreal", reason: null, session: SESSION });
    expect(synth.spoken).toEqual([]);
    const pc = FakePC.all[0]!;
    pc.setState("connected");
    await flush();
    expect(sock.of("aicall:avatar").map((x) => x.op)).toContain("connected");
    expect(overlay().dataset.phase).toBe("speaking");
    sock.replies["aicall:say"] = () => ({ ok: true, reply: { kind: "answer", text: "Open Settings.", speech: "Open Settings.", message_id: "m1", ended: null }, call: CALL });
    await vi.advanceTimersByTimeAsync(10_000);
    overlay().querySelector<HTMLInputElement>(".ai-type input")!.value = "reset password";
    overlay().querySelector<HTMLFormElement>(".ai-type")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(sock.of("aicall:say")).toHaveLength(1);
    expect(synth.spoken).toEqual([]);
    expect(overlay().dataset.phase).toBe("speaking");
  });

  it("no video within 12 s: back to the built-in face, the server is told, and the browser says the greeting", async () => {
    await start({ mode: "photoreal", reason: null, session: SESSION });
    await vi.advanceTimersByTimeAsync(12_500);
    expect(sock.of("aicall:avatar").pop()).toEqual({ call_id: "call_pr1", op: "failed", data: "connect_timeout" });
    expect(FakePC.all[0]!.closed).toBe(true);
    expect(face().dataset.mode).not.toBe("video");
    expect(overlay().querySelector("[data-photoreal-note]")).toBeNull();
    expect(overlay().textContent).toContain("switched to the simple avatar");
    expect(synth.spoken.join(" ")).toContain("not a person");
  });

  it("the server says photoreal stopped (a provider error, the budget, the kill switch): the page switches without reporting back", async () => {
    await start({ mode: "photoreal", reason: null, session: SESSION });
    FakePC.all[0]!.setState("connected");
    FakePC.all[0]!.ontrack?.({ streams: [new FakeStream(["video"]) as never], track: {} as never });
    await flush();
    const before = sock.of("aicall:avatar").length;
    sock.fire("aicall:avatar_state", { call_id: "call_pr1", state: "failed", reason: "budget" });
    await flush();
    expect(sock.of("aicall:avatar")).toHaveLength(before);
    expect(face().querySelector("video.face-video")).toBeNull();
    expect(overlay().textContent).toContain("switched to the simple avatar");
    // and answers are spoken by the browser again
    sock.replies["aicall:say"] = () => ({ ok: true, reply: { kind: "answer", text: "Open Settings.", speech: "Open Settings.", message_id: "m1", ended: null }, call: CALL });
    await vi.advanceTimersByTimeAsync(10_000);
    overlay().querySelector<HTMLInputElement>(".ai-type input")!.value = "reset password";
    overlay().querySelector<HTMLFormElement>(".ai-type")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(synth.spoken).toContain("Open Settings.");
  });

  it("the built-in face when the server says so: no peer connection, the greeting from the browser voice", async () => {
    await start({ mode: "builtin", reason: "not_connected", session: null });
    expect(FakePC.all).toHaveLength(0);
    expect(overlay().querySelector("[data-photoreal-note]")).toBeNull();
    expect(synth.spoken.join(" ")).toContain("not a person");
  });
});
