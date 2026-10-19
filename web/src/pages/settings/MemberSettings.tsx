import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useMembers } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { Member, Role } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { CopyButton } from "../../components/settings/CopyButton";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";
import { LoadingBlock } from "../../components/ui/Spinner";
import { fieldErrors } from "../../lib/apiError";
import { keys } from "../../state/keys";

function tempPassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

/** Mirrors the server: owners manage everyone, managers manage agents, nobody changes themselves here. */
export const canManage = (actor: Pick<Member, "id" | "role">, target: Pick<Member, "id" | "role">): boolean =>
  actor.id !== target.id && (actor.role === "owner" || (actor.role === "manager" && target.role === "agent"));

export function MemberSettings() {
  const { member: me } = useSession();
  const members = useMembers();
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
        setForm({ name: "", email: "", password: "", role: "agent" });
      },
    });
  };

  return (
    <>
      <SettingsSection title="Members & seats" description="Live seats can take conversations. Visibility controls which conversations an agent can see.">
        {members.isPending && <LoadingBlock label="Loading members" />}
        {members.isError && <ErrorNotice error={members.error} onRetry={() => void members.refetch()} />}
        {members.data && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Live seat</th>
                  <th scope="col">Can see</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => {
                  const editable = canManage(me, m);
                  return (
                    <tr key={m.id}>
                      <th scope="row">
                        {m.name}
                        {m.id === me.id && <span className="tag"> You</span>}
                        <small className="block muted">{m.email}</small>
                      </th>
                      <td>
                        <select aria-label={`Role of ${m.name}`} value={m.role} disabled={!editable || me.role !== "owner"} onChange={(e) => patch.mutate({ id: m.id, role: e.target.value as Role })}>
                          <option value="owner">Owner</option>
                          <option value="manager">Manager</option>
                          <option value="agent">Agent</option>
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" role="switch" className="switch" aria-label={`Live seat for ${m.name}`} checked={m.live_seat} disabled={!editable} onChange={(e) => patch.mutate({ id: m.id, live_seat: e.target.checked })} />
                      </td>
                      <td>
                        <select aria-label={`Visibility for ${m.name}`} value={m.inbox_visibility} disabled={!editable} onChange={(e) => patch.mutate({ id: m.id, inbox_visibility: e.target.value as Member["inbox_visibility"] })}>
                          <option value="assigned">Only assigned</option>
                          <option value="assigned_inbox">Their inboxes</option>
                        </select>
                      </td>
                      <td>
                        <button type="button" className="btn btn-danger-ghost btn-sm" disabled={!editable} onClick={() => window.confirm(`Remove ${m.name} from the workspace?`) && remove.mutate(m.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(patch.isError || remove.isError) && <ErrorNotice error={patch.error ?? remove.error} />}
      </SettingsSection>

      <SettingsSection title="Add a member" description="They sign in with their email and the temporary password you share. Ask them to change it after signing in.">
        <form className="stack narrow" onSubmit={submit}>
          <Field label="Name" error={errors.name}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field label="Email" error={errors.email}>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </Field>
          <Field label="Temporary password" hint="At least 8 characters." error={errors.password}>
            <div className="row">
              <input value={form.password} minLength={8} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              <button type="button" className="btn btn-outline" onClick={() => setForm({ ...form, password: tempPassword() })}>
                Generate
              </button>
            </div>
          </Field>
          <Field label="Role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })}>
              <option value="agent">Agent</option>
              <option value="manager" disabled={me.role !== "owner"}>
                Manager
              </option>
            </select>
          </Field>
          {add.isError && <ErrorNotice error={add.error} />}
          <button type="submit" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add member"}
          </button>
        </form>
        {created && (
          <div className="notice notice-success" role="status">
            <span>
              Added {created.email}. Temporary password: <code>{created.password}</code>
            </span>
            <CopyButton text={created.password} label="Copy password" />
          </div>
        )}
      </SettingsSection>
    </>
  );
}
