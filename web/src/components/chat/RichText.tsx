import { splitMentions } from "../../lib/mentions";

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

function linkify(text: string) {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline decoration-current/50 underline-offset-2 hover:decoration-current">
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
          <span key={i} className="rounded bg-primary/15 px-1 font-medium text-primary-text" data-member-id={seg.id}>
            @{seg.name}
          </span>
        ) : (
          <span key={i}>{linkify(seg.text)}</span>
        ),
      )}
    </>
  );
}
