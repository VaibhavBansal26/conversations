/**
 * Photoreal avatars for AI video calls (docs/CALLS.md "Photoreal avatar", ADR 0039). The DEFAULT is not a provider at all: it is the built-in face
 * (the agent's photo or the drawn face, ADR 0034), used whenever photoreal is off, not connected, over budget, killed or failing.
 *
 * A provider is a hosted service that renders a talking head and streams it to the visitor's browser over WebRTC. This server keeps the API key
 * and makes every provider call; the browser only receives the stream's SDP offer and ICE servers (short-lived session information) and sends its
 * answer and candidates back through this server. The visitor's browser sends NO media to the provider: its peer connection has no tracks.
 */
export interface IceServerInfo {
  urls: string | string[];
  username?: string;
  credential?: string;
}
export interface AvatarSpec {
  name: string;
  source: "presenter" | "image";
  presenter_id?: string | null;
  image_url?: string | null;
  voice_provider?: string | null;
  voice_id?: string | null;
}
export interface AvatarStream {
  /** the provider's stream id */
  streamId: string;
  /** the provider's session id for this stream (sent back with every later call) */
  sessionId: string | null;
  offer: { type: "offer"; sdp: string };
  iceServers: IceServerInfo[];
}
export interface AvatarProvider {
  readonly id: "did" | "fake";
  /** the cheapest authenticated call there is: proves the key works. Returns remaining credits when the provider says. */
  testConnection(apiKey: string): Promise<{ credits_remaining: number | null }>;
  /** the provider's agent for this avatar: created once, then reused (its id is stored) */
  ensureAgent(apiKey: string, spec: AvatarSpec, existingId: string | null): Promise<string>;
  startStream(apiKey: string, agentId: string): Promise<AvatarStream>;
  sendAnswer(apiKey: string, agentId: string, s: { streamId: string; sessionId: string | null }, answer: { type: "answer"; sdp: string }): Promise<void>;
  sendIce(apiKey: string, agentId: string, s: { streamId: string; sessionId: string | null }, c: { candidate: string | null; sdpMid: string | null; sdpMLineIndex: number | null }): Promise<void>;
  speak(apiKey: string, agentId: string, s: { streamId: string; sessionId: string | null }, text: string, voice: { provider: string | null; id: string | null }): Promise<void>;
  close(apiKey: string, agentId: string, s: { streamId: string; sessionId: string | null }): Promise<void>;
}

/** A provider failure whose message is safe to store and show: never the key, never a response body. */
export class AvatarError extends Error {
  constructor(
    readonly kind: "auth" | "not_ready" | "rate_limited" | "credits" | "bad_request" | "unavailable" | "timeout" | "malformed",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AvatarError";
  }
}
