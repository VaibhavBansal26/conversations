import type { ReactNode } from "react";

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
  if (!items.length) {
    return (
      <div id={id} className="suggest" role="listbox" aria-label={label}>
        <p className="suggest-empty">No matches</p>
      </div>
    );
  }
  return (
    <div id={id} className="suggest" role="listbox" aria-label={label}>
      {items.map((item, i) => (
        <div
          key={item.id}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          className={`suggest-item${i === active ? " active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <span>{item.label}</span>
          {item.hint && <small>{item.hint}</small>}
        </div>
      ))}
    </div>
  );
}
