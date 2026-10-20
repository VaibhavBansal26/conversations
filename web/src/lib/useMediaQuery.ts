import { useSyncExternalStore } from "react";

/** Subscribes to a CSS media query; falls back to `fallback` where matchMedia is unavailable (jsdom). */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia?.(query);
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    () => window.matchMedia?.(query).matches ?? fallback,
    () => fallback,
  );
}

/** Tailwind's default breakpoints, so JS layout decisions match the CSS ones. */
export const BREAKPOINT = { md: "(min-width: 768px)", lg: "(min-width: 1024px)", xl: "(min-width: 1280px)", "2xl": "(min-width: 1536px)" } as const;
