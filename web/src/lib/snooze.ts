export interface SnoozePreset {
  id: "1h" | "3h" | "tomorrow" | "next_week";
  label: string;
  until: Date;
}

const HOUR = 3_600_000;

/** Presets are always strictly in the future relative to `now`. */
export function snoozePresets(now: Date = new Date()): SnoozePreset[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  const nextWeek = new Date(now);
  const untilMonday = ((8 - nextWeek.getDay()) % 7) || 7;
  nextWeek.setDate(nextWeek.getDate() + untilMonday);
  nextWeek.setHours(9, 0, 0, 0);

  return [
    { id: "1h", label: "In 1 hour", until: new Date(now.getTime() + HOUR) },
    { id: "3h", label: "In 3 hours", until: new Date(now.getTime() + 3 * HOUR) },
    { id: "tomorrow", label: "Tomorrow, 9:00", until: tomorrow },
    { id: "next_week", label: "Next week, Mon 9:00", until: nextWeek },
  ];
}

/** The API wants an ISO timestamp with offset; "Z" satisfies that. */
export const toApiTimestamp = (d: Date): string => d.toISOString();
