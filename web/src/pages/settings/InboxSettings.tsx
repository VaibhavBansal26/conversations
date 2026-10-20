import { Inbox as InboxIcon, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useInboxes, useMembers } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { Inbox } from "../../api/types";
import { ConfirmDialog } from "../../components/settings/ConfirmDialog";
import { EditorPanel, ListRow, RowList, SettingsSection } from "../../components/settings/SettingsSection";
import { keys } from "../../state/keys";
import { Avatar, Badge, Button, EmptyState, ErrorNotice, Field, Input, Select, Skeleton, Switch, toast } from "../../ui";

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
  const [confirm, setConfirm] = useState<Inbox | null>(null);
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
    save.mutate({ ...draft, name: draft.name.trim() }, { onSuccess: () => { toast({ title: "Inbox saved", tone: "success" }); done(); } });
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <SettingsSection
      title="Inboxes"
      description="Group conversations by team or channel and decide who gets them."
      actions={
        <Button size="sm" onClick={() => open(null)}>
          <Plus aria-hidden="true" /> New inbox
        </Button>
      }
    >
      {inboxes.isPending && (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading inboxes">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {inboxes.isError && <ErrorNotice error={inboxes.error} onRetry={() => void inboxes.refetch()} />}
      {inboxes.data?.length === 0 && editing === null && (
        <EmptyState icon={InboxIcon} title="No inboxes yet" hint="Create one to start routing conversations." action={<Button onClick={() => open(null)}>New inbox</Button>} />
      )}
      {!!inboxes.data?.length && (
        <RowList>
          {inboxes.data.map((i) => (
            <ListRow
              key={i.id}
              actions={
                <>
                  <Button variant="outline" size="sm" onClick={() => open(i)}>
                    <Pencil aria-hidden="true" /> Edit
                  </Button>
                  <Button variant="danger-ghost" size="sm" aria-label={`Delete inbox ${i.name}`} onClick={() => setConfirm(i)}>
                    <Trash2 aria-hidden="true" /> Delete
                  </Button>
                </>
              }
            >
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-text">
                  <InboxIcon className="size-[18px]" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <strong className="block truncate text-sm">{i.name}</strong>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                    <span>{i.algorithm === "round_robin" ? "Round robin" : "Manual assignment"}</span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3.5" aria-hidden="true" />
                      {i.member_ids.length} member{i.member_ids.length === 1 ? "" : "s"}
                    </span>
                    {i.default_email_inbound && <Badge tone="info">Default for email</Badge>}
                    {i.default_sms_inbound && <Badge tone="info">Default for SMS</Badge>}
                  </p>
                </div>
              </div>
            </ListRow>
          ))}
        </RowList>
      )}
      {remove.isError && <ErrorNotice error={remove.error} />}

      {editing !== null && (
        <EditorPanel title={editing === "new" ? "New inbox" : "Edit inbox"} label={editing === "new" ? "New inbox" : "Edit inbox"} onSubmit={submit}>
          <Field label="Name">
            <Input value={draft.name} maxLength={80} required onChange={(e) => set("name", e.target.value)} data-autofocus autoFocus />
          </Field>
          <Field label="Assignment">
            <Select
              value={draft.algorithm}
              onValueChange={(v) => set("algorithm", v as Draft["algorithm"])}
              options={[
                { value: "manual", label: "Manual: agents pick up conversations" },
                { value: "round_robin", label: "Round robin: distribute automatically" },
              ]}
            />
          </Field>
          <div className="divide-y divide-border">
            <Switch label="Live routing visibility" hint="Members see who a conversation is being routed to in real time." checked={draft.live_routing_visibility} onChange={(v) => set("live_routing_visibility", v)} />
            <Switch label="Default inbox for inbound email" checked={draft.default_email_inbound} onChange={(v) => set("default_email_inbound", v)} />
            <Switch label="Default inbox for inbound SMS" checked={draft.default_sms_inbound} onChange={(v) => set("default_sms_inbound", v)} />
          </div>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Members</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {members.map((m) => {
                const on = draft.member_ids.includes(m.id);
                return (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                    <input type="checkbox" className="size-4 accent-primary" checked={on} onChange={(e) => set("member_ids", e.target.checked ? [...draft.member_ids, m.id] : draft.member_ids.filter((x) => x !== m.id))} />
                    <Avatar name={m.name} size="xs" />
                    <span className="truncate">{m.name}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="flex gap-2">
            <Button type="submit" loading={save.isPending} disabled={!draft.name.trim()}>
              {save.isPending ? "Saving…" : "Save inbox"}
            </Button>
            <Button variant="ghost" onClick={done}>
              Cancel
            </Button>
          </div>
        </EditorPanel>
      )}
      {confirm && (
        <ConfirmDialog
          title="Delete inbox"
          message={`Delete inbox "${confirm.name}"?`}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            remove.mutate(confirm.id);
            setConfirm(null);
          }}
        />
      )}
    </SettingsSection>
  );
}
