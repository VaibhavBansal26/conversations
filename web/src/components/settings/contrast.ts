/** WCAG 2.x relative luminance / contrast helpers for the widget colour pickers. */
const HEX = /^#[0-9a-fA-F]{6}$/;

export const isHex = (v: string): boolean => HEX.test(v);

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  if (!isHex(a) || !isHex(b)) return 1;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** AA for normal text needs 4.5:1. */
export const passesAA = (fg: string, bg: string): boolean => contrastRatio(fg, bg) >= 4.5;

/** White or near-black, whichever reads better on the brand colour. */
export const readableOn = (bg: string): string => (contrastRatio("#ffffff", bg) >= contrastRatio("#14141a", bg) ? "#ffffff" : "#14141a");

/** Palettes the live preview uses; they mirror the CSS variables in server/public/widget.js. */
export const WIDGET_PALETTE = {
  light: { bg: "#ffffff", bg2: "#f6f6f9", fg: "#15151c", muted: "#4b4b5a", line: "#e2e2ea", inBubble: "#ffffff", bot: "#eef0ff", botLine: "#c9ceff" },
  dark: { bg: "#14141a", bg2: "#0d0d12", fg: "#ececf3", muted: "#a9a9bb", line: "#2b2b38", inBubble: "#22222c", bot: "#1f2147", botLine: "#363a7a" },
} as const;
