// A call between two teammates, in the browser (docs/CALLS.md, ADR 0036): signalling over the app's socket (`tcall:*`), media over WebRTC.
// The caller offers and restarts ICE (the "impolite" peer of the perfect negotiation pattern); the callee answers and is the polite one (it rolls back
// its own offer on a collision, which only happens when it renegotiates, for screen sharing).
import type { CallKind, IceServer, Transport } from "./engine";

export type TeamPhase = "idle" | "ringing_out" | "ringing_in" | "connecting" | "active" | "ended";
export interface TeamCallView {
  phase: TeamPhase;
  kind: CallKind | null;
  callId: string | null;
  channelId: string | null;
  peerName: string;
  role: "caller" | "callee" | null;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  quality: "good" | "fair" | "poor" | null;
  seconds: number;
  local: MediaStream | null;
  remote: MediaStream | null;
  /** plain-words status line: why it ended, that it is reconnecting */
  message: string;
  warning: string | null;
}
export interface TeamCallDto {
  id: string;
  channel_id: string;
  kind: CallKind;
  state: string;
  caller: { id: string; name: string };
  callee: { id: string; name: string };
  end_reason?: string | null;
  ended_by?: string | null;
}

const IDLE: TeamCallView = { phase: "idle", kind: null, callId: null, channelId: null, peerName: "", role: null, muted: false, cameraOff: false, sharing: false, quality: null, seconds: 0, local: null, remote: null, message: "", warning: null };

export interface TeamEngineDeps {
  transport: Transport;
  selfId: () => string;
  RTCPeerConnection?: typeof RTCPeerConnection;
  mediaDevices?: MediaDevices;
  now?: () => number;
}

export const TEAM_INVITE_ERRORS: Record<string, string> = {
  TEAM_CALLS_DISABLED: "Calls between teammates are switched off for this workspace.",
  TEAM_CALL_KIND_DISABLED: "This kind of call is switched off for this workspace.",
  GROUP_CALLS_NOT_AVAILABLE: "Calls work between two people: open a direct message with the person you want to call.",
  CALLEE_OFFLINE: "They are not online, so the call could not ring.",
  CALLEE_UNAVAILABLE: "They are not available for calls right now.",
  CALLEE_BUSY: "They are in another call.",
  CALLEE_CANNOT_RECEIVE: "They cannot take calls.",
  CALLEE_GONE: "They are no longer in this workspace.",
  CALL_IN_PROGRESS: "You are already in a call.",
  RATE_LIMITED: "You have called a lot just now. Try again in a few minutes.",
  PERMISSION_DENIED: "You do not have permission to place calls.",
};

const ENDED_BY_STATE = (c: TeamCallDto, self: string): string => {
  const other = c.caller.id === self ? c.callee.name : c.caller.name;
  switch (c.state) {
    case "declined":
      return c.caller.id === self ? `${other} declined the call.` : "You declined the call.";
    case "missed":
      return c.caller.id === self ? `${other} did not answer.` : `Missed call from ${other}.`;
    case "failed":
      return "The call could not connect.";
    default:
      return c.end_reason === "cancelled" && c.caller.id !== self ? `${other} cancelled the call.` : "The call ended.";
  }
};

export class TeamCallEngine {
  private view: TeamCallView = IDLE;
  private listeners = new Set<(v: TeamCallView) => void>();
  private pc: RTCPeerConnection | null = null;
  private offs: (() => void)[] = [];
  private makingOffer = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stats: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private since = 0;
  private screen: MediaStream | null = null;
  private ice: IceServer[] = [];
  private reported = false;
  private accepting = false;
  private firstOfferHandled = false;
  private readonly rtc: typeof RTCPeerConnection | undefined;
  private readonly media: MediaDevices | undefined;
  private readonly now: () => number;

  constructor(private readonly d: TeamEngineDeps) {
    this.rtc = d.RTCPeerConnection ?? (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : undefined);
    this.media = d.mediaDevices ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
    this.now = d.now ?? Date.now;
  }
  get state(): TeamCallView {
    return this.view;
  }
  subscribe(fn: (v: TeamCallView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<TeamCallView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l(this.view);
  }
  private get busy() {
    return this.view.phase !== "idle" && this.view.phase !== "ended";
  }

  private async mic(kind: CallKind): Promise<MediaStream | { error: string }> {
    if (!this.rtc || !this.media?.getUserMedia) return { error: "This browser cannot place calls." };
    try {
      return await this.media.getUserMedia({ audio: true, video: kind === "video" });
    } catch {
      try {
        if (kind !== "video") throw new Error("denied");
        const s = await this.media.getUserMedia({ audio: true });
        this.set({ message: "No camera: continuing with audio only." });
        return s;
      } catch {
        return { error: "Allow the microphone for this site to take part in a call." };
      }
    }
  }

  /** Ring the other member of a direct message. Resolves when the server accepted the invitation; the rest is events. */
  async call(channelId: string, kind: CallKind, peerName: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.busy) return { ok: false, message: "You are already in a call." };
    this.reset();
    const stream = await this.mic(kind);
    if ("error" in stream) return { ok: false, message: stream.error };
    const ack = await this.d.transport.emit<{ call: TeamCallDto; ice: { iceServers: IceServer[]; warning: string | null } }>("tcall:invite", { channel_id: channelId, kind });
    if (!ack.ok) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, message: TEAM_INVITE_ERRORS[ack.error.code] ?? ack.error.message };
    }
    this.ice = ack.ice.iceServers;
    this.set({ phase: "ringing_out", kind, callId: ack.call.id, channelId, peerName, role: "caller", local: stream, warning: ack.ice.warning });
    this.bind(ack.call.id);
    return { ok: true };
  }

  /** `tcall:state` from the server, for a call this member is part of (fed by the provider; every tab gets it). */
  handleState(c: TeamCallDto) {
    const self = this.d.selfId();
    const me = c.caller.id === self ? "caller" : c.callee.id === self ? "callee" : null;
    if (!me) return;
    if (c.state === "ringing" && me === "callee" && !this.busy) {
      this.reset();
      this.set({ phase: "ringing_in", kind: c.kind, callId: c.id, channelId: c.channel_id, peerName: c.caller.name, role: "callee" });
      return;
    }
    if (c.id !== this.view.callId) return;
    if (c.state === "connecting") {
      if (this.view.phase === "ringing_out") {
        this.set({ phase: "connecting" });
        void this.startCaller();
      } else if (this.view.phase === "ringing_in" && !this.accepting) this.finish("Answered on another device.");
    } else if (["declined", "missed", "ended", "failed"].includes(c.state)) this.finish(ENDED_BY_STATE(c, self));
  }

  /** Answer the call that rings. */
  async accept(): Promise<{ ok: true } | { ok: false; message: string }> {
    const v = this.view;
    if (v.phase !== "ringing_in" || !v.callId || !v.kind || this.accepting) return { ok: false, message: "There is no call to answer." };
    this.accepting = true;
    const stream = await this.mic(v.kind);
    if ("error" in stream) {
      this.accepting = false;
      void this.d.transport.emit("tcall:decline", { call_id: v.callId });
      this.finish(stream.error);
      return { ok: false, message: stream.error };
    }
    this.set({ local: stream });
    this.bind(v.callId);
    const ack = await this.d.transport.emit<{ call: TeamCallDto; ice: { iceServers: IceServer[]; warning: string | null } }>("tcall:accept", { call_id: v.callId });
    this.accepting = false;
    if (!ack.ok) {
      this.finish(ack.error.code === "CALL_STATE" ? "The call is no longer ringing." : ack.error.message);
      return { ok: false, message: ack.error.message };
    }
    this.ice = ack.ice.iceServers;
    this.set({ phase: "connecting", warning: ack.ice.warning });
    this.makePeer();
    return { ok: true };
  }
  async decline() {
    const id = this.view.callId;
    if (this.view.phase !== "ringing_in" || !id) return;
    await this.d.transport.emit("tcall:decline", { call_id: id });
    this.finish("You declined the call.");
  }
  /** Hang up, or cancel while it rings. */
  async end() {
    const id = this.view.callId;
    if (!id) return this.reset();
    if (this.view.phase === "ringing_in") return this.decline();
    await this.d.transport.emit("tcall:end", { call_id: id });
    this.finish("The call ended.");
  }

  private bind(callId: string) {
    const t = this.d.transport;
    for (const o of this.offs.splice(0)) o();
    this.offs.push(
      t.subscribe("tcall:offer", ((p: { call_id: string; data: RTCSessionDescriptionInit }) => p.call_id === callId && void this.onOffer(p.data)) as never),
      t.subscribe("tcall:answer", ((p: { call_id: string; data: RTCSessionDescriptionInit }) => p.call_id === callId && void this.pc?.setRemoteDescription(p.data).catch(() => {})) as never),
      t.subscribe("tcall:ice", ((p: { call_id: string; data: RTCIceCandidateInit }) => p.call_id === callId && this.onIce(p.data)) as never),
      t.subscribe("tcall:peer", ((p: { call_id: string; event: "lost" | "resumed" }) => p.call_id === callId && this.onPeer(p.event)) as never),
      t.subscribe("connect", (() => this.onSocketConnected()) as never),
    );
  }

  private makePeer(): RTCPeerConnection {
    const pc = new this.rtc!({ iceServers: this.ice });
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (!this.view.callId) return;
      void this.d.transport.emit("tcall:ice", { call_id: this.view.callId, data: e.candidate ? (e.candidate.toJSON ? e.candidate.toJSON() : { candidate: e.candidate.candidate }) : {} });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? this.view.remote ?? new MediaStream();
      if (!e.streams[0]) stream.addTrack(e.track);
      this.set({ remote: stream });
    };
    pc.onnegotiationneeded = () => {
      // the caller's first offer starts here (adding its tracks); the callee only renegotiates after it has answered
      if (this.view.role === "caller" || pc.remoteDescription) void this.negotiate();
    };
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
          void this.d.transport.emit("tcall:connected", { call_id: this.view.callId });
        }
      } else if (st === "disconnected" || st === "failed") {
        this.set({ message: "Reconnecting..." });
        if (this.view.role === "caller") void this.restartIce();
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          if (this.pc && (this.pc.connectionState === "failed" || this.pc.connectionState === "disconnected") && this.view.callId) void this.d.transport.emit("tcall:failed", { call_id: this.view.callId, reason: "ice_failed" });
        }, 15_000);
      }
    };
    return pc;
  }
  private async startCaller() {
    const pc = this.makePeer();
    const stream = this.view.local;
    stream?.getTracks().forEach((t) => pc.addTrack(t, stream));
  }
  private async negotiate(iceRestart = false) {
    const pc = this.pc;
    if (!pc || !this.view.callId || this.makingOffer) return;
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      await this.d.transport.emit("tcall:offer", { call_id: this.view.callId, data: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
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
    const collision = desc.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
    // the caller is impolite: it ignores an offer that collides with its own; the callee is polite and rolls back
    if (collision && this.view.role === "caller") return;
    try {
      if (collision) await pc.setLocalDescription({ type: "rollback" });
      await pc.setRemoteDescription(desc);
      if (!this.firstOfferHandled) {
        this.firstOfferHandled = true;
        // the callee's microphone (and camera) go into the answer, on the transceivers the offer created
        const stream = this.view.local;
        stream?.getTracks().forEach((t) => pc.addTrack(t, stream));
      }
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      await pc.setLocalDescription();
      await this.d.transport.emit("tcall:answer", { call_id: this.view.callId, data: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
    } catch {
      /* a bad renegotiation does not end the call by itself */
    }
  }
  private onIce(c: RTCIceCandidateInit) {
    if (!c || !c.candidate) return;
    if (!this.pc?.remoteDescription) this.pendingIce.push(c);
    else void this.pc.addIceCandidate(c).catch(() => {});
  }
  private onPeer(event: "lost" | "resumed") {
    if (event === "lost") this.set({ message: `${this.view.peerName} lost the connection. Waiting...` });
    else {
      this.set({ message: "" });
      if (this.view.role === "caller") void this.restartIce();
    }
  }
  private onSocketConnected() {
    if (!this.view.callId || (this.view.phase !== "connecting" && this.view.phase !== "active")) return;
    void this.d.transport.emit<{ ice: { iceServers: IceServer[] } }>("tcall:resume", { call_id: this.view.callId }).then((ack) => {
      if (!ack.ok) return this.finish("The call ended while you were offline.");
      this.ice = ack.ice.iceServers;
      this.pc?.setConfiguration?.({ iceServers: this.ice });
      if (this.view.role === "caller") void this.restartIce();
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
    this.accepting = false;
    this.firstOfferHandled = false;
  }
  /** Forget the last (ended) call. */
  reset() {
    this.teardown();
    this.set({ ...IDLE });
  }
}
