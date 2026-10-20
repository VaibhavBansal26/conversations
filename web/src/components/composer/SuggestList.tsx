import type { ReactNode } from "react";
import { cn } from "../../ui";

export interface SuggestItem {
  id: string;
  label: ReactNode;
  hint?: string;
}

interface Props {
  id: string;
  label: string;
  items: SuggestItem[];
  active: number;
  onPick: (item: SuggestItem) => void;
}

/** Listbox shown above the textarea; keyboard handling stays with the textarea (aria-activedescendant). */
export function SuggestList({ id, label, items, active, onPick }: Props) {
  const box = "absolute bottom-full left-2 z-20 mb-1 max-h-56 w-72 max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg animate-pop-in";
  if (!items.length) {
    return (
      <div id={id} className={box} role="listbox" aria-label={label}>
        <p className="px-3 py-3 text-[13px] text-subtle">No matches</p>
      </div>
    );
  }
  return (
    <div id={id} className={box} role="listbox" aria-label={label}>
      {items.map((item, i) => (
        <div
          key={item.id}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          className={cn("flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm", i === active && "bg-primary-soft text-primary-text")}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="truncate font-medium">{item.label}</span>
          {item.hint && <small className="shrink-0 text-xs text-subtle">{item.hint}</small>}
        </div>
      ))}
    </div>
  );
}
