import { useQuery } from "@tanstack/react-query";
import { Mic, MicOff, MonitorUp, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useCan, useSession } from "../auth/AuthContext";
import { useSocket } from "../realtime/SocketProvider";
import { cn, toast } from "../ui";
import type { CallKind } from "./engine";
import { TeamCallEngine, type TeamCallDto, type TeamCallView } from "./teamEngine";

export interface TeamCallsConfig {
  enabled: boolean;
  voice: boolean;
  video: boolean;
  screen_share: boolean;
  ring_seconds: number;
  warning: string | null;
  live_call: TeamCallDto | null;
}
interface TeamCallsValue {
  /** calls between teammates are on and this member may place and take them */
  available: boolean;
  config: TeamCallsConfig | null;
  view: TeamCallView;
  engine: TeamCallEngine;
  /** ring the other member of a direct message */
  call(channelId: string, kind: CallKind, peerName: string): Promise<void>;
  /** open (or create) the direct message with a teammate and ring them */
  callMember(memberId: string, name: string, kind: CallKind): Promise<void>;
}
const Ctx = createContext<TeamCallsValue | null>(null);
/** Null outside the provider: the call buttons simply do not show. */
export const useTeamCalls = (): TeamCallsValue | null => useContext(Ctx);

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function TeamCallProvider({ children }: { children: ReactNode }) {
  const socket = useSocket();
  const canCall = useCan("calls:internal");
  const me = useSession().member.id;
  const cfg = useQuery({ queryKey: ["team-calls", "config"], enabled: canCall, staleTime: 60_000, queryFn: () => api.get<TeamCallsConfig>("/team-calls/config") }).data ?? null;
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const engine = useMemo(
    () =>
      new TeamCallEngine({
        selfId: () => me,
        transport: { emit: (event, payload, timeoutMs) => socketRef.current.emit(event, payload, timeoutMs), subscribe: (event, handler) => socketRef.current.subscribe(event, handler) },
      }),
    [me],
  );
  const [view, setView] = useState<TeamCallView>(engine.state);
  useEffect(() => engine.subscribe(setView), [engine]);
  useEffect(() => () => engine.reset(), [engine]);
  // every tab of the member hears about every state of every call they are part of: an incoming call rings anywhere in the app
  useEffect(() => {
    if (!socket.connected || !canCall) return;
    return socket.subscribe("tcall:state", ((p: { call: TeamCallDto }) => engine.handleState(p.call)) as never);
  }, [socket, socket.connected, canCall, engine]);
  // a tab opened in the middle of a ringing call
  useEffect(() => {
    if (cfg?.live_call && cfg.live_call.state === "ringing" && engine.state.phase === "idle") engine.handleState(cfg.live_call);
  }, [cfg?.live_call, engine]);
  // what was missed or refused is also said in a toast, wherever the member is in the app
  useEffect(() => {
    if (view.phase === "ended" && view.message && view.role === "callee" && /Missed|cancelled/.test(view.message)) toast({ title: view.message, tone: "default" });
  }, [view.phase, view.message, view.role]);
  const available = canCall && !!cfg?.enabled;
  const call = useCallback(
    async (channelId: string, kind: CallKind, peerName: string) => {
      const r = await engine.call(channelId, kind, peerName);
      if (!r.ok) toast({ title: "Could not start the call", description: r.message, tone: "error" });
    },
    [engine],
  );
  const callMember = useCallback(
    async (memberId: string, name: string, kind: CallKind) => {
      try {
        const ch = await api.post<{ id: string }>("/team/dms", { member_ids: [memberId] });
        await call(ch.id, kind, name);
      } catch (e) {
        toast({ title: "Could not start the call", description: e instanceof Error ? e.message : "Try again", tone: "error" });
      }
    },
    [call],
  );
  const value = useMemo<TeamCallsValue>(() => ({ available, config: cfg, view, engine, call, callMember }), [available, cfg, view, engine, call, callMember]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <IncomingTeamCall />
      <TeamCallPanel />
    </Ctx.Provider>
  );
}

/** A soft double beep while a call rings, where the browser allows sound. */
function useRing(on: boolean) {
  useEffect(() => {
    if (!on || typeof window === "undefined") return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext | null = null;
    const beep = () => {
      try {
        ctx ??= new Ctor();
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);
        g.gain.value = 0.05;
        osc.frequency.value = 520;
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } catch {
        /* the screen is the signal */
      }
    };
    beep();
    const t = setInterval(beep, 2200);
    return () => {
      clearInterval(t);
      void ctx?.close().catch(() => {});
    };
  }, [on]);
}

/** Rings in every tab, wherever the member is in the app. */
export function IncomingTeamCall() {
  const c = useTeamCalls();
  const accept = useRef<HTMLButtonElement>(null);
  const ringing = c?.view.phase === "ringing_in";
  useRing(!!ringing);
  useEffect(() => {
    if (ringing) accept.current?.focus();
  }, [ringing]);
  if (!c || !ringing) return null;
  const { view, engine } = c;
  return (
    <section role="alertdialog" aria-label="Incoming call" aria-describedby="incoming-call-text" className="fixed left-1/2 top-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-border-strong bg-neutral-900 p-3 text-white shadow-xl">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white/15" aria-hidden="true">
        {view.kind === "video" ? <Video className="size-5" /> : <Phone className="size-5" />}
      </span>
      <p id="incoming-call-text" className="min-w-0 flex-1 text-sm">
        <strong className="block truncate">{view.peerName}</strong>
        <span className="text-white/80">{view.kind === "video" ? "is calling you (video)" : "is calling you"}</span>
      </p>
      <button ref={accept} type="button" aria-label={`Accept the call from ${view.peerName}`} onClick={() => void engine.accept()} className="grid size-11 place-items-center rounded-full bg-success text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        <Phone className="size-5" aria-hidden="true" />
      </button>
      <button type="button" aria-label={`Decline the call from ${view.peerName}`} onClick={() => void engine.decline()} className="grid size-11 place-items-center rounded-full bg-danger text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        <PhoneOff className="size-5" aria-hidden="true" />
      </button>
    </section>
  );
}

const QUALITY = { good: "Connection: good", fair: "Connection: fair", poor: "Connection: poor" } as const;
const QUALITY_DOT = { good: "bg-success", fair: "bg-warning", poor: "bg-danger" } as const;

/** The call in progress (or ringing out, or just ended): floats over the app so the conversation stays in view. */
export function TeamCallPanel() {
  const c = useTeamCalls();
  const remote = useRef<HTMLVideoElement>(null);
  const local = useRef<HTMLVideoElement>(null);
  const v = c?.view;
  useEffect(() => {
    if (remote.current) remote.current.srcObject = v?.remote ?? null;
    if (local.current) local.current.srcObject = v?.local ?? null;
  }, [v?.remote, v?.local, v?.phase]);
  if (!c || !v || v.phase === "idle" || v.phase === "ringing_in") return null;
  const { engine } = c;
  const video = v.kind === "video";
  const status = v.phase === "ringing_out" ? `Calling ${v.peerName}...` : v.phase === "connecting" ? "Connecting..." : v.phase === "active" ? mmss(v.seconds) : "Call ended";
  return (
    <section role="dialog" aria-label={`Call with ${v.peerName}`} aria-live="polite" className="fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border-strong bg-neutral-900 text-white shadow-xl">
      <div className="relative aspect-video bg-black">
        {/* the other person's audio plays through this element even in a voice call */}
        <video ref={remote} autoPlay playsInline aria-label={`Video of ${v.peerName}`} className={cn("size-full object-contain", !video && "hidden")} />
        {!video && (
          <div className="grid size-full place-items-center">
            <div className="flex flex-col items-center gap-2">
              <span className="grid size-16 place-items-center rounded-full bg-white/15 text-2xl font-semibold" aria-hidden="true">
                {v.peerName.charAt(0).toUpperCase()}
              </span>
              <span className="text-sm opacity-90">{v.peerName}</span>
            </div>
          </div>
        )}
        <video ref={local} autoPlay playsInline muted aria-label="Your video" className={cn("absolute bottom-2 right-2 w-1/4 -scale-x-100 rounded-md border border-white/60 bg-neutral-800", (!video || v.cameraOff || !v.local?.getVideoTracks().length) && "hidden")} />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent px-3 py-2 text-xs">
          <span className="tabular-nums" role="timer">
            {status}
          </span>
          {v.quality && (
            <span className="inline-flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", QUALITY_DOT[v.quality])} role="img" aria-label={QUALITY[v.quality]} />
              {v.quality}
            </span>
          )}
        </div>
      </div>
      {(v.message && v.phase !== "ended") || v.warning ? (
        <p className="px-3 pt-2 text-xs text-white/80" role="status">
          {v.message || v.warning}
        </p>
      ) : null}
      {v.phase === "ended" ? (
        <div className="flex items-center justify-between gap-2 p-3">
          <p className="text-sm">{v.message}</p>
          <button type="button" className="rounded-md bg-white/15 px-3 py-1.5 text-sm font-medium hover:bg-white/25" onClick={() => engine.reset()}>
            Close
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 p-3">
          <button type="button" aria-label={v.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={v.muted} onClick={() => engine.toggleMute()} className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 aria-pressed:bg-white aria-pressed:text-neutral-900">
            {v.muted ? <MicOff className="size-5" aria-hidden="true" /> : <Mic className="size-5" aria-hidden="true" />}
          </button>
          {video && v.local?.getVideoTracks().length ? (
            <button type="button" aria-label={v.cameraOff ? "Turn camera on" : "Turn camera off"} aria-pressed={v.cameraOff} onClick={() => engine.toggleCamera()} className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 aria-pressed:bg-white aria-pressed:text-neutral-900">
              {v.cameraOff ? <VideoOff className="size-5" aria-hidden="true" /> : <Video className="size-5" aria-hidden="true" />}
            </button>
          ) : null}
          {video && c.config?.screen_share && v.phase === "active" ? (
            <button type="button" aria-label={v.sharing ? "Stop sharing your screen" : "Share your screen"} aria-pressed={v.sharing} onClick={() => void engine.toggleShare()} className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 aria-pressed:bg-white aria-pressed:text-neutral-900">
              <MonitorUp className="size-5" aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label={v.phase === "ringing_out" ? "Cancel call" : "End call"} onClick={() => void engine.end()} className="grid size-11 place-items-center rounded-full bg-danger text-white hover:brightness-110">
            <PhoneOff className="size-5" aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
