import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { keys } from "../../state/keys";
import { Link } from "react-router";
import { useSmsNumbers } from "../../api/hooks";
import type { AiCallSettings, CallSettings as Settings, PhoneCallSettings, Session, Workspace } from "../../api/types";
import { useCan, useSession } from "../../auth/AuthContext";
import type { CallsConfig } from "../../calls/CallProvider";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { ErrorNotice, Field, Input, Select, Switch } from "../../ui";

const PHONE: PhoneCallSettings = { enabled: false, caller_id: null, daily_limit: 50, allowed_countries: [], max_duration_s: 1800, quiet_hours: { enabled: true, start: "21:00", end: "08:00" } };
const AI: AiCallSettings = { enabled: false, voice: true, video: true, max_duration_s: 600, idle_timeout_s: 120, max_concurrent: 3, daily_limit: 100, realtime_minutes_daily: 30, realtime_max_concurrent: 2 };
const INTERNAL = { enabled: false, voice: true, video: true, screen_share: true, ring_seconds: 30 };
const DEFAULTS: Settings = { internal: INTERNAL, browser: { enabled: false, voice: true, video: true, screen_share: true }, ai: AI, ai_engine: "browser", ring_seconds: 45, turn_provider: "none", phone: PHONE };
const TURN = {
  none: { label: "None (STUN only)", help: "Peers connect directly when their networks allow it. Calls fail for visitors behind strict firewalls, symmetric NATs and many mobile networks." },
  static: { label: "Your own TURN server", help: "The server's TURN_URLS and TURN_SECRET (for example coturn): the app hands out credentials that expire after the call. The shared secret never reaches a browser." },
  twilio: { label: "Twilio Network Traversal", help: "Uses the Twilio account connected under SMS & email: Twilio bills relayed media to that account." },
} as const;

/** Browser calls: on or off, which kinds, ring time and where relay (TURN) credentials come from. Placing calls needs the `calls:make` permission. */
export function CallSettings() {
  const { workspace } = useSession();
  const canEdit = useCan("calls:settings");
  const cur: Settings = { ...DEFAULTS, ...(workspace.settings.calls ?? {}), browser: { ...DEFAULTS.browser, ...(workspace.settings.calls?.browser ?? {}) }, ai: { ...AI, ...(workspace.settings.calls?.ai ?? {}) }, internal: { ...INTERNAL, ...(workspace.settings.calls?.internal ?? {}) }, phone: { ...PHONE, ...(workspace.settings.calls?.phone ?? {}), quiet_hours: { ...PHONE.quiet_hours, ...(workspace.settings.calls?.phone?.quiet_hours ?? {}) } } };
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: Settings) => api.patch<Workspace>("/calls/settings", body),
    onSuccess: (workspace) => qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, workspace } : s)),
  });
  const [v, setV] = useState<Settings>(cur);
  const errors = fieldErrors(save.error);
  const dirty = JSON.stringify(v) !== JSON.stringify(cur);
  const config = useQuery({ queryKey: ["calls", "config", cur.turn_provider, cur.browser.enabled, cur.ai?.enabled, cur.ai_engine, cur.phone?.enabled, cur.phone?.caller_id, cur.phone?.allowed_countries.join()], enabled: cur.browser.enabled || !!cur.phone?.enabled || !!cur.ai?.enabled || !!cur.internal?.enabled, queryFn: () => api.get<CallsConfig>("/calls/config") });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(v);
  };
  const [countries, setCountries] = useState((cur.phone?.allowed_countries ?? []).join(", "));
  const numbers = useSmsNumbers().data ?? [];
  const phone = v.phone ?? PHONE;
  const setPhone = (patch: Partial<PhoneCallSettings>) => setV({ ...v, phone: { ...phone, ...patch } });
  const internal = v.internal ?? INTERNAL;
  const setInternal = (patch: Partial<typeof INTERNAL>) => setV({ ...v, internal: { ...internal, ...patch } });
  const ai = v.ai ?? AI;
  const setAi = (patch: Partial<AiCallSettings>) => setV({ ...v, ai: { ...ai, ...patch } });
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
          <legend className="px-1 text-[13px] font-semibold">Calls between teammates</legend>
          <Switch label="Let teammates call each other" hint="A voice or video call between the two people of a direct message in team chat, from the conversation or the member list. The other person's screen rings wherever they are in the app; people who are offline, on do-not-disturb or in another call are not rung. Not recorded. Group calls are not available." checked={internal.enabled} onChange={(enabled) => setInternal({ enabled })} />
          {internal.enabled && (
            <>
              <Switch label="Voice" checked={internal.voice} onChange={(voice) => setInternal({ voice })} />
              <Switch label="Video" checked={internal.video} onChange={(video) => setInternal({ video })} />
              <Switch label="Screen sharing" checked={internal.screen_share} onChange={(screen_share) => setInternal({ screen_share })} />
              <Field label="Ring time (seconds)" hint="Then the call counts as missed and leaves a card in the conversation." error={errors["settings.calls.internal.ring_seconds"]}>
                <Input type="number" min={10} max={90} value={internal.ring_seconds} onChange={(e) => setInternal({ ring_seconds: Number(e.target.value) })} />
              </Field>
              <p className="text-xs text-subtle">Needs the "calls with teammates" permission, which the Owner, Manager and Agent roles have. Custom roles must be given it under Roles.</p>
            </>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4" disabled={!canEdit}>
          <legend className="px-1 text-[13px] font-semibold">Calls with the AI assistant</legend>
          <Switch label="Let visitors talk to the AI assistant" hint="A visitor can speak with the AI agent that answers their chat. The visitor's browser recognises the speech and speaks the answers (needs Chrome, Edge or Safari; Firefox gets the text chat). Nothing is recorded, and the AI is announced at the start. An AI agent must also be allowed the 'talk with visitors by voice or video' action under AI agents." checked={ai.enabled} onChange={(enabled) => setAi({ enabled })} />
          {ai.enabled && (
            <>
              <Switch label="Voice" checked={ai.voice} onChange={(voice) => setAi({ voice })} />
              <Switch label="Video call with an AI avatar" hint="The assistant appears as an animated face with captions. It cannot see the visitor: the visitor's camera is never sent anywhere (an optional self-view stays on their screen)." checked={ai.video} onChange={(video) => setAi({ video })} />
              <Field label="Speech engine" hint={v.ai_engine === "realtime" ? "Live voice: the visitor's browser talks to OpenAI's realtime voice service with a short-lived secret this server creates for each call. It sounds more natural, costs money per minute, and the model speaks before our checks can read what it said: a monitor ends the call and hands over to a person if it says something it must not. It falls back to the browser's voice whenever it is unavailable." : "The visitor's browser does the speech: free, nothing leaves your servers, and every answer goes through the same checks as a typed one."}>
                <Select value={v.ai_engine ?? "browser"} onValueChange={(e) => setV({ ...v, ai_engine: e as "browser" | "realtime" })} options={[{ value: "browser", label: "The visitor's browser (free)" }, { value: "realtime", label: "Live voice (OpenAI realtime, optional)" }]} />
              </Field>
              {v.ai_engine === "realtime" && config.data?.ai && !config.data.ai.realtime_available && (
                <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-text">
                  {config.data.ai.realtime_switched_off ? "Live voice is switched off for this whole installation (AI_REALTIME_ENABLED), so calls use the browser's voice." : "This installation has no OpenAI key or realtime model configured (OPENAI_API_KEY and OPENAI_REALTIME_MODEL), so calls use the browser's voice."}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Longest call (minutes)" error={errors["settings.calls.ai.max_duration_s"]}>
                  <Input type="number" min={1} max={30} value={Math.round(ai.max_duration_s / 60)} onChange={(e) => setAi({ max_duration_s: Number(e.target.value) * 60 })} />
                </Field>
                <Field label="Ends after silence (seconds)" error={errors["settings.calls.ai.idle_timeout_s"]}>
                  <Input type="number" min={30} max={600} value={ai.idle_timeout_s} onChange={(e) => setAi({ idle_timeout_s: Number(e.target.value) })} />
                </Field>
                <Field label="Calls at the same time" hint="Also limited by the plan's AI concurrency.">
                  <Input type="number" min={1} max={20} value={ai.max_concurrent} onChange={(e) => setAi({ max_concurrent: Number(e.target.value) })} />
                </Field>
                <Field label="Calls per day" hint="For the whole workspace: a spend guard.">
                  <Input type="number" min={1} max={1000} value={ai.daily_limit} onChange={(e) => setAi({ daily_limit: Number(e.target.value) })} />
                </Field>
                {v.ai_engine === "realtime" && (
                  <>
                    <Field label="Live voice minutes per day" hint="Past this, calls use the browser's voice for the rest of the (UTC) day.">
                      <Input type="number" min={1} max={1000} value={ai.realtime_minutes_daily} onChange={(e) => setAi({ realtime_minutes_daily: Number(e.target.value) })} />
                    </Field>
                    <Field label="Live voice calls at the same time">
                      <Input type="number" min={1} max={10} value={ai.realtime_max_concurrent} onChange={(e) => setAi({ realtime_max_concurrent: Number(e.target.value) })} />
                    </Field>
                  </>
                )}
              </div>
            </>
          )}
        </fieldset>
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
