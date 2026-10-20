import type { Attachment } from "../../api/types";
import { formatBytes } from "../../lib/time";
import { Icon } from "../../ui";

/** Images preview inline, audio plays back, everything else is a download chip. */
export function Attachments({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="attachments">
      {items.map((a) => {
        if (a.content_type.startsWith("image/")) {
          return (
            <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="att-image">
              <img src={a.url} alt={a.file_name} loading="lazy" />
            </a>
          );
        }
        if (a.content_type.startsWith("audio/")) {
          return (
            <div key={a.id} className="att-audio">
              <audio controls preload="none" src={a.url} aria-label={`Voice note ${a.file_name}`} />
            </div>
          );
        }
        return (
          <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="chip file-chip" download={a.file_name}>
            <Icon name="file" size={14} />
            <span className="chip-name">{a.file_name}</span>
            <span className="chip-meta">{formatBytes(a.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
