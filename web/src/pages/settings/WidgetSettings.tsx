// Adapted from the legacy UI (see docs/PROVENANCE.md): messenger customiser, availability and required-information sections.
import { AlertTriangle, Copy, Globe, Monitor, Moon, Smartphone, Sun, Volume2 } from "lucide-react";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useInboxes } from "../../api/hooks";
import { useSaveWorkspace } from "../../api/settingsHooks";
import type { WidgetSettings as Widget } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { contrastRatio, isHex, passesAA, readableOn } from "../../components/settings/contrast";
import { SaveBar } from "../../components/settings/SettingsSection";
import { WidgetPreview } from "../../components/settings/WidgetPreview";
import { Button, cn, ErrorNotice, Field, Input, Select, SegmentedList, SegmentedTrigger, Switch, Tabs, TabsContent, Textarea } from "../../ui";
import { WidgetInstall } from "./WidgetInstall";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const REQUIRED: Widget["required_info"] = ["name", "email", "phone"];
const PRESETS = ["#4f46e5", "#0f766e", "#be185d", "#c2410c", "#1d4ed8", "#111827"];
const DEFAULT_LABEL = "Chat with us";

const timezones = (): string[] => {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? ["UTC"];
};

/** Same short tone the widget plays, so agents can check the volume of what visitors hear. */
function playPreviewSound() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.value = 0.05;
    o.frequency.value = 880;
    o.start();
    o.stop(ctx.currentTime + 0.12);
  } catch {
    /* sound is optional */
  }
}

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-border bg-surface shadow-xs">
      <legend className="sr-only">{title}</legend>
      <div className="border-b border-border px-5 py-3.5" aria-hidden="true">
        <h3 className="text-[15px] font-semibold leading-tight">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      <div className="flex flex-col gap-4 px-5 py-5">{children}</div>
    </fieldset>
  );
}

/** Colour text input + native picker; only valid #rrggbb values are reported (the server rejects anything else). */
function ColorField({ label, value, onChange, presets }: { label: string; value: string; onChange: (v: string) => void; presets?: string[] }) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = isHex(text);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} value={isHex(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} className="size-9 shrink-0 cursor-pointer rounded-md border border-border-strong bg-surface p-0.5" />
        <Input
          id={id}
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-invalid={!valid || undefined}
          className="font-mono uppercase"
          onChange={(e) => {
            const v = `#${e.target.value.replace(/^#+/, "")}`;
            setText(v);
            if (isHex(v)) onChange(v.toLowerCase());
          }}
        />
      </div>
      {!valid && <p className="text-xs font-medium text-danger-text">Use a 6-digit hex colour such as #4f46e5.</p>}
      {presets && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${label} presets`}>
          {presets.map((c) => (
            <button key={c} type="button" aria-label={`Use ${c}`} onClick={() => onChange(c)} className={cn("size-6 rounded-full border-2 border-surface ring-1 ring-border-strong", value.toLowerCase() === c && "ring-2 ring-foreground")} style={{ background: c }} />
          ))}
        </div>
      )}
    </div>
  );
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[] }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium text-muted-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
            value === o.value && "bg-surface text-foreground shadow-xs",
          )}
        >
          <input type="radio" name={name} className="sr-only" checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.icon}
          {o.label}
        </label>
      ))}
    </div>
  );
}

const LAUNCHERS: { id: Widget["launcher_style"]; label: string; hint: string }[] = [
  { id: "bubble", label: "Bubble", hint: "Round icon button" },
  { id: "pill", label: "Pill", hint: "Icon and label" },
  { id: "icon", label: "Square", hint: "Rounded icon button" },
];

function WidgetCustomiser() {
  const saved = useSession().workspace.settings.widget;
  const inboxes = useInboxes().data ?? [];
  const save = useSaveWorkspace();
  const [w, setW] = useState<Widget>(saved);
  const [away, setAway] = useState(false);
  const [view, setView] = useState<"chat" | "form" | "closed">("chat");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const set = <K extends keyof Widget>(k: K, v: Widget[K]) => setW((cur) => ({ ...cur, [k]: v }));
  const dirty = JSON.stringify(w) !== JSON.stringify(saved);
  const oh = w.office_hours;
  const ratio = contrastRatio(w.text_color, w.primary_color);
  const lowContrast = !passesAA(w.text_color, w.primary_color);

  const setDay = (day: number, on: boolean) =>
    set("office_hours", { ...oh, days: on ? [...oh.days, { day, start: "09:00", end: "17:00" }].sort((a, b) => a.day - b.day) : oh.days.filter((d) => d.day !== day) });
  const setRange = (day: number, field: "start" | "end", value: string) =>
    set("office_hours", { ...oh, days: oh.days.map((d) => (d.day === day ? { ...d, [field]: value } : d)) });
  /** copy the first open day's hours to every open day (legacy "same hours" convenience) */
  const applyFirstToAll = () => {
    const first = oh.days[0];
    if (first) set("office_hours", { ...oh, days: oh.days.map((d) => ({ ...d, start: first.start, end: first.end })) });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ settings: { widget: { ...w, logo_url: w.logo_url?.trim() || null, launcher_label: w.launcher_label.trim() || DEFAULT_LABEL } } });
  };

  return (
    // container query: side by side only when the content area itself is wide enough (the settings navigation takes 256 px of a 1024 px window)
    <div className="@container">
    <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_minmax(320px,440px)] @4xl:items-start">
      <form className="flex min-w-0 flex-col gap-5" onSubmit={submit} aria-label="Chat widget settings">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Chat widget</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Customise what visitors see. The preview updates as you type; nothing is saved until you press Save.</p>
        </div>

        <Card title="Appearance" description="Brand colours, shape and launcher">
          <Field label="Title">
            <Input value={w.title} maxLength={80} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Intro text" hint={`${240 - w.intro.length} characters left`}>
            <Textarea rows={2} maxLength={240} value={w.intro} onChange={(e) => set("intro", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField label="Brand colour" value={w.primary_color} presets={PRESETS} onChange={(v) => set("primary_color", v)} />
            <ColorField label="Text colour" value={w.text_color} presets={["#ffffff", "#14141a"]} onChange={(v) => set("text_color", v)} />
          </div>
          {lowContrast && isHex(w.primary_color) && isHex(w.text_color) && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-border bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                Low contrast: the text colour on the brand colour is {ratio.toFixed(1)}:1; accessible text needs at least 4.5:1.
              </span>
              <Button variant="outline" size="sm" onClick={() => set("text_color", readableOn(w.primary_color))}>
                Fix automatically
              </Button>
            </div>
          )}
          <Field label="Logo URL" hint="Optional. Use an https image URL; it shows in the widget header.">
            <Input type="url" value={w.logo_url ?? ""} placeholder="https://" onChange={(e) => set("logo_url", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="radius" className="flex items-center justify-between text-[13px] font-medium">
                Corner radius <span className="tabular-nums text-subtle">{w.radius}px</span>
              </label>
              <input id="radius" type="range" min={0} max={24} step={1} value={w.radius} onChange={(e) => set("radius", Number(e.target.value))} className="h-9 w-full accent-primary" />
            </div>
            <Field label="Launcher spacing (px)" hint="Distance from the page edge.">
              <Input type="number" min={0} max={200} value={w.launcher_spacing} onChange={(e) => set("launcher_spacing", Math.max(0, Math.min(200, Number(e.target.value))))} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Launcher style</legend>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Launcher style">
              {LAUNCHERS.map((l) => (
                <label
                  key={l.id}
                  className={cn(
                    "flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                    w.launcher_style === l.id ? "border-primary bg-primary-soft" : "border-border hover:bg-surface-2",
                  )}
                >
                  <input type="radio" name="launcher-style" className="sr-only" checked={w.launcher_style === l.id} onChange={() => set("launcher_style", l.id)} />
                  <span className={cn("flex h-9 items-center justify-center gap-1 bg-[var(--sw)] px-2 text-[11px] font-semibold text-[var(--sw-fg)]", l.id === "bubble" && "w-9 rounded-full", l.id === "pill" && "rounded-full px-3", l.id === "icon" && "w-9 rounded-lg")} style={{ "--sw": w.primary_color, "--sw-fg": w.text_color } as React.CSSProperties} aria-hidden="true">
                    <span className="size-3.5 rounded-sm bg-[var(--sw-fg)] opacity-90" />
                    {l.id === "pill" && "Chat"}
                  </span>
                  <span>
                    <strong className="block text-[13px]">{l.label}</strong>
                    <span className="text-xs text-muted-foreground">{l.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {w.launcher_style === "pill" && (
            <Field label="Launcher label" hint="Shown next to the icon on the pill launcher (24 characters max).">
              <Input value={w.launcher_label} maxLength={24} onChange={(e) => set("launcher_label", e.target.value)} />
            </Field>
          )}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Launcher position</span>
              <Segmented label="Launcher position" value={w.launcher_position} onChange={(v) => set("launcher_position", v)} options={[{ value: "right", label: "Bottom right" }, { value: "left", label: "Bottom left" }]} />
            </div>
            <div className="flex items-center gap-2">
              <Switch label="Notification sound" checked={w.sound} onChange={(v) => set("sound", v)} />
              <Button variant="outline" size="icon-sm" aria-label="Play sound" disabled={!w.sound} onClick={playPreviewSound}>
                <Volume2 aria-hidden="true" />
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Messages" description="Posted automatically to new conversations">
          <Field label="Welcome message" hint={`${500 - w.welcome_message.length} characters left`}>
            <Textarea rows={2} maxLength={500} value={w.welcome_message} onChange={(e) => set("welcome_message", e.target.value)} />
          </Field>
          <Field label="Away message" hint="Shown outside office hours.">
            <Textarea rows={2} maxLength={500} value={w.away_message} onChange={(e) => set("away_message", e.target.value)} />
          </Field>
        </Card>

        <Card title="Visitor details" description="What the widget asks before the chat starts">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Required information">
            {REQUIRED.map((f) => {
              const on = w.required_info.includes(f);
              return (
                <label key={f} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm", on ? "border-primary bg-primary-soft" : "border-border bg-surface hover:bg-surface-2")}>
                  <input type="checkbox" className="size-4 accent-primary" checked={on} onChange={(e) => set("required_info", e.target.checked ? [...w.required_info, f] : w.required_info.filter((x) => x !== f))} />
                  Ask for {f}
                </label>
              );
            })}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Chat type" hint={w.chat_type === "sms" ? "Visitors are asked for a phone number and replies also go by text." : undefined}>
              <Select value={w.chat_type} onValueChange={(v) => set("chat_type", v as Widget["chat_type"])} options={[{ value: "live_chat", label: "Live chat" }, { value: "sms", label: "Text message (SMS)" }]} />
            </Field>
            <Field label="Route new chats to">
              <Select value={w.default_inbox_id ?? ""} onValueChange={(v) => set("default_inbox_id", v || null)} options={[{ value: "", label: "Default inbox" }, ...inboxes.map((i) => ({ value: i.id, label: i.name }))]} />
            </Field>
          </div>
        </Card>

        <Card title="Office hours" description="Outside these hours visitors get the away message">
          <Switch label="Enable office hours" hint="Visitors are told when the team is back." checked={oh.enabled} onChange={(v) => set("office_hours", { ...oh, enabled: v })} />
          {oh.enabled && (
            <>
              <Field label="Timezone">
                <div className="flex gap-2">
                  <Input list="tz-list" value={oh.timezone} onChange={(e) => set("office_hours", { ...oh, timezone: e.target.value })} />
                  <Button variant="outline" aria-label="Use this browser's timezone" onClick={() => set("office_hours", { ...oh, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })}>
                    <Globe aria-hidden="true" /> Use mine
                  </Button>
                </div>
              </Field>
              <datalist id="tz-list">
                {timezones().map((tz) => (
                  <option key={tz} value={tz} />
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
                          <span aria-hidden="true" className="text-subtle">to</span>
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
        </Card>

        {save.isError && <ErrorNotice error={save.error} />}
        <div className="-mx-4 md:-mx-8 @4xl:mx-0">
          <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty && isHex(w.primary_color) && isHex(w.text_color)} onReset={() => setW(saved)} />
        </div>
      </form>

      <aside className="flex flex-col gap-3 @4xl:sticky @4xl:top-4" aria-label="Preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold">Preview</h3>
          <Switch label="Away state" checked={away} onChange={setAway} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Preview screen"
            value={view}
            onChange={setView}
            options={[
              { value: "chat", label: "Chat" },
              { value: "form", label: "Pre-chat" },
              { value: "closed", label: "Closed" },
            ]}
          />
          <Segmented label="Preview colour scheme" value={theme} onChange={setTheme} options={[{ value: "light", label: "Light", icon: <Sun className="size-3.5" aria-hidden="true" /> }, { value: "dark", label: "Dark", icon: <Moon className="size-3.5" aria-hidden="true" /> }]} />
          <Segmented label="Preview device" value={device} onChange={setDevice} options={[{ value: "desktop", label: "Desktop", icon: <Monitor className="size-3.5" aria-hidden="true" /> }, { value: "mobile", label: "Phone", icon: <Smartphone className="size-3.5" aria-hidden="true" /> }]} />
        </div>
        <WidgetPreview settings={w} away={away} view={view} theme={theme} device={device} />
        <p className="text-xs text-subtle">Visitors see the dark look when their device is set to dark mode. The preview mirrors the live widget.</p>
      </aside>
    </div>
    </div>
  );
}

/** Settings > Chat widget: install it (embed token, snippet per platform, live check, preview) or customise how it looks. `?tab=install` opens the first. */
export function WidgetSettings() {
  const [tab, setTab] = useState<"install" | "customise">(() => (new URLSearchParams(window.location.search).get("tab") === "install" ? "install" : "customise"));
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "install" | "customise")}>
      <SegmentedList aria-label="Chat widget" className="mb-5">
        <SegmentedTrigger value="install">Install</SegmentedTrigger>
        <SegmentedTrigger value="customise">Customise</SegmentedTrigger>
      </SegmentedList>
      <TabsContent value="install">
        <WidgetInstall />
      </TabsContent>
      <TabsContent value="customise">
        <WidgetCustomiser />
      </TabsContent>
    </Tabs>
  );
}
