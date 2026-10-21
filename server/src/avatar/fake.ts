import { AvatarError, type AvatarProvider, type AvatarSpec, type AvatarStream } from "./provider.js";

/** A provider for tests and for local demos (`AVATAR_TEST_PROVIDER=fake`, refused in production): records every call, fails on demand, spends nothing. */
export class FakeAvatarProvider implements AvatarProvider {
  readonly id = "fake" as const;
  calls: { op: string; key: string; args: unknown[] }[] = [];
  /** make the next call of this operation fail with this kind */
  failNext = new Map<string, AvatarError["kind"]>();
  credits = 20;
  private n = 0;
  private record(op: string, key: string, ...args: unknown[]) {
    this.calls.push({ op, key, args });
    const k = this.failNext.get(op);
    if (k) {
      this.failNext.delete(op);
      throw new AvatarError(k, `fake ${op} failed (${k})`);
    }
  }
  of(op: string) {
    return this.calls.filter((c) => c.op === op);
  }
  async testConnection(key: string) {
    this.record("test", key);
    if (!key.includes(":")) throw new AvatarError("auth", "D-ID refused the API key", 401);
    return { credits_remaining: this.credits };
  }
  async ensureAgent(key: string, spec: AvatarSpec, existingId: string | null) {
    if (existingId) return existingId;
    this.record("agent", key, spec);
    return `agt_fake_${++this.n}`;
  }
  async startStream(key: string, agentId: string): Promise<AvatarStream> {
    this.record("stream", key, agentId);
    return { streamId: `strm_${++this.n}`, sessionId: `sess_${this.n}`, offer: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=fake-avatar\r\n" }, iceServers: [{ urls: ["stun:stun.fake-avatar.test:3478"] }] };
  }
  async sendAnswer(key: string, agentId: string, s: { streamId: string; sessionId: string | null }, answer: unknown) {
    this.record("sdp", key, agentId, s, answer);
  }
  async sendIce(key: string, agentId: string, s: { streamId: string; sessionId: string | null }, c: unknown) {
    this.record("ice", key, agentId, s, c);
  }
  async speak(key: string, agentId: string, s: { streamId: string; sessionId: string | null }, text: string, voice: unknown) {
    this.record("speak", key, agentId, s, text, voice);
  }
  async close(key: string, agentId: string, s: { streamId: string; sessionId: string | null }) {
    this.record("close", key, agentId, s);
  }
}
