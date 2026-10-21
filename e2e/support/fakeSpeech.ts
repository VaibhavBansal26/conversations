/**
 * A fake Web Speech API for the browser tests, injected before the page's own scripts (the real thing needs a microphone, a network speech service and
 * speakers). The product code is untouched: it calls `SpeechRecognition` and `speechSynthesis` exactly as it does in a real browser, and the test plays
 * the visitor's voice and watches what the assistant "says" through `window.__speech`:
 *
 *   __speech.hear("how do I")        words recognised but not final yet (an interim result)
 *   __speech.say("how do I reset")   a finished phrase
 *   __speech.spoken                  every piece of text the assistant spoke
 *   __speech.cancelled               how many times its voice was cut (barge-in)
 *   __speech.finish()                the assistant reaches the end of what it is saying
 *   __speech.running                 whether a recognizer is listening
 *
 * `FAKE_NO_SPEECH_SCRIPT` removes speech recognition, like Firefox.
 */
export const FAKE_SPEECH_SCRIPT = `(() => {
  const st = { spoken: [], cancelled: 0, starts: 0, queue: [], current: null };
  class Rec {
    constructor() { this.running = false; this.onresult = null; this.onerror = null; this.onend = null; this.onspeechstart = null; st.recs = (st.recs || []); st.recs.push(this); }
    start() { if (this.running) throw new Error("InvalidStateError"); this.running = true; st.starts++; st.current = this; }
    stop() { this._end(); }
    abort() { this._end(); }
    _end() { if (!this.running) return; this.running = false; if (st.current === this) st.current = null; setTimeout(() => this.onend && this.onend(), 0); }
  }
  class Utter { constructor(text) { this.text = text; this.lang = ""; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; this.onboundary = null; } }
  const synth = {
    speak(u) { st.queue.push(u); st.spoken.push(u.text); setTimeout(() => u.onstart && u.onstart(), 0); },
    cancel() { st.cancelled++; st.queue = []; },
    getVoices() { return []; },
  };
  const res = (text, final) => { const r = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: final }); return { resultIndex: 0, results: [r] }; };
  // speechSynthesis is a getter on the real window: plain assignment would be ignored
  const def = (k, v) => Object.defineProperty(window, k, { value: v, configurable: true, writable: true });
  def("SpeechRecognition", Rec);
  def("speechSynthesis", synth);
  def("SpeechSynthesisUtterance", Utter);
  window.__speech = {
    get spoken() { return st.spoken; },
    get cancelled() { return st.cancelled; },
    get starts() { return st.starts; },
    get running() { return !!(st.current && st.current.running); },
    get speaking() { return st.queue.length > 0; },
    hear(text) { const r = st.current; if (!r) throw new Error("not listening"); r.onspeechstart && r.onspeechstart(); r.onresult && r.onresult(res(text, false)); },
    say(text) { const r = st.current; if (!r) throw new Error("not listening"); r.onspeechstart && r.onspeechstart(); r.onresult && r.onresult(res(text, true)); },
    finish() { while (st.queue.length) { const u = st.queue.shift(); u.onboundary && u.onboundary(); u.onend && u.onend(); } },
    deny() { const r = st.current; if (r && r.onerror) r.onerror({ error: "not-allowed" }); },
  };
})();`;

export const FAKE_NO_SPEECH_SCRIPT = `(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; })();`;
