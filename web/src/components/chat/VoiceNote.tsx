// Adapted from the legacy UI (see docs/PROVENANCE.md): voice-note player (play/pause, bars, duration), without a waveform library.
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../api/types";
import { cn } from "../../ui";

const BARS = 32;
const SPEEDS = [1, 1.5, 2] as const;

/** Deterministic pseudo-waveform: the same note always draws the same bars (no audio decoding needed). */
export function barHeights(seed: string, n = BARS): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return Array.from({ length: n }, () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    return 0.25 + ((h % 1000) / 1000) * 0.75;
  });
}

export const formatDuration = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

export function VoiceNote({ attachment, tone = "in" }: { attachment: Attachment; tone?: "in" | "out" }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const bars = useMemo(() => barHeights(attachment.id), [attachment.id]);
  const progress = duration ? time / duration : 0;

  useEffect(() => {
    const el = audio.current;
    if (el) el.playbackRate = speed;
  }, [speed]);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audio.current;
    if (!el || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    el.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration;
  };

  return (
    <div className="flex w-60 max-w-full items-center gap-2.5" data-testid="voice-note">
      <audio
        ref={audio}
        preload="metadata"
        src={attachment.url}
        aria-label={`Voice note ${attachment.file_name}`}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
        className={cn("grid size-9 shrink-0 place-items-center rounded-full", tone === "out" ? "bg-white/20 hover:bg-white/30" : "bg-primary text-primary-foreground hover:bg-primary-hover")}
      >
        {playing ? <Pause className="size-4" fill="currentColor" aria-hidden="true" /> : <Play className="size-4 translate-x-px" fill="currentColor" aria-hidden="true" />}
      </button>
      <div className="flex h-8 flex-1 cursor-pointer items-center gap-[2px]" onClick={seek} role="presentation">
        {bars.map((h, i) => (
          <span
            key={i}
            className={cn("w-[3px] shrink-0 rounded-full transition-colors", i / BARS < progress ? (tone === "out" ? "bg-white" : "bg-primary") : tone === "out" ? "bg-white/40" : "bg-border-strong")}
            style={{ height: `${h * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-col items-end text-[11px] tabular-nums leading-tight">
        <span>{formatDuration(playing || time ? time : duration)}</span>
        <button type="button" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)} className="rounded px-1 font-semibold opacity-80 hover:opacity-100" aria-label={`Playback speed ${speed}x`}>
          {speed}x
        </button>
      </div>
    </div>
  );
}
