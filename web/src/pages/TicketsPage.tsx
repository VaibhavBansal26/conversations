import { CheckCheck, Search, Ticket as TicketIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useInboxes, useMembers } from "../api/hooks";
import { useTicketActions, useTickets, useTicketCounts } from "../api/ticketHooks";
import type { Ticket, TicketStatus } from "../api/types";
import { useCan } from "../auth/AuthContext";
import { TicketChip } from "../components/tickets/TicketChip";
import { formatRelative } from "../lib/time";
import { handlerLabel, PRIORITY_LABEL, TICKET_STATUS_LABEL } from "../lib/tickets";
import { Badge, Button, EmptyState, ErrorNotice, Input, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, toast } from "../ui";

const STATUS_OPTIONS = [
  { value: "live", label: "All open tickets" },
  { value: "waiting_for_human", label: TICKET_STATUS_LABEL.waiting_for_human },
  { value: "new,bot_handling", label: "New and with the AI agent" },
  { value: "open", label: TICKET_STATUS_LABEL.open },
  { value: "pending_customer", label: TICKET_STATUS_LABEL.pending_customer },
  { value: "resolved", label: TICKET_STATUS_LABEL.resolved },
  { value: "closed", label: TICKET_STATUS_LABEL.closed },
  { value: "all", label: "Everything" },
];
const HANDLER_OPTIONS = [
  { value: "", label: "Anyone" },
  { value: "me", label: "Me" },
  { value: "human", label: "People" },
  { value: "bot", label: "AI agents" },
  { value: "unassigned", label: "Nobody yet" },
];

/** Ticket queue: filter by status, handler and department; select several and resolve or close them together. */
export function TicketsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "live";
  const handler = params.get("handler") ?? "";
  const department = params.get("department") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const canClose = useCan("tickets:close");
  const members = useMembers().data;
  const inboxes = useInboxes().data ?? [];
  const names = useMemo(() => ({ members: new Map((members ?? []).map((m) => [m.id, m.name])) }), [members]);
  const deptName = useMemo(() => new Map(inboxes.map((i) => [i.id, i.name])), [inboxes]);
  const query = useTickets({ status, handler: handler || undefined, department_id: department || undefined, q: q || undefined });
  const counts = useTicketCounts();
  const actions = useTicketActions();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const rows: Ticket[] = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);

  const set = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    setParams(p, { replace: true });
    setSelected(new Set());
  };
  useEffect(() => {
    if (search.trim() === q) return;
    const t = setTimeout(() => set({ q: search.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((cur) => (cur.has(id) ? new Set([...cur].filter((x) => x !== id)) : new Set([...cur, id])));
  const bulk = (action: "resolve" | "close") =>
    actions.bulk.mutate(
      { ticket_ids: [...selected], action },
      {
        onSuccess: (r) => {
          toast({ title: `${r.succeeded} ticket${r.succeeded === 1 ? "" : "s"} ${action === "close" ? "closed" : "resolved"}${r.failed ? `, ${r.failed} could not be changed` : ""}`, tone: r.failed ? "error" : "success" });
          setSelected(new Set());
        },
      },
    );

  const c = counts.data;
  const summary: { status: TicketStatus; label: string }[] = [
    { status: "waiting_for_human", label: "Waiting for a person" },
    { status: "bot_handling", label: "With the AI agent" },
    { status: "open", label: "Open" },
    { status: "pending_customer", label: "Waiting for customer" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="shrink-0 border-b border-border px-4 pb-3 pt-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold leading-tight tracking-tight">Tickets</h1>
            <p className="text-xs text-subtle">An episode of support inside a conversation. {c ? `${c.total_live} open` : ""}</p>
          </div>
          <ul className="flex flex-wrap gap-2" aria-label="Open tickets by status">
            {summary.map((s) => (
              <li key={s.status}>
                <button
                  type="button"
                  onClick={() => set({ status: s.status })}
                  aria-pressed={status === s.status}
                  className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[13px] hover:bg-surface-2 aria-pressed:border-primary aria-pressed:bg-primary-soft"
                >
                  <span className="font-semibold tabular-nums">{c?.[s.status] ?? 0}</span>
                  <span className="text-muted-foreground">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-subtle" aria-hidden="true" />
            <Input aria-label="Search tickets by number or subject" placeholder="Search number or subject" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select size="md" aria-label="Status" className="w-52" value={status} onValueChange={(v) => set({ status: v === "live" ? "" : v })} options={STATUS_OPTIONS} />
          <Select aria-label="Handled by" className="w-36" value={handler} onValueChange={(v) => set({ handler: v })} options={HANDLER_OPTIONS} />
          <Select
            aria-label="Department"
            className="w-44"
            value={department}
            onValueChange={(v) => set({ department: v })}
            options={[{ value: "", label: "Every department" }, ...inboxes.map((i) => ({ value: i.id, label: i.name }))]}
          />
        </div>
        {selected.size > 0 && canClose && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-primary-soft px-3 py-2 text-[13px]" role="region" aria-label="Bulk actions">
            <strong>{selected.size} selected</strong>
            <Button size="sm" variant="outline" loading={actions.bulk.isPending} onClick={() => bulk("resolve")}>
              <CheckCheck /> Resolve
            </Button>
            <Button size="sm" variant="outline" loading={actions.bulk.isPending} onClick={() => bulk("close")}>
              Close
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending && (
          <div className="space-y-2 p-4" role="status" aria-label="Loading tickets">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}
        {query.isError && (
          <div className="p-4">
            <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
          </div>
        )}
        {query.data && rows.length === 0 && (
          <EmptyState icon={TicketIcon} title="No tickets here" hint="A ticket opens with a customer's first message and ends when it is resolved. Change the filters to see more." className="py-20" />
        )}
        {rows.length > 0 && (
          <>
            <Table className="hidden md:table">
              <caption className="sr-only">Tickets</caption>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col" className="w-10">
                    {canClose && (
                      <input
                        type="checkbox"
                        aria-label="Select all tickets on this page"
                        className="size-4 accent-[var(--color-primary)]"
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                      />
                    )}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col">Ticket</TableHeaderCell>
                  <TableHeaderCell scope="col">Customer</TableHeaderCell>
                  <TableHeaderCell scope="col">Handled by</TableHeaderCell>
                  <TableHeaderCell scope="col">Department</TableHeaderCell>
                  <TableHeaderCell scope="col">Priority</TableHeaderCell>
                  <TableHeaderCell scope="col" className="text-right">
                    Last activity
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((t) => (
                  <TableRow key={t.id} data-testid="ticket-row">
                    <TableCell>
                      {canClose && <input type="checkbox" aria-label={`Select ticket ${t.number}`} className="size-4 accent-[var(--color-primary)]" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <Link to={`/inbox/${t.room_id}`} className="flex items-center gap-2 font-medium hover:underline">
                        <TicketChip number={t.number} status={t.status} />
                        <span className="truncate">{t.subject}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-40 truncate">{t.contact?.name || t.contact?.email || "Visitor"}</TableCell>
                    <TableCell>{handlerLabel(t.handler, names)}</TableCell>
                    <TableCell>{t.department_id ? (deptName.get(t.department_id) ?? "Department") : <span className="text-subtle">None</span>}</TableCell>
                    <TableCell>{t.priority >= 2 ? <Badge tone={t.priority === 3 ? "danger" : "warning"}>{PRIORITY_LABEL[t.priority]}</Badge> : <span className="text-subtle">{PRIORITY_LABEL[t.priority]}</span>}</TableCell>
                    <TableCell className="whitespace-nowrap text-right text-muted-foreground">{formatRelative(t.last_activity_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ul className="divide-y divide-border md:hidden" aria-label="Tickets">
              {rows.map((t) => (
                <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                  {canClose && <input type="checkbox" aria-label={`Select ticket ${t.number}`} className="mt-1 size-5 accent-[var(--color-primary)]" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />}
                  <Link to={`/inbox/${t.room_id}`} className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <TicketChip number={t.number} status={t.status} />
                      <small className="ml-auto text-xs text-subtle">{formatRelative(t.last_activity_at)}</small>
                    </span>
                    <span className="mt-1 block truncate font-medium">{t.subject}</span>
                    <small className="text-xs text-muted-foreground">
                      {t.contact?.name || "Visitor"} · {handlerLabel(t.handler, names)}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
            {query.hasNextPage && (
              <div className="p-4 text-center">
                <Button variant="outline" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
