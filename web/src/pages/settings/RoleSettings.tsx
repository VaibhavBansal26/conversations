import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";

interface Role {
  id: string;
  key: string;
  name: string;
  description: string;
  base_role: string;
  system: boolean;
  permissions: string[];
}
interface Invitation {
  id: string;
  email: string;
  role_id: string;
  expires_at: string;
}

const ALL = [
  "conversations:read", "conversations:reply", "conversations:assign", "conversations:delete", "contacts:read", "contacts:write", "contacts:import", "contacts:delete",
  "inboxes:manage", "members:read", "members:manage", "roles:manage", "settings:read", "settings:write", "channels:manage", "tokens:manage", "templates:manage", "kb:manage",
  "ai:use", "billing:manage", "analytics:read", "analytics:export", "analytics_identity:manage", "api_keys:manage", "audit:read",
];

export function RoleSettings() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<{ data: Role[] }>("/roles") });
  const invites = useQuery({ queryKey: ["invitations"], queryFn: () => api.get<{ data: Invitation[] }>("/invitations") });
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [base, setBase] = useState<"agent" | "manager">("agent");
  const [perms, setPerms] = useState<Set<string>>(new Set(["conversations:read", "conversations:reply"]));
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("role_agent");

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
  };
  const toggle = (p: string) => setPerms((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])));
  const roleName = (id: string) => roles.data?.data.find((r) => r.id === id)?.name ?? id;

  return (
    <>
      <SettingsSection title="Invite someone" description="They get an email with a link that works for 7 days and join with exactly the role you pick.">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => {
              await api.post("/invitations", { email: email.trim(), role_id: roleId });
              setEmail("");
              await qc.invalidateQueries({ queryKey: ["invitations"] });
            });
          }}
        >
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Role">
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.data?.data.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary" type="submit" disabled={!email}>
            Send invitation
          </button>
        </form>
        {invites.data && invites.data.data.length > 0 && (
          <ul className="plain-list" aria-label="Pending invitations">
            {invites.data.data.map((i) => (
              <li key={i.id}>
                {i.email} <span className="muted">as {roleName(i.role_id)}, expires {new Date(i.expires_at).toLocaleDateString()}</span>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => void run(async () => {
                  await api.delete(`/invitations/${i.id}`);
                  await qc.invalidateQueries({ queryKey: ["invitations"] });
                })}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title="Roles" description="Built-in roles cannot be changed. Custom roles combine permissions; nobody can grant a permission they do not have.">
        <ul className="plain-list">
          {roles.data?.data.map((r) => (
            <li key={r.id}>
              <strong>{r.name}</strong> {r.system ? <em>(built in)</em> : null} <span className="muted">{r.description}</span>
              <details>
                <summary>{r.permissions.length} permissions</summary>
                <p>{r.permissions.join(", ")}</p>
              </details>
              {!r.system && (
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => void run(async () => {
                  await api.delete(`/roles/${r.id}`);
                  await qc.invalidateQueries({ queryKey: ["roles"] });
                })}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSection title="New custom role">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => {
              await api.post("/roles", { name: name.trim(), base_role: base, permissions: [...perms] });
              setName("");
              await qc.invalidateQueries({ queryKey: ["roles"] });
            });
          }}
        >
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </Field>
          <Field label="Sees conversations like" hint="Managers see every conversation; agents only those assigned to them or their inbox.">
            <select value={base} onChange={(e) => setBase(e.target.value as "agent" | "manager")}>
              <option value="agent">an agent</option>
              <option value="manager">a manager</option>
            </select>
          </Field>
          <fieldset>
            <legend>Permissions</legend>
            {ALL.map((p) => (
              <label key={p} className="check">
                <input type="checkbox" checked={perms.has(p)} onChange={() => toggle(p)} /> {p}
              </label>
            ))}
          </fieldset>
          <button className="btn btn-primary" type="submit" disabled={!name.trim() || perms.size === 0}>
            Create role
          </button>
        </form>
      </SettingsSection>
      {error !== null && <ErrorNotice error={error} />}
    </>
  );
}
