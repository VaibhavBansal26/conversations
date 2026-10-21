import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Laptop, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { Session, Workspace } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { pushPermission, pushSupported, rememberDevice, subscribeThisBrowser, thisDeviceId, unsubscribeThisBrowser, type PushEvent } from "../../lib/push";
import { keys } from "../../state/keys";
import { Badge, Button, ErrorNotice, Field, Input, Skeleton, Switch, toast } from "../../ui";

interface Device {
  id: string;
  label: string;
  user_agent: string;
  push_service: string;
  events: PushEvent[];
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
  disabled: boolean;
}
interface Devices {
  data: Device[];
  config: { enabled: boolean; public_key: string | null; reason: "not_configured" | "invalid_keys" | null; previews: boolean };
}
const EVENTS: { id: PushEvent; label: string; hint: string }[] = [
  { id: "missed_call", label: "Missed calls", hint: "A teammate called you (alone or in a group call) and you did not answer." },
  { id: "assigned", label: "Assigned to you", hint: "A conversation or ticket was assigned to you, while the app is closed." },
  { id: "message", label: "Customer messages", hint: "A customer wrote in a conversation assigned to you, while the app is closed." },
];
const RESULT: Record<string, string> = { sent: "Sent. It should appear on this device in a few seconds.", gone: "This device's subscription had expired and was removed. Turn notifications on again.", failed: "The push service refused it. Turn notifications off and on again.", retry: "The push service did not answer. Try again in a minute." };
const browserName = (ua: string) => (/Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser");

/** Settings > Notifications > Push notifications: per device, per event, with a test button. Every member manages their own devices. */
export function PushSettings() {
  const qc = useQueryClient();
  const { member } = useSession();
  const manager = member.role === "owner" || member.role === "manager";
  const q = useQuery({ queryKey: ["push", "devices"], queryFn: () => api.get<Devices>("/push/subscriptions") });
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [mineId, setMineId] = useState<string | null>(thisDeviceId());
  const refresh = () => void qc.invalidateQueries({ queryKey: ["push", "devices"] });
  const patch = useMutation({ mutationFn: ({ id, events }: { id: string; events: PushEvent[] }) => api.patch(`/push/subscriptions/${id}`, { events }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (id === mineId) await unsubscribeThisBrowser();
      return api.delete(`/push/subscriptions/${id}`);
    },
    onSuccess: (_d, id) => {
      if (id === mineId) (rememberDevice(null), setMineId(null));
      refresh();
    },
  });
  const test = useMutation({ mutationFn: (id: string) => api.post<{ result: string }>(`/push/subscriptions/${id}/test`), onSuccess: (r) => (toast({ title: RESULT[r.result] ?? r.result, tone: r.result === "sent" ? "success" : "error" }), refresh()) });
  const previews = useMutation({
    mutationFn: (v: boolean) => api.patch<Workspace>("/workspace", { settings: { push_message_previews: v } }),
    onSuccess: (w) => {
      qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, workspace: w } : s));
      refresh();
    },
  });

  const cfg = q.data?.config;
  const devices = q.data?.data ?? [];
  const mine = devices.find((d) => d.id === mineId) ?? null;
  const supported = pushSupported();
  const permission = pushPermission();

  const turnOn = async () => {
    if (!cfg?.public_key) return;
    setBusy(true);
    const r = await subscribeThisBrowser(cfg.public_key);
    if (!r.ok) {
      setBusy(false);
      toast({ title: r.reason === "denied" ? "Notifications are blocked for this site" : r.reason === "unsupported" ? "This browser cannot receive push notifications" : "Could not turn notifications on", description: r.reason === "denied" ? "Allow notifications for this site in the browser's site settings, then try again." : undefined, tone: "error" });
      return;
    }
    try {
      const d = await api.post<Device>("/push/subscriptions", { subscription: r.subscription, label: label.trim() || undefined });
      rememberDevice(d.id);
      setMineId(d.id);
      toast({ title: "Notifications are on for this device", tone: "success" });
      refresh();
    } catch (e) {
      toast({ title: "Could not turn notifications on", description: e instanceof Error ? e.message : undefined, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Push notifications" description="Notifications on this computer or phone even when the app is closed. Each device is turned on separately.">
      {q.isPending && <Skeleton className="h-24" />}
      {q.isError && <ErrorNotice error={q.error} />}
      {cfg && !cfg.enabled && (
        <p role="status" className="rounded-lg border border-border bg-surface-2 p-3 text-[13px] text-muted-foreground">
          Push notifications are not set up on this server{cfg.reason === "invalid_keys" ? " (its VAPID keys are not valid)" : ""}. The person who runs it sets the VAPID keys; until then you still get in-app notifications and emails.
        </p>
      )}
      {cfg?.enabled && !supported && <p role="status" className="text-[13px] text-muted-foreground">This browser cannot receive push notifications. On iPhone and iPad, add the app to the home screen first (Safari 16.4 or later).</p>}
      {cfg?.enabled && supported && !mine && (
        <div className="flex max-w-lg flex-col gap-3">
          {permission === "denied" && <p className="text-[13px] text-warning-text">Notifications are blocked for this site. Allow them in the browser's site settings, then turn them on here.</p>}
          <Field label="Name for this device" hint="So you can tell your devices apart, for example Work laptop.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Work laptop" />
          </Field>
          <Button className="self-start" loading={busy} onClick={() => void turnOn()}>
            <BellRing /> Turn on for this device
          </Button>
        </div>
      )}
      {devices.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Your devices">
          {devices.map((d) => (
            <li key={d.id} className="rounded-lg border border-border p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <Laptop className="size-4 text-subtle" aria-hidden="true" />
                <span className="font-medium">{d.label || browserName(d.user_agent)}</span>
                {d.id === mineId && <Badge tone="primary">This device</Badge>}
                {d.disabled && <Badge tone="danger">Stopped after errors</Badge>}
                <span className="ml-auto text-xs text-subtle">
                  {browserName(d.user_agent)} via {d.push_service}
                  {d.last_success_at ? `, last delivered ${new Date(d.last_success_at).toLocaleString()}` : ""}
                </span>
              </div>
              <div className="mt-2 divide-y divide-border">
                {EVENTS.map((e) => (
                  <Switch key={e.id} label={e.label} hint={e.hint} checked={d.events.includes(e.id)} onChange={(on) => patch.mutate({ id: d.id, events: on ? [...d.events, e.id] : d.events.filter((x) => x !== e.id) })} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" loading={test.isPending && test.variables === d.id} onClick={() => test.mutate(d.id)}>
                  Send a test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(d.id)} aria-label={`Turn off notifications on ${d.label || "this device"}`}>
                  <Trash2 /> Turn off
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {cfg?.enabled && manager && (
        <Switch
          label="Show message text in notifications (whole workspace)"
          hint="Off by default: a notification then says only that a customer wrote, without their name or words, because a phone's lock screen can be seen by others."
          checked={cfg.previews}
          onChange={(v) => previews.mutate(v)}
        />
      )}
      <p className="text-xs text-subtle">Do not disturb pauses push notifications too. Missed calls are sent even when the app is open; the rest only when it is closed.</p>
    </SettingsSection>
  );
}
