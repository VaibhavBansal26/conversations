import { AvatarError, type AvatarProvider, type AvatarSpec, type AvatarStream } from "./provider.js";

/**
 * D-ID (https://docs.d-id.com), its Agents Streams API. What was CONFIRMED from D-ID's published reference (read on 2026-10-21) and what was ASSUMED:
 *
 *  confirmed  auth: `Authorization: Basic <API_USERNAME:API_PASSWORD>`, the key exactly as the Studio shows it (the reference's example uses the raw
 *             form; it does not say to base64-encode it). ASSUMED: the raw form works; if D-ID answers 401 to a valid key, base64-encoding is the
 *             first thing to try (`DID_AUTH_ENCODE=base64`).
 *  confirmed  GET /credits -> {credits: [...], remaining, total}. Used for "Test connection". ASSUMED: reading credits spends none (the reference
 *             does not say either way; it is a read of the account).
 *  confirmed  POST /agents {presenter: {type: "talk", source_url, thumbnail} | {type: "clip", presenter_id}, voice?: {type, voice_id}, preview_name?}
 *             -> {id, ...}. ASSUMED: an agent may need a moment to be built (a stream then answers 409 NotReadyError: "retry after a minute or
 *             two"); we treat that as a failure of this call and fall back to the built-in face.
 *  confirmed  POST /agents/{agentId}/streams {compatibility_mode?, stream_warmup?, fluent?, session_timeout?} -> 201 {id, jsep: {type: "offer",
 *             sdp}, ice_servers: [{urls, username?, credential?}], session_id?}
 *  confirmed  POST /agents/{agentId}/streams/{streamId}/sdp {answer: {type: "answer", sdp}, session_id}
 *  confirmed  POST /agents/{agentId}/streams/{streamId}/ice {candidate, sdpMid, sdpMLineIndex, session_id}
 *  confirmed  POST /agents/{agentId}/streams/{streamId} {script: {type: "text", input (3..40000 chars), provider?: {type, voice_id}}, session_id}
 *             -> {status, duration, session_id}. ASSUMED (the reference does not say it in words): this makes the avatar say `input` on the stream.
 *  confirmed  DELETE /agents/{agentId}/streams/{streamId} {session_id}
 *  NOT confirmed: idle timeouts and maximum stream length (not documented beyond session_timeout <= 300 s "with proper permissions"), how credits
 *             are counted per second of stream, whether `thumbnail` may equal `source_url`, rate limits.
 * NOTHING here was run against the real service: tests use a fake of these endpoints (tests/avatar.test.ts).
 */
export interface DidOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** "raw" (as documented) or "base64" (classic HTTP Basic) */
  authEncoding?: "raw" | "base64";
  timeoutMs?: number;
}

export class DidAvatarProvider implements AvatarProvider {
  readonly id = "did" as const;
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly o: DidOptions = {}) {
    this.base = (o.baseUrl ?? "https://api.d-id.com").replace(/\/$/, "");
    this.f = o.fetchFn ?? fetch;
  }
  private auth(key: string) {
    return `Basic ${this.o.authEncoding === "base64" ? Buffer.from(key).toString("base64") : key}`;
  }
  private async call<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { authorization: this.auth(key), accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 12_000),
      });
    } catch (e) {
      throw new AvatarError(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "unavailable", "D-ID could not be reached");
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // the body is not kept: it could echo what was sent. The status says enough.
      const s = res.status;
      if (s === 401 || s === 403) throw new AvatarError("auth", "D-ID refused the API key", s);
      if (s === 402) throw new AvatarError("credits", "The D-ID account has no credits left", s);
      if (s === 409) throw new AvatarError("not_ready", "The D-ID avatar is still being prepared: try again in a minute or two", s);
      if (s === 429) throw new AvatarError("rate_limited", "D-ID is rate limiting this account", s);
      if (s >= 500) throw new AvatarError("unavailable", `D-ID answered ${s}`, s);
      throw new AvatarError("bad_request", `D-ID refused the request (${s})`, s);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AvatarError("malformed", "D-ID sent an unreadable answer");
    }
  }

  async testConnection(key: string) {
    const r = await this.call<{ remaining?: unknown }>(key, "GET", "/credits");
    return { credits_remaining: typeof r.remaining === "number" ? r.remaining : null };
  }

  async ensureAgent(key: string, spec: AvatarSpec, existingId: string | null): Promise<string> {
    if (existingId) return existingId;
    const voice = spec.voice_provider ? { type: spec.voice_provider, ...(spec.voice_id ? { voice_id: spec.voice_id } : {}) } : undefined;
    const presenter =
      spec.source === "presenter"
        ? { type: "clip", presenter_id: spec.presenter_id, ...(voice ? { voice } : {}) }
        : { type: "talk", source_url: spec.image_url, thumbnail: spec.image_url, ...(voice ? { voice } : {}) };
    const r = await this.call<{ id?: unknown }>(key, "POST", "/agents", { presenter, preview_name: spec.name.slice(0, 60) });
    if (typeof r.id !== "string" || !r.id) throw new AvatarError("malformed", "D-ID did not return an agent id");
    return r.id;
  }

  async startStream(key: string, agentId: string): Promise<AvatarStream> {
    const r = await this.call<{ id?: unknown; jsep?: { type?: unknown; sdp?: unknown }; ice_servers?: unknown; session_id?: unknown }>(key, "POST", `/agents/${encodeURIComponent(agentId)}/streams`, { compatibility_mode: "auto", stream_warmup: true });
    if (typeof r.id !== "string" || !r.jsep || r.jsep.type !== "offer" || typeof r.jsep.sdp !== "string" || !Array.isArray(r.ice_servers)) throw new AvatarError("malformed", "D-ID did not return a stream offer");
    const ice = (r.ice_servers as { urls?: unknown; username?: unknown; credential?: unknown }[])
      .filter((x) => typeof x.urls === "string" || Array.isArray(x.urls))
      .map((x) => ({ urls: x.urls as string | string[], ...(typeof x.username === "string" ? { username: x.username } : {}), ...(typeof x.credential === "string" ? { credential: x.credential } : {}) }));
    return { streamId: r.id, sessionId: typeof r.session_id === "string" ? r.session_id : null, offer: { type: "offer", sdp: r.jsep.sdp }, iceServers: ice };
  }

  private path(agentId: string, streamId: string, tail = "") {
    return `/agents/${encodeURIComponent(agentId)}/streams/${encodeURIComponent(streamId)}${tail}`;
  }
  async sendAnswer(key: string, agentId: string, s: { streamId: string; sessionId: string | null }, answer: { type: "answer"; sdp: string }) {
    await this.call(key, "POST", this.path(agentId, s.streamId, "/sdp"), { answer, ...(s.sessionId ? { session_id: s.sessionId } : {}) });
  }
  async sendIce(key: string, agentId: string, s: { streamId: string; sessionId: string | null }, c: { candidate: string | null; sdpMid: string | null; sdpMLineIndex: number | null }) {
    await this.call(key, "POST", this.path(agentId, s.streamId, "/ice"), { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, ...(s.sessionId ? { session_id: s.sessionId } : {}) });
  }
  async speak(key: string, agentId: string, s: { streamId: string; sessionId: string | null }, text: string, voice: { provider: string | null; id: string | null }) {
    // the reference requires at least 3 characters of input
    const input = text.length >= 3 ? text.slice(0, 4000) : `${text}...`;
    const provider = voice.provider ? { type: voice.provider, ...(voice.id ? { voice_id: voice.id } : {}) } : undefined;
    await this.call(key, "POST", this.path(agentId, s.streamId), { script: { type: "text", input, ...(provider ? { provider } : {}) }, ...(s.sessionId ? { session_id: s.sessionId } : {}) });
  }
  async close(key: string, agentId: string, s: { streamId: string; sessionId: string | null }) {
    await this.call(key, "DELETE", this.path(agentId, s.streamId), s.sessionId ? { session_id: s.sessionId } : {});
  }
}
