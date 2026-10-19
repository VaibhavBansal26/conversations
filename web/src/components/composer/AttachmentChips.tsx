import type { Attachment } from "../../api/types";
import { formatBytes } from "../../lib/time";
import { Icon } from "../ui/Icon";

interface Props {
  items: Attachment[];
  uploading: number;
  onRemove: (id: string) => void;
}

export function AttachmentChips({ items, uploading, onRemove }: Props) {
  if (!items.length && !uploading) return null;
  return (
    <ul className="chip-row" aria-label="Attachments">
      {items.map((a) => (
        <li key={a.id} className="chip file-chip">
          {a.content_type.startsWith("audio/") ? <audio controls src={a.url} aria-label={`Preview ${a.file_name}`} /> : <Icon name="paperclip" size={14} />}
          <span className="chip-name">{a.file_name}</span>
          <span className="chip-meta">{formatBytes(a.size)}</span>
          <button type="button" className="icon-btn sm" aria-label={`Remove ${a.file_name}`} onClick={() => onRemove(a.id)}>
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
      {uploading > 0 && (
        <li className="chip skeleton" role="status">
          Uploading…
        </li>
      )}
    </ul>
  );
}
