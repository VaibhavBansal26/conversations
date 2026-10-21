export type TeamShortcut = "prev" | "next" | "next_unread";

/** Alt+Up / Alt+Down move between conversations; Alt+Shift+Up / Down jump to the next one with unread messages. */
export function teamShortcutFor(e: Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">): TeamShortcut | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") return e.shiftKey ? "next_unread" : e.key === "ArrowUp" ? "prev" : "next";
  return null;
}
