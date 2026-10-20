// Adapted from the legacy UI (see docs/PROVENANCE.md): team-member table with per-member access controls.
import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useMembers } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { Member, Role } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { CopyButton } from "../../components/settings/CopyButton";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { keys } from "../../state/keys";
import {
  Avatar, Badge, Button, Dialog, DialogFooter, EmptyState, ErrorNotice, Field, Input, Select, Skeleton, SwitchControl, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, toast,
} from "../../ui";
import { ConfirmDialog } from "./ConfirmDialog";

function tempPassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

/** Mirrors the server: owners manage everyone, managers manage agents, nobody changes themselves here. */
export const canManage = (actor: Pick<Member, "id" | "role">, target: Pick<Member, "id" | "role">): boolean =>
  actor.id !== target.id && (actor.role === "owner" || (actor.role === "manager" && target.role === "agent"));

const ROLE_TONE = { owner: "primary", manager: "info", agent: "neutral" } as const;

export function MemberSettings() {
  const { member: me } = useSession();
  const members = useMembers();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "agent" as Exclude<Role, "owner"> });
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const add = useListMutation((b: typeof form) => api.post<Member>("/members", { ...b, password: b.password || undefined }), keys.members);
  const patch = useListMutation(({ id, ...body }: { id: string } & Partial<Pick<Member, "role" | "live_seat" | "inbox_visibility">>) => api.patch<Member>(`/members/${id}`, body), keys.members);
  const remove = useListMutation((id: string) => api.delete(`/members/${id}`), keys.members);
  const errors = fieldErrors(add.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(form, {
      onSuccess: () => {
        setCreated(form.password ? { email: form.email, password: form.password } : null);
        toast({ title: "Member added", description: form.email, tone: "success" });
        setForm({ name: "", email: "", password: "", role: "agent" });
        setAdding(false);
      },
    });
  };

  return (
    <>
      <SettingsSection
        title="Members & seats"
        description="Live seats can take conversations. Visibility controls which conversations an agent can see."
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" /> Add member
          </Button>
        }
      >
        {members.isPending && (
          <div role="status" aria-label="Loading members" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}
        {members.isError && <ErrorNotice error={members.error} onRetry={() => void members.refetch()} />}
        {members.data?.length === 0 && <EmptyState title="No members yet" hint="Add a teammate to share the inbox." />}
        {members.data && members.data.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">Member</TableHeaderCell>
                <TableHeaderCell scope="col">Role</TableHeaderCell>
                <TableHeaderCell scope="col">Live seat</TableHeaderCell>
                <TableHeaderCell scope="col">Can see</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <span className="sr-only">Actions</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.data.map((m) => {
                const editable = canManage(me, m);
                return (
                  <TableRow key={m.id}>
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <div className="flex items-center gap-3">
                        <Avatar name={m.name} seed={m.id} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">
                            {m.name}
                            {m.id === me.id && <Badge tone="primary">You</Badge>}
                          </div>
                          <small className="block truncate text-xs text-subtle">{m.email}</small>
                        </div>
                      </div>
                    </th>
                    <TableCell>
                      {editable && me.role === "owner" ? (
                        <Select
                          size="sm"
                          className="w-32"
                          aria-label={`Role of ${m.name}`}
                          value={m.role}
                          onValueChange={(v) => patch.mutate({ id: m.id, role: v as Role })}
                          options={[
                            { value: "owner", label: "Owner" },
                            { value: "manager", label: "Manager" },
                            { value: "agent", label: "Agent" },
                          ]}
                        />
                      ) : (
                        <Badge tone={ROLE_TONE[m.role]} aria-label={`Role of ${m.name}`}>
                          {m.role}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <SwitchControl aria-label={`Live seat for ${m.name}`} checked={m.live_seat} disabled={!editable} onCheckedChange={(v) => patch.mutate({ id: m.id, live_seat: v })} />
                    </TableCell>
                    <TableCell>
                      <Select
                        size="sm"
                        className="w-40"
                        aria-label={`Visibility for ${m.name}`}
                        disabled={!editable}
                        value={m.inbox_visibility}
                        onValueChange={(v) => patch.mutate({ id: m.id, inbox_visibility: v as Member["inbox_visibility"] })}
                        options={[
                          { value: "assigned", label: "Only assigned" },
                          { value: "assigned_inbox", label: "Their inboxes" },
                        ]}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="danger-ghost" size="sm" disabled={!editable} onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`}>
                        <Trash2 aria-hidden="true" /> Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {(patch.isError || remove.isError) && <ErrorNotice error={patch.error ?? remove.error} />}
        {created && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-success-soft px-3 py-2.5 text-sm text-success-text" role="status">
            <span className="min-w-0 flex-1">
              Added {created.email}. Temporary password: <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-foreground">{created.password}</code>
            </span>
            <CopyButton text={created.password} label="Copy password" />
          </div>
        )}
      </SettingsSection>

      {adding && (
        <Dialog title="Add a member" description="They sign in with their email and the temporary password you share. Ask them to change it after signing in." onClose={() => setAdding(false)}>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field label="Name" error={errors.name}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </Field>
            <Field label="Temporary password" hint="At least 8 characters." error={errors.password}>
              <div className="flex gap-2">
                <Input value={form.password} minLength={8} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
                <Button variant="outline" onClick={() => setForm({ ...form, password: tempPassword() })}>
                  Generate
                </Button>
              </div>
            </Field>
            <Field label="Role">
              <Select
                value={form.role}
                onValueChange={(v) => setForm({ ...form, role: v as typeof form.role })}
                options={[
                  { value: "agent", label: "Agent" },
                  { value: "manager", label: "Manager", disabled: me.role !== "owner" },
                ]}
              />
            </Field>
            {add.isError && <ErrorNotice error={add.error} />}
            <DialogFooter className="-mx-5 -mb-4">
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={add.isPending}>
                {add.isPending ? "Adding…" : "Add member"}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          description="They lose access to the workspace immediately. Their conversations stay in the inbox."
          confirmLabel="Remove member"
          onConfirm={() => remove.mutate(removing.id, { onSuccess: () => toast({ title: "Member removed", tone: "success" }) })}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}
