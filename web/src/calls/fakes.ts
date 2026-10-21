// Fakes for the WebRTC pieces jsdom does not have, shared by the call tests.
export class FakeTrack {
  enabled = true;
  stopped = false;
  onended: (() => void) | null = null;
  constructor(readonly kind: "audio" | "video") {}
  stop() {
    this.stopped = true;
  }
}
export class FakeStream {
  tracks: FakeTrack[];
  constructor(kinds: ("audio" | "video")[] = []) {
    this.tracks = kinds.map((k) => new FakeTrack(k));
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

export class FakeDC {
  readyState: "connecting" | "open" | "closed" = "connecting";
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly label: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
  }
  /** test helpers */
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  receive(ev: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
  of(type: string) {
    return this.sent.filter((x) => x.type === type);
  }
}

export class FakePC {
  static all: FakePC[] = [];
  signalingState = "stable";
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  senders: { track: FakeTrack | null; replaceTrack(t: FakeTrack | null): Promise<void> }[] = [];
  added: unknown[] = [];
  restarted = 0;
  closed = false;
  config: unknown;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { streams: unknown[]; track: FakeTrack }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly cfg: { iceServers: unknown[] }) {
    FakePC.all.push(this);
  }
  channels: FakeDC[] = [];
  transceivers: { kind: string; direction: string }[] = [];
  createDataChannel(label: string) {
    const dc = new FakeDC(label);
    this.channels.push(dc);
    return dc;
  }
  addTransceiver(kind: string, init: { direction: string }) {
    this.transceivers.push({ kind, direction: init.direction });
  }
  addTrack(t: FakeTrack) {
    const sender = { track: t as FakeTrack | null, replaceTrack: async (x: FakeTrack | null) => void (sender.track = x) };
    this.senders.push(sender);
    this.added.push(t);
    queueMicrotask(() => this.onnegotiationneeded?.());
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return [];
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0 answer" };
  }
  async createOffer(o?: { iceRestart?: boolean }) {
    return { type: "offer", sdp: `v=0 offer restart=${o?.iceRestart ? 1 : 0}` };
  }
  async setLocalDescription(d?: { type: string; sdp?: string }) {
    if (d?.type === "rollback") {
      this.signalingState = "stable";
      this.localDescription = null;
      return;
    }
    const type = d?.type ?? (this.remoteDescription ? "answer" : "offer");
    this.localDescription = { type, sdp: d?.sdp ?? `v=0 ${type}` };
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
  }
  candidates: unknown[] = [];
  async addIceCandidate(c: unknown) {
    this.candidates.push(c);
  }
  restartIce() {
    this.restarted++;
  }
  setConfiguration(c: unknown) {
    this.config = c;
  }
  async getStats() {
    return new Map<string, unknown>();
  }
  close() {
    this.closed = true;
  }
  /** test helpers */
  setState(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

export class FakeMedia {
  calls: unknown[] = [];
  denyVideo = false;
  denyAll = false;
  async getUserMedia(c: { audio?: boolean; video?: boolean }) {
    this.calls.push(c);
    if (this.denyAll || (c.video && this.denyVideo)) throw new Error("denied");
    return new FakeStream([...(c.audio ? (["audio"] as const) : []), ...(c.video ? (["video"] as const) : [])]) as unknown as MediaStream;
  }
  async enumerateDevices() {
    return [{ kind: "audioinput", deviceId: "mic1", label: "Built-in microphone" }, { kind: "videoinput", deviceId: "cam1", label: "Camera" }];
  }
  async getDisplayMedia() {
    return new FakeStream(["video"]) as unknown as MediaStream;
  }
}

/** A socket stand-in: records emits, answers them from a script, and lets the test fire server events. */
export class FakeTransport {
  emitted: { event: string; payload: any }[] = [];
  handlers = new Map<string, Set<(p: any) => void>>();
  replies: Record<string, (p: any) => unknown> = {};
  async emit(event: string, payload: object) {
    this.emitted.push({ event, payload });
    const r = this.replies[event]?.(payload);
    return (r ?? { ok: true }) as any;
  }
  subscribe(event: string, handler: (p: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => void this.handlers.get(event)?.delete(handler);
  }
  fire(event: string, payload: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }
  of(event: string) {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}
