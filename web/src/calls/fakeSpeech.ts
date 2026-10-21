// A fake Web Speech API for tests: SpeechRecognition (the visitor speaks) and speechSynthesis (the assistant is heard), under the test's control.
// The product code only ever touches the browser's own interfaces, so this exercises the same code paths a real browser does.
export class FakeRecognition {
  static all: FakeRecognition[] = [];
  static starts = 0;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  running = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  constructor() {
    FakeRecognition.all.push(this);
  }
  start() {
    if (this.running) throw new Error("InvalidStateError");
    this.running = true;
    FakeRecognition.starts++;
  }
  stop() {
    this.finish();
  }
  abort() {
    this.finish();
  }
  private finish() {
    if (!this.running) return;
    this.running = false;
    queueMicrotask(() => this.onend?.());
  }
  /** the browser stopped the recognizer by itself (it does, after a pause) */
  endByItself() {
    this.finish();
  }
  static current(): FakeRecognition | undefined {
    return [...FakeRecognition.all].reverse().find((r) => r.running);
  }
  private results(text: string, final: boolean) {
    const res = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: final });
    return { resultIndex: 0, results: [res] };
  }
  /** words heard but not final yet */
  interim(text: string) {
    this.onspeechstart?.();
    this.onresult?.(this.results(text, false));
  }
  /** a finished phrase */
  final(text: string) {
    this.onresult?.(this.results(text, true));
  }
  error(code: string) {
    this.onerror?.({ error: code });
  }
  static reset() {
    FakeRecognition.all = [];
    FakeRecognition.starts = 0;
  }
}

export class FakeUtterance {
  voice: unknown = null;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onboundary: (() => void) | null = null;
  constructor(readonly text: string) {}
}

export class FakeSynth {
  queue: FakeUtterance[] = [];
  spoken: string[] = [];
  cancelled = 0;
  speak(u: FakeUtterance) {
    this.queue.push(u);
    this.spoken.push(u.text);
    queueMicrotask(() => u.onstart?.());
  }
  cancel() {
    this.cancelled++;
    this.queue = [];
  }
  getVoices() {
    return [];
  }
  /** the voice reached the end of what it is saying (all queued pieces) */
  finish() {
    while (this.queue.length) {
      const u = this.queue.shift()!;
      u.onboundary?.();
      u.onend?.();
    }
  }
  get speaking() {
    return this.queue.length > 0;
  }
}

/** Put the fakes on a window (or remove speech recognition to play a browser without it, such as Firefox). */
export function installSpeech(win: Window & typeof globalThis, o: { recognition?: boolean; synthesis?: boolean } = {}) {
  const w = win as unknown as Record<string, unknown>;
  const synth = new FakeSynth();
  if (o.recognition === false) {
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  } else w.SpeechRecognition = FakeRecognition;
  if (o.synthesis === false) {
    delete w.speechSynthesis;
    delete w.SpeechSynthesisUtterance;
  } else {
    w.speechSynthesis = synth;
    w.SpeechSynthesisUtterance = FakeUtterance;
  }
  FakeRecognition.reset();
  return synth;
}
