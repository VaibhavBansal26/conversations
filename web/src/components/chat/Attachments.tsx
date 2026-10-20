import { FileText, Download } from "lucide-react";
import { useState } from "react";
import type { Attachment } from "../../api/types";
import { formatBytes } from "../../lib/time";
import { cn } from "../../ui";
import { Lightbox } from "./Lightbox";
import { VoiceNote } from "./VoiceNote";

/** Images preview inline (click for the viewer), audio plays as a voice note, everything else is a download chip. */
export function Attachments({ items, tone = "in" }: { items: Attachment[]; tone?: "in" | "out" }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!items.length) return null;
  const images = items.filter((a) => a.content_type.startsWith("image/"));
  const others = items.filter((a) => !a.content_type.startsWith("image/"));
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length > 0 && (
        <div className={cn("grid gap-1", images.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
          {images.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`View ${a.file_name}`}
              className={cn("overflow-hidden rounded-lg bg-black/10", images.length === 1 ? "max-w-[280px]" : "aspect-square")}
            >
              <img src={a.url} alt={a.file_name} loading="lazy" className={cn("size-full object-cover", images.length === 1 && "max-h-72")} />
            </button>
          ))}
        </div>
      )}
      {others.map((a) =>
        a.content_type.startsWith("audio/") ? (
          <VoiceNote key={a.id} attachment={a} tone={tone} />
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            download={a.file_name}
            className={cn("flex w-64 max-w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left", tone === "out" ? "border-white/25 bg-white/10 hover:bg-white/15" : "border-border bg-surface-2 hover:bg-surface-3")}
          >
            <FileText className="size-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{a.file_name}</span>
              <span className="block text-xs opacity-75">{formatBytes(a.size)}</span>
            </span>
            <Download className="size-4 shrink-0 opacity-70" aria-hidden="true" />
          </a>
        ),
      )}
      {open !== null && <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}
