import type { TypingEvent } from "../../api/types";

export function TypingIndicator({ who }: { who: TypingEvent["who"] | undefined }) {
  if (!who) return null;
  const name = who.name || (who.type === "contact" ? "Customer" : "A teammate");
  return (
    <div className="flex items-center gap-2 px-1 pt-1 text-xs text-subtle" role="status" aria-live="polite">
      <span className="flex items-center gap-0.5 rounded-full bg-surface-3 px-2 py-1.5" aria-hidden="true">
        {[0, 150, 300].map((d) => (
          <i key={d} className="size-1.5 animate-bounce rounded-full bg-subtle motion-reduce:animate-none" style={{ animationDelay: `${d}ms` }} />
        ))}
      </span>
      {name} is typing…
    </div>
  );
}
