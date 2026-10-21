/**
 * Speech for calls with the AI agent (docs/CALLS.md, ADR 0033).
 *
 * The default engine is `browser`: the visitor's browser turns speech into text (SpeechRecognition) and the reply text into sound (speechSynthesis).
 * Only TEXT reaches this server, through the same pipeline as a typed message, so the knowledge base, the safety guards, the hand-off triggers, the
 * budget and the audit all apply unchanged, and no audio is received, stored or sent to a third party by this app. (The browser vendor's speech
 * service may process the audio: Chrome sends it to Google, Safari to Apple. That is the browser's behaviour, and the docs say so.)
 *
 * `SpeechProvider` is the seam for a server-side engine (a hosted realtime speech API): one that implements `transcribe` and `synthesize` can be
 * registered here and chosen with `calls.ai.engine`. Only the browser engine is built; `FakeSpeechProvider` exists for tests.
 */
export interface SpeechCapabilities {
  /** the visitor's side can turn speech into text */
  stt: boolean;
  /** the visitor's side can speak text */
  tts: boolean;
}

export interface Transcription {
  text: string;
  language: string | null;
  confidence: number | null;
}
export interface Synthesis {
  audio: Uint8Array;
  mime: string;
}

export interface SpeechProvider {
  /** stored on the call row (`calls.engine`) */
  readonly name: string;
  /** which parts the visitor's browser does itself and which this provider offers */
  readonly clientSide: SpeechCapabilities;
  readonly serverSide: SpeechCapabilities;
  /** server-side engines only: audio in, text out */
  transcribe?(audio: Uint8Array, o: { mime: string; language: string }): Promise<Transcription>;
  /** server-side engines only: text in, audio out */
  synthesize?(text: string, o: { language: string; voice?: string }): Promise<Synthesis>;
}

/** The shipped engine: everything happens in the visitor's browser, the server only sees text. */
export const browserSpeech: SpeechProvider = { name: "browser", clientSide: { stt: true, tts: true }, serverSide: { stt: false, tts: false } };

/** Deterministic engine for tests: "transcribes" UTF-8 bytes back into text and "synthesizes" the text as bytes. */
export class FakeSpeechProvider implements SpeechProvider {
  readonly name = "fake";
  readonly clientSide = { stt: false, tts: false };
  readonly serverSide = { stt: true, tts: true };
  readonly spoken: string[] = [];
  async transcribe(audio: Uint8Array, o: { language: string }): Promise<Transcription> {
    return { text: Buffer.from(audio).toString("utf8"), language: o.language, confidence: 1 };
  }
  async synthesize(text: string): Promise<Synthesis> {
    this.spoken.push(text);
    return { audio: Buffer.from(text, "utf8"), mime: "audio/fake" };
  }
}

export const SPEECH_ENGINES: Record<string, SpeechProvider> = { browser: browserSpeech };

/** What is read aloud: the answer without the link list, URLs, markdown marks and long runs of punctuation. The caption keeps the full text. */
export function speakable(text: string): string {
  return text
    .replace(/\n+\s*From our help centre:[\s\S]*$/i, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[*_`#>~]+/g, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim()
    .slice(0, 1200);
}

/** The language the recognizer and the voice should use: the visitor's locale when the agent speaks it (or names no languages), else the agent's first language. */
export function speechLanguage(agentLanguages: string[], visitorLocale: string | null | undefined): string {
  const loc = (visitorLocale ?? "").trim().toLowerCase().replace(/_/g, "-");
  const base = loc.split("-")[0] ?? "";
  if (!agentLanguages.length) return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(loc) ? loc : "en";
  const exact = agentLanguages.find((l) => l === loc);
  if (exact) return exact;
  const same = agentLanguages.find((l) => l.split("-")[0] === base);
  if (same) return loc.length > base.length ? loc : same;
  return agentLanguages[0]!;
}
