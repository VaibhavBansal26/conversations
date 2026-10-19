import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useKb, useListMutation } from "../../api/settingsHooks";
import type { KbEntry } from "../../api/types";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";
import { LoadingBlock } from "../../components/ui/Spinner";
import { keys } from "../../state/keys";

export function KnowledgeBaseSettings() {
  const kb = useKb();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState({ question: "", answer: "" });
  const save = useListMutation(
    (d: typeof draft) => (editing === "new" ? api.post("/kb", d) : api.put(`/kb/${editing}`, d)),
    keys.kb,
  );
  const remove = useListMutation((id: string) => api.delete(`/kb/${id}`), keys.kb);

  const open = (e: KbEntry | null) => {
    setDraft(e ? { question: e.question, answer: e.answer } : { question: "", answer: "" });
    setEditing(e ? e.id : "new");
    save.reset();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft, { onSuccess: () => setEditing(null) });
  };

  return (
    <SettingsSection
      title="Knowledge base"
      description="Questions and answers the AI uses to suggest grounded replies."
      actions={
        <button type="button" className="btn btn-primary" onClick={() => open(null)}>
          New entry
        </button>
      }
    >
      {kb.isPending && <LoadingBlock label="Loading knowledge base" />}
      {kb.isError && <ErrorNotice error={kb.error} onRetry={() => void kb.refetch()} />}
      {kb.data?.length === 0 && editing === null && <EmptyState title="No entries yet" hint="Add common questions so suggestions can quote your real answers." />}
      <ul className="card-list">
        {kb.data?.map((e) => (
          <li key={e.id} className="card">
            <div>
              <strong>{e.question}</strong>
              <p className="muted clamp">{e.answer}</p>
            </div>
            <div className="row">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => open(e)}>
                Edit
              </button>
              <button type="button" className="btn btn-danger-ghost btn-sm" aria-label={`Delete entry ${e.question}`} onClick={() => window.confirm("Delete this entry?") && remove.mutate(e.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {remove.isError && <ErrorNotice error={remove.error} />}
      {editing !== null && (
        <form className="stack panel-form" onSubmit={submit} aria-label={editing === "new" ? "New entry" : "Edit entry"}>
          <h3>{editing === "new" ? "New entry" : "Edit entry"}</h3>
          <Field label="Question">
            <input value={draft.question} minLength={3} maxLength={500} required onChange={(e) => setDraft({ ...draft, question: e.target.value })} data-autofocus />
          </Field>
          <Field label="Answer">
            <textarea rows={5} maxLength={4000} required value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
          </Field>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save entry"}
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
