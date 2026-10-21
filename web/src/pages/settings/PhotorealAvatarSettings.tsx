import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, PlugZap, Trash2, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { Session, Workspace } from "../../api/types";
import { useCan } from "../../auth/AuthContext";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { keys } from "../../state/keys";
import { Badge, Button, ErrorNotice, Field, Input, Select, Skeleton, Switch, toast } from "../../ui";

interface AvatarStatus {
  provider: "did" | null;
  connection: { source: "workspace" | "instance"; status: "pending" | "connected" | "failing"; key_hint: string | null; last_error: string | null; last_checked_at: string | null } | null;
  state: "not_connected" | "pending" | "failing" | "connected_off" | "on" | "switched_off_on_server";
  kill_switch: boolean;
  settings: { enabled: boolean; minutes_daily: number; max_concurrent: number };
  usage_today: { minutes: number; limit_minutes: number; estimated_cost_usd: number | null };
  avatars: { id: string; name: string; source: "presenter" | "image"; presenter_id: string | null; image_url: string | null; voice_provider: string | null; voice_id: string | null; prepared: boolean; consent_at: string | null }[];
  agents: { id: string; name: string; avatar_id: string | null }[];
}
const CHIP: Record<AvatarStatus["state"], { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  not_connected: { label: "Not connected", tone: "neutral" },
  pending: { label: "Key saved, not tested", tone: "info" },
  failing: { label: "Failing: using the built-in face", tone: "danger" },
  connected_off: { label: "Connected, switched off", tone: "warning" },
  on: { label: "Connected and on", tone: "success" },
  switched_off_on_server: { label: "Switched off on this server", tone: "warning" },
};
const VOICES = [
  { value: "", label: "The avatar's own voice" },
  { value: "microsoft", label: "Microsoft (Azure) voice" },
  { value: "elevenlabs", label: "ElevenLabs voice" },
];

/**
 * Settings > Calls > Photoreal avatar (ADR 0039). Optional: the built-in face is the default and stays in use until a key is connected AND the switch
 * is on, and whenever anything fails. The key field is write-only: the server never sends the key back.
 */
export function PhotorealAvatarSettings() {
  const canEdit = useCan("calls:settings");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["calls", "avatar"], enabled: canEdit, queryFn: () => api.get<AvatarStatus>("/calls/avatar") });
  const set = (s: AvatarStatus) => qc.setQueryData(["calls", "avatar"], s);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["calls", "avatar"] });
  const [provider, setProvider] = useState<"none" | "did">("did");
  const [key, setKey] = useState("");
  const [form, setForm] = useState({ name: "", source: "presenter" as "presenter" | "image", presenter_id: "", image_url: "", voice_provider: "", voice_id: "", consent: false });
  const [limits, setLimits] = useState<{ minutes_daily: number; max_concurrent: number } | null>(null);

  const connect = useMutation({ mutationFn: () => api.put<AvatarStatus>("/calls/avatar/connection", { provider: "did", api_key: key }), onSuccess: (s) => (setKey(""), set(s), test.mutate()) });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; credits_remaining?: number | null; error?: string; status: AvatarStatus }>("/calls/avatar/connection/test"),
    onSuccess: (r) => {
      set(r.status);
      toast(r.ok ? { title: "Connection works", description: r.credits_remaining != null ? `D-ID says ${r.credits_remaining} credits remain.` : undefined, tone: "success" } : { title: "The provider refused", description: r.error, tone: "error" });
    },
  });
  const disconnect = useMutation({ mutationFn: () => api.delete<AvatarStatus>("/calls/avatar/connection"), onSuccess: (s) => (set(s), toast({ title: "Disconnected: the key was deleted", tone: "success" })) });
  const saveSettings = useMutation({
    mutationFn: (avatar: Partial<AvatarStatus["settings"]>) => api.patch<Workspace>("/calls/settings", { avatar }),
    onSuccess: (w) => (qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, workspace: w } : s)), refresh(), setLimits(null)),
  });
  const addAvatar = useMutation({
    mutationFn: () =>
      api.post("/calls/avatar/avatars", {
        name: form.name,
        source: form.source,
        ...(form.source === "presenter" ? { presenter_id: form.presenter_id } : { image_url: form.image_url, consent: form.consent }),
        ...(form.voice_provider ? { voice_provider: form.voice_provider, voice_id: form.voice_id || undefined } : {}),
      }),
    onSuccess: () => (setForm({ name: "", source: "presenter", presenter_id: "", image_url: "", voice_provider: "", voice_id: "", consent: false }), refresh()),
  });
  const removeAvatar = useMutation({ mutationFn: (id: string) => api.delete(`/calls/avatar/avatars/${id}`), onSuccess: refresh });
  const assign = useMutation({ mutationFn: ({ agent, avatar }: { agent: string; avatar: string | null }) => api.put(`/agents/${agent}/photoreal-avatar`, { avatar_id: avatar }), onSuccess: refresh });

  if (!canEdit) return null;
  const s = q.data;
  const chip = s ? CHIP[s.state] : null;
  const lim = limits ?? s?.settings ?? { minutes_daily: 10, max_concurrent: 1 };
  const connected = !!s?.connection;
  const workspaceKey = s?.connection?.source === "workspace";

  return (
    <SettingsSection
      title="Photoreal avatar"
      description="Optional. A hosted service can show the AI assistant as a realistic talking video in AI video calls. Until you connect a key and switch it on, and whenever anything fails, calls show the built-in face (the agent's photo or the drawn face)."
      actions={chip ? <Badge tone={chip.tone}>{chip.label}</Badge> : undefined}
    >
      {q.isPending && <Skeleton className="h-32" />}
      {q.isError && <ErrorNotice error={q.error} />}
      {s && (
        <div className="flex max-w-xl flex-col gap-5">
          {s.kill_switch && <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-text">The server operator switched photoreal avatars off (AVATAR_PHOTOREAL_ENABLED). Calls use the built-in face.</p>}
          <Field label="Provider" hint="D-ID is the provider this app supports. None keeps the built-in face.">
            <Select value={connected ? "did" : provider} disabled={connected} onValueChange={(v) => setProvider(v as "none" | "did")} options={[{ value: "none", label: "None (built-in face)" }, { value: "did", label: "D-ID" }]} />
          </Field>
          {(connected || provider === "did") && (
            <>
              <details className="rounded-lg border border-border p-3 text-[13px]" open={!connected}>
                <summary className="cursor-pointer font-medium">How to set it up</summary>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted-foreground">
                  <li>
                    Create an account at D-ID (<a className="inline-flex items-center gap-1 underline" href="https://studio.d-id.com" target="_blank" rel="noreferrer noopener">studio.d-id.com <ExternalLink className="size-3" aria-hidden="true" /></a>). Streaming uses your D-ID credits.
                  </li>
                  <li>In D-ID Studio, open the API key page and create a key. It is shown once, as <code>username:password</code>: copy all of it.</li>
                  <li>Paste it below, press Save key: it is tested at once with a call that only reads your credit balance.</li>
                  <li>Add an avatar: a D-ID stock presenter id (from D-ID's presenter list), or the https address of a photo.</li>
                  <li>Choose which AI agent uses it, then switch photoreal on. Start with a low minutes limit while you try it.</li>
                </ol>
              </details>
              <form
                className="flex flex-col gap-2"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  if (key.trim()) connect.mutate();
                }}
              >
                <Field label="D-ID API key" hint={workspaceKey ? `Connected, ends ${s.connection!.key_hint}. Enter a new key to replace it.` : s.connection?.source === "instance" ? "This server provides a key. Enter your own to use your D-ID account instead." : "Stored encrypted. It is never shown again, and never sent to visitors' browsers."}>
                  <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={workspaceKey ? "••••••••" : "username:password"} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={!key.trim()} loading={connect.isPending}>
                    <KeyRound /> Save key
                  </Button>
                  {connected && (
                    <Button type="button" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
                      <PlugZap /> Test connection
                    </Button>
                  )}
                  {workspaceKey && (
                    <Button type="button" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
                      <Trash2 /> Disconnect
                    </Button>
                  )}
                </div>
                {s.connection?.last_error && <p className="text-[13px] text-danger-text">Last test: {s.connection.last_error}</p>}
                {connect.isError && <ErrorNotice error={connect.error} />}
              </form>

              {connected && (
                <>
                  <section aria-label="Avatars" className="flex flex-col gap-3">
                    <h3 className="text-[13px] font-semibold">Avatars</h3>
                    {s.avatars.length === 0 && <p className="text-[13px] text-muted-foreground">No avatar yet.</p>}
                    <ul className="flex flex-col gap-2">
                      {s.avatars.map((a) => (
                        <li key={a.id} className="flex items-center gap-3 rounded-lg border border-border p-2.5 text-sm">
                          <UserRound className="size-4 text-subtle" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">
                            <strong className="font-medium">{a.name}</strong> <span className="text-xs text-subtle">{a.source === "presenter" ? `presenter ${a.presenter_id}` : "photo, consent recorded"}</span>
                          </span>
                          <Button size="sm" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => removeAvatar.mutate(a.id)}>
                            <Trash2 />
                          </Button>
                        </li>
                      ))}
                    </ul>
                    <form
                      className="flex flex-col gap-3 rounded-lg border border-dashed border-border p-3"
                      onSubmit={(e: FormEvent) => {
                        e.preventDefault();
                        addAvatar.mutate();
                      }}
                    >
                      <Field label="Name">
                        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} placeholder="Amy" />
                      </Field>
                      <Field label="Source">
                        <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v as "presenter" | "image" })} options={[{ value: "presenter", label: "A D-ID stock presenter" }, { value: "image", label: "A photo (https address)" }]} />
                      </Field>
                      {form.source === "presenter" ? (
                        <Field label="Presenter id" hint="From D-ID's list of presenters.">
                          <Input value={form.presenter_id} onChange={(e) => setForm({ ...form, presenter_id: e.target.value })} />
                        </Field>
                      ) : (
                        <>
                          <Field label="Photo address" hint="A clear, front-facing photo at an https address D-ID can download.">
                            <Input type="url" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="https://" />
                          </Field>
                          <label className="flex items-start gap-2 text-[13px]">
                            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
                            <span>
                              I have the right to use this photo, and the person in it has agreed to be shown as an AI assistant. D-ID's own terms and consent rules for real people apply as well. The video always says it is an AI.
                            </span>
                          </label>
                        </>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Voice">
                          <Select value={form.voice_provider} onValueChange={(v) => setForm({ ...form, voice_provider: v })} options={VOICES} />
                        </Field>
                        {form.voice_provider && (
                          <Field label="Voice id" hint="For example en-US-JennyNeural.">
                            <Input value={form.voice_id} onChange={(e) => setForm({ ...form, voice_id: e.target.value })} />
                          </Field>
                        )}
                      </div>
                      <Button type="submit" variant="outline" className="self-start" disabled={!form.name.trim() || (form.source === "presenter" ? !form.presenter_id.trim() : !form.image_url.trim() || !form.consent)} loading={addAvatar.isPending}>
                        Add avatar
                      </Button>
                      {addAvatar.isError && <ErrorNotice error={addAvatar.error} />}
                    </form>
                  </section>

                  {s.agents.length > 0 && (
                    <section aria-label="Which agent uses which avatar" className="flex flex-col gap-2">
                      <h3 className="text-[13px] font-semibold">Which agent uses which avatar</h3>
                      {s.agents.map((a) => (
                        <Field key={a.id} label={a.name}>
                          <Select value={a.avatar_id ?? ""} onValueChange={(v) => assign.mutate({ agent: a.id, avatar: v || null })} options={[{ value: "", label: "Built-in face" }, ...s.avatars.map((x) => ({ value: x.id, label: x.name }))]} />
                        </Field>
                      ))}
                    </section>
                  )}

                  <Switch label="Use the photoreal avatar in AI video calls" hint="Only video calls with the AI, only with the browser voice engine. The visitor's camera is never sent. The AI label and the 'not a real person' notice stay on the video." checked={s.settings.enabled} onChange={(enabled) => saveSettings.mutate({ enabled })} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Minutes per day" hint={`Today: ${s.usage_today.minutes} of ${s.usage_today.limit_minutes}${s.usage_today.estimated_cost_usd != null ? `, about $${s.usage_today.estimated_cost_usd}` : ""}. Then calls use the built-in face.`}>
                      <Input type="number" min={1} max={600} value={lim.minutes_daily} onChange={(e) => setLimits({ ...lim, minutes_daily: Number(e.target.value) })} />
                    </Field>
                    <Field label="At the same time" hint="Photoreal calls running at once.">
                      <Input type="number" min={1} max={5} value={lim.max_concurrent} onChange={(e) => setLimits({ ...lim, max_concurrent: Number(e.target.value) })} />
                    </Field>
                  </div>
                  {limits && (
                    <Button variant="outline" className="self-start" loading={saveSettings.isPending} onClick={() => saveSettings.mutate(limits)}>
                      Save limits
                    </Button>
                  )}
                  {saveSettings.isError && <ErrorNotice error={saveSettings.error} />}
                </>
              )}
            </>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
