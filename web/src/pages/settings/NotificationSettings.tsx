import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import type { Availability, Member, NotificationPrefs, Session } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { toLocalInput } from "../../lib/time";
import { keys } from "../../state/keys";
import { Button, cn, ErrorNotice, Input, Switch, toast } from "../../ui";
import { PushSettings } from "./PushSettings";

const PREFS: { id: keyof NotificationPrefs; label: string; hint: string }[] = [
  { id: "assigned_to_you", label: "Assigned to you", hint: "A conversation is assigned to you." },
  { id: "assigned_to_your_team", label: "Assigned to your inbox", hint: "A conversation lands in an inbox you belong to." },
  { id: "unassigned", label: "Unassigned conversations", hint: "New conversations nobody owns yet." },
  { id: "mentions", label: "Mentions", hint: "A teammate @mentions you in a note." },
  { id: "delayed_msgs", label: "Snoozed conversations returning", hint: "A snooze ends or a customer replies to a snoozed chat." },
  { id: "email", label: "Email me about missed notifications", hint: "A digest to your inbox when you were away." },
];

const LEVELS: { id: Availability; label: string; hint: string; dot: string }[] = [
  { id: "active", label: "Available", hint: "Receive new conversations and notifications.", dot: "bg-presence-on" },
  { id: "away", label: "Away", hint: "Skipped by round-robin routing.", dot: "bg-warning-text" },
  { id: "inactive", label: "Inactive", hint: "Not receiving anything.", dot: "bg-presence-off" },
];

export function NotificationSettings() {
  const { member } = useSession();
  const qc = useQueryClient();
  const [dnd, setDnd] = useState(member.dnd_until ? toLocalInput(new Date(member.dnd_until)) : "");
  const save = useMutation({
    mutationFn: (patch: Partial<Pick<Member, "availability" | "dnd_until" | "notification_prefs">>) => api.patch<Member>("/members/me", patch),
    onSuccess: (m) => {
      qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, member: m } : s));
      toast({ title: "Preference saved", tone: "success" });
    },
  });
  const dndActive = !!member.dnd_until && new Date(member.dnd_until) > new Date();

  return (
    <>
      <SettingsSection title="Availability" description="Controls whether you are offered new conversations.">
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Availability">
          {LEVELS.map((l) => {
            const active = member.availability === l.id;
            return (
              <label
                key={l.id}
                className={cn(
                  "relative flex cursor-pointer flex-col gap-1 rounded-lg border p-3.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  active ? "border-primary bg-primary-soft" : "border-border hover:bg-surface-2",
                )}
              >
                <input type="radio" name="availability" className="sr-only" checked={active} onChange={() => save.mutate({ availability: l.id })} />
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <span className={cn("size-2.5 rounded-full", l.dot)} aria-hidden="true" />
                  {l.label}
                </span>
                <span className="text-[13px] text-muted-foreground">{l.hint}</span>
              </label>
            );
          })}
        </div>
        <div className="flex max-w-lg flex-col gap-1.5">
          <label htmlFor="dnd" className="text-[13px] font-medium">
            Do not disturb until
          </label>
          <div className="flex flex-wrap gap-2">
            <Input id="dnd" type="datetime-local" className="w-auto flex-1" value={dnd} onChange={(e) => setDnd(e.target.value)} />
            <Button variant="outline" disabled={!dnd} onClick={() => save.mutate({ dnd_until: new Date(dnd).toISOString() })}>
              Set
            </Button>
            <Button
              variant="ghost"
              disabled={!member.dnd_until}
              onClick={() => {
                setDnd("");
                save.mutate({ dnd_until: null });
              }}
            >
              Clear
            </Button>
          </div>
          {dndActive && <p className="text-xs text-warning-text">Notifications are paused until {new Date(member.dnd_until ?? "").toLocaleString()}.</p>}
        </div>
      </SettingsSection>
      <SettingsSection title="Notifications" description="Choose what is worth interrupting you for.">
        <div className="max-w-xl divide-y divide-border">
          {PREFS.map((p) => (
            <Switch key={p.id} label={p.label} hint={p.hint} checked={member.notification_prefs[p.id]} onChange={(v) => save.mutate({ notification_prefs: { ...member.notification_prefs, [p.id]: v } })} />
          ))}
        </div>
        {save.isError && <ErrorNotice error={save.error} />}
      </SettingsSection>
      <PushSettings />
    </>
  );
}
