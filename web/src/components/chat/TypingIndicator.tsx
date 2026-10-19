import type { TypingEvent } from "../../api/types";

export function TypingIndicator({ who }: { who: TypingEvent["who"] | undefined }) {
  if (!who) return null;
  const name = who.name || (who.type === "contact" ? "Customer" : "A teammate");
  return (
    <div className="typing" role="status" aria-live="polite">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {name} is typing…
    </div>
  );
}
