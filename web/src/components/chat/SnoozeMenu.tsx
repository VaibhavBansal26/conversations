import { AlarmClock } from "lucide-react";
import { useState } from "react";
import { snoozePresets, toApiTimestamp } from "../../lib/snooze";
import { toLocalInput } from "../../lib/time";
import { Button, cn, Field, Input, Popover, Tooltip } from "../../ui";

interface Props {
  snoozed: boolean;
  onSnooze: (until: string | null) => void;
  now?: () => Date;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SnoozeMenu({ snoozed, onSnooze, now = () => new Date(), open, onOpenChange }: Props) {
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");

  const applyCustom = (close: () => void) => {
    const when = new Date(custom);
    if (!custom || Number.isNaN(when.getTime()) || when.getTime() <= now().getTime()) {
      setError("Pick a date and time in the future.");
      return;
    }
    onSnooze(toApiTimestamp(when));
    close();
  };

  return (
    <Popover
      label="Snooze conversation"
      trigger={
        <Tooltip content="Snooze" shortcut="s">
          <span className="grid size-9 place-items-center">
            <AlarmClock className="size-[18px]" aria-hidden="true" />
          </span>
        </Tooltip>
      }
      triggerClassName={cn("grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground", snoozed && "bg-primary-soft text-primary-text")}
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      panelClassName="w-72 p-2"
    >
      {(close) => (
        <div className="flex flex-col gap-0.5">
          <h3 className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-subtle">Snooze until</h3>
          {snoozePresets(now()).map((p) => (
            <button
              key={p.id}
              type="button"
              className="flex items-center rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-2"
              onClick={() => {
                onSnooze(toApiTimestamp(p.until));
                close();
              }}
            >
              {p.label}
            </button>
          ))}
          <div className="mt-1 space-y-2 border-t border-border px-2 pb-1 pt-3">
            <Field label="Custom date and time" error={error || undefined}>
              <Input
                type="datetime-local"
                min={toLocalInput(now())}
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setError("");
                }}
              />
            </Field>
            <Button size="sm" className="w-full" onClick={() => applyCustom(close)}>
              Snooze
            </Button>
          </div>
          {snoozed && (
            <button
              type="button"
              className="mt-1 rounded-md px-2.5 py-2 text-left text-sm font-medium text-danger-text hover:bg-danger-soft"
              onClick={() => {
                onSnooze(null);
                close();
              }}
            >
              Remove snooze
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
