// The team side of a call: signalling over the app's socket, media over WebRTC (docs/CALLS.md). The agent is the "impolite" peer of the perfect
// negotiation pattern (it keeps its own offer on a collision) and the one that restarts ICE; the visitor page is the polite one.

export type CallKind = "voice" | "video";
export type CallPhase = "idle" | "ringing" | "connecting" | "active" | "ended";
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
type Ack<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

export interface Transport {
  emit<T extends object>(event: string, payload: object, timeoutMs?: number): Promise<Ack<T>>;
  /** subscribe to a server event; returns the unsubscribe function */
  subscribe(event: string, handler: (payload: never) => void): () => void;
}
export interface CallView {
  phase: CallPhase;
  kind: CallKind | null;
  callId: string | null;
  roomId: string | null;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  quality: "good" | "fair" | "poor" | null;
  seconds: number;
  local: MediaStream | null;
  remote: MediaStream | null;
  /** plain-words status line: why it ended, that it is reconnecting, a TURN warning */
  message: string;
  warning: string | null;
}
interface CallDto {
  id: string;
  room_id: string;
  kind: CallKind;
  state: string;
  end_reason?: string | null;
  ended_by?: string | null;
}

const IDLE: CallView = { phase: "idle", kind: null, callId: null, roomId: null, muted: false, cameraOff: false, sharing: false, quality: null, seconds: 0, local: null, remote: null, message: "", warning: null };

export interface EngineDeps {
  transport: Transport;
  RTCPeerConnection?: typeof RTCPeerConnection;
  mediaDevices?: MediaDevices;
  now?: () => number;
}

const ENDED_TEXT: Record<string, string> = { declined: "The visitor declined the call.", missed: "The visitor did not answer.", failed: "The call could not connect.", ended: "The call ended." };

export class CallEngine {
  private view: CallView = IDLE;
  private listeners = new Set<(v: CallView) => void>();
  private pc: RTCPeerConnection | null = null;
  private offs: (() => void)[] = [];
  private makingOffer = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stats: ReturnType<typeof setInterval> | undefined;
  private since = 0;
  private screen: MediaStream | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private ice: IceServer[] = [];
  private reported = false;
  private readonly rtc: typeof RTCPeerConnection | undefined;
  private readonly media: MediaDevices | undefined;
  private readonly now: () => number;

  constructor(private readonly d: EngineDeps) {
    this.rtc = d.RTCPeerConnection ?? (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : undefined);
    this.media = d.mediaDevices ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
    this.now = d.now ?? Date.now;
  }

  get state(): CallView {
    return this.view;
  }
  subscribe(fn: (v: CallView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<CallView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l(this.view);
  }

  /** Place a call. Resolves when the invitation is accepted by the server (the visitor's phone rings); the rest is events. */
  async start(roomId: string, kind: CallKind): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.view.phase !== "idle" && this.view.phase !== "ended") return { ok: false, message: "You are already in a call." };
    if (!this.rtc || !this.media?.getUserMedia) return { ok: false, message: "This browser cannot place calls." };
    this.reset();
    let stream: MediaStream;
    try {
      stream = await this.media.getUserMedia({ audio: true, video: kind === "video" });
    } catch {
      try {
        if (kind !== "video") throw new Error("denied");
        stream = await this.media.getUserMedia({ audio: true });
        this.set({ message: "No camera: continuing with audio only." });
      } catch {
        return { ok: false, message: "Allow the microphone for this site to place a call." };
      }
    }
    const ack = await this.d.transport.emit<{ call: CallDto; ice: { iceServers: IceServer[]; warning: string | null } }>("call:invite", { room_id: roomId, kind });
    if (!ack.ok) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, message: INVITE_ERRORS[ack.error.code] ?? ack.error.message };
    }
    this.ice = ack.ice.iceServers;
    this.set({ phase: "ringing", kind, callId: ack.call.id, roomId, local: stream, warning: ack.ice.warning });
    this.bindEvents(ack.call.id);
    return { ok: true };
  }

  private bindEvents(callId: string) {
    const t = this.d.transport;
    this.offs.push(
      t.subscribe("call:state", ((p: { call: CallDto }) => this.onState(p.call)) as never),
      t.subscribe("call:offer", ((p: { call_id: string; data: RTCSessionDescriptionInit }) => p.call_id === callId && void this.onOffer(p.data)) as never),
      t.subscribe("call:answer", ((p: { call_id: string; data: RTCSessionDescriptionInit }) => p.call_id === callId && void this.pc?.setRemoteDescription(p.data).catch(() => {})) as never),
      t.subscribe("call:ice", ((p: { call_id: string; data: RTCIceCandidateInit }) => p.call_id === callId && this.onIce(p.data)) as never),
      t.subscribe("call:peer", ((p: { call_id: string; event: "lost" | "resumed" }) => p.call_id === callId && this.onPeer(p.event)) as never),
      t.subscribe("connect", (() => this.onSocketConnected()) as never),
    );
  }

  private onState(c: CallDto) {
    if (c.id !== this.view.callId) return;
    if (c.state === "connecting" && this.view.phase === "ringing") {
      this.set({ phase: "connecting" });
      void this.createPeerAndOffer();
    } else if (["declined", "missed", "ended", "failed"].includes(c.state)) {
      this.finish(ENDED_TEXT[c.state] ?? "The call ended.");
    }
  }

  private makePeer(): RTCPeerConnection {
    const pc = new this.rtc!({ iceServers: this.ice });
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (!this.view.callId) return;
      void this.d.transport.emit("call:ice", { call_id: this.view.callId, data: e.candidate ? (e.candidate.toJSON ? e.candidate.toJSON() : { candidate: e.candidate.candidate }) : {} });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? this.view.remote ?? new MediaStream();
      if (!e.streams[0]) stream.addTrack(e.track);
      this.set({ remote: stream });
    };
    pc.onnegotiationneeded = () => void this.negotiate();
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") {
        clearTimeout(this.restartTimer);
        if (this.view.phase !== "active") {
          this.since = this.now();
          this.set({ phase: "active", message: "", seconds: 0 });
          this.startTimers();
        } else this.set({ message: "" });
        if (!this.reported) {
          this.reported = true;
          void this.d.transport.emit("call:connected", { call_id: this.view.callId });
        }
      } else if (st === "disconnected" || st === "failed") {
        this.set({ message: "Reconnecting..." });
        // restart ICE (the agent is the offerer); if it does not recover in 15 s the call is reported failed
        void this.restartIce();
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          if (this.pc && (this.pc.connectionState === "failed" || this.pc.connectionState === "disconnected") && this.view.callId) void this.d.transport.emit("call:failed", { call_id: this.view.callId, reason: "ice_failed" });
        }, 15_000);
      }
    };
    return pc;
  }

  private async createPeerAndOffer() {
    const pc = this.makePeer();
    const stream = this.view.local;
    stream?.getTracks().forEach((t) => pc.addTrack(t, stream));
    // addTrack fires negotiationneeded: the first offer goes out from there
  }

  private async negotiate(iceRestart = false) {
    const pc = this.pc;
    if (!pc || !this.view.callId || this.makingOffer) return;
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      await this.d.transport.emit("call:offer", { call_id: this.view.callId, data: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
    } catch {
      /* the connection state reports a failed negotiation */
    } finally {
      this.makingOffer = false;
    }
  }
  private async restartIce() {
    if (this.pc?.restartIce) this.pc.restartIce();
    await this.negotiate(true);
  }

  private async onOffer(desc: RTCSessionDescriptionInit) {
    const pc = this.pc;
    if (!pc) return;
    // impolite: an offer that collides with ours is ignored (the visitor rolls back)
    if (this.makingOffer || pc.signalingState !== "stable") return;
    try {
      await pc.setRemoteDescription(desc);
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      await pc.setLocalDescription();
      await this.d.transport.emit("call:answer", { call_id: this.view.callId, data: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
    } catch {
      /* ignore: a bad renegotiation does not end the call by itself */
    }
  }
  private onIce(c: RTCIceCandidateInit) {
    if (!c || !c.candidate) return;
    if (!this.pc?.remoteDescription) this.pendingIce.push(c);
    else void this.pc.addIceCandidate(c).catch(() => {});
  }
  private onPeer(event: "lost" | "resumed") {
    if (event === "lost") this.set({ message: "The visitor lost the connection. Waiting..." });
    else {
      this.set({ message: "" });
      void this.restartIce();
    }
  }
  /** This socket reconnected (network change): bind it to the call and restart ICE. */
  private onSocketConnected() {
    if (!this.view.callId || (this.view.phase !== "connecting" && this.view.phase !== "active")) return;
    void this.d.transport.emit<{ ice: { iceServers: IceServer[] } }>("call:resume", { call_id: this.view.callId }).then((ack) => {
      if (!ack.ok) return this.finish("The call ended while you were offline.");
      this.ice = ack.ice.iceServers;
      this.pc?.setConfiguration?.({ iceServers: this.ice });
      void this.restartIce();
    });
  }

  /* ---------- controls ---------- */
  toggleMute() {
    const muted = !this.view.muted;
    this.view.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
  }
  toggleCamera() {
    const cameraOff = !this.view.cameraOff;
    this.view.local?.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    this.set({ cameraOff });
  }
  async toggleShare() {
    if (this.view.sharing) return this.stopShare();
    if (!this.media?.getDisplayMedia || !this.pc) return;
    try {
      const stream = await this.media.getDisplayMedia({ video: true });
      this.screen = stream;
      const track = stream.getVideoTracks()[0]!;
      const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
      else this.pc.addTrack(track, stream);
      track.onended = () => void this.stopShare();
      this.set({ sharing: true });
    } catch {
      /* cancelled */
    }
  }
  private async stopShare() {
    if (!this.view.sharing) return;
    const cam = this.view.local?.getVideoTracks()[0] ?? null;
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(cam);
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.set({ sharing: false });
  }
  /** Hang up, or cancel while it rings. */
  async end() {
    const id = this.view.callId;
    if (!id) return this.reset();
    await this.d.transport.emit("call:end", { call_id: id });
    this.finish("The call ended.");
  }

  /* ---------- quality, timers, teardown ---------- */
  private startTimers() {
    clearInterval(this.timer);
    clearInterval(this.stats);
    this.timer = setInterval(() => this.set({ seconds: Math.floor((this.now() - this.since) / 1000) }), 1000);
    let prev: { lost: number; recv: number } | null = null;
    this.stats = setInterval(() => {
      void this.pc?.getStats().then((report) => {
        let lost = 0;
        let recv = 0;
        let rtt: number | null = null;
        report.forEach((r: { type: string; packetsLost?: number; packetsReceived?: number; nominated?: boolean; state?: string; currentRoundTripTime?: number }) => {
          if (r.type === "inbound-rtp") {
            lost += r.packetsLost ?? 0;
            recv += r.packetsReceived ?? 0;
          }
          if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded") && typeof r.currentRoundTripTime === "number") rtt = r.currentRoundTripTime;
        });
        const dl = prev ? lost - prev.lost : lost;
        const dr = prev ? recv - prev.recv : recv;
        prev = { lost, recv };
        const loss = dl + dr > 0 ? dl / (dl + dr) : 0;
        this.set({ quality: loss > 0.08 || (rtt !== null && rtt > 0.6) ? "poor" : loss > 0.03 || (rtt !== null && rtt > 0.3) ? "fair" : "good" });
      });
    }, 2000);
  }
  private finish(message: string) {
    if (this.view.phase === "idle" || this.view.phase === "ended") return;
    this.teardown();
    this.set({ phase: "ended", message, muted: false, cameraOff: false, sharing: false, quality: null, local: null, remote: null });
  }
  private teardown() {
    clearInterval(this.timer);
    clearInterval(this.stats);
    clearTimeout(this.restartTimer);
    for (const o of this.offs.splice(0)) o();
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.view.local?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.pendingIce = [];
    this.makingOffer = false;
    this.reported = false;
  }
  /** Forget the last (ended) call. */
  reset() {
    this.teardown();
    this.set({ ...IDLE });
  }
}

const INVITE_ERRORS: Record<string, string> = {
  CALLS_DISABLED: "Calls are switched off for this workspace.",
  CALL_KIND_DISABLED: "This kind of call is switched off for this workspace.",
  VISITOR_OFFLINE: "The visitor is not in the chat right now, so the call could not ring.",
  NO_CONVERSATION: "The visitor has not written yet.",
  CALL_IN_PROGRESS: "There is already a call in this conversation.",
  PERMISSION_DENIED: "You do not have permission to place calls.",
};
