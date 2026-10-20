import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { SettingsSection } from "../components/settings/SettingsSection";
import { ErrorNotice } from "../ui";
import { Field } from "../ui";
import { formatDateTime } from "../lib/time";
import { useAdmin } from "./AdminContext";
import { adminApi } from "./adminApi";

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

export function WorkspacesPage() {
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: () => adminApi.get<Record<string, any>>("/stats") });
  const list = useQuery({ queryKey: ["admin", "workspaces", applied, cursor], queryFn: () => adminApi.get<{ data: Row[]; next_cursor: string | null }>("/workspaces", { search: applied, cursor, limit: 25 }) });
  return (
    <>
      <SettingsSection title="Overview" description="Across every workspace on this installation.">
        {stats.data && (
          <dl className="stat-grid">
            {[
              ["Workspaces", stats.data.workspaces],
              ["Suspended", stats.data.suspended],
              ["New in 7 days", stats.data.new_last_7_days],
              ["Members", stats.data.members],
              ["Payment past due", stats.data.past_due],
              ["Credits outstanding", stats.data.credits_outstanding],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <dt>{String(k)}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </SettingsSection>
      <SettingsSection title="Workspaces">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setCursors([]);
            setApplied(search.trim());
          }}
        >
          <label className="sr-only" htmlFor="ws-search">Search workspaces</label>
          <input id="ws-search" value={search} placeholder="Name, workspace id or member email" onChange={(e) => setSearch(e.target.value)} />
          <button type="submit" className="btn btn-outline">Search</button>
        </form>
        {list.isError && <ErrorNotice error={list.error} />}
        <table className="table">
          <caption className="sr-only">Workspaces</caption>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Plan</th><th scope="col">Members</th><th scope="col">Credits</th><th scope="col">Billing</th><th scope="col">Created</th></tr>
          </thead>
          <tbody>
            {list.data?.data.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link to={`/admin/workspaces/${w.id}`}>{w.name}</Link> {w.suspended && <span className="tag">Suspended</span>}
                </td>
                <td>{w.plan}</td>
                <td>{w.members}</td>
                <td>{w.credit_balance}</td>
                <td>{w.billing_status ?? "none"}</td>
                <td>{formatDateTime(w.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <button type="button" className="btn btn-ghost" disabled={!cursors.length} onClick={() => setCursors((c) => c.slice(0, -1))}>Newer</button>
          <button type="button" className="btn btn-ghost" disabled={!list.data?.next_cursor} onClick={() => list.data?.next_cursor && setCursors((c) => [...c, list.data!.next_cursor!])}>Older</button>
        </div>
      </SettingsSection>
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
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: refresh });
  const impersonate = useMutation({
    mutationFn: () => adminApi.post<{ token: string }>(`/workspaces/${id}/impersonate`, { reason }),
    onSuccess: (r) => {
      // the token travels in the URL fragment (never sent to a server) and the opened page removes it from the address bar at once
      window.open(`/impersonate#token=${encodeURIComponent(r.token)}`, "_blank", "noopener,noreferrer");
      refresh();
    },
  });

  if (q.isPending) return <p role="status" className="muted">Loading…</p>;
  if (q.isError) return <ErrorNotice error={q.error} />;
  const d = q.data;
  const needReason = reason.trim().length < 3;
  return (
    <>
      <SettingsSection title={d.name} description={`${d.id} · created ${formatDateTime(d.created_at)}`} actions={d.suspended ? <span className="tag">Suspended</span> : undefined}>
        <p className="stat"><strong>{d.plan}</strong> plan · {d.seats.used} of {d.seats.limit} seats · {d.credit_balance} credits</p>
        <p className="muted">
          Last 30 days: {d.usage_30d.conversations_started} conversations started, {d.usage_30d.messages_in_those_conversations} messages in them · {d.totals.rooms} conversations and {d.totals.contacts} contacts in total
        </p>
        {d.suspended && <p className="notice notice-danger" role="note">Suspended: {d.suspended_reason}</p>}
        {d.billing && (
          <p className="muted">
            Billing: {d.billing.status}
            {d.billing.grace_until ? ` · grace until ${formatDateTime(d.billing.grace_until)}` : ""}
            {d.billing.cancel_at_period_end ? " · cancels at period end" : ""}
            {d.billing.auto_recharge ? " · auto-recharge on" : ""}
            {d.billing.connect_charges_enabled ? " · takes customer payments" : ""}
          </p>
        )}
        {d.tier_override && <p className="muted">Rate-limit tier override: {d.tier_override.tier}{d.tier_override.note ? ` (${d.tier_override.note})` : ""}</p>}
      </SettingsSection>

      <SettingsSection title="Actions" description="Every action needs a reason, is recorded in the audit log, and appears in the workspace's own audit log.">
        <Field label="Reason" hint="At least 3 characters. Used by the actions below that need one.">
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="row wrap">
          <button type="button" className="btn btn-outline" disabled={needReason || impersonate.isPending || d.suspended} onClick={() => impersonate.mutate()}>
            Open read-only support view (15 min)
          </button>
          {canChange && !d.suspended && (
            <button type="button" className="btn btn-danger-ghost" disabled={needReason || act.isPending} onClick={() => act.mutate(() => adminApi.post(`/workspaces/${id}/suspend`, { reason }))}>
              Suspend workspace
            </button>
          )}
          {canChange && d.suspended && (
            <button type="button" className="btn btn-primary" disabled={act.isPending} onClick={() => act.mutate(() => adminApi.post(`/workspaces/${id}/unsuspend`, { reason }))}>
              Unsuspend
            </button>
          )}
        </div>
        {canChange && (
          <>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                act.mutate(async () => {
                  await adminApi.post(`/workspaces/${id}/credits`, { amount: Number(credits.amount), note: credits.note || reason }, { "Idempotency-Key": crypto.randomUUID() });
                  setCredits({ amount: "", note: "" });
                });
              }}
            >
              <label className="sr-only" htmlFor="adj-amount">Credits to add (negative to remove)</label>
              <input id="adj-amount" type="number" step={1} value={credits.amount} placeholder="Credits (+/-)" onChange={(e) => setCredits((c) => ({ ...c, amount: e.target.value }))} />
              <label className="sr-only" htmlFor="adj-note">Note</label>
              <input id="adj-note" value={credits.note} placeholder="Note (defaults to the reason)" onChange={(e) => setCredits((c) => ({ ...c, note: e.target.value }))} />
              <button type="submit" className="btn btn-outline" disabled={!Number.isInteger(Number(credits.amount)) || Number(credits.amount) === 0 || (credits.note || reason).trim().length < 3 || act.isPending}>Adjust credits</button>
            </form>
            <div className="row">
              <label className="sr-only" htmlFor="tier">Rate-limit tier</label>
              <select id="tier" value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">Follow the plan</option>
                <option value="free">free</option>
                <option value="pro">pro</option>
                <option value="business">business</option>
              </select>
              <button type="button" className="btn btn-outline" disabled={act.isPending} onClick={() => act.mutate(() => adminApi.put(`/workspaces/${id}/tier`, { tier: tier || null, note: reason || undefined }))}>
                Set tier override
              </button>
            </div>
          </>
        )}
        {(act.isError || impersonate.isError) && <ErrorNotice error={act.error ?? impersonate.error} />}
      </SettingsSection>

      <SettingsSection title="Members">
        <table className="table">
          <caption className="sr-only">Members</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Seat</th></tr></thead>
          <tbody>{d.members.map((m) => <tr key={m.id}><td>{m.name}</td><td>{m.email}</td><td>{m.role}</td><td>{m.live_seat ? "live" : "no"}</td></tr>)}</tbody>
        </table>
      </SettingsSection>

      <SettingsSection title="Credit ledger">
        <table className="table">
          <caption className="sr-only">Recent credit activity</caption>
          <thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">Change</th><th scope="col">Balance</th><th scope="col">Reference</th></tr></thead>
          <tbody>{d.ledger.map((l) => <tr key={l.id}><td>{formatDateTime(l.created_at)}</td><td>{l.kind}</td><td>{l.delta > 0 ? `+${l.delta}` : l.delta}</td><td>{l.balance_after}</td><td>{l.ref}</td></tr>)}</tbody>
        </table>
      </SettingsSection>

      <SettingsSection title="Recent audit" actions={<Link to={`/admin/audit?workspace_id=${d.id}`}>See all</Link>}>
        <ul className="plain">{d.audit.map((a) => <li key={a.id}>{formatDateTime(a.created_at)} · {a.actor_type} · {a.action}</li>)}</ul>
      </SettingsSection>
    </>
  );
}
