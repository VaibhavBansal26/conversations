import { LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useTemplates } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { Template } from "../../api/types";
import { ConfirmDialog } from "../../components/settings/ConfirmDialog";
import { EditorPanel, ListRow, RowList, SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { keys } from "../../state/keys";
import { Badge, Button, EmptyState, ErrorNotice, Field, Input, Select, Skeleton, Textarea, toast } from "../../ui";

interface Draft {
  name: string;
  channel: Template["channel"];
  shortcut: string;
  subject: string;
  body: string;
}
const blank: Draft = { name: "", channel: "any", shortcut: "", subject: "", body: "" };
const CHANNEL_LABEL: Record<Template["channel"], string> = { any: "Any channel", dm: "Live chat", sms: "SMS", email: "Email" };
const MERGE_FIELDS = ["{{contact.first_name|there}}", "{{contact.name}}", "{{agent.name}}", "{{workspace.name}}"];

export function TemplateSettings() {
  const templates = useTemplates();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [confirm, setConfirm] = useState<Template | null>(null);
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
    save.mutate(draft, { onSuccess: () => { toast({ title: "Template saved", tone: "success" }); setEditing(null); } });
  };

  return (
    <SettingsSection
      title="Templates"
      description="Canned replies agents insert by typing / in the composer."
      actions={
        <Button size="sm" onClick={() => open(null)}>
          <Plus aria-hidden="true" /> New template
        </Button>
      }
    >
      {templates.isPending && (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading templates">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}
      {templates.isError && <ErrorNotice error={templates.error} onRetry={() => void templates.refetch()} />}
      {templates.data?.length === 0 && editing === null && (
        <EmptyState icon={LayoutTemplate} title="No templates yet" hint="Save the replies you send most, then insert them with / in the composer." action={<Button onClick={() => open(null)}>New template</Button>} />
      )}
      {!!templates.data?.length && (
        <RowList>
          {templates.data.map((t) => (
            <ListRow
              key={t.id}
              actions={
                <>
                  <Button variant="outline" size="sm" onClick={() => open(t)}>
                    <Pencil aria-hidden="true" /> Edit
                  </Button>
                  <Button variant="danger-ghost" size="sm" aria-label={`Delete template ${t.name}`} onClick={() => setConfirm(t)}>
                    <Trash2 aria-hidden="true" /> Delete
                  </Button>
                </>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">{t.name}</strong>
                {t.shortcut && <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">/{t.shortcut}</code>}
                <Badge>{CHANNEL_LABEL[t.channel] ?? t.channel}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{t.body}</p>
            </ListRow>
          ))}
        </RowList>
      )}
      {remove.isError && <ErrorNotice error={remove.error} />}
      {editing !== null && (
        <EditorPanel title={editing === "new" ? "New template" : "Edit template"} label={editing === "new" ? "New template" : "Edit template"} onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" error={errors.name}>
              <Input value={draft.name} maxLength={100} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus data-autofocus />
            </Field>
            <Field label="Shortcut" hint="Letters, digits, - and _" error={errors.shortcut}>
              <Input value={draft.shortcut} maxLength={40} pattern="[A-Za-z0-9_-]*" onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })} />
            </Field>
            <Field label="Channel">
              <Select value={draft.channel} onValueChange={(v) => setDraft({ ...draft, channel: v as Template["channel"] })} options={(Object.keys(CHANNEL_LABEL) as Template["channel"][]).map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
            </Field>
          </div>
          {draft.channel === "email" && (
            <Field label="Subject">
              <Input value={draft.subject} maxLength={300} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
            </Field>
          )}
          <Field label="Message" hint="Merge fields: {{contact.first_name|there}} uses the contact's first name, or “there” when unknown. Also {{contact.name}}, {{agent.name}}, {{workspace.name}}." error={errors.body}>
            <Textarea rows={5} maxLength={10000} required value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Insert merge field">
            <span className="text-xs text-subtle">Insert:</span>
            {MERGE_FIELDS.map((f) => (
              <button key={f} type="button" className="rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-xs hover:bg-surface-2" onClick={() => setDraft((d) => ({ ...d, body: d.body + f }))}>
                {f.replace(/\|.*\}\}/, "}}")}
              </button>
            ))}
          </div>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="flex gap-2">
            <Button type="submit" loading={save.isPending}>
              {save.isPending ? "Saving…" : "Save template"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </EditorPanel>
      )}
      {confirm && <ConfirmDialog title="Delete template" message={`Delete "${confirm.name}"?`} onCancel={() => setConfirm(null)} onConfirm={() => { remove.mutate(confirm.id); setConfirm(null); }} />}
    </SettingsSection>
  );
}
