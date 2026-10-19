import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

interface Props {
  /** Accessible name of the trigger button. */
  label: string;
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  triggerClassName?: string;
  panelClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  role?: "menu" | "dialog";
}

/** Disclosure popover: closes on Escape / outside click and returns focus to its trigger. */
export function Popover({ label, trigger, children, align = "start", triggerClassName = "btn btn-ghost", panelClassName, open, onOpenChange, disabled, role = "dialog" }: Props) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      setInner(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, setOpen]);

  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, [setOpen]);

  return (
    <div className="popover" ref={root}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup={role}
        aria-expanded={isOpen}
        aria-controls={isOpen ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!isOpen)}
      >
        {trigger}
      </button>
      {isOpen && (
        <div id={id} className={`popover-panel align-${align}${panelClassName ? ` ${panelClassName}` : ""}`} role={role} aria-label={label}>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
