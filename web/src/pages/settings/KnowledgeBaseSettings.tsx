import { Library, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
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
  const [draft, setDraft] = useState({ question: "", answer: "" });
  const [confirm, setConfirm] = useState<KbEntry | null>(null);
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
