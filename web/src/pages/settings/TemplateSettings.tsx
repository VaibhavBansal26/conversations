import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useTemplates } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { Template } from "../../api/types";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";
import { LoadingBlock } from "../../components/ui/Spinner";
import { fieldErrors } from "../../lib/apiError";
import { keys } from "../../state/keys";

interface Draft {
  name: string;
  channel: Template["channel"];
  shortcut: string;
  subject: string;
  body: string;
}
const blank: Draft = { name: "", channel: "any", shortcut: "", subject: "", body: "" };

export function TemplateSettings() {
  const templates = useTemplates();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const save = useListMutation(
    (d: Draft) => {
      const body = { name: d.name.trim(), channel: d.channel, shortcut: d.shortcut.trim() || null, subject: d.subject.trim() || null, body: d.body };
      return editing === "new" ? api.post("/templates", body) : api.patch(`/templates/${editing}`, body);
    },
    keys.templates,
  );
  const remove = useListMutation((id: string) => api.delete(`/templates/${id}`), keys.templates);
  const errors = fieldErrors(save.error);

  const open = (t: Template | null) => {
    setDraft(t ? { name: t.name, channel: t.channel, shortcut: t.shortcut ?? "", subject: t.subject ?? "", body: t.body } : blank);
    setEditing(t ? t.id : "new");
    save.reset();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft, { onSuccess: () => setEditing(null) });
  };

  return (
    <SettingsSection
      title="Templates"
      description="Canned replies agents insert by typing / in the composer."
      actions={
        <button type="button" className="btn btn-primary" onClick={() => open(null)}>
          New template
        </button>
      }
    >
      {templates.isPending && <LoadingBlock label="Loading templates" />}
      {templates.isError && <ErrorNotice error={templates.error} onRetry={() => void templates.refetch()} />}
      {templates.data?.length === 0 && editing === null && <EmptyState title="No templates yet" />}
      <ul className="card-list">
        {templates.data?.map((t) => (
          <li key={t.id} className="card">
            <div>
              <strong>{t.name}</strong> {t.shortcut && <code>/{t.shortcut}</code>} <span className="tag">{t.channel}</span>
              <p className="muted clamp">{t.body}</p>
            </div>
            <div className="row">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => open(t)}>
                Edit
              </button>
              <button type="button" className="btn btn-danger-ghost btn-sm" aria-label={`Delete template ${t.name}`} onClick={() => window.confirm(`Delete "${t.name}"?`) && remove.mutate(t.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {remove.isError && <ErrorNotice error={remove.error} />}
      {editing !== null && (
        <form className="stack panel-form" onSubmit={submit} aria-label={editing === "new" ? "New template" : "Edit template"}>
          <h3>{editing === "new" ? "New template" : "Edit template"}</h3>
          <div className="grid-3">
            <Field label="Name" error={errors.name}>
              <input value={draft.name} maxLength={100} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-autofocus />
            </Field>
            <Field label="Shortcut" hint="Letters, digits, - and _" error={errors.shortcut}>
              <input value={draft.shortcut} maxLength={40} pattern="[A-Za-z0-9_-]*" onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })} />
            </Field>
            <Field label="Channel">
              <select value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value as Template["channel"] })}>
                <option value="any">Any channel</option>
                <option value="dm">Live chat</option>
                <option value="sms">SMS</option>
                <option value="email">Email</option>
              </select>
            </Field>
          </div>
          {draft.channel === "email" && (
            <Field label="Subject">
              <input value={draft.subject} maxLength={300} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
            </Field>
          )}
          <Field label="Message" hint="Merge fields: {{contact.first_name|there}} uses the contact's first name, or “there” when unknown. Also {{contact.name}}, {{agent.name}}, {{workspace.name}}." error={errors.body}>
            <textarea rows={5} maxLength={10000} required value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </Field>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save template"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </SettingsSection>
  );
}
