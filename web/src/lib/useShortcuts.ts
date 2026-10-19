import { useEffect, useRef } from "react";
import { shortcutFor, type ShortcutAction } from "./shortcuts";

type Handlers = Partial<Record<ShortcutAction, () => void>>;

/** Global keyboard shortcuts. Letter keys are ignored while typing or while a modal dialog is open. */
export function useShortcuts(handlers: Handlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      const handler = action ? ref.current[action] : undefined;
      if (!action || !handler) return;
      if (action !== "escape" && document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
