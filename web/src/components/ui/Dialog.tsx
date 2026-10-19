import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: traps Tab, closes on Escape / backdrop click, restores focus to whatever opened it. */
export function Dialog({ title, onClose, children, wide }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const els = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = els[0];
    const last = els[els.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={`dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
