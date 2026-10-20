import type { OfficeHours } from "../domain/settings.js";
import { zonedParts } from "../util/time.js";

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Disabled office hours mean "always open". */
export function isOpen(oh: OfficeHours, at: Date): boolean {
  if (!oh.enabled) return true;
  const { day, minutes } = zonedParts(at, oh.timezone);
  return oh.days.some((d) => d.day === day && minutes >= toMin(d.start) && minutes < toMin(d.end));
}

/** Human text such as "tomorrow at 09:00" or "Monday at 09:00", or null when no opening exists. */
export function nextOpening(oh: OfficeHours, at: Date): string | null {
  const { day, minutes } = zonedParts(at, oh.timezone);
  for (let offset = 0; offset <= 7; offset++) {
    const d = (day + offset) % 7;
    const starts = oh.days
      .filter((x) => x.day === d && (offset > 0 || toMin(x.start) > minutes))
      .map((x) => x.start)
      .sort();
    if (starts.length) return `${offset === 0 ? "today" : offset === 1 ? "tomorrow" : DAYS[d]} at ${starts[0]} (${oh.timezone})`;
  }
  return null;
}

/** UTC instant of local wall-clock `y-m-d hh:mm` in `timeZone` (DST aware; iterates once to settle the offset). */
function zonedToUtc(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  } catch {
    return guess;
  }
  const offsetAt = (utc: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - utc;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/**
 * Seconds between two instants that fall inside office hours (the workspace's weekly schedule in its timezone). With office hours disabled the
 * whole interval counts (calendar time). Used for first-response and resolution times so nights and weekends do not inflate them.
 */
export function businessSeconds(oh: OfficeHours, from: Date, to: Date): number {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return 0;
  if (!oh.enabled) return Math.round((b - a) / 1000);
  let total = 0;
  // walk local calendar days; bounded so a corrupt timestamp cannot spin forever
  const start = zonedLocalDate(a, oh.timezone);
  const endDay = zonedLocalDate(b, oh.timezone);
  let day = new Date(Date.UTC(start.y, start.m - 1, start.d));
  const last = Date.UTC(endDay.y, endDay.m - 1, endDay.d);
  for (let i = 0; day.getTime() <= last && i < 800; i++, day = new Date(day.getTime() + 86400_000)) {
    const dow = day.getUTCDay();
    for (const w of oh.days.filter((x) => x.day === dow)) {
      const ws = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), toMin(w.start), oh.timezone);
      const we = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), toMin(w.end), oh.timezone);
      total += Math.max(0, Math.min(b, we) - Math.max(a, ws));
    }
  }
  return Math.round(total / 1000);
}

function zonedLocalDate(ms: number, timeZone: string): { y: number; m: number; d: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day! };
}
