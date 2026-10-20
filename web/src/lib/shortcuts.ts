export type ShortcutAction =
  | "next_room"
  | "prev_room"
  | "toggle_status"
  | "open_assign"
  | "focus_composer"
  | "focus_search"
  | "new_conversation"
  | "toggle_panel"
  | "toggle_priority"
  | "toggle_favorite"
  | "open_snooze"
  | "help"
  | "escape";

export interface KeyInfo {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

const KEYS: Record<string, ShortcutAction> = {
  j: "next_room",
  k: "prev_room",
  e: "toggle_status",
  a: "open_assign",
  c: "focus_composer",
  "/": "focus_search",
  n: "new_conversation",
  i: "toggle_panel",
  p: "toggle_priority",
  f: "toggle_favorite",
  s: "open_snooze",
  "?": "help",
};

export function isTypingTarget(target: KeyInfo["target"]): boolean {
  const el = target as Partial<HTMLElement> | null | undefined;
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable || el.getAttribute?.("contenteditable") === "true";
}

/** Escape always closes overlays; letter shortcuts are ignored while the agent is typing or using a modifier. */
export function shortcutFor(e: KeyInfo): ShortcutAction | null {
  if (e.key === "Escape") return "escape";
  if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return null;
  return KEYS[e.key] ?? null;
}

export interface ShortcutGroup {
  title: string;
  items: { keys: string[]; label: string }[];
}

export const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigate",
    items: [
      { keys: [MOD_KEY, "K"], label: "Command palette: jump to a conversation or run an action" },
      { keys: ["j", "k"], label: "Next / previous conversation" },
      { keys: ["/"], label: "Search conversations" },
      { keys: ["n"], label: "New conversation" },
    ],
  },
  {
    title: "Conversation",
    items: [
      { keys: ["e"], label: "Close or reopen" },
      { keys: ["a"], label: "Open the assign menu" },
      { keys: ["s"], label: "Snooze" },
      { keys: ["p"], label: "Toggle priority" },
      { keys: ["f"], label: "Toggle favorite" },
      { keys: ["i"], label: "Show or hide contact details" },
      { keys: ["c"], label: "Focus the composer" },
    ],
  },
  {
    title: "Composer",
    items: [
      { keys: ["Enter"], label: "Send (Shift + Enter for a new line)" },
      { keys: ["/"], label: "At the start of a reply: pick a template" },
      { keys: ["@"], label: "In a note: mention a teammate" },
    ],
  },
  {
    title: "General",
    items: [
      { keys: ["?"], label: "Show this help" },
      { keys: ["Esc"], label: "Close menus and dialogs" },
    ],
  },
];

/** Flat list kept for tests and docs generators. */
export const SHORTCUT_HELP = SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => ({ keys: i.keys.join(" + "), label: i.label })));
