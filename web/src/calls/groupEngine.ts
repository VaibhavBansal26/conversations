// A group call between up to four teammates, in the browser (docs/CALLS.md, ADR 0038): signalling over the app's socket (`gcall:*`), media over WebRTC.
// It is a MESH: one RTCPeerConnection per other person. The person who joins sends an offer to everyone already in the call, so on every link the
// newer joiner is the offerer (the impolite peer: it restarts ICE) and the older participant answers (the polite one).
import type { CallKind, IceServer, Transport } from "./engine";

export type GroupPhase = "idle" | "ringing_in" | "joining" | "in_call" | "ended";
export interface GroupParticipant {
  member_id: string;
  name: string;
  status: "invited" | "joined" | "left" | "declined" | "missed";
  joined_at: string | null;
  muted: boolean;
  camera_off: boolean;
}
export interface GroupCallDto {
  id: string;
  channel_id: string;
  kind: CallKind;
  state: "live" | "ended" | "missed";
  host_id: string;
  max_participants: number;
  sharing_id: string | null;
  participants: GroupParticipant[];
}
export interface GroupTile {
  memberId: string;
  name: string;
  stream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  link: "connecting" | "connected" | "reconnecting" | "self";
  speaking: boolean;
  presenting: boolean;
}
export interface GroupView {
  phase: GroupPhase;
  kind: CallKind | null;
  callId: string | null;
  channelId: string | null;
  title: string;
  call: GroupCallDto | null;
  local: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  speakingId: string | null;
  tiles: GroupTile[];
  seconds: number;
  message: string;
  warning: string | null;
  skipped: { member_id: string; name: string; reason: string }[];
}
const IDLE: GroupView = { phase: "idle", kind: null, callId: null, channelId: null, title: "", call: null, local: null, muted: false, cameraOff: false, sharing: false, speakingId: null, tiles: [], seconds: 0, message: "", warning: null, skipped: [] };

export interface GroupEngineDeps {
  transport: Transport;
  selfId: () => string;
  selfName?: () => string;
  RTCPeerConnection?: typeof RTCPeerConnection;
  mediaDevices?: MediaDevices;
  now?: () => number;
  /** loudness 0..1 of a stream right now (the default reads a WebAudio analyser; tests inject it) */
  levelOf?: (stream: MediaStream) => number;
}

export const GROUP_ERRORS: Record<string, string> = {
  TEAM_CALLS_DISABLED: "Calls between teammates are switched off for this workspace.",
  GROUP_CALLS_DISABLED: "Group calls are switched off for this workspace.",
  TEAM_CALL_KIND_DISABLED: "This kind of call is switched off for this workspace.",
  USE_DIRECT_CALL: "This is a direct message: use its call buttons.",
  TOO_MANY_PARTICIPANTS: "A group call has a limit on the number of people. Choose fewer.",
  NOBODY_TO_RING: "Nobody you chose can take a call right now.",
  GROUP_CALL_EXISTS: "There is already a call in this conversation: join it.",
  GROUP_CALL_FULL: "This call is full.",
  CALL_IN_PROGRESS: "You are already in a call.",
  ALREADY_IN_THIS_CALL: "You are already in this call on another device.",
  CALL_STATE: "The call has ended.",
  RATE_LIMITED: "You have called a lot just now. Try again in a few minutes.",
  PERMISSION_DENIED: "You do not have permission to place calls.",
  SHARE_IN_USE: "Someone else is sharing their screen.",
  SHARE_NOT_AVAILABLE: "Screen sharing is not available in this call.",
};
export const SKIP_REASONS: Record<string, string> = { offline: "is offline", unavailable: "is not available", busy: "is in another call", cannot_receive: "cannot take calls", not_in_conversation: "is not in this conversation", gone: "is no longer here", already_invited: "is already being called", already_in_call: "is already in the call" };

interface Link {
  member: string;
  pc: RTCPeerConnection;
  offerer: boolean;
  pendingIce: RTCIceCandidateInit[];
  makingOffer: boolean;
  firstOfferHandled: boolean;
  stream: MediaStream | null;
  state: "connecting" | "connected" | "reconnecting";
}

export class GroupCallEngine {
  private view: GroupView = IDLE;
  private listeners = new Set<(v: GroupView) => void>();
  private links = new Map<string, Link>();
  private offs: (() => void)[] = [];
  private ice: IceServer[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private speakTimer: ReturnType<typeof setInterval> | undefined;
  private since = 0;
  private screen: MediaStream | null = null;
  private joining = false;
  private readonly rtc: typeof RTCPeerConnection | undefined;
  private readonly media: MediaDevices | undefined;
  private readonly now: () => number;
  private audio = new Map<string, { analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }>();
  private actx: AudioContext | null = null;

  constructor(private readonly d: GroupEngineDeps) {
    this.rtc = d.RTCPeerConnection ?? (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : undefined);
    this.media = d.mediaDevices ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
    this.now = d.now ?? Date.now;
  }
  get state(): GroupView {
    return this.view;
  }
  subscribe(fn: (v: GroupView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<GroupView>) {
    this.view = { ...this.view, ...patch };
    this.view = { ...this.view, tiles: this.buildTiles() };
    for (const l of this.listeners) l(this.view);
  }
  private get busy() {
    return this.view.phase !== "idle" && this.view.phase !== "ended";
  }
  private buildTiles(): GroupTile[] {
    const v = this.view;
    if (v.phase !== "in_call" && v.phase !== "joining") return [];
    const self = this.d.selfId();
    const joined = (v.call?.participants ?? []).filter((p) => p.status === "joined");
    const order = [...joined.filter((p) => p.member_id === self), ...joined.filter((p) => p.member_id !== self)];
    const out: GroupTile[] = order.map((p) => {
      const isSelf = p.member_id === self;
      const l = this.links.get(p.member_id);
      return {
        memberId: p.member_id,
        name: isSelf ? "You" : p.name,
        stream: isSelf ? v.local : l?.stream ?? null,
        muted: isSelf ? v.muted : p.muted,
        cameraOff: isSelf ? v.cameraOff : p.camera_off,
        link: isSelf ? "self" : l?.state ?? "connecting",
        speaking: v.speakingId === p.member_id,
        presenting: v.call?.sharing_id === p.member_id,
      };
    });
    return out;
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

  /** Start a call in a group message or channel. */
  async start(channelId: string, kind: CallKind, title: string, inviteIds?: string[]): Promise<{ ok: true; skipped: GroupView["skipped"] } | { ok: false; message: string }> {
    if (this.busy) return { ok: false, message: "You are already in a call." };
    this.reset();
    const stream = await this.mic(kind);
    if ("error" in stream) return { ok: false, message: stream.error };
    const ack = await this.d.transport.emit<{ call: GroupCallDto; ice: { iceServers: IceServer[]; warning: string | null }; skipped: GroupView["skipped"] }>("gcall:start", { channel_id: channelId, kind, ...(inviteIds ? { invite_ids: inviteIds } : {}) });
    if (!ack.ok) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, message: this.explain(ack.error) };
    }
    this.ice = ack.ice.iceServers;
    this.enter(ack.call, stream, title, ack.ice.warning, ack.skipped);
    return { ok: true, skipped: ack.skipped };
  }

  /** `gcall:state` from the server, for a call this member has a row in (fed by the provider; every tab gets it). */
  handleState(c: GroupCallDto) {
    const self = this.d.selfId();
    const me = c.participants.find((p) => p.member_id === self);
    if (!me) return;
    const v = this.view;
    if (!this.busy && c.state === "live" && me.status === "invited") {
      this.reset();
      const host = c.participants.find((p) => p.member_id === c.host_id);
      this.set({ phase: "ringing_in", kind: c.kind, callId: c.id, channelId: c.channel_id, call: c, title: host?.name ?? "A teammate" });
      return;
    }
    if (c.id !== v.callId) return;
    if (v.phase === "ringing_in") {
      if (c.state !== "live" || me.status === "missed") this.finish(c.state === "live" ? "You missed the call." : "The call ended before you answered.");
      else if (me.status === "joined" && !this.joining) this.finish("Answered on another device.");
      else this.set({ call: c });
      return;
    }
    if (v.phase !== "in_call" && v.phase !== "joining") return;
    if (c.state !== "live" || me.status !== "joined") return this.finish(c.state === "live" ? "You left the call." : "The call ended.");
    for (const [m] of this.links) if (!c.participants.some((p) => p.member_id === m && p.status === "joined")) this.closeLink(m);
    if (this.view.sharing && c.sharing_id && c.sharing_id !== self) void this.stopShare(false);
    this.set({ call: c });
  }

  /** Join the call that rings, or one from a card (`callId`). */
  async join(callId?: string, kind?: CallKind, title = ""): Promise<{ ok: true } | { ok: false; message: string }> {
    const id = callId ?? this.view.callId;
    if (!id || this.joining) return { ok: false, message: "There is no call to join." };
    if (this.busy && this.view.phase !== "ringing_in") return { ok: false, message: "You are already in a call." };
    const k = kind ?? this.view.kind ?? "voice";
    this.joining = true;
    const stream = await this.mic(k);
    if ("error" in stream) {
      this.joining = false;
      if (this.view.phase === "ringing_in") void this.d.transport.emit("gcall:decline", { call_id: id });
      this.finish(stream.error);
      return { ok: false, message: stream.error };
    }
    this.bind(id);
    const ack = await this.d.transport.emit<{ call: GroupCallDto; ice: { iceServers: IceServer[]; warning: string | null }; peers: string[] }>("gcall:join", { call_id: id });
    this.joining = false;
    if (!ack.ok) {
      stream.getTracks().forEach((t) => t.stop());
      const message = this.explain(ack.error);
      for (const o of this.offs.splice(0)) o();
      if (this.view.phase === "ringing_in") this.finish(message);
      return { ok: false, message };
    }
    this.ice = ack.ice.iceServers;
    this.enter(ack.call, stream, title || this.view.title, ack.ice.warning, []);
    for (const peer of ack.peers) this.openLink(peer, true);
    return { ok: true };
  }
  async decline() {
    const id = this.view.callId;
    if (this.view.phase !== "ringing_in" || !id) return;
    await this.d.transport.emit("gcall:decline", { call_id: id });
    this.finish("You declined the call.");
  }
  async leave() {
    const id = this.view.callId;
    if (!id) return this.reset();
    if (this.view.phase === "ringing_in") return this.decline();
    await this.d.transport.emit("gcall:leave", { call_id: id });
    this.finish("You left the call.");
  }
  async invite(memberIds: string[]): Promise<{ ok: true; skipped: GroupView["skipped"] } | { ok: false; message: string }> {
    const id = this.view.callId;
    if (!id || this.view.phase !== "in_call") return { ok: false, message: "You are not in a call." };
    const ack = await this.d.transport.emit<{ call: GroupCallDto; skipped: GroupView["skipped"] }>("gcall:invite", { call_id: id, member_ids: memberIds });
    if (!ack.ok) return { ok: false, message: this.explain(ack.error) };
    this.set({ skipped: ack.skipped });
    return { ok: true, skipped: ack.skipped };
  }
  private explain(e: { code: string; message: string; details?: unknown }): string {
    return GROUP_ERRORS[e.code] ?? e.message;
  }

  private enter(call: GroupCallDto, stream: MediaStream, title: string, warning: string | null, skipped: GroupView["skipped"]) {
    this.since = this.now();
    this.set({ phase: "in_call", kind: call.kind, callId: call.id, channelId: call.channel_id, call, title, local: stream, warning, skipped, seconds: 0, muted: false, cameraOff: false });
    this.bind(call.id);
    clearInterval(this.timer);
    clearInterval(this.speakTimer);
    this.timer = setInterval(() => this.set({ seconds: Math.floor((this.now() - this.since) / 1000) }), 1000);
    this.speakTimer = setInterval(() => this.pickSpeaker(), 400);
  }

  private bind(callId: string) {
    const t = this.d.transport;
    for (const o of this.offs.splice(0)) o();
    type Sig = { call_id: string; from: string; data: RTCSessionDescriptionInit & RTCIceCandidateInit };
    this.offs.push(
      t.subscribe("gcall:offer", ((p: Sig) => p.call_id === callId && void this.onOffer(p.from, p.data)) as never),
      t.subscribe("gcall:answer", ((p: Sig) => p.call_id === callId && void this.links.get(p.from)?.pc.setRemoteDescription(p.data).catch(() => {})) as never),
      t.subscribe("gcall:ice", ((p: Sig) => p.call_id === callId && this.onIce(p.from, p.data)) as never),
      t.subscribe("gcall:peer", ((p: { call_id: string; member_id: string; event: "lost" | "resumed" }) => p.call_id === callId && this.onPeer(p.member_id, p.event)) as never),
      t.subscribe("connect", (() => this.onSocketConnected()) as never),
    );
  }

  /* ---------- one link of the mesh ---------- */
  private openLink(member: string, offerer: boolean): Link {
    this.closeLink(member);
    const pc = new this.rtc!({ iceServers: this.ice });
    const link: Link = { member, pc, offerer, pendingIce: [], makingOffer: false, firstOfferHandled: false, stream: null, state: "connecting" };
    this.links.set(member, link);
    pc.onicecandidate = (e) => {
      if (!this.view.callId) return;
      void this.d.transport.emit("gcall:ice", { call_id: this.view.callId, to: member, data: e.candidate ? (e.candidate.toJSON ? e.candidate.toJSON() : { candidate: e.candidate.candidate }) : {} });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? link.stream ?? new MediaStream();
      if (!e.streams[0]) stream.addTrack(e.track);
      link.stream = stream;
      this.set({});
    };
    pc.onnegotiationneeded = () => {
      if (link.offerer || pc.remoteDescription) void this.negotiate(link);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") link.state = "connected";
      else if (st === "disconnected" || st === "failed") {
        link.state = "reconnecting";
        if (link.offerer) void this.restartIce(link);
      }
      this.set({});
    };
    if (offerer) {
      const stream = this.view.local;
      stream?.getTracks().forEach((t) => pc.addTrack(t, stream));
      // a voice-only call still receives video if the other side sends it (screen share)
    }
    return link;
  }
  private closeLink(member: string) {
    const l = this.links.get(member);
    if (!l) return;
    this.links.delete(member);
    this.audio.delete(member);
    try {
      l.pc.close();
    } catch {
      /* ignore */
    }
    this.set({});
  }
  private async negotiate(link: Link, iceRestart = false) {
    const pc = link.pc;
    if (!this.view.callId || link.makingOffer || this.links.get(link.member) !== link) return;
    try {
      link.makingOffer = true;
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      await this.d.transport.emit("gcall:offer", { call_id: this.view.callId, to: link.member, data: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
    } catch {
      /* the connection state reports a failed negotiation */
    } finally {
      link.makingOffer = false;
    }
  }
  private async restartIce(link: Link) {
    if (link.pc.restartIce) link.pc.restartIce();
    await this.negotiate(link, true);
  }
  private async onOffer(from: string, desc: RTCSessionDescriptionInit) {
    if (!this.view.callId || this.view.phase !== "in_call") return;
    const link = this.links.get(from) ?? this.openLink(from, false);
    const pc = link.pc;
    const collision = desc.type === "offer" && (link.makingOffer || pc.signalingState !== "stable");
    // the offerer is impolite: it ignores an offer that collides with its own; the answerer is polite and rolls back
    if (collision && link.offerer) return;
    try {
      if (collision) await pc.setLocalDescription({ type: "rollback" });
      await pc.setRemoteDescription(desc);
      if (!link.firstOfferHandled) {
        link.firstOfferHandled = true;
        const stream = this.view.local;
        stream?.getTracks().forEach((t) => pc.addTrack(t, stream));
      }
      for (const c of link.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      await pc.setLocalDescription();
      await this.d.transport.emit("gcall:answer", { call_id: this.view.callId, to: from, data: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
    } catch {
      /* a bad renegotiation does not end the call by itself */
    }
  }
  private onIce(from: string, c: RTCIceCandidateInit) {
    if (!c || !c.candidate) return;
    const l = this.links.get(from);
    if (!l) return;
    if (!l.pc.remoteDescription) l.pendingIce.push(c);
    else void l.pc.addIceCandidate(c).catch(() => {});
  }
  private onPeer(member: string, event: "lost" | "resumed") {
    const l = this.links.get(member);
    const name = this.view.call?.participants.find((p) => p.member_id === member)?.name ?? "Someone";
    if (event === "lost") {
      if (l) l.state = "reconnecting";
      this.set({ message: `${name} lost the connection. Waiting...` });
    } else {
      this.set({ message: "" });
      if (l?.offerer) void this.restartIce(l);
    }
  }
  private onSocketConnected() {
    if (!this.view.callId || this.view.phase !== "in_call") return;
    void this.d.transport.emit<{ ice: { iceServers: IceServer[] } }>("gcall:resume", { call_id: this.view.callId }).then((ack) => {
      if (!ack.ok) return this.finish("The call ended while you were offline.");
      this.ice = ack.ice.iceServers;
      for (const l of this.links.values()) {
        l.pc.setConfiguration?.({ iceServers: this.ice });
        if (l.offerer) void this.restartIce(l);
      }
    });
  }

  /* ---------- controls ---------- */
  toggleMute() {
    const muted = !this.view.muted;
    this.view.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
    if (this.view.callId) void this.d.transport.emit("gcall:media", { call_id: this.view.callId, muted });
  }
  toggleCamera() {
    const cameraOff = !this.view.cameraOff;
    this.view.local?.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    this.set({ cameraOff });
    if (this.view.callId) void this.d.transport.emit("gcall:media", { call_id: this.view.callId, camera_off: cameraOff });
  }
  async toggleShare(): Promise<{ ok: boolean; message?: string }> {
    if (this.view.sharing) {
      await this.stopShare(true);
      return { ok: true };
    }
    if (!this.media?.getDisplayMedia || !this.view.callId) return { ok: false, message: "This browser cannot share the screen." };
    // the server decides who holds the screen: ask first, then capture
    const ack = await this.d.transport.emit("gcall:share", { call_id: this.view.callId, on: true });
    if (!ack.ok) {
      const message = this.explain(ack.error);
      this.set({ message });
      return { ok: false, message };
    }
    try {
      const stream = await this.media.getDisplayMedia({ video: true });
      this.screen = stream;
      const track = stream.getVideoTracks()[0]!;
      for (const l of this.links.values()) {
        const sender = l.pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
        else l.pc.addTrack(track, stream);
      }
      track.onended = () => void this.stopShare(true);
      this.set({ sharing: true, message: "" });
      return { ok: true };
    } catch {
      void this.d.transport.emit("gcall:share", { call_id: this.view.callId, on: false });
      return { ok: false };
    }
  }
  private async stopShare(tell: boolean) {
    if (!this.view.sharing) return;
    const cam = this.view.local?.getVideoTracks()[0] ?? null;
    for (const l of this.links.values()) {
      const sender = l.pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(cam);
    }
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.set({ sharing: false });
    if (tell && this.view.callId) void this.d.transport.emit("gcall:share", { call_id: this.view.callId, on: false });
  }

  /* ---------- who is speaking ---------- */
  private level(stream: MediaStream | null, key: string): number {
    if (!stream) return 0;
    if (this.d.levelOf) return this.d.levelOf(stream);
    try {
      if (!stream.getAudioTracks().length) return 0;
      const Ctor = typeof window !== "undefined" ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined;
      if (!Ctor) return 0;
      this.actx ??= new Ctor();
      let a = this.audio.get(key);
      if (!a) {
        const analyser = this.actx.createAnalyser();
        analyser.fftSize = 512;
        this.actx.createMediaStreamSource(stream).connect(analyser);
        a = { analyser, buf: new Uint8Array(new ArrayBuffer(analyser.fftSize)) };
        this.audio.set(key, a);
      }
      a.analyser.getByteTimeDomainData(a.buf);
      let sum = 0;
      for (const b of a.buf) sum += ((b - 128) / 128) ** 2;
      return Math.sqrt(sum / a.buf.length);
    } catch {
      return 0;
    }
  }
  private pickSpeaker() {
    const self = this.d.selfId();
    let best: string | null = null;
    let bestLevel = 0.04;
    const consider = (id: string, l: number) => {
      if (l > bestLevel) (best = id), (bestLevel = l);
    };
    if (!this.view.muted) consider(self, this.level(this.view.local, self));
    for (const l of this.links.values()) {
      const muted = this.view.call?.participants.find((p) => p.member_id === l.member)?.muted;
      if (!muted) consider(l.member, this.level(l.stream, l.member));
    }
    if (best !== this.view.speakingId) this.set({ speakingId: best });
  }

  private finish(message: string) {
    if (this.view.phase === "idle" || this.view.phase === "ended") return;
    this.teardown();
    this.set({ phase: "ended", message, muted: false, cameraOff: false, sharing: false, speakingId: null, local: null, tiles: [] });
  }
  private teardown() {
    clearInterval(this.timer);
    clearInterval(this.speakTimer);
    for (const o of this.offs.splice(0)) o();
    for (const l of this.links.values()) {
      try {
        l.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.links.clear();
    this.audio.clear();
    this.view.local?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.joining = false;
    void this.actx?.close().catch(() => {});
    this.actx = null;
  }
  /** Forget the last (ended) call. */
  reset() {
    this.teardown();
    this.set({ ...IDLE });
  }
}
