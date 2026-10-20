import { FileText, Loader2, X } from "lucide-react";
import type { Attachment } from "../../api/types";
import { formatBytes } from "../../lib/time";

interface Props {
  items: Attachment[];
  uploading: number;
  onRemove: (id: string) => void;
}

export function AttachmentChips({ items, uploading, onRemove }: Props) {
  if (!items.length && !uploading) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-3 pb-2" aria-label="Attachments">
      {items.map((a) => (
        <li key={a.id} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-1 text-[13px]">
          {a.content_type.startsWith("image/") ? (
            <img src={a.url} alt="" className="size-7 rounded object-cover" />
          ) : a.content_type.startsWith("audio/") ? (
            <audio controls src={a.url} aria-label={`Preview ${a.file_name}`} className="h-8 w-44" />
          ) : (
            <FileText className="size-4 shrink-0 text-subtle" aria-hidden="true" />
          )}
          <span className="min-w-0 max-w-40 truncate font-medium">{a.file_name}</span>
          <span className="text-xs text-subtle">{formatBytes(a.size)}</span>
          <button type="button" aria-label={`Remove ${a.file_name}`} onClick={() => onRemove(a.id)} className="grid size-6 place-items-center rounded text-subtle hover:bg-surface-3 hover:text-foreground">
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </li>
      ))}
      {uploading > 0 && (
        <li className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-2.5 py-1.5 text-[13px] text-subtle" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Uploading…
        </li>
      )}
    </ul>
  );
}
