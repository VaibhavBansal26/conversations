// Adapted from the legacy UI (see docs/PROVENANCE.md): permission editing as grouped toggles with scope presets.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MailPlus, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { SettingsSection } from "../../components/settings/SettingsSection";
import {
  Badge, Button, Card, Dialog, DialogFooter, EmptyState, ErrorNotice, Field, Input, Select, Sheet, Skeleton, toast,
} from "../../ui";
import { ConfirmDialog } from "./ConfirmDialog";

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

const GROUP_LABEL: Record<string, string> = {
  conversations: "Conversations", contacts: "Contacts", inboxes: "Inboxes", members: "Members", roles: "Roles", settings: "Settings", channels: "Channels", tokens: "Embed tokens",
  templates: "Templates", kb: "Knowledge base", ai: "AI", billing: "Billing", analytics: "Analytics", analytics_identity: "Analytics identity", api_keys: "API keys", audit: "Audit log",
};

/** Permission keys grouped by the area before the colon, in the order the server lists them. */
export function groupPermissions(perms: string[]): { area: string; label: string; items: { key: string; action: string }[] }[] {
  const out: Record<string, { key: string; action: string }[]> = {};
  for (const p of perms) {
    const [area = p, action = ""] = p.split(":");
    (out[area] ??= []).push({ key: p, action });
  }
  return Object.entries(out).map(([area, items]) => ({ area, label: GROUP_LABEL[area] ?? area, items }));
}

export function RoleSettings() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<{ data: Role[] }>("/roles") });
  const invites = useQuery({ queryKey: ["invitations"], queryFn: () => api.get<{ data: Invitation[] }>("/invitations") });
  const [error, setError] = useState<unknown>(null);
  const [inviting, setInviting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [name, setName] = useState("");
  const [base, setBase] = useState<"agent" | "manager">("agent");
  const [perms, setPerms] = useState<Set<string>>(new Set(["conversations:read", "conversations:reply"]));
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("role_agent");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      if (done) toast({ title: done, tone: "success" });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (p: string) => setPerms((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])));
  const roleName = (id: string) => roles.data?.data.find((r) => r.id === id)?.name ?? id;

  return (
    <>
      <SettingsSection
        title="Roles"
        description="Built-in roles cannot be changed. Custom roles combine permissions; nobody can grant a permission they do not have."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setInviting(true)}>
              <MailPlus aria-hidden="true" /> Invite someone
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" /> New custom role
            </Button>
          </div>
        }
      >
        {roles.isPending && (
          <div role="status" aria-label="Loading roles" className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        )}
        {roles.isError && <ErrorNotice error={roles.error} onRetry={() => void roles.refetch()} />}
        <ul className="grid gap-3 lg:grid-cols-2">
          {roles.data?.data.map((r) => (
            <li key={r.id}>
              <Card className="flex h-full flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-[15px]">{r.name}</strong>
                      {r.system ? (
                        <Badge>
                          <Lock className="size-3" aria-hidden="true" /> built in
                        </Badge>
                      ) : (
                        <Badge tone="primary">custom</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">{r.description}</p>
                  </div>
                  {!r.system && (
                    <Button variant="danger-ghost" size="icon-sm" aria-label={`Delete role ${r.name}`} onClick={() => setDeleting(r)}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  )}
                </div>
                <details className="group mt-auto text-[13px]">
                  <summary className="w-fit cursor-pointer rounded text-primary-text hover:underline">{r.permissions.length} permissions</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {groupPermissions(r.permissions).map((g) => (
                      <div key={g.area} className="flex flex-wrap items-center gap-1.5">
                        <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">{g.label}</span>
                        {g.items.map((i) => (
                          <Badge key={i.key} tone="outline" title={i.key}>
                            {i.action}
                          </Badge>
                        ))}
                      </div>
                    ))}
                    <p className="sr-only">{r.permissions.join(", ")}</p>
                  </div>
                </details>
              </Card>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSection title="Pending invitations" description="Invitation links work for 7 days. Revoke one to cancel it.">
        {invites.data && invites.data.data.length === 0 && <EmptyState icon={MailPlus} title="No pending invitations" hint="Invite a teammate with the button above." className="py-8" />}
        {invites.data && invites.data.data.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface" aria-label="Pending invitations">
            {invites.data.data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{i.email}</div>
                  <div className="text-[13px] text-muted-foreground">
                    as {roleName(i.role_id)}, expires {new Date(i.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void run(async () => {
                      await api.delete(`/invitations/${i.id}`);
                      await qc.invalidateQueries({ queryKey: ["invitations"] });
                    }, "Invitation revoked")
                  }
                >
                  <X aria-hidden="true" /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {error !== null && <ErrorNotice error={error} />}

      {inviting && (
        <Dialog title="Invite someone" description="They get an email with a link that works for 7 days and join with exactly the role you pick." onClose={() => setInviting(false)}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                await api.post("/invitations", { email: email.trim(), role_id: roleId });
                setEmail("");
                setInviting(false);
                await qc.invalidateQueries({ queryKey: ["invitations"] });
              }, "Invitation sent");
            }}
          >
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Role">
              <Select value={roleId} onValueChange={setRoleId} options={(roles.data?.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />
            </Field>
            <DialogFooter className="-mx-5 -mb-4">
              <Button variant="ghost" onClick={() => setInviting(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!email}>
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}

      <Sheet open={creating} onOpenChange={setCreating} title="New custom role" side="right" className="w-[min(28rem,96vw)]">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => {
              await api.post("/roles", { name: name.trim(), base_role: base, permissions: [...perms] });
              setName("");
              setCreating(false);
              await qc.invalidateQueries({ queryKey: ["roles"] });
            }, "Role created");
          }}
        >
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
            </Field>
            <Field label="Sees conversations like" hint="Managers see every conversation; agents only those assigned to them or their inbox.">
              <Select
                value={base}
                onValueChange={(v) => setBase(v as "agent" | "manager")}
                options={[
                  { value: "agent", label: "an agent" },
                  { value: "manager", label: "a manager" },
                ]}
              />
            </Field>
            <fieldset className="space-y-3">
              <legend className="mb-1 flex w-full items-center justify-between text-[13px] font-medium">
                Permissions
                <span className="text-xs font-normal text-subtle">{perms.size} selected</span>
              </legend>
              {groupPermissions(ALL).map((g) => (
                <div key={g.area} className="rounded-lg border border-border">
                  <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground">{g.label}</div>
                  <div className="flex flex-col py-1">
                    {g.items.map((i) => (
                      <label key={i.key} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-surface-2">
                        <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={perms.has(i.key)} onChange={() => toggle(i.key)} />
                        <span>{i.key}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </fieldset>
          </div>
          <div className="flex justify-end gap-2 border-t border-border p-3">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim() || perms.size === 0}>
              <ShieldCheck aria-hidden="true" /> Create role
            </Button>
          </div>
        </form>
      </Sheet>

      {deleting && (
        <ConfirmDialog
          title={`Delete role ${deleting.name}?`}
          description="Members who have this role must be moved to another role first."
          confirmLabel="Delete role"
          onConfirm={() =>
            void run(async () => {
              await api.delete(`/roles/${deleting.id}`);
              await qc.invalidateQueries({ queryKey: ["roles"] });
            }, "Role deleted")
          }
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
