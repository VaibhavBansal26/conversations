import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { keys } from "../../state/keys";
import { Link } from "react-router";
import { useSmsNumbers } from "../../api/hooks";
import type { CallSettings as Settings, PhoneCallSettings, Session, Workspace } from "../../api/types";
import { useCan, useSession } from "../../auth/AuthContext";
import type { CallsConfig } from "../../calls/CallProvider";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { ErrorNotice, Field, Input, Select, Switch } from "../../ui";

const PHONE: PhoneCallSettings = { enabled: false, caller_id: null, daily_limit: 50, allowed_countries: [], max_duration_s: 1800, quiet_hours: { enabled: true, start: "21:00", end: "08:00" } };
const DEFAULTS: Settings = { browser: { enabled: false, voice: true, video: true, screen_share: true }, ring_seconds: 45, turn_provider: "none", phone: PHONE };
const TURN = {
  none: { label: "None (STUN only)", help: "Peers connect directly when their networks allow it. Calls fail for visitors behind strict firewalls, symmetric NATs and many mobile networks." },
  static: { label: "Your own TURN server", help: "The server's TURN_URLS and TURN_SECRET (for example coturn): the app hands out credentials that expire after the call. The shared secret never reaches a browser." },
  twilio: { label: "Twilio Network Traversal", help: "Uses the Twilio account connected under SMS & email: Twilio bills relayed media to that account." },
} as const;

/** Browser calls: on or off, which kinds, ring time and where relay (TURN) credentials come from. Placing calls needs the `calls:make` permission. */
export function CallSettings() {
  const { workspace } = useSession();
  const canEdit = useCan("calls:settings");
  const cur: Settings = { ...DEFAULTS, ...(workspace.settings.calls ?? {}), browser: { ...DEFAULTS.browser, ...(workspace.settings.calls?.browser ?? {}) }, phone: { ...PHONE, ...(workspace.settings.calls?.phone ?? {}), quiet_hours: { ...PHONE.quiet_hours, ...(workspace.settings.calls?.phone?.quiet_hours ?? {}) } } };
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: Settings) => api.patch<Workspace>("/calls/settings", body),
    onSuccess: (workspace) => qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, workspace } : s)),
  });
  const [v, setV] = useState<Settings>(cur);
  const errors = fieldErrors(save.error);
  const dirty = JSON.stringify(v) !== JSON.stringify(cur);
  const config = useQuery({ queryKey: ["calls", "config", cur.turn_provider, cur.browser.enabled, cur.phone?.enabled, cur.phone?.caller_id, cur.phone?.allowed_countries.join()], enabled: cur.browser.enabled || !!cur.phone?.enabled, queryFn: () => api.get<CallsConfig>("/calls/config") });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(v);
  };
  const [countries, setCountries] = useState((cur.phone?.allowed_countries ?? []).join(", "));
  const numbers = useSmsNumbers().data ?? [];
  const phone = v.phone ?? PHONE;
  const setPhone = (patch: Partial<PhoneCallSettings>) => setV({ ...v, phone: { ...phone, ...patch } });
  const set = (patch: Partial<Settings["browser"]>) => setV({ ...v, browser: { ...v.browser, ...patch } });
  return (
    <SettingsSection title="Calls" description="Voice and video calls between your team and a visitor, in the browser. They are off until you switch them on. Calls are not recorded.">
      {!canEdit && <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted-foreground">You can see these settings; changing them needs the call settings permission.</p>}
      <form className="flex max-w-xl flex-col gap-4" onSubmit={submit}>
        <fieldset className="flex flex-col" disabled={!canEdit}>
          <Switch label="Browser calls" hint="Team members with the call permission see Voice and Video buttons in a conversation. Visitors can ask for a call from the chat." checked={v.browser.enabled} onChange={(enabled) => set({ enabled })} />
          {v.browser.enabled && (
            <>
              <Switch label="Voice calls" checked={v.browser.voice} onChange={(voice) => set({ voice })} />
              <Switch label="Video calls" checked={v.browser.video} onChange={(video) => set({ video })} />
              <Switch label="Screen sharing" hint="Either side can share a screen during a video call." checked={v.browser.screen_share} onChange={(screen_share) => set({ screen_share })} />
            </>
          )}
        </fieldset>
        <Field label="Ring time (seconds)" hint="A call nobody answers within this time counts as missed and offers the visitor a callback form." error={errors["settings.calls.ring_seconds"]}>
          <Input type="number" min={15} max={120} value={v.ring_seconds} disabled={!canEdit} onChange={(e) => setV({ ...v, ring_seconds: Number(e.target.value) })} />
        </Field>
        <Field label="Relay (TURN) for hard networks" hint={TURN[v.turn_provider].help}>
          <Select value={v.turn_provider} disabled={!canEdit} onValueChange={(p) => setV({ ...v, turn_provider: p as Settings["turn_provider"] })} options={(Object.keys(TURN) as (keyof typeof TURN)[]).map((k) => ({ value: k, label: TURN[k].label }))} />
        </Field>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4" disabled={!canEdit}>
          <legend className="px-1 text-[13px] font-semibold">Phone calls</legend>
          <Switch label="Phone calls (click-to-call)" hint="A team member's phone rings first through your own Twilio account, then the contact's. Only contacts who agreed to be called on their number are called. Not recorded." checked={phone.enabled} onChange={(enabled) => setPhone({ enabled })} />
          {phone.enabled && (
            <>
              {config.data?.phone && config.data.phone.problems.length > 0 && (
                <ul role="status" className="list-disc rounded-md bg-warning-soft py-2 pl-7 pr-3 text-sm text-warning-text">
                  {config.data.phone.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <Field label="Caller ID" hint={numbers.length ? "Shown to the contact. One of your imported Twilio numbers." : "Import your Twilio numbers first, under SMS & email."} error={errors["settings.calls.phone.caller_id"]}>
                <Select value={phone.caller_id ?? ""} onValueChange={(n) => setPhone({ caller_id: n || null })} placeholder="Choose a number" options={numbers.map((n) => ({ value: n.e164, label: n.e164 }))} />
              </Field>
              <Field label="Countries that may be called" hint="Two-letter codes, comma separated, for example US, CA, GB. Nothing is called outside this list; premium-rate numbers are never called.">
                <Input value={countries} onChange={(e) => (setCountries(e.target.value), setPhone({ allowed_countries: e.target.value.split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean) }))} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Calls per day" hint="For the whole workspace. A spend guard." error={errors["settings.calls.phone.daily_limit"]}>
                  <Input type="number" min={1} max={1000} value={phone.daily_limit} onChange={(e) => setPhone({ daily_limit: Number(e.target.value) })} />
                </Field>
                <Field label="Longest call (minutes)" error={errors["settings.calls.phone.max_duration_s"]}>
                  <Input type="number" min={1} max={120} value={Math.round(phone.max_duration_s / 60)} onChange={(e) => setPhone({ max_duration_s: Number(e.target.value) * 60 })} />
                </Field>
              </div>
              <Switch label="No calls at night" hint="In the contact's time zone (their browser's, else your office-hours zone)." checked={phone.quiet_hours.enabled} onChange={(enabled) => setPhone({ quiet_hours: { ...phone.quiet_hours, enabled } })} />
              {phone.quiet_hours.enabled && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Night starts">
                    <Input type="time" value={phone.quiet_hours.start} onChange={(e) => setPhone({ quiet_hours: { ...phone.quiet_hours, start: e.target.value } })} />
                  </Field>
                  <Field label="Night ends">
                    <Input type="time" value={phone.quiet_hours.end} onChange={(e) => setPhone({ quiet_hours: { ...phone.quiet_hours, end: e.target.value } })} />
                  </Field>
                </div>
              )}
              <p className="text-xs text-subtle">
                Needs your own verified Twilio account (<Link to="/settings/channels" className="underline">SMS &amp; email</Link>) with voice enabled on the caller ID number. Contacts who sent STOP or unsubscribed are never called.
              </p>
            </>
          )}
        </fieldset>
        {config.data?.warning && cur.browser.enabled && (
          <p role="status" className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-text">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {config.data.warning}
          </p>
        )}
        <p className="text-xs text-subtle">Calls need HTTPS (browsers only allow the microphone and camera on secure pages). A site that embeds the hosted chat in an iframe must allow it with <code>allow=&quot;microphone; camera&quot;</code>.</p>
        {save.isError && <ErrorNotice error={save.error} />}
        {canEdit && <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={() => setV(cur)} />}
      </form>
    </SettingsSection>
  );
}
