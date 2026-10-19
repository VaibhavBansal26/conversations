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
