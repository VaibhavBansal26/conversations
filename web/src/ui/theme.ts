import { useCallback, useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "conv.theme";
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Applies the stored preference to <html data-theme>; "system" removes it so prefers-color-scheme decides. */
export function applyTheme(pref: ThemePref = read()): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function setTheme(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage blocked: the choice still applies for this page view */
  }
  applyTheme(pref);
  listeners.forEach((l) => l());
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => "system" as const,
  );
  return [pref, useCallback((p: ThemePref) => setTheme(p), [])];
}
