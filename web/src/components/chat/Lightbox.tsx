// Adapted from the legacy UI (see docs/PROVENANCE.md): image dialog with previous/next over every image in the conversation.
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect } from "react";
import type { Attachment } from "../../api/types";
import { Button, DialogOverlay } from "../../ui";

interface Props {
  images: Attachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}

/** Full-screen viewer: arrow keys and buttons move through the images, Escape closes. */
export function Lightbox({ images, index, onIndex, onClose }: Props) {
  const current = images[index];
  const many = images.length > 1;
  const go = (delta: number) => onIndex((index + delta + images.length) % images.length);

  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!current) return null;
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogOverlay className="bg-black/85" />
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed inset-0 z-50 flex flex-col focus:outline-none" onClick={(e) => e.target === e.currentTarget && onClose()}>
          <DialogPrimitive.Title className="sr-only">Image viewer: {current.file_name}</DialogPrimitive.Title>
          <div className="flex items-center gap-2 px-4 py-3 text-white">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{current.file_name}</span>
            {many && (
              <span className="text-xs text-white/70" aria-live="polite">
                {index + 1} / {images.length}
              </span>
            )}
            <a href={current.url} download={current.file_name} aria-label="Download image" className="grid size-9 place-items-center rounded-md hover:bg-white/10">
              <Download className="size-5" aria-hidden="true" />
            </a>
            <DialogPrimitive.Close aria-label="Close image viewer" className="grid size-9 place-items-center rounded-md hover:bg-white/10">
              <X className="size-5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <img src={current.url} alt={current.file_name} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />
            {many && (
              <>
                <Button variant="secondary" size="icon" className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full" aria-label="Previous image" onClick={() => go(-1)}>
                  <ChevronLeft />
                </Button>
                <Button variant="secondary" size="icon" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full" aria-label="Next image" onClick={() => go(1)}>
                  <ChevronRight />
                </Button>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
