import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Search } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { formatDateTime } from "../lib/time";
import {
  Badge, Button, Dialog, DialogFooter, EmptyState, ErrorNotice, Field, Input, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, toast,
} from "../ui";
import { useAdmin } from "./AdminContext";
import { adminApi } from "./adminApi";
import { Pager, Panel } from "./Panel";

interface Row {
  id: string;
  name: string;
  plan: string;
  created_at: string;
  suspended: boolean;
  credit_balance: number;
  members: number;
  billing_status: string | null;
}

const billingTone = (s: string | null) => (s === "active" || s === "trialing" ? "success" : s === "past_due" || s === "unpaid" ? "danger" : "neutral");

export function WorkspacesPage() {
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: () => adminApi.get<Record<string, any>>("/stats") });
  const list = useQuery({ queryKey: ["admin", "workspaces", applied, cursor], queryFn: () => adminApi.get<{ data: Row[]; next_cursor: string | null }>("/workspaces", { search: applied, cursor, limit: 25 }) });
  const tiles: [string, unknown, boolean?][] = stats.data
    ? [
        ["Workspaces", stats.data.workspaces],
        ["Suspended", stats.data.suspended, Number(stats.data.suspended) > 0],
        ["New in 7 days", stats.data.new_last_7_days],
        ["Members", stats.data.members],
        ["Payment past due", stats.data.past_due, Number(stats.data.past_due) > 0],
        ["Credits outstanding", stats.data.credits_outstanding],
      ]
    : [];
  return (
    <>
      <Panel title="Overview" description="Across every workspace on this installation.">
        {stats.isPending && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        )}
        {stats.isError && <ErrorNotice error={stats.error} />}
        {stats.data && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {tiles.map(([k, v, warn]) => (
              <div key={k} className="rounded-lg border border-border bg-surface-2/50 px-4 py-3">
                <dt className="text-xs font-medium text-muted-foreground [overflow-wrap:normal]">{k}</dt>
                <dd className={`mt-1 text-2xl font-semibold tabular-nums ${warn ? "text-danger-text" : ""}`}>{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>
      <Panel title="Workspaces">
        <form
          className="flex gap-2"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setCursors([]);
            setApplied(search.trim());
          }}
        >
          <label className="sr-only" htmlFor="ws-search">
            Search workspaces
          </label>
          <div className="relative max-w-md flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-subtle" aria-hidden="true" />
            <Input id="ws-search" className="pl-9" value={search} placeholder="Name, workspace id or member email" onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {list.isError && <ErrorNotice error={list.error} />}
        <Table>
          <caption className="sr-only">Workspaces</caption>
          <TableHead>
            <TableRow>
              {["Name", "Plan", "Members", "Credits", "Billing", "Created"].map((h) => (
                <TableHeaderCell key={h} scope="col">
                  {h}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {list.data?.data.map((w) => (
              <TableRow key={w.id}>
                <TableCell>
                  <Link to={`/admin/workspaces/${w.id}`} className="font-medium text-primary-text hover:underline">
                    {w.name}
                  </Link>{" "}
                  {w.suspended && <Badge tone="danger">Suspended</Badge>}
                </TableCell>
                <TableCell>
                  <Badge tone="outline">{w.plan}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">{w.members}</TableCell>
                <TableCell className="tabular-nums">{w.credit_balance}</TableCell>
                <TableCell>
                  <Badge tone={billingTone(w.billing_status)}>{w.billing_status ?? "none"}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(w.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {list.isPending && <Skeleton className="h-24" />}
        {list.data && list.data.data.length === 0 && <EmptyState title="No workspaces match" hint="Try a different name, id or email." />}
        <Pager canNewer={!!cursors.length} canOlder={!!list.data?.next_cursor} onNewer={() => setCursors((c) => c.slice(0, -1))} onOlder={() => list.data?.next_cursor && setCursors((c) => [...c, list.data!.next_cursor!])} />
      </Panel>
    </>
  );
}

interface Detail {
  id: string;
  name: string;
  plan: string;
  created_at: string;
  suspended: boolean;
  suspended_reason: string | null;
  credit_balance: number;
  seats: { used: number; limit: number };
  billing: { status: string; current_period_end: string | null; grace_until: string | null; cancel_at_period_end: boolean; auto_recharge: boolean; connect_charges_enabled: boolean } | null;
  tier_override: { tier: string; note: string | null } | null;
  usage_30d: { conversations_started: number; messages_in_those_conversations: number };
  totals: { rooms: number; contacts: number };
  members: { id: string; name: string; email: string; role: string; live_seat: boolean }[];
  ledger: { id: string; kind: string; delta: number; balance_after: number; ref: string | null; created_at: string }[];
  audit: { id: string; actor_type: string; action: string; created_at: string }[];
}

export function WorkspaceDetailPage() {
  const { id = "" } = useParams();
  const { canChange } = useAdmin();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "workspace", id], queryFn: () => adminApi.get<Detail>(`/workspaces/${id}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin", "workspace", id] });
  const [reason, setReason] = useState("");
  const [credits, setCredits] = useState({ amount: "", note: "" });
  const [tier, setTier] = useState("");
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const act = useMutation({
    mutationFn: ({ fn }: { fn: () => Promise<unknown>; done?: string }) => fn(),
    onSuccess: (_r, v) => {
      if (v.done) toast({ title: v.done, tone: "success" });
      refresh();
    },
  });
  const impersonate = useMutation({
    mutationFn: () => adminApi.post<{ token: string }>(`/workspaces/${id}/impersonate`, { reason }),
    onSuccess: (r) => {
      // the token travels in the URL fragment (never sent to a server) and the opened page removes it from the address bar at once
      window.open(`/impersonate#token=${encodeURIComponent(r.token)}`, "_blank", "noopener,noreferrer");
      refresh();
    },
  });

  if (q.isPending)
    return (
      <div role="status" aria-label="Loading workspace" className="flex flex-col gap-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-48" />
      </div>
    );
  if (q.isError) return <ErrorNotice error={q.error} />;
  const d = q.data;
  const needReason = reason.trim().length < 3;
  return (
    <>
      <Link to="/admin" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" /> All workspaces
      </Link>
      <Panel title={d.name} description={`${d.id} · created ${formatDateTime(d.created_at)}`} actions={d.suspended ? <Badge tone="danger">Suspended</Badge> : <Badge tone="success">Active</Badge>}>
        <p className="text-sm">
          <strong>{d.plan}</strong> plan · {d.seats.used} of {d.seats.limit} seats · {d.credit_balance} credits
        </p>
        <p className="text-[13px] text-muted-foreground">
          Last 30 days: {d.usage_30d.conversations_started} conversations started, {d.usage_30d.messages_in_those_conversations} messages in them · {d.totals.rooms} conversations and {d.totals.contacts} contacts in total
        </p>
        {d.suspended && (
          <p className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger-text" role="note">
            Suspended: {d.suspended_reason}
          </p>
        )}
        {d.billing && (
          <p className="text-[13px] text-muted-foreground">
            Billing: {d.billing.status}
            {d.billing.grace_until ? ` · grace until ${formatDateTime(d.billing.grace_until)}` : ""}
            {d.billing.cancel_at_period_end ? " · cancels at period end" : ""}
            {d.billing.auto_recharge ? " · auto-recharge on" : ""}
            {d.billing.connect_charges_enabled ? " · takes customer payments" : ""}
          </p>
        )}
        {d.tier_override && (
          <p className="text-[13px] text-muted-foreground">
            Rate-limit tier override: {d.tier_override.tier}
            {d.tier_override.note ? ` (${d.tier_override.note})` : ""}
          </p>
        )}
      </Panel>

      <Panel title="Actions" description="Every action needs a reason, is recorded in the audit log, and appears in the workspace's own audit log.">
        <Field label="Reason" hint="At least 3 characters. Used by the actions below that need one.">
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={needReason || impersonate.isPending || d.suspended} onClick={() => impersonate.mutate()}>
            <ExternalLink aria-hidden="true" /> Open read-only support view (15 min)
          </Button>
          {canChange && !d.suspended && (
            <Button variant="danger-ghost" disabled={needReason || act.isPending} onClick={() => setConfirmSuspend(true)}>
              Suspend workspace
            </Button>
          )}
          {canChange && d.suspended && (
            <Button disabled={act.isPending} onClick={() => act.mutate({ fn: () => adminApi.post(`/workspaces/${id}/unsuspend`, { reason }), done: "Workspace unsuspended" })}>
              Unsuspend
            </Button>
          )}
        </div>
        {canChange && (
          <>
            <form
              className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                act.mutate({
                  fn: async () => {
                    await adminApi.post(`/workspaces/${id}/credits`, { amount: Number(credits.amount), note: credits.note || reason }, { "Idempotency-Key": crypto.randomUUID() });
                    setCredits({ amount: "", note: "" });
                  },
                  done: "Credits adjusted",
                });
              }}
            >
              <Field label="Credits to add (negative to remove)" className="w-56">
                <Input id="adj-amount" type="number" step={1} value={credits.amount} placeholder="Credits (+/-)" onChange={(e) => setCredits((c) => ({ ...c, amount: e.target.value }))} />
              </Field>
              <Field label="Note" className="min-w-48 flex-1">
                <Input value={credits.note} placeholder="Defaults to the reason" onChange={(e) => setCredits((c) => ({ ...c, note: e.target.value }))} />
              </Field>
              <Button type="submit" variant="outline" disabled={!Number.isInteger(Number(credits.amount)) || Number(credits.amount) === 0 || (credits.note || reason).trim().length < 3 || act.isPending}>
                Adjust credits
              </Button>
            </form>
            <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
              <Field label="Rate-limit tier" className="w-56">
                <Select
                  value={tier}
                  onValueChange={setTier}
                  options={[
                    { value: "", label: "Follow the plan" },
                    { value: "free", label: "free" },
                    { value: "pro", label: "pro" },
                    { value: "business", label: "business" },
                  ]}
                />
              </Field>
              <Button variant="outline" disabled={act.isPending} onClick={() => act.mutate({ fn: () => adminApi.put(`/workspaces/${id}/tier`, { tier: tier || null, note: reason || undefined }), done: "Tier override saved" })}>
                Set tier override
              </Button>
            </div>
          </>
        )}
        {(act.isError || impersonate.isError) && <ErrorNotice error={act.error ?? impersonate.error} />}
      </Panel>

      <Panel title="Members">
        <Table>
          <caption className="sr-only">Members</caption>
          <TableHead>
            <TableRow>
              {["Name", "Email", "Role", "Seat"].map((h) => (
                <TableHeaderCell key={h} scope="col">
                  {h}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {d.members.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.name}</TableCell>
                <TableCell>{m.email}</TableCell>
                <TableCell>
                  <Badge>{m.role}</Badge>
                </TableCell>
                <TableCell>{m.live_seat ? "live" : "no"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel title="Credit ledger">
        <Table>
          <caption className="sr-only">Recent credit activity</caption>
          <TableHead>
            <TableRow>
              {["When", "Type", "Change", "Balance", "Reference"].map((h) => (
                <TableHeaderCell key={h} scope="col">
                  {h}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {d.ledger.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(l.created_at)}</TableCell>
                <TableCell>{l.kind}</TableCell>
                <TableCell className={`tabular-nums ${l.delta > 0 ? "text-success-text" : "text-danger-text"}`}>{l.delta > 0 ? `+${l.delta}` : l.delta}</TableCell>
                <TableCell className="tabular-nums">{l.balance_after}</TableCell>
                <TableCell className="font-mono text-xs">{l.ref}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel title="Recent audit" actions={<Link to={`/admin/audit?workspace_id=${d.id}`} className="text-sm font-medium text-primary-text hover:underline">See all</Link>}>
        <ul className="divide-y divide-border text-sm">
          {d.audit.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-x-3 py-2">
              <span className="text-muted-foreground">{formatDateTime(a.created_at)}</span>
              <span>{a.actor_type}</span>
              <span className="font-mono text-[13px]">{a.action}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {confirmSuspend && (
        <Dialog title="Suspend workspace?" description="Members are signed out of their workspace until it is unsuspended." onClose={() => setConfirmSuspend(false)}>
          <p className="text-sm text-muted-foreground">
            Reason that will be recorded: <strong className="text-foreground">{reason}</strong>
          </p>
          <DialogFooter className="-mx-5 -mb-4 mt-5">
            <Button variant="ghost" onClick={() => setConfirmSuspend(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={act.isPending}
              onClick={() => {
                act.mutate({ fn: () => adminApi.post(`/workspaces/${id}/suspend`, { reason }), done: "Workspace suspended" });
                setConfirmSuspend(false);
              }}
            >
              Confirm suspension
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
