import { Library, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import { api } from "../../api/client";
import { useKb, useListMutation } from "../../api/settingsHooks";
import type { KbEntry } from "../../api/types";
import { ConfirmDialog } from "../../components/settings/ConfirmDialog";
import { EditorPanel, ListRow, RowList, SettingsSection } from "../../components/settings/SettingsSection";
import { keys } from "../../state/keys";
import { Button, EmptyState, ErrorNotice, Field, Input, Skeleton, Textarea, toast } from "../../ui";

export function KnowledgeBaseSettings() {
  const kb = useKb();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const prefill = (useLocation().state as { question?: string } | null)?.question;
  const [draft, setDraft] = useState({ question: "", answer: "", collection: "", url: "" });
  const [confirm, setConfirm] = useState<KbEntry | null>(null);
  const save = useListMutation(
    (d: typeof draft) => (editing === "new" ? api.post("/kb", { ...d, url: d.url || null }) : api.put(`/kb/${editing}`, { ...d, url: d.url || null })),
    keys.kb,
  );
  const remove = useListMutation((id: string) => api.delete(`/kb/${id}`), keys.kb);

  const open = (e: KbEntry | null) => {
    setDraft(e ? { question: e.question, answer: e.answer, collection: e.collection ?? "", url: e.url ?? "" } : { question: prefill ?? "", answer: "", collection: "", url: "" });
    setEditing(e ? e.id : "new");
    save.reset();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft, { onSuccess: () => { toast({ title: "Entry saved", tone: "success" }); setEditing(null); } });
  };

  return (
    <SettingsSection
      title="Knowledge base"
      description="Questions and answers the AI uses to suggest grounded replies."
      actions={
        <Button size="sm" onClick={() => open(null)}>
          <Plus aria-hidden="true" /> New entry
        </Button>
      }
    >
      {kb.isPending && (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading knowledge base">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}
      {kb.isError && <ErrorNotice error={kb.error} onRetry={() => void kb.refetch()} />}
      {kb.data?.length === 0 && editing === null && (
        <EmptyState icon={Library} title="No entries yet" hint="Add common questions so suggestions can quote your real answers." action={<Button onClick={() => open(null)}>New entry</Button>} />
      )}
      {!!kb.data?.length && (
        <RowList>
          {kb.data.map((e) => (
            <ListRow
              key={e.id}
              actions={
                <>
                  <Button variant="outline" size="sm" onClick={() => open(e)}>
                    <Pencil aria-hidden="true" /> Edit
                  </Button>
                  <Button variant="danger-ghost" size="sm" aria-label={`Delete entry ${e.question}`} onClick={() => setConfirm(e)}>
                    <Trash2 aria-hidden="true" /> Delete
                  </Button>
                </>
              }
            >
              <strong className="text-sm">{e.question}</strong>
              {(e.collection || e.url) && (
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-subtle">
                  {e.collection && <span>Collection: {e.collection}</span>}
                  {e.url && <span className="truncate">{e.url}</span>}
                </p>
              )}
              <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{e.answer}</p>
            </ListRow>
          ))}
        </RowList>
      )}
      {remove.isError && <ErrorNotice error={remove.error} />}
      {editing !== null && (
        <EditorPanel title={editing === "new" ? "New entry" : "Edit entry"} label={editing === "new" ? "New entry" : "Edit entry"} onSubmit={submit}>
          <Field label="Question">
            <Input value={draft.question} minLength={3} maxLength={500} required onChange={(e) => setDraft({ ...draft, question: e.target.value })} data-autofocus autoFocus />
          </Field>
          <Field label="Answer" hint={`${draft.answer.length} / 4000`}>
            <Textarea rows={5} maxLength={4000} required value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Collection" hint="Optional group, such as billing. An AI agent can be limited to some collections.">
              <Input value={draft.collection} maxLength={60} onChange={(e) => setDraft({ ...draft, collection: e.target.value })} />
            </Field>
            <Field label="Page address" hint="Optional. Shown to visitors as the source of an answer.">
              <Input type="url" value={draft.url} maxLength={500} placeholder="https://help.example.com/..." onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </Field>
          </div>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="flex gap-2">
            <Button type="submit" loading={save.isPending}>
              {save.isPending ? "Saving…" : "Save entry"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </EditorPanel>
      )}
      {confirm && <ConfirmDialog title="Delete entry" message="Delete this entry?" onCancel={() => setConfirm(null)} onConfirm={() => { remove.mutate(confirm.id); setConfirm(null); }} />}
    </SettingsSection>
  );
}
