import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Tooltip, cn } from "../../ui";

interface Props {
  disabled?: boolean;
  onRecorded: (file: File) => void;
  onError: (message: string) => void;
}

export const canRecordAudio = (): boolean => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** Optional voice-note recorder; renders nothing where MediaRecorder / microphone access is unavailable. */
export function VoiceRecorder({ disabled, onRecorded, onError }: Props) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  if (!canRecordAudio()) return null;

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        onRecorded(new File(chunks, `voice-note.${ext}`, { type }));
      };
      rec.start();
      recorder.current = rec;
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      onError("Microphone access was denied or is unavailable.");
    }
  };

  const stop = () => {
    recorder.current?.stop();
    if (timer.current) clearInterval(timer.current);
    setRecording(false);
  };

  return recording ? (
    <button type="button" className="flex h-8 items-center gap-1.5 rounded-md bg-danger-soft px-2 text-[13px] font-semibold text-danger-text" aria-label={`Stop recording (${seconds}s)`} onClick={stop}>
      <span className="size-2 animate-pulse rounded-full bg-danger motion-reduce:animate-none" aria-hidden="true" />
      <Square className="size-3.5" fill="currentColor" aria-hidden="true" />
      <span className="tabular-nums">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
    </button>
  ) : (
    <Tooltip content="Record a voice note">
      <button type="button" className={cn("grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-45")} aria-label="Record voice note" disabled={disabled} onClick={() => void start()}>
        <Mic className="size-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
