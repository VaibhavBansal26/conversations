import { useState } from "react";
import { snoozePresets, toApiTimestamp } from "../../lib/snooze";
import { toLocalInput } from "../../lib/time";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";

interface Props {
  snoozed: boolean;
  onSnooze: (until: string | null) => void;
  now?: () => Date;
}

export function SnoozeMenu({ snoozed, onSnooze, now = () => new Date() }: Props) {
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
    <Popover label="Snooze conversation" trigger={<Icon name="clock" />} triggerClassName={`icon-btn${snoozed ? " on" : ""}`} align="end" panelClassName="snooze-panel">
      {(close) => (
        <div className="stack">
          <h3 className="panel-title">Snooze until</h3>
          {snoozePresets(now()).map((p) => (
            <button
              key={p.id}
              type="button"
              className="menu-item"
              onClick={() => {
                onSnooze(toApiTimestamp(p.until));
                close();
              }}
            >
              {p.label}
            </button>
          ))}
          <div className="custom-snooze">
            <label htmlFor="snooze-custom">Custom date and time</label>
            <input id="snooze-custom" type="datetime-local" min={toLocalInput(now())} value={custom} onChange={(e) => { setCustom(e.target.value); setError(""); }} />
            {error && <p className="field-error" role="alert">{error}</p>}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => applyCustom(close)}>
              Snooze
            </button>
          </div>
          {snoozed && (
            <button
              type="button"
              className="menu-item"
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
