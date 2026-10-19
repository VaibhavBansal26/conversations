const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact relative time for list rows: "now", "5m", "3h", "2d", then a short date. */
export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = now.getTime() - t;
  if (diff < MIN) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const formatClock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(new Date(now.getTime() - DAY).toISOString())) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
