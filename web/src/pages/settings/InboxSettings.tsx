import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useInboxes, useMembers } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { Inbox } from "../../api/types";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { EmptyState } from "../../ui";
import { ErrorNotice } from "../../ui";
import { Field } from "../../ui";
import { Switch } from "../../ui";
import { LoadingBlock } from "../../ui";
import { keys } from "../../state/keys";

interface Draft {
  name: string;
  algorithm: Inbox["algorithm"];
  live_routing_visibility: boolean;
  default_email_inbound: boolean;
  default_sms_inbound: boolean;
  member_ids: string[];
}

const blank: Draft = { name: "", algorithm: "manual", live_routing_visibility: false, default_email_inbound: false, default_sms_inbound: false, member_ids: [] };
const toDraft = (i: Inbox): Draft => ({ name: i.name, algorithm: i.algorithm, live_routing_visibility: i.live_routing_visibility, default_email_inbound: i.default_email_inbound, default_sms_inbound: i.default_sms_inbound, member_ids: i.member_ids });

export function InboxSettings() {
  const inboxes = useInboxes();
  const members = useMembers().data ?? [];
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const done = () => setEditing(null);
  const save = useListMutation(
    async (d: Draft) => (editing === "new" ? api.post<Inbox>("/inboxes", d) : api.patch<Inbox>(`/inboxes/${editing}`, d)),
    keys.inboxes,
  );
  const remove = useListMutation((id: string) => api.delete(`/inboxes/${id}`), keys.inboxes);

  const open = (i: Inbox | null) => {
    setDraft(i ? toDraft(i) : blank);
    setEditing(i ? i.id : "new");
    save.reset();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...draft, name: draft.name.trim() }, { onSuccess: done });
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <SettingsSection
      title="Inboxes"
      description="Group conversations by team or channel and decide who gets them."
      actions={
        <button type="button" className="btn btn-primary" onClick={() => open(null)}>
          New inbox
        </button>
      }
    >
      {inboxes.isPending && <LoadingBlock label="Loading inboxes" />}
      {inboxes.isError && <ErrorNotice error={inboxes.error} onRetry={() => void inboxes.refetch()} />}
      {inboxes.data?.length === 0 && editing === null && <EmptyState title="No inboxes yet" hint="Create one to start routing conversations." />}
      <ul className="card-list">
        {inboxes.data?.map((i) => (
          <li key={i.id} className="card">
            <div>
              <strong>{i.name}</strong>
              <p className="muted">
                {i.algorithm === "round_robin" ? "Round robin" : "Manual assignment"} · {i.member_ids.length} member{i.member_ids.length === 1 ? "" : "s"}
                {i.default_email_inbound && " · default for email"}
                {i.default_sms_inbound && " · default for SMS"}
              </p>
            </div>
            <div className="row">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => open(i)}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-danger-ghost btn-sm"
                aria-label={`Delete inbox ${i.name}`}
                onClick={() => window.confirm(`Delete inbox "${i.name}"?`) && remove.mutate(i.id)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {remove.isError && <ErrorNotice error={remove.error} />}

      {editing !== null && (
        <form className="stack panel-form" onSubmit={submit} aria-label={editing === "new" ? "New inbox" : "Edit inbox"}>
          <h3>{editing === "new" ? "New inbox" : "Edit inbox"}</h3>
          <Field label="Name">
            <input value={draft.name} maxLength={80} required onChange={(e) => set("name", e.target.value)} data-autofocus />
          </Field>
          <Field label="Assignment">
            <select value={draft.algorithm} onChange={(e) => set("algorithm", e.target.value as Draft["algorithm"])}>
              <option value="manual">Manual: agents pick up conversations</option>
              <option value="round_robin">Round robin: distribute automatically</option>
            </select>
          </Field>
          <Switch label="Live routing visibility" hint="Members see who a conversation is being routed to in real time." checked={draft.live_routing_visibility} onChange={(v) => set("live_routing_visibility", v)} />
          <Switch label="Default inbox for inbound email" checked={draft.default_email_inbound} onChange={(v) => set("default_email_inbound", v)} />
          <Switch label="Default inbox for inbound SMS" checked={draft.default_sms_inbound} onChange={(v) => set("default_sms_inbound", v)} />
          <fieldset>
            <legend>Members</legend>
            <div className="check-grid">
              {members.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={draft.member_ids.includes(m.id)} onChange={(e) => set("member_ids", e.target.checked ? [...draft.member_ids, m.id] : draft.member_ids.filter((x) => x !== m.id))} />
                  {m.name}
                </label>
              ))}
            </div>
          </fieldset>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={save.isPending || !draft.name.trim()}>
              {save.isPending ? "Saving…" : "Save inbox"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={done}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </SettingsSection>
  );
}
