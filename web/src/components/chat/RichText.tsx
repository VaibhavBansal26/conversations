import { splitMentions } from "../../lib/mentions";

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

function linkify(text: string) {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/** Plain text with clickable links and `@[Name](id)` mention tokens shown as @Name. Never injects HTML. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {splitMentions(text).map((seg, i) =>
        seg.type === "mention" ? (
          <span key={i} className="mention" data-member-id={seg.id}>
            @{seg.name}
          </span>
        ) : (
          <span key={i}>{linkify(seg.text)}</span>
        ),
      )}
    </>
  );
}
