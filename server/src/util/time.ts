export const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);
export const addMinutes = (d: Date, m: number): Date => addSeconds(d, m * 60);

/** Local wall-clock parts of `date` in an IANA timezone. Falls back to UTC for unknown zones. */
export function zonedParts(date: Date, timeZone: string): { day: number; minutes: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday as string);
  return { day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
