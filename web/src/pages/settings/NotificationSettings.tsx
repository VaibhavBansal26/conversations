import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import type { Availability, Member, NotificationPrefs, Session } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../ui";
import { Switch } from "../../ui";
import { toLocalInput } from "../../lib/time";
import { keys } from "../../state/keys";

const PREFS: { id: keyof NotificationPrefs; label: string; hint: string }[] = [
  { id: "assigned_to_you", label: "Assigned to you", hint: "A conversation is assigned to you." },
  { id: "assigned_to_your_team", label: "Assigned to your inbox", hint: "A conversation lands in an inbox you belong to." },
  { id: "unassigned", label: "Unassigned conversations", hint: "New conversations nobody owns yet." },
  { id: "mentions", label: "Mentions", hint: "A teammate @mentions you in a note." },
  { id: "delayed_msgs", label: "Snoozed conversations returning", hint: "A snooze ends or a customer replies to a snoozed chat." },
  { id: "email", label: "Email me about missed notifications", hint: "A digest to your inbox when you were away." },
];

const LEVELS: { id: Availability; label: string; hint: string }[] = [
  { id: "active", label: "Available", hint: "Receive new conversations and notifications." },
  { id: "away", label: "Away", hint: "Skipped by round-robin routing." },
  { id: "inactive", label: "Inactive", hint: "Not receiving anything." },
];

export function NotificationSettings() {
  const { member } = useSession();
  const qc = useQueryClient();
  const [dnd, setDnd] = useState(member.dnd_until ? toLocalInput(new Date(member.dnd_until)) : "");
  const save = useMutation({
    mutationFn: (patch: Partial<Pick<Member, "availability" | "dnd_until" | "notification_prefs">>) => api.patch<Member>("/members/me", patch),
    onSuccess: (m) => qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, member: m } : s)),
  });
  const dndActive = !!member.dnd_until && new Date(member.dnd_until) > new Date();

  return (
    <>
      <SettingsSection title="Availability" description="Controls whether you are offered new conversations.">
        <div className="radio-cards" role="radiogroup" aria-label="Availability">
          {LEVELS.map((l) => (
            <label key={l.id} className={`radio-card${member.availability === l.id ? " active" : ""}`}>
              <input type="radio" name="availability" checked={member.availability === l.id} onChange={() => save.mutate({ availability: l.id })} />
              <strong>{l.label}</strong>
              <span>{l.hint}</span>
            </label>
          ))}
        </div>
        <div className="stack narrow">
          <label htmlFor="dnd">Do not disturb until</label>
          <div className="row">
            <input id="dnd" type="datetime-local" value={dnd} onChange={(e) => setDnd(e.target.value)} />
            <button type="button" className="btn btn-outline" disabled={!dnd} onClick={() => save.mutate({ dnd_until: new Date(dnd).toISOString() })}>
              Set
            </button>
            <button type="button" className="btn btn-ghost" disabled={!member.dnd_until} onClick={() => { setDnd(""); save.mutate({ dnd_until: null }); }}>
              Clear
            </button>
          </div>
          {dndActive && <p className="hint">Notifications are paused until {new Date(member.dnd_until ?? "").toLocaleString()}.</p>}
        </div>
      </SettingsSection>
      <SettingsSection title="Notifications" description="Choose what is worth interrupting you for.">
        <div className="stack narrow">
          {PREFS.map((p) => (
            <Switch key={p.id} label={p.label} hint={p.hint} checked={member.notification_prefs[p.id]} onChange={(v) => save.mutate({ notification_prefs: { ...member.notification_prefs, [p.id]: v } })} />
          ))}
        </div>
        {save.isError && <ErrorNotice error={save.error} />}
      </SettingsSection>
    </>
  );
}
