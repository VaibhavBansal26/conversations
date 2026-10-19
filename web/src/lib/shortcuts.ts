export type ShortcutAction = "next_room" | "prev_room" | "toggle_status" | "open_assign" | "focus_composer" | "help" | "escape";

export interface KeyInfo {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean; getAttribute?(name: string): string | null } | null;
}

const KEYS: Record<string, ShortcutAction> = {
  j: "next_room",
  k: "prev_room",
  e: "toggle_status",
  a: "open_assign",
  c: "focus_composer",
  "?": "help",
};

export function isTypingTarget(target: KeyInfo["target"]): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!target.isContentEditable || target.getAttribute?.("contenteditable") === "true";
}

/** Escape always closes overlays; letter shortcuts are ignored while the agent is typing or using a modifier. */
export function shortcutFor(e: KeyInfo): ShortcutAction | null {
  if (e.key === "Escape") return "escape";
  if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return null;
  return KEYS[e.key] ?? null;
}

export const SHORTCUT_HELP: { keys: string; label: string }[] = [
  { keys: "j / k", label: "Next / previous conversation" },
  { keys: "e", label: "Close or reopen conversation" },
  { keys: "a", label: "Open assign menu" },
  { keys: "c", label: "Focus the composer" },
  { keys: "?", label: "Show this help" },
  { keys: "Esc", label: "Close menus and dialogs" },
  { keys: "Enter", label: "Send message (Shift+Enter for a new line)" },
];
