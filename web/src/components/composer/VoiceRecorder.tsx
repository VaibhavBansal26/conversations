import { useEffect, useRef, useState } from "react";
import { Icon } from "../../ui";

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
    <button type="button" className="icon-btn recording" aria-label={`Stop recording (${seconds}s)`} onClick={stop}>
      <Icon name="stop" />
      <span className="rec-time">{seconds}s</span>
    </button>
  ) : (
    <button type="button" className="icon-btn" aria-label="Record voice note" disabled={disabled} onClick={() => void start()}>
      <Icon name="mic" />
    </button>
  );
}
