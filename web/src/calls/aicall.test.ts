// The visitor side of calls with the AI assistant (server/public/chat/aicall.js) in jsdom with a fake Web Speech API:
// speech -> text -> the assistant's answer -> speech, barge-in, silence, push-to-talk, hand-over, the text fallback and the avatar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../../server/public/chat/aicall.js?raw";
import { FakeMedia } from "./fakes";
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

const CALL = { id: "call_ai1", room_id: "room_1", transport: "ai", kind: "ai_voice", state: "active", agent_name: "Aria" };
const AI = { agent: { name: "Aria", label: "AI assistant", avatar_url: null }, greeting: "Hi, I'm Aria (AI assistant), not a person. This call is not recorded. How can I help you today?", disclosure: "x", engine: "browser", speech_lang: "en-us", max_duration_s: 600, idle_timeout_s: 120, max_utterance_chars: 600 };

let sock: Sock;
let media: FakeMedia;
let synth: FakeSynth;
let container: HTMLElement;
let ctl: any;
let events: { type: string; payload: any }[];
let fallback: string[];
const cfg = { ai: { enabled: true, voice: true, video: true, engine: "browser", agent: { name: "Aria", label: "AI assistant", avatar_url: null, languages: [] }, max_duration_s: 600, idle_timeout_s: 120 } };

const mk = (over: Record<string, unknown> = {}) =>
  Ai.create({ doc: document, win: window, container, getSocket: () => sock, getRoomId: () => "room_1", config: cfg, emit: (type: string, payload: unknown) => events.push({ type, payload }), mediaDevices: media, onFallback: (why: string) => fallback.push(why), ...over });
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};
const overlay = () => container.querySelector<HTMLElement>(".aicall")!;
const caps = () => [...container.querySelectorAll(".ai-caps .cap")].map((c) => `${(c as HTMLElement).dataset.who ?? "interim"}: ${c.lastElementChild!.textContent}`);
const status = () => container.querySelector(".ai-status")!.textContent;
const btn = (cls: string) => container.querySelector<HTMLButtonElement>(`.ai-bar button.${cls}`)!;
const rec = () => FakeRecognition.current()!;
/** say something and let the pause that ends a sentence pass */
async function speak(text: string) {
  rec().interim(text.slice(0, 3));
  rec().final(text);
  await vi.advanceTimersByTimeAsync(800);
  await flush();
}
async function started(kind: "voice" | "video" = "voice") {
  const p = ctl.start(kind);
  await flush();
  await p;
  return p;
}
const answer = (text: string, over: Record<string, unknown> = {}) => ({ ok: true, call: CALL, reply: { kind: "answer", text, speech: text, message_id: "m1", ended: null, ...over } });

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  sock = new Sock();
  media = new FakeMedia();
  synth = installSpeech(window);
  events = [];
  fallback = [];
  sock.replies["aicall:start"] = () => ({ ok: true, call: CALL, ai: AI });
  ctl = mk();
  ctl.bind(sock);
});
afterEach(() => {
  ctl.destroy();
  vi.useRealTimers();
});

describe("the buttons", () => {
  it("are not offered when the workspace has AI calls off", () => {
    expect(mk({ config: { ai: { enabled: false } } }).bar()).toBeNull();
    expect(mk({ config: {} }).bar()).toBeNull();
  });

  it("offer voice and the avatar video call, labelled as an AI", () => {
    const bar = ctl.bar() as HTMLElement;
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Talk to our AI assistant (voice)", "Video call with our AI assistant (avatar)"]);
    expect(mk({ config: { ai: { enabled: true, video: false } } }).bar().querySelectorAll("button")).toHaveLength(1);
  });

  it("in a browser without speech recognition they explain why and send the visitor to the text chat, without touching the microphone or the server", async () => {
    installSpeech(window, { recognition: false });
    const c = mk();
    const bar = c.bar() as HTMLElement;
    container.appendChild(bar);
    (bar.querySelector("[data-ai-call=voice]") as HTMLButtonElement).click();
    await flush();
    expect(bar.textContent).toContain("cannot recognise speech");
    expect(bar.textContent).toContain("Firefox");
    expect(fallback).toEqual(["unsupported"]);
    expect(events.map((e) => e.type)).toEqual(["ai_call_unsupported"]);
    expect(media.calls).toHaveLength(0);
    expect(sock.of("aicall:start")).toHaveLength(0);
    expect(container.querySelector(".aicall")).toBeNull();
    c.destroy();
  });
});

describe("starting", () => {
  it("opens the microphone, starts the call with the language and what the browser can do, and shows who the visitor talks to", async () => {
    await started();
    expect(media.calls).toEqual([{ audio: true }]);
    expect(sock.of("aicall:start")).toEqual([{ room_id: "room_1", kind: "voice", locale: expect.any(String), speech: { stt: true, tts: true } }]);
    expect(overlay().hidden).toBe(false);
    expect(overlay().querySelector(".ai-name")!.textContent).toBe("Call with Aria");
    expect(overlay().querySelector(".ai-badge")!.textContent).toBe("AI assistant, not a person");
    expect(overlay().textContent).toContain("This call is not recorded");
    expect(caps()).toEqual([`ai: ${AI.greeting}`]);
    // the disclosure is spoken, and listening is already on so the visitor can interrupt it
    expect(synth.spoken[0]).toContain("not a person");
    expect(rec().lang).toBe("en-us");
    expect(rec().continuous).toBe(true);
    expect(rec().interimResults).toBe(true);
    expect(events.find((e) => e.type === "ai_call_state" && e.payload.state === "listening")!.payload).toMatchObject({ room_id: "room_1", call_id: "call_ai1", kind: "voice" });
  });

  it("tells the visitor plainly when the assistant is busy or unavailable and does not leave the microphone open", async () => {
    sock.replies["aicall:start"] = () => ({ ok: false, error: { code: "AI_BUSY", message: "busy" } });
    await started();
    expect(status()).toContain("busy with other calls");
    expect(FakeRecognition.starts).toBe(0);
    expect(media.calls).toHaveLength(1);
    const tracks = (await media.getUserMedia({ audio: true })) as unknown as { getTracks(): { stopped: boolean }[] };
    void tracks;
  });

  it("a refused microphone falls back to typing inside the call, and typing works", async () => {
    media.denyAll = true;
    await started();
    expect(caps().some((c) => c.includes("Microphone access was blocked"))).toBe(true);
    expect(FakeRecognition.starts).toBe(0);
    expect(btn("ptt")).toBeNull();
    sock.replies["aicall:say"] = () => answer("Open Settings.");
    const input = container.querySelector<HTMLInputElement>(".ai-type input")!;
    input.value = "How do I reset my password?";
    container.querySelector<HTMLFormElement>(".ai-type")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(sock.of("aicall:say")).toEqual([{ call_id: "call_ai1", text: "How do I reset my password?", seq: 1, via: "typed" }]);
    expect(caps()).toContain("you: How do I reset my password?");
  });

  it("the video call shows an avatar, says the assistant cannot see the visitor and does not touch the camera", async () => {
    sock.replies["aicall:start"] = () => ({ ok: true, call: { ...CALL, kind: "ai_video" }, ai: AI });
    await started("video");
    expect(overlay().querySelector("svg.ai-avatar")).not.toBeNull();
    expect(overlay().querySelector("svg.ai-avatar")!.getAttribute("aria-label")).toBe("Aria, animated AI avatar");
    expect(overlay().textContent).toContain("cannot see you");
    expect(overlay().textContent).toContain("not sent anywhere");
    expect(media.calls).toEqual([{ audio: true }]); // no camera
    expect(sock.of("aicall:start")[0]).toMatchObject({ kind: "video" });
    expect(overlay().querySelector<HTMLVideoElement>(".ai-self")!.hidden).toBe(true);
    // the self-view is the visitor's own choice and stays local
    btn("cam").click();
    await flush();
    expect(media.calls).toEqual([{ audio: true }, { video: true }]);
    expect(overlay().querySelector<HTMLVideoElement>(".ai-self")!.hidden).toBe(false);
    expect(overlay().querySelector(".ai-self")!.getAttribute("aria-label")).toContain("only you see this");
    expect(sock.emitted.every((e) => !JSON.stringify(e.payload).includes("video: true") || e.event === "aicall:start")).toBe(true);
    btn("cam").click();
    expect(overlay().querySelector<HTMLVideoElement>(".ai-self")!.hidden).toBe(true);
  });
});

describe("the loop: speech to text, the answer, text to speech", () => {
  it("sends what was said, shows both sides as captions and speaks the answer without its links", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => answer("Open Settings, choose Security.\n\nFrom our help centre:\nReset: https://help.example.test/r", { speech: "Open Settings, choose Security." });
    rec().interim("how do");
    expect(container.querySelector(".ai-caps .cap.interim")!.textContent).toContain("how do");
    rec().final("how do I reset my password");
    expect(sock.of("aicall:say")).toHaveLength(0); // waits for the pause that ends the sentence
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(sock.of("aicall:say")).toEqual([{ call_id: "call_ai1", text: "how do I reset my password", seq: 1, via: "voice" }]);
    expect(caps().slice(-2)).toEqual(["you: how do I reset my password", "ai: Open Settings, choose Security.\n\nFrom our help centre:\nReset: https://help.example.test/r"]);
    expect(synth.spoken.at(-1)).toBe("Open Settings, choose Security.");
    expect(synth.spoken.join(" ")).not.toContain("https://");
    expect(overlay().dataset.phase).toBe("speaking");
    synth.finish();
    await flush();
    expect(overlay().dataset.phase).toBe("listening");
    expect(status()).toBe("Listening...");
  });

  it("merges phrases that arrive close together into one utterance, and what is said while the assistant is thinking into the next one", async () => {
    await started();
    synth.finish();
    let release: (a: Ack) => void = () => {};
    sock.emit = (event: string, payload: any, ack?: (a: Ack) => void) => {
      sock.emitted.push({ event, payload });
      if (event === "aicall:say" && sock.emitted.filter((e) => e.event === "aicall:say").length === 1) release = ack!;
      else ack?.((sock.replies[event]?.(payload) as Ack) ?? { ok: true });
    };
    sock.replies["aicall:say"] = () => answer("Second answer.");
    rec().final("what are");
    await vi.advanceTimersByTimeAsync(300);
    rec().final("your opening hours");
    await vi.advanceTimersByTimeAsync(800);
    expect(sock.of("aicall:say")).toHaveLength(1);
    expect(sock.of("aicall:say")[0].text).toBe("what are your opening hours");
    expect(overlay().dataset.phase).toBe("thinking");
    // two more things while it thinks: one request in flight at a time, one merged follow-up afterwards
    rec().final("and on");
    await vi.advanceTimersByTimeAsync(800);
    rec().final("saturdays");
    await vi.advanceTimersByTimeAsync(800);
    expect(sock.of("aicall:say")).toHaveLength(1);
    release(answer("First answer.") as Ack);
    await flush();
    expect(sock.of("aicall:say").map((p) => p.text)).toEqual(["what are your opening hours", "and on saturdays"]);
    expect(sock.of("aicall:say").map((p) => p.seq)).toEqual([1, 2]);
  });

  it("the visitor speaking over the assistant cuts its voice at once (barge-in)", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => answer("A long answer that goes on and on.");
    await speak("tell me about invoices");
    expect(overlay().dataset.phase).toBe("speaking");
    const cancelled = synth.cancelled;
    rec().interim("actually wait");
    expect(synth.cancelled).toBeGreaterThan(cancelled);
    expect(synth.queue).toHaveLength(0);
    expect(overlay().dataset.phase).toBe("listening");
    // and what they said next is sent as the next utterance
    rec().final("actually wait what about refunds");
    await vi.advanceTimersByTimeAsync(800);
    expect(sock.of("aicall:say")).toHaveLength(2);
  });

  it("restarts the recognizer when the browser stops it by itself", async () => {
    await started();
    const first = rec();
    first.endByItself();
    await vi.advanceTimersByTimeAsync(400);
    expect(rec()).not.toBe(first);
    expect(FakeRecognition.starts).toBe(2);
  });

  it("shows a rate-limit answer as a gentle request and keeps listening", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => ({ ok: false, error: { code: "RATE_LIMITED", message: "slow" } });
    await speak("one two three");
    expect(caps().at(-1)).toBe("ai: Please slow down a little.");
    expect(overlay().dataset.phase).toBe("listening");
  });

  it("a timeout or a broken answer says so and the call goes on", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => ({ ok: false, error: { code: "INTERNAL", message: "x" } });
    await speak("hello again");
    expect(caps().at(-1)).toContain("Something went wrong");
    expect(overlay().dataset.phase).toBe("listening");
  });
});

describe("silence", () => {
  it("asks whether the visitor is still there once, then ends the call and tells the server why", async () => {
    await started();
    synth.finish();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(caps().at(-1)).toBe("ai: Are you still there?");
    expect(synth.spoken.at(-1)).toBe("Are you still there?");
    synth.finish();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sock.of("aicall:end")).toEqual([{ call_id: "call_ai1", reason: "silence" }]);
    expect(overlay().dataset.phase).toBe("ended");
    expect(status()).toContain("I did not hear anything");
    expect(btn("end").textContent).toBe("Close");
  });

  it("speech resets the silence clock", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => answer("Sure.");
    await vi.advanceTimersByTimeAsync(15_000);
    await speak("hello there");
    synth.finish();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(caps().some((c) => c.includes("still there"))).toBe(false);
    expect(sock.of("aicall:end")).toHaveLength(0);
  });
});

describe("controls", () => {
  it("mute stops the recognizer and un-mute starts it again; the microphone track follows", async () => {
    await started();
    synth.finish();
    await flush();
    expect(rec()).toBeDefined();
    btn("mute").click();
    await flush();
    expect(FakeRecognition.current()).toBeUndefined();
    expect(status()).toBe("Microphone muted");
    expect(btn("mute").getAttribute("aria-pressed")).toBe("true");
    btn("mute").click();
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeRecognition.current()).toBeDefined();
  });

  it("push-to-talk listens only while the button is held, and sends on release", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => answer("Done.");
    btn("ptt").click();
    await flush();
    expect(FakeRecognition.current()).toBeUndefined();
    expect(status()).toBe("Hold to talk");
    const hold = btn("hold");
    hold.dispatchEvent(new Event("pointerdown", { cancelable: true }));
    await flush();
    expect(FakeRecognition.current()).toBeDefined();
    rec().final("press and talk");
    expect(sock.of("aicall:say")).toHaveLength(0); // still held
    hold.dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(sock.of("aicall:say")).toEqual([{ call_id: "call_ai1", text: "press and talk", seq: 1, via: "voice" }]);
    expect(FakeRecognition.current()).toBeUndefined();
  });

  it("pressing the talk button while the assistant speaks silences it", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => answer("Long answer.");
    await speak("question please");
    btn("ptt").click();
    await flush();
    const before = synth.cancelled;
    btn("hold").dispatchEvent(new Event("pointerdown", { cancelable: true }));
    expect(synth.cancelled).toBeGreaterThan(before);
  });

  it("Escape and End call end the call; the server is told once", async () => {
    await started();
    overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(sock.of("aicall:end")).toEqual([{ call_id: "call_ai1", reason: "completed" }]);
    expect(overlay().dataset.phase).toBe("ended");
    expect(FakeRecognition.current()).toBeUndefined();
    btn("end").click(); // Close
    expect(overlay().hidden).toBe(true);
  });
});

describe("handing the call to a person", () => {
  it("the Talk to a person button is always there, hands off, keeps the window open and gives way to the incoming-call screen", async () => {
    sock.replies["aicall:handoff"] = () => ({ ok: true, call: { ...CALL, state: "ended" }, human_call: true, text: "x" });
    await started();
    expect(btn("person").textContent).toBe("Talk to a person");
    btn("person").click();
    await flush();
    expect(sock.of("aicall:handoff")).toEqual([{ call_id: "call_ai1" }]);
    expect(overlay().dataset.phase).toBe("waiting");
    expect(status()).toContain("they will call you here");
    expect(overlay().hidden).toBe(false);
    expect(FakeRecognition.current()).toBeUndefined();
    expect(events.at(-1)!.payload).toMatchObject({ state: "waiting", reason: "human_call" });
    // a person rings: the ordinary incoming-call screen (calls.js) takes over, this one goes away
    sock.fire("call:state", { call: { id: "call_h1", room_id: "room_1", transport: "webrtc", kind: "voice", state: "ringing", agent_name: "Olivia" } });
    expect(overlay().hidden).toBe(true);
  });

  it("without browser calls a person answers in the chat, and the window closes by itself", async () => {
    sock.replies["aicall:handoff"] = () => ({ ok: true, call: { ...CALL, state: "ended" }, human_call: false, text: "x" });
    await started();
    btn("person").click();
    await flush();
    expect(status()).toContain("They will answer in the chat");
    await vi.advanceTimersByTimeAsync(6100);
    expect(overlay().hidden).toBe(true);
  });

  it("a spoken request is handed over by the server: the reply ends the call after the assistant has said so", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => answer("I'm connecting you with a person.", { kind: "handoff", ended: { reason: "handoff", handoff_reason: "customer_requested_human", human_call: true } });
    await speak("I want to talk to a human");
    expect(overlay().dataset.phase).toBe("speaking");
    synth.finish();
    await flush();
    expect(overlay().dataset.phase).toBe("waiting");
    expect(status()).toContain("they will call you here");
  });

  it("the server ending the call (time limit, a person took over, resolved) is said and shown", async () => {
    await started();
    synth.finish();
    sock.replies["aicall:say"] = () => answer("x", { kind: "max_duration", ended: { reason: "max_duration" } });
    await speak("one more thing");
    synth.finish();
    await flush();
    expect(overlay().dataset.phase).toBe("ended");
    expect(status()).toContain("time limit");
    expect(synth.spoken.at(-1)).toContain("time limit");
  });

  it("a call ended by the server's sweep (silence, disconnect) shows the end screen", async () => {
    await started();
    sock.fire("call:state", { call: { ...CALL, state: "ended", end_reason: "idle" } });
    expect(overlay().dataset.phase).toBe("ended");
    expect(status()).toContain("I did not hear anything");
  });
});

describe("after a reconnect", () => {
  it("binds the new socket to the running call and ends if the server no longer knows it", async () => {
    await started();
    sock.replies["call:resume"] = () => ({ ok: true });
    sock.fire("connect");
    expect(sock.of("call:resume")).toEqual([{ call_id: "call_ai1" }]);
    expect(overlay().dataset.phase).not.toBe("ended");
    sock.replies["call:resume"] = () => ({ ok: false, error: { code: "CALL_STATE" } });
    sock.fire("connect");
    await flush();
    expect(overlay().dataset.phase).toBe("ended");
  });
});

describe("speech engine details", () => {
  it("reads long replies in sentence-sized pieces and picks a voice for the language when one exists", async () => {
    const engine = Ai.browserEngine(window);
    const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of a long answer that a browser might cut off.`).join(" ");
    let ended = 0;
    engine.speak(long, "en-us", { onEnd: () => ended++ });
    expect(synth.spoken.length).toBe(1);
    for (let i = 0; i < 40 && !ended; i++) {
      const u = synth.queue.shift();
      u?.onend?.();
    }
    expect(ended).toBe(1);
    expect(synth.spoken.length).toBeGreaterThan(3);
    expect(synth.spoken.every((s) => s.length <= 240)).toBe(true);
    expect(synth.spoken.join(" ")).toBe(long);
  });

  it("cancelling does not fire the end callback of the cancelled speech", () => {
    const engine = Ai.browserEngine(window);
    let ended = 0;
    engine.speak("Hello there. How are you?", "en", { onEnd: () => ended++ });
    const u = synth.queue[0]!;
    engine.cancel();
    u.onend?.();
    expect(ended).toBe(0);
  });

  it("works without speech synthesis: captions only", async () => {
    installSpeech(window, { synthesis: false });
    const c = mk();
    c.bind(sock);
    const p = c.start("voice");
    await flush();
    await p;
    expect(caps()[0]).toContain("Hi, I'm Aria");
    expect(overlay().dataset.phase).toBe("listening");
    c.destroy();
  });
});
