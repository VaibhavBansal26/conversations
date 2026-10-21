// The visitor side of the realtime engine (server/public/chat/aicall.js) in jsdom with a fake RTCPeerConnection, a fake data channel and a fake fetch for
// the provider's SDP exchange. NOTHING here talks to the real service: what the real provider sends and does is not verified by these tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../../server/public/chat/aicall.js?raw";
import { FakeDC, FakeMedia, FakePC } from "./fakes";
import { FakeRecognition, installSpeech, type FakeSynth } from "./fakeSpeech";

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

const SECRET = `ek_${Math.random().toString(16).slice(2)}`;
const CALL = { id: "call_rt1", room_id: "room_1", transport: "ai", kind: "ai_voice", state: "active", agent_name: "Aria" };
const REALTIME = { client_secret: SECRET, expires_at: 9999999999, url: "https://api.provider.test/v1/realtime/calls", model: "m", voice: null, tools: ["search_kb", "handoff_to_human"], opening: "Hi" };
const AI = { agent: { name: "Aria", label: "AI assistant", avatar_url: null, avatar_alt: "" }, greeting: "Hi, I'm Aria (AI assistant), not a person. This call is not recorded. How can I help you today?", disclosure: "x", engine: "realtime", fallback_reason: null, realtime: REALTIME, speech_lang: "en-us", max_duration_s: 600, idle_timeout_s: 120, max_utterance_chars: 600 };

let sock: Sock;
let media: FakeMedia;
let synth: FakeSynth;
let container: HTMLElement;
let ctl: any;
let events: { type: string; payload: any }[];
let fetchCalls: { url: string; init: any }[];
let fetchMode: "ok" | "fail" | "http" = "ok";
const cfg = { ai: { enabled: true, voice: true, video: true, realtime: true, engine: "browser", agent: { name: "Aria", label: "AI assistant", avatar_url: null, languages: [] } } };

const fakeFetch = async (url: string, init: any) => {
  fetchCalls.push({ url, init });
  if (fetchMode === "fail") throw new Error("network down");
  if (fetchMode === "http") return { ok: false, status: 500, text: async () => "no" };
  return { ok: true, status: 200, text: async () => "v=0 answer" };
};
const mk = (over: Record<string, unknown> = {}) =>
  Ai.create({ doc: document, win: window, container, getSocket: () => sock, getRoomId: () => "room_1", config: cfg, emit: (type: string, payload: unknown) => events.push({ type, payload }), mediaDevices: media, RTCPeerConnection: FakePC, fetch: fakeFetch, onFallback: () => {}, ...over });
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};
const overlay = () => container.querySelector<HTMLElement>(".aicall")!;
const caps = () => [...container.querySelectorAll(".ai-caps .cap")].map((c) => `${(c as HTMLElement).dataset.who ?? (c.classList.contains("ai") ? "ai-interim" : "interim")}: ${c.lastElementChild!.textContent}`);
const btn = (cls: string) => container.querySelector<HTMLButtonElement>(`.ai-bar button.${cls}`)!;
const pc = () => FakePC.all[0]!;
const dc = (): FakeDC => pc().channels[0]!;
async function started(replyOver: Record<string, unknown> = {}) {
  sock.replies["aicall:start"] = () => ({ ok: true, call: CALL, ai: { ...AI, ...replyOver } });
  const p = ctl.start("voice");
  await flush();
  await p;
  await flush();
}
async function connected() {
  await started();
  dc().open();
  await flush();
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.useFakeTimers();
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  sock = new Sock();
  media = new FakeMedia();
  synth = installSpeech(window);
  FakePC.all = [];
  events = [];
  fetchCalls = [];
  fetchMode = "ok";
  ctl = mk();
  ctl.bind(sock);
});
afterEach(() => {
  ctl.destroy();
  vi.useRealTimers();
});

describe("connecting to the voice service", () => {
  it("builds a peer connection with the microphone and a data channel, exchanges SDP with the one-call secret, and keeps the secret away from the server and the host", async () => {
    await started();
    expect(FakePC.all).toHaveLength(1);
    expect(pc().added).toHaveLength(1); // the microphone track
    expect(pc().channels.map((c) => c.label)).toEqual(["oai-events"]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(REALTIME.url);
    expect(fetchCalls[0]!.init).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/sdp" } });
    expect(fetchCalls[0]!.init.body).toBe("v=0 offer restart=0");
    expect(pc().remoteDescription).toEqual({ type: "answer", sdp: "v=0 answer" });
    // the browser's own speech is not used, the secret goes nowhere else
    expect(FakeRecognition.starts).toBe(0);
    expect(synth.spoken).toEqual([]);
    expect(JSON.stringify([sock.emitted, events])).not.toContain(SECRET);
    expect(overlay().textContent).toContain("Live voice");
    expect(overlay().textContent).toContain("not recorded by us");
  });

  it("starts the conversation when the channel opens, and shows the face in the thinking state until the assistant speaks", async () => {
    await connected();
    expect(dc().of("response.create")).toHaveLength(1);
    expect(overlay().dataset.phase).toBe("thinking");
    expect(caps()[0]).toContain("not a person"); // the disclosure is on screen at once
  });
});

describe("what the provider sends over the channel", () => {
  it("captions both sides live, tells the server what was said (the first assistant sentence is the greeting), and follows the states", async () => {
    await connected();
    dc().receive({ type: "response.output_audio_transcript.delta", delta: "Hi, I'm " });
    dc().receive({ type: "response.output_audio_transcript.delta", delta: "Aria." });
    expect(overlay().dataset.phase).toBe("speaking");
    expect(caps().at(-1)).toBe("ai-interim: Hi, I'm Aria.");
    dc().receive({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Hi, I'm Aria (AI assistant), not a person." });
    expect(sock.of("aicall:transcript")[0]).toEqual({ call_id: "call_rt1", role: "assistant", text: "Hi, I'm Aria (AI assistant), not a person.", item_id: "a1", greeting: true });
    dc().receive({ type: "response.done", response: { output: [] } });
    expect(overlay().dataset.phase).toBe("listening");

    dc().receive({ type: "input_audio_buffer.speech_started" });
    dc().receive({ type: "input_audio_buffer.speech_stopped" });
    expect(overlay().dataset.phase).toBe("thinking");
    dc().receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "How do I reset my password?" });
    expect(sock.of("aicall:transcript")[1]).toEqual({ call_id: "call_rt1", role: "user", text: "How do I reset my password?", item_id: "u1" });
    dc().receive({ type: "response.output_audio_transcript.done", item_id: "a2", transcript: "Open Settings." });
    expect(sock.of("aicall:transcript")[2]).toEqual({ call_id: "call_rt1", role: "assistant", text: "Open Settings.", item_id: "a2" }); // not the greeting
    expect(caps().slice(-2)).toEqual(["you: How do I reset my password?", "ai: Open Settings."]);
  });

  it("the visitor speaking while the assistant talks moves the face back to listening (the service itself stops the answer)", async () => {
    await connected();
    dc().receive({ type: "response.output_audio_transcript.delta", delta: "A long answer" });
    expect(overlay().querySelector(".face")!.getAttribute("data-state")).toBe("speaking");
    dc().receive({ type: "input_audio_buffer.speech_started" });
    expect(overlay().querySelector(".face")!.getAttribute("data-state")).toBe("listening");
  });

  it("a function call goes to OUR server; its answer goes back to the model and the model is asked to continue", async () => {
    await connected();
    sock.replies["aicall:tool"] = () => ({ ok: true, output: JSON.stringify({ entries: [{ id: "k1", question: "q", answer: "a" }] }) });
    dc().receive({ type: "response.done", response: { output: [{ type: "function_call", name: "search_kb", arguments: "{\"query\":\"reset password\"}", call_id: "fc_1" }] } });
    await flush();
    expect(sock.of("aicall:tool")).toEqual([{ call_id: "call_rt1", name: "search_kb", arguments: "{\"query\":\"reset password\"}" }]);
    const out = dc().of("conversation.item.create").at(-1);
    expect(out.item).toMatchObject({ type: "function_call_output", call_id: "fc_1" });
    expect(JSON.parse(out.item.output).entries).toHaveLength(1);
    expect(dc().of("response.create")).toHaveLength(2);
  });

  it("a refused tool call reports the refusal to the model instead of crashing", async () => {
    await connected();
    sock.replies["aicall:tool"] = () => ({ ok: false, error: { code: "RATE_LIMITED", message: "slow down" } });
    dc().receive({ type: "response.done", response: { output: [{ type: "function_call", name: "search_kb", arguments: "{}", call_id: "fc_2" }] } });
    await flush();
    expect(JSON.parse(dc().of("conversation.item.create").at(-1).item.output)).toEqual({ error: "slow down" });
  });

  it("a hand-over by the model lets it say goodbye, then the window waits for a person", async () => {
    await connected();
    sock.replies["aicall:tool"] = () => ({ ok: true, output: "{}", ended: { reason: "handoff", handoff_reason: "customer_requested_human", human_call: true } });
    dc().receive({ type: "response.done", response: { output: [{ type: "function_call", name: "handoff_to_human", arguments: "{}", call_id: "fc_3" }] } });
    await flush();
    expect(overlay().dataset.phase).not.toBe("waiting"); // still saying goodbye
    dc().receive({ type: "response.done", response: { output: [] } });
    await flush();
    expect(overlay().dataset.phase).toBe("waiting");
    expect(overlay().querySelector(".ai-status")!.textContent).toContain("they will call you here");
    expect(pc().closed).toBe(true);
  });

  it("a goodbye that never finishes does not hold the call open", async () => {
    await connected();
    sock.replies["aicall:tool"] = () => ({ ok: true, output: "{}", ended: { reason: "resolved" } });
    dc().receive({ type: "response.done", response: { output: [{ type: "function_call", name: "resolve_ticket", arguments: "{}", call_id: "fc_4" }] } });
    await flush();
    await vi.advanceTimersByTimeAsync(8100);
    expect(overlay().dataset.phase).toBe("ended");
    expect(pc().closed).toBe(true);
  });
});

describe("the safety monitor's cut", () => {
  it("closes the connection at once when the server ends the call after a transcript, and hands the visitor over", async () => {
    await connected();
    sock.replies["aicall:transcript"] = () => ({ ok: true, ended: { reason: "monitor", handoff_reason: "unsafe_answer", human_call: true } });
    dc().receive({ type: "response.output_audio_transcript.done", item_id: "a9", transcript: "I guarantee it." });
    await flush();
    expect(pc().closed).toBe(true);
    expect(dc().readyState).toBe("closed");
    expect(overlay().dataset.phase).toBe("waiting");
    // nothing more is accepted from the model's side
    dc().receive({ type: "response.output_audio_transcript.delta", delta: "more" });
    expect(overlay().dataset.phase).toBe("waiting");
  });

  it("the kill switch ends the call at once too", async () => {
    await connected();
    sock.replies["aicall:transcript"] = () => ({ ok: true, ended: { reason: "kill_switch" } });
    dc().receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "u3", transcript: "hello" });
    await flush();
    expect(pc().closed).toBe(true);
    expect(overlay().dataset.phase).toBe("ended");
  });

  it("a call the server already ended (CALL_STATE) closes the connection", async () => {
    await connected();
    sock.replies["aicall:transcript"] = () => ({ ok: false, error: { code: "CALL_STATE" } });
    dc().receive({ type: "response.output_audio_transcript.done", item_id: "a8", transcript: "words" });
    await flush();
    expect(pc().closed).toBe(true);
    expect(overlay().dataset.phase).toBe("ended");
  });
});

describe("when the connection to the voice service fails: back to the browser's voice", () => {
  const switched = async () => {
    expect(sock.of("aicall:fallback")).toHaveLength(1);
    expect(caps().at(-1)).toContain("switched to your browser's voice");
    expect(FakeRecognition.current()).toBeDefined(); // listening with the browser engine now
    expect(pc().closed).toBe(true);
    // and the loop of the browser engine works
    sock.replies["aicall:say"] = () => ({ ok: true, call: CALL, reply: { kind: "answer", text: "Sure.", speech: "Sure.", message_id: "m", ended: null } });
    FakeRecognition.current()!.final("hello there");
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(sock.of("aicall:say")).toHaveLength(1);
    expect(synth.spoken.at(-1)).toBe("Sure.");
  };
  beforeEach(() => {
    sock.replies["aicall:fallback"] = () => ({ ok: true, engine: "browser", fallback: "client_failed" });
  });

  it("the SDP exchange fails", async () => {
    fetchMode = "fail";
    await started();
    await flush();
    await switched();
    expect(sock.of("aicall:fallback")[0].reason).toBe("connect_failed");
  });
  it("the provider refuses (HTTP error)", async () => {
    fetchMode = "http";
    await started();
    await flush();
    await switched();
  });
  it("the channel never opens", async () => {
    await started();
    await vi.advanceTimersByTimeAsync(12_100);
    await flush();
    await switched();
    expect(sock.of("aicall:fallback")[0].reason).toBe("connect_timeout");
  });
  it("the connection fails after it was up", async () => {
    await connected();
    pc().setState("failed");
    await flush();
    await switched();
    expect(sock.of("aicall:fallback")[0].reason).toBe("ice_failed");
  });
  it("a connection that stays 'disconnected' for ten seconds", async () => {
    await connected();
    pc().setState("disconnected");
    await vi.advanceTimersByTimeAsync(10_100);
    await flush();
    await switched();
  });
  it("a connection that comes back within ten seconds is left alone", async () => {
    await connected();
    pc().setState("disconnected");
    await vi.advanceTimersByTimeAsync(4000);
    pc().setState("connected");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sock.of("aicall:fallback")).toHaveLength(0);
    expect(pc().closed).toBe(false);
  });
  it("if even the fallback is refused the visitor is told, not left hanging", async () => {
    sock.replies["aicall:fallback"] = () => ({ ok: false, error: { code: "CALL_STATE" } });
    fetchMode = "fail";
    await started();
    await flush();
    expect(overlay().dataset.phase).toBe("ended");
  });
  it("a browser without WebRTC is sent to the browser engine by the server and never connects to the provider", async () => {
    const c = mk({ RTCPeerConnection: undefined });
    c.bind(sock);
    sock.replies["aicall:start"] = () => ({ ok: true, call: { ...CALL, id: "call_b" }, ai: { ...AI, engine: "browser", fallback_reason: "no_webrtc", realtime: null } });
    const p = c.start("voice");
    await flush();
    await p;
    expect(sock.of("aicall:start").at(-1).speech.webrtc).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    expect(FakeRecognition.current()).toBeDefined();
    c.destroy();
  });
});

describe("controls in a realtime call", () => {
  it("typing sends the text over the channel and tells the server", async () => {
    await connected();
    const input = container.querySelector<HTMLInputElement>(".ai-type input")!;
    input.value = "What are your opening hours?";
    container.querySelector<HTMLFormElement>(".ai-type")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(dc().of("conversation.item.create").at(-1).item).toMatchObject({ role: "user", content: [{ type: "input_text", text: "What are your opening hours?" }] });
    expect(dc().of("response.create")).toHaveLength(2);
    expect(sock.of("aicall:transcript").at(-1)).toMatchObject({ role: "user", via: "typed", text: "What are your opening hours?" });
    expect(sock.of("aicall:say")).toHaveLength(0);
  });

  it("mute turns the microphone track off and on", async () => {
    await connected();
    const track = pc().added[0] as { enabled: boolean };
    btn("mute").click();
    expect(track.enabled).toBe(false);
    btn("mute").click();
    expect(track.enabled).toBe(true);
  });

  it("push-to-talk opens the microphone only while the button is held", async () => {
    await connected();
    const track = pc().added[0] as { enabled: boolean };
    btn("ptt").click();
    expect(track.enabled).toBe(false);
    btn("hold").dispatchEvent(new Event("pointerdown", { cancelable: true }));
    expect(track.enabled).toBe(true);
    btn("hold").dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(500);
    expect(track.enabled).toBe(false);
  });

  it("ending the call closes the channel and the connection, releases the microphone and tells the server", async () => {
    await connected();
    btn("end").click();
    await flush();
    expect(sock.of("aicall:end")).toEqual([{ call_id: "call_rt1", reason: "completed" }]);
    expect(pc().closed).toBe(true);
    expect(dc().readyState).toBe("closed");
    expect(overlay().dataset.phase).toBe("ended");
  });

  it("Talk to a person closes the connection and waits for the call", async () => {
    sock.replies["aicall:handoff"] = () => ({ ok: true, human_call: true, text: "x", call: CALL });
    await connected();
    btn("person").click();
    await flush();
    expect(overlay().dataset.phase).toBe("waiting");
    expect(pc().closed).toBe(true);
  });

  it("silence: the assistant is asked to check whether the visitor is there, then the call ends", async () => {
    await connected();
    dc().receive({ type: "response.done", response: { output: [] } }); // the greeting is over
    await vi.advanceTimersByTimeAsync(20_000);
    expect(caps().at(-1)).toBe("ai: Are you still there?");
    expect(dc().of("response.create").at(-1).response.instructions).toMatch(/still there/);
    await vi.advanceTimersByTimeAsync(25_100);
    expect(sock.of("aicall:end")).toEqual([{ call_id: "call_rt1", reason: "silence" }]);
  });

  it("the face follows the real level of the assistant's audio when the browser can measure it", async () => {
    const read = vi.fn((a: Uint8Array) => a.forEach((_, i) => (a[i] = i % 2 ? 250 : 5)));
    const Ctx = function (this: any) {
      this.createAnalyser = () => ({ fftSize: 64, getByteTimeDomainData: read });
      this.createMediaStreamSource = () => ({ connect: () => {} });
      this.close = () => {};
    } as unknown as typeof AudioContext;
    (window as any).AudioContext = Ctx;
    try {
      await connected();
      pc().ontrack?.({ streams: [{} as MediaStream], track: {} as any } as any);
      dc().receive({ type: "response.output_audio_transcript.delta", delta: "Hello" });
      await vi.advanceTimersByTimeAsync(300);
      expect(read).toHaveBeenCalled();
      expect(Number(overlay().querySelector<HTMLElement>(".face")!.style.getPropertyValue("--lvl"))).toBeGreaterThan(0.3);
    } finally {
      delete (window as any).AudioContext;
    }
  });

  it("a visitor with no microphone still gets the assistant's voice and can type", async () => {
    media.denyAll = true;
    await started();
    expect(pc().transceivers).toEqual([{ kind: "audio", direction: "recvonly" }]);
    expect(caps().some((c) => c.includes("Microphone access was blocked"))).toBe(true);
  });
});

describe("browsers without speech recognition", () => {
  it("can still call when the realtime engine is on, because the voice service does the listening", async () => {
    installSpeech(window, { recognition: false });
    const c = mk();
    c.bind(sock);
    sock.replies["aicall:start"] = () => ({ ok: true, call: { ...CALL, id: "call_n" }, ai: AI });
    const p = c.start("voice");
    await flush();
    await p;
    expect(sock.of("aicall:start")).toHaveLength(1);
    expect(FakePC.all).toHaveLength(1);
    c.destroy();
  });

  it("but the server giving the call the browser engine puts them in the text chat, with the call ended", async () => {
    installSpeech(window, { recognition: false });
    const fallback: string[] = [];
    const c = mk({ onFallback: (w: string) => fallback.push(w) });
    c.bind(sock);
    sock.replies["aicall:start"] = () => ({ ok: true, call: { ...CALL, id: "call_n2" }, ai: { ...AI, engine: "browser", fallback_reason: "provider_failed", realtime: null } });
    const p = c.start("voice");
    await flush();
    await p;
    expect(sock.of("aicall:end")).toEqual([{ call_id: "call_n2", reason: "unsupported" }]);
    expect(fallback).toEqual(["unsupported"]);
    expect(events.some((e) => e.type === "ai_call_unsupported")).toBe(true);
    c.destroy();
  });

  it("and without the realtime engine the buttons explain and send the visitor to the text chat as before", async () => {
    installSpeech(window, { recognition: false });
    const c = mk({ config: { ai: { ...cfg.ai, realtime: false } } });
    const bar = c.bar() as HTMLElement;
    container.appendChild(bar);
    (bar.querySelector("[data-ai-call=voice]") as HTMLButtonElement).click();
    await flush();
    expect(bar.textContent).toContain("cannot recognise speech");
    expect(sock.of("aicall:start")).toHaveLength(0);
    c.destroy();
  });
});
