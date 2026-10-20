import { useState, type FormEvent } from "react";
import { useInboxes } from "../../api/hooks";
import { useSaveWorkspace } from "../../api/settingsHooks";
import type { WidgetSettings as Widget } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { WidgetPreview } from "../../components/settings/WidgetPreview";
import { ErrorNotice } from "../../ui";
import { Field } from "../../ui";
import { Switch } from "../../ui";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const REQUIRED: Widget["required_info"] = ["name", "email", "phone"];

const timezones = (): string[] => {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? ["UTC"];
};

export function WidgetSettings() {
  const saved = useSession().workspace.settings.widget;
  const inboxes = useInboxes().data ?? [];
  const save = useSaveWorkspace();
  const [w, setW] = useState<Widget>(saved);
  const [away, setAway] = useState(false);
  const set = <K extends keyof Widget>(k: K, v: Widget[K]) => setW((cur) => ({ ...cur, [k]: v }));
  const dirty = JSON.stringify(w) !== JSON.stringify(saved);
  const oh = w.office_hours;

  const setDay = (day: number, on: boolean) =>
    set("office_hours", { ...oh, days: on ? [...oh.days, { day, start: "09:00", end: "17:00" }].sort((a, b) => a.day - b.day) : oh.days.filter((d) => d.day !== day) });
  const setRange = (day: number, field: "start" | "end", value: string) =>
    set("office_hours", { ...oh, days: oh.days.map((d) => (d.day === day ? { ...d, [field]: value } : d)) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ settings: { widget: { ...w, logo_url: w.logo_url?.trim() || null } } });
  };

  return (
    <SettingsSection title="Chat widget" description="Customise what visitors see. The preview updates as you type; nothing is saved until you press Save.">
      <div className="widget-layout">
        <form className="stack" onSubmit={submit}>
          <fieldset>
            <legend>Appearance</legend>
            <Field label="Title">
              <input value={w.title} maxLength={80} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Intro text">
              <textarea rows={2} maxLength={240} value={w.intro} onChange={(e) => set("intro", e.target.value)} />
            </Field>
            <div className="grid-2">
              <Field label="Brand colour">
                <input type="color" value={w.primary_color} onChange={(e) => set("primary_color", e.target.value)} />
              </Field>
              <Field label="Text colour">
                <input type="color" value={w.text_color} onChange={(e) => set("text_color", e.target.value)} />
              </Field>
            </div>
            <Field label="Logo URL" hint="Optional. Use an https image URL.">
              <input type="url" value={w.logo_url ?? ""} placeholder="https://" onChange={(e) => set("logo_url", e.target.value)} />
            </Field>
            <div className="grid-2">
              <Field label="Launcher position">
                <select value={w.launcher_position} onChange={(e) => set("launcher_position", e.target.value as Widget["launcher_position"])}>
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </select>
              </Field>
              <Field label="Launcher spacing (px)">
                <input type="number" min={0} max={200} value={w.launcher_spacing} onChange={(e) => set("launcher_spacing", Number(e.target.value))} />
              </Field>
            </div>
            <Switch label="Notification sound" checked={w.sound} onChange={(v) => set("sound", v)} />
          </fieldset>

          <fieldset>
            <legend>Messages</legend>
            <Field label="Welcome message">
              <textarea rows={2} maxLength={500} value={w.welcome_message} onChange={(e) => set("welcome_message", e.target.value)} />
            </Field>
            <Field label="Away message" hint="Shown outside office hours.">
              <textarea rows={2} maxLength={500} value={w.away_message} onChange={(e) => set("away_message", e.target.value)} />
            </Field>
          </fieldset>

          <fieldset>
            <legend>Visitor details</legend>
            <div className="check-row" role="group" aria-label="Required information">
              {REQUIRED.map((f) => (
                <label key={f} className="check">
                  <input type="checkbox" checked={w.required_info.includes(f)} onChange={(e) => set("required_info", e.target.checked ? [...w.required_info, f] : w.required_info.filter((x) => x !== f))} />
                  Ask for {f}
                </label>
              ))}
            </div>
            <Field label="Chat type">
              <select value={w.chat_type} onChange={(e) => set("chat_type", e.target.value as Widget["chat_type"])}>
                <option value="live_chat">Live chat</option>
                <option value="sms">Text message (SMS)</option>
              </select>
            </Field>
            <Field label="Route new chats to">
              <select value={w.default_inbox_id ?? ""} onChange={(e) => set("default_inbox_id", e.target.value || null)}>
                <option value="">Default inbox</option>
                {inboxes.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>

          <fieldset>
            <legend>Office hours</legend>
            <Switch label="Enable office hours" hint="Outside these hours visitors see the away message." checked={oh.enabled} onChange={(v) => set("office_hours", { ...oh, enabled: v })} />
            {oh.enabled && (
              <>
                <Field label="Timezone">
                  <input list="tz-list" value={oh.timezone} onChange={(e) => set("office_hours", { ...oh, timezone: e.target.value })} />
                </Field>
                <datalist id="tz-list">
                  {timezones().map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
                <ul className="hours">
                  {DAYS.map((name, day) => {
                    const range = oh.days.find((d) => d.day === day);
                    return (
                      <li key={day}>
                        <label className="check">
                          <input type="checkbox" checked={!!range} onChange={(e) => setDay(day, e.target.checked)} /> {name}
                        </label>
                        {range ? (
                          <span className="row">
                            <input type="time" aria-label={`${name} opens`} value={range.start} onChange={(e) => setRange(day, "start", e.target.value)} />
                            <span aria-hidden="true">to</span>
                            <input type="time" aria-label={`${name} closes`} value={range.end} onChange={(e) => setRange(day, "end", e.target.value)} />
                          </span>
                        ) : (
                          <span className="muted">Closed</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </fieldset>

          {save.isError && <ErrorNotice error={save.error} />}
          <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={() => setW(saved)} />
        </form>

        <aside className="widget-aside" aria-label="Preview">
          <div className="row between">
            <h3>Preview</h3>
            <label className="check">
              <input type="checkbox" checked={away} onChange={(e) => setAway(e.target.checked)} /> Show away state
            </label>
          </div>
          <WidgetPreview settings={w} away={away} />
        </aside>
      </div>
    </SettingsSection>
  );
}
