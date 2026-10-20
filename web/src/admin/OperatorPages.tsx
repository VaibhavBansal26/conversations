import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { SettingsSection } from "../components/settings/SettingsSection";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { formatDateTime } from "../lib/time";
import { useAdmin } from "./AdminContext";
import { adminApi } from "./adminApi";

interface AuditRow {
  id: string;
  workspace_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export function AuditPage() {
  const [params] = useSearchParams();
  const [action, setAction] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const workspace_id = params.get("workspace_id") ?? undefined;
  const cursor = cursors.at(-1);
  const q = useQuery({ queryKey: ["admin", "audit", workspace_id, action, cursor], queryFn: () => adminApi.get<{ data: AuditRow[]; next_cursor: string | null }>("/audit", { workspace_id, action, cursor, limit: 50 }) });
  return (
    <SettingsSection title="Audit log" description="Append-only. Rows cannot be changed or removed, even by the database user the app runs as." >
      <div className="row">
        <label className="sr-only" htmlFor="audit-action">Action prefix</label>
        <input id="audit-action" value={action} placeholder="Action prefix, e.g. admin. or billing." onChange={(e) => (setCursors([]), setAction(e.target.value))} />
        {workspace_id && <span className="tag">Workspace {workspace_id}</span>}
      </div>
      {q.isError && <ErrorNotice error={q.error} />}
      <table className="table">
        <caption className="sr-only">Audit log</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Detail</th></tr></thead>
        <tbody>
          {q.data?.data.map((r) => (
            <tr key={r.id}>
              <td>{formatDateTime(r.created_at)}</td>
              <td>{r.actor_type}{r.actor_id ? ` ${r.actor_id}` : ""}</td>
              <td>{r.action}</td>
              <td>{r.target}</td>
              <td><code>{JSON.stringify(r.detail)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="btn btn-ghost" disabled={!cursors.length} onClick={() => setCursors((c) => c.slice(0, -1))}>Newer</button>
        <button type="button" className="btn btn-ghost" disabled={!q.data?.next_cursor} onClick={() => q.data?.next_cursor && setCursors((c) => [...c, q.data!.next_cursor!])}>Older</button>
      </div>
    </SettingsSection>
  );
}

export function RateLimitPage() {
  const { canChange } = useAdmin();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "ratelimit"], queryFn: () => adminApi.get<{ lists: { allow: unknown[]; deny: unknown[] }; limited: unknown[] }>("/ratelimit") });
  const [form, setForm] = useState({ entity: "", ttl: "3600", note: "" });
  const add = useMutation({
    mutationFn: () => adminApi.post("/ratelimit/deny", { entity: form.entity.trim(), ttl_seconds: Number(form.ttl), note: form.note || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "ratelimit"] }),
  });
  return (
    <>
      {canChange && (
        <SettingsSection title="Block an entity" description="ip:&lt;address&gt;, ws:&lt;workspace id&gt;, user:&lt;member id&gt;, key:&lt;api key id&gt; or visitor:&lt;session id&gt;. Blocks expire on their own.">
          <form className="row wrap" onSubmit={(e) => (e.preventDefault(), add.mutate())}>
            <label className="sr-only" htmlFor="rl-entity">Entity</label>
            <input id="rl-entity" value={form.entity} placeholder="ip:203.0.113.5" onChange={(e) => setForm((f) => ({ ...f, entity: e.target.value }))} required />
            <label className="sr-only" htmlFor="rl-ttl">Seconds</label>
            <input id="rl-ttl" type="number" min={1} max={2592000} value={form.ttl} onChange={(e) => setForm((f) => ({ ...f, ttl: e.target.value }))} />
            <label className="sr-only" htmlFor="rl-note">Note</label>
            <input id="rl-note" value={form.note} placeholder="Note" onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            <button type="submit" className="btn btn-danger-ghost" disabled={add.isPending}>Block</button>
          </form>
          {add.isError && <ErrorNotice error={add.error} compact />}
        </SettingsSection>
      )}
      <SettingsSection title="Currently blocked and recently limited">
        {q.isError && <ErrorNotice error={q.error} />}
        <pre className="code">{JSON.stringify(q.data, null, 2)}</pre>
      </SettingsSection>
    </>
  );
}

interface AdminRow {
  id: string;
  email: string;
  name: string;
  role: string;
  mfa_enabled: boolean;
  disabled: boolean;
  last_login_at: string | null;
}

export function AdminsPage() {
  const { canChange, admin } = useAdmin();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "admins"], queryFn: () => adminApi.get<{ data: AdminRow[] }>("/admins") });
  const toggle = useMutation({
    mutationFn: (a: AdminRow) => adminApi.post(`/admins/${a.id}/${a.disabled ? "enable" : "disable"}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "admins"] }),
  });
  return (
    <SettingsSection title="Operators" description="Operators are created with the command line (npm run admin -- create); there is no sign-up.">
      {toggle.isError && <ErrorNotice error={toggle.error} />}
      <table className="table">
        <caption className="sr-only">Platform operators</caption>
        <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Two-factor</th><th scope="col">Last sign-in</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {q.data?.data.map((a) => (
            <tr key={a.id}>
              <td>{a.email} {a.disabled && <span className="tag">Disabled</span>}</td>
              <td>{a.role}</td>
              <td>{a.mfa_enabled ? "on" : "not enrolled"}</td>
              <td>{a.last_login_at ? formatDateTime(a.last_login_at) : "never"}</td>
              <td>
                {canChange && a.id !== admin?.id && (
                  <button type="button" className="btn btn-sm btn-outline" disabled={toggle.isPending} onClick={() => toggle.mutate(a)}>
                    {a.disabled ? "Enable" : "Disable"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsSection>
  );
}
