export interface VirtualWindow {
  start: number;
  /** exclusive */
  end: number;
  padTop: number;
  padBottom: number;
}

/** Which rows of a fixed-height list to render for the current scroll position, plus spacer heights for the rest. */
export function windowRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): VirtualWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  const start = Math.max(0, Math.min(count - 1, first) - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** New scrollTop that brings row `index` into view, or null when it already is. */
export function scrollToReveal(index: number, rowHeight: number, viewport: number, scrollTop: number): number | null {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport;
  return null;
}
