import { Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../ui";
import { useCalls } from "./CallProvider";

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const QUALITY = { good: "Connection: good", fair: "Connection: fair", poor: "Connection: poor" } as const;
const QUALITY_DOT = { good: "bg-success", fair: "bg-warning", poor: "bg-danger" } as const;

/** The call in progress: floats over the inbox so the agent keeps the conversation in view. Shows nothing when there is no call. */
export function CallPanel() {
  const calls = useCalls();
  const remote = useRef<HTMLVideoElement>(null);
  const local = useRef<HTMLVideoElement>(null);
  const v = calls?.view;
  useEffect(() => {
    if (remote.current) remote.current.srcObject = v?.remote ?? null;
    if (local.current) local.current.srcObject = v?.local ?? null;
  }, [v?.remote, v?.local, v?.phase]);
  if (!calls || !v || v.phase === "idle") return null;
  const { engine } = calls;
  const video = v.kind === "video";
  const status = v.phase === "ringing" ? "Ringing..." : v.phase === "connecting" ? "Connecting..." : v.phase === "active" ? mmss(v.seconds) : "Call ended";
  return (
    <section role="dialog" aria-label="Call" aria-live="polite" className="fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border-strong bg-neutral-900 text-white shadow-xl">
      <div className="relative aspect-video bg-black">
        {/* the remote audio plays through this element even for a voice call */}
        <video ref={remote} autoPlay playsInline aria-label="Video of the visitor" className={cn("size-full object-contain", !video && "hidden")} />
        {!video && <div className="grid size-full place-items-center text-sm opacity-80">Voice call</div>}
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
          {video && calls.config?.browser.screen_share && v.phase === "active" ? (
            <button type="button" aria-label={v.sharing ? "Stop sharing your screen" : "Share your screen"} aria-pressed={v.sharing} onClick={() => void engine.toggleShare()} className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 aria-pressed:bg-white aria-pressed:text-neutral-900">
              <MonitorUp className="size-5" aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label={v.phase === "ringing" ? "Cancel call" : "End call"} onClick={() => void engine.end()} className="grid size-11 place-items-center rounded-full bg-danger text-white hover:brightness-110">
            <PhoneOff className="size-5" aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
