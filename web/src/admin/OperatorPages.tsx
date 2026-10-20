import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { formatDateTime } from "../lib/time";
import { Badge, Button, EmptyState, ErrorNotice, Field, Input, Skeleton, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, toast } from "../ui";
import { useAdmin } from "./AdminContext";
import { adminApi } from "./adminApi";
import { Pager, Panel } from "./Panel";

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

const Head = ({ cols }: { cols: string[] }) => (
  <TableHead>
    <TableRow>
      {cols.map((h) => (
        <TableHeaderCell key={h} scope="col">
          {h}
        </TableHeaderCell>
      ))}
    </TableRow>
  </TableHead>
);

export function AuditPage() {
  const [params] = useSearchParams();
  const [action, setAction] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const workspace_id = params.get("workspace_id") ?? undefined;
  const cursor = cursors.at(-1);
  const q = useQuery({ queryKey: ["admin", "audit", workspace_id, action, cursor], queryFn: () => adminApi.get<{ data: AuditRow[]; next_cursor: string | null }>("/audit", { workspace_id, action, cursor, limit: 50 }) });
  return (
    <Panel title="Audit log" description="Append-only. Rows cannot be changed or removed, even by the database user the app runs as.">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="audit-action">
          Action prefix
        </label>
        <Input id="audit-action" className="max-w-sm" value={action} placeholder="Action prefix, e.g. admin. or billing." onChange={(e) => (setCursors([]), setAction(e.target.value))} />
        {workspace_id && <Badge tone="primary">Workspace {workspace_id}</Badge>}
      </div>
      {q.isError && <ErrorNotice error={q.error} />}
      <Table>
        <caption className="sr-only">Audit log</caption>
        <Head cols={["When", "Who", "Action", "Target", "Detail"]} />
        <TableBody>
          {q.data?.data.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.created_at)}</TableCell>
              <TableCell>
                {r.actor_type}
                {r.actor_id ? ` ${r.actor_id}` : ""}
              </TableCell>
              <TableCell className="font-mono text-[13px]">{r.action}</TableCell>
              <TableCell>{r.target}</TableCell>
              <TableCell className="max-w-xs">
                <code className="line-clamp-2 break-all font-mono text-xs text-muted-foreground">{JSON.stringify(r.detail)}</code>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.isPending && <Skeleton className="h-24" />}
      {q.data?.data.length === 0 && <EmptyState title="No audit rows" hint="Nothing matches this filter." />}
      <Pager canNewer={!!cursors.length} canOlder={!!q.data?.next_cursor} onNewer={() => setCursors((c) => c.slice(0, -1))} onOlder={() => q.data?.next_cursor && setCursors((c) => [...c, q.data!.next_cursor!])} />
    </Panel>
  );
}

export function RateLimitPage() {
  const { canChange } = useAdmin();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "ratelimit"], queryFn: () => adminApi.get<{ lists: { allow: unknown[]; deny: unknown[] }; limited: unknown[] }>("/ratelimit") });
  const [form, setForm] = useState({ entity: "", ttl: "3600", note: "" });
  const add = useMutation({
    mutationFn: () => adminApi.post("/ratelimit/deny", { entity: form.entity.trim(), ttl_seconds: Number(form.ttl), note: form.note || undefined }),
    onSuccess: () => {
      toast({ title: "Entity blocked", tone: "success" });
      return qc.invalidateQueries({ queryKey: ["admin", "ratelimit"] });
    },
  });
  return (
    <>
      {canChange && (
        <Panel title="Block an entity" description="ip:<address>, ws:<workspace id>, user:<member id>, key:<api key id> or visitor:<session id>. Blocks expire on their own.">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), add.mutate())}>
            <Field label="Entity" className="min-w-52 flex-1">
              <Input value={form.entity} placeholder="ip:203.0.113.5" onChange={(e) => setForm((f) => ({ ...f, entity: e.target.value }))} required />
            </Field>
            <Field label="Seconds" className="w-32">
              <Input type="number" min={1} max={2592000} value={form.ttl} onChange={(e) => setForm((f) => ({ ...f, ttl: e.target.value }))} />
            </Field>
            <Field label="Note" className="min-w-52 flex-1">
              <Input value={form.note} placeholder="Optional" onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <Button type="submit" variant="danger" loading={add.isPending}>
              Block
            </Button>
          </form>
          {add.isError && <ErrorNotice error={add.error} compact />}
        </Panel>
      )}
      <Panel title="Currently blocked and recently limited">
        {q.isError && <ErrorNotice error={q.error} />}
        {q.isPending && <Skeleton className="h-32" />}
        <pre className="max-h-[28rem] overflow-auto rounded-md bg-surface-2 p-4 font-mono text-xs leading-relaxed">{JSON.stringify(q.data, null, 2)}</pre>
      </Panel>
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
    <Panel title="Operators" description="Operators are created with the command line (npm run admin -- create); there is no sign-up.">
      {toggle.isError && <ErrorNotice error={toggle.error} />}
      <Table>
        <caption className="sr-only">Platform operators</caption>
        <TableHead>
          <TableRow>
            {["Email", "Role", "Two-factor", "Last sign-in"].map((h) => (
              <TableHeaderCell key={h} scope="col">
                {h}
              </TableHeaderCell>
            ))}
            <TableHeaderCell scope="col">
              <span className="sr-only">Actions</span>
            </TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {q.data?.data.map((a) => (
            <TableRow key={a.id}>
              <TableCell>
                {a.email} {a.disabled && <Badge tone="danger">Disabled</Badge>}
              </TableCell>
              <TableCell>
                <Badge tone={a.role === "superadmin" ? "primary" : "neutral"}>{a.role}</Badge>
              </TableCell>
              <TableCell>{a.mfa_enabled ? <Badge tone="success">on</Badge> : <Badge tone="warning">not enrolled</Badge>}</TableCell>
              <TableCell className="text-muted-foreground">{a.last_login_at ? formatDateTime(a.last_login_at) : "never"}</TableCell>
              <TableCell className="text-right">
                {canChange && a.id !== admin?.id && (
                  <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate(a)}>
                    {a.disabled ? "Enable" : "Disable"}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.isPending && <Skeleton className="h-24" />}
    </Panel>
  );
}
