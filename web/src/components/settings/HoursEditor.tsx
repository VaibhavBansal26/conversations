import { Copy, Globe } from "lucide-react";
import { useId } from "react";
import type { OfficeHours } from "../../api/types";
import { Button, Field, Input, Switch } from "../../ui";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const timezones = (): string[] => {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? ["UTC"];
};

interface Props<T extends OfficeHours> {
  value: T;
  onChange: (next: T) => void;
  label?: string;
  hint?: string;
}

/** Weekly opening hours in a time zone: the same control for the chat widget's office hours and for a department's hours. */
export function HoursEditor<T extends OfficeHours>({ value: oh, onChange, label = "Enable opening hours", hint }: Props<T>) {
  const tz = useId();
  const setDay = (day: number, on: boolean) =>
    onChange({ ...oh, days: on ? [...oh.days, { day, start: "09:00", end: "17:00" }].sort((a, b) => a.day - b.day) : oh.days.filter((d) => d.day !== day) });
  const setRange = (day: number, field: "start" | "end", v: string) => onChange({ ...oh, days: oh.days.map((d) => (d.day === day ? { ...d, [field]: v } : d)) });
  /** copy the first open day's hours to every open day */
  const applyFirstToAll = () => {
    const first = oh.days[0];
    if (first) onChange({ ...oh, days: oh.days.map((d) => ({ ...d, start: first.start, end: first.end })) });
  };
  return (
    <>
      <Switch label={label} hint={hint} checked={oh.enabled} onChange={(v) => onChange({ ...oh, enabled: v })} />
      {oh.enabled && (
        <>
          <Field label="Timezone">
            <div className="flex gap-2">
              <Input list={tz} value={oh.timezone} onChange={(e) => onChange({ ...oh, timezone: e.target.value })} />
              <Button variant="outline" aria-label="Use this browser's timezone" onClick={() => onChange({ ...oh, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })}>
                <Globe aria-hidden="true" /> Use mine
              </Button>
            </div>
          </Field>
          <datalist id={tz}>
            {timezones().map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {DAYS.map((name, day) => {
              const range = oh.days.find((d) => d.day === day);
              return (
                <li key={day} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                  <label className="flex w-32 cursor-pointer items-center gap-2.5 text-sm font-medium">
                    <input type="checkbox" className="size-4 accent-primary" checked={!!range} onChange={(e) => setDay(day, e.target.checked)} /> {name}
                  </label>
                  {range ? (
                    <span className="flex items-center gap-2">
                      <Input type="time" className="w-28" aria-label={`${name} opens`} value={range.start} onChange={(e) => setRange(day, "start", e.target.value)} />
                      <span aria-hidden="true" className="text-subtle">
                        to
                      </span>
                      <Input type="time" className="w-28" aria-label={`${name} closes`} value={range.end} onChange={(e) => setRange(day, "end", e.target.value)} />
                    </span>
                  ) : (
                    <span className="text-[13px] text-subtle">Closed</span>
                  )}
                </li>
              );
            })}
          </ul>
          {oh.days.length > 1 && (
            <div>
              <Button variant="ghost" size="sm" onClick={applyFirstToAll}>
                <Copy aria-hidden="true" /> Use {DAYS[oh.days[0]!.day]}'s hours for every open day
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
