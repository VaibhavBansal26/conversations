import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Popover } from "./Popover";

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

interface Props {
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  header?: ReactNode;
}

/** Action menu with roving arrow-key navigation (ArrowUp/Down, Home/End, Enter/Space to choose, Escape to dismiss). */
export function Menu({ label, trigger, items, align, triggerClassName, open, onOpenChange, header }: Props) {
  return (
    <Popover label={label} trigger={trigger} align={align} triggerClassName={triggerClassName} open={open} onOpenChange={onOpenChange} role="menu" panelClassName="menu-panel">
      {(close) => (
        <MenuList
          items={items}
          header={header}
          onPick={(item) => {
            close();
            item.onSelect();
          }}
        />
      )}
    </Popover>
  );
}

function MenuList({ items, header, onPick }: { items: MenuItem[]; header?: ReactNode; onPick: (item: MenuItem) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const enabled = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

  const onKeyDown = (e: KeyboardEvent) => {
    const els = enabled();
    const idx = els.indexOf(document.activeElement as HTMLButtonElement);
    const move = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length]?.focus();
    };
    if (e.key === "ArrowDown") move(idx + 1);
    else if (e.key === "ArrowUp") move(idx <= 0 ? els.length - 1 : idx - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(els.length - 1);
  };

  return (
    <div ref={list} onKeyDown={onKeyDown}>
      {header && <div className="menu-header">{header}</div>}
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          className={`menu-item${item.danger ? " danger" : ""}${item.checked ? " checked" : ""}`}
          disabled={item.disabled}
          autoFocus={i === 0}
          onClick={() => onPick(item)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
