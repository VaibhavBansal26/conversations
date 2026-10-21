import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, BarChart3, Minus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { useCan } from "../auth/AuthContext";
import { BarChart, LineChart, Sparkline } from "../components/charts/Charts";
import { SupportAnalytics } from "./SupportAnalytics";
import { Avatar, Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorNotice, Skeleton, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Tabs, TabsList, TabsTrigger, cn } from "../ui";

interface Overview {
  rooms_opened: number;
  rooms_closed: number;
  messages_in: number;
  messages_out: number;
  first_response_p50_s: number | null;
  first_response_p90_s: number | null;
  resolution_p50_s: number | null;
  resolution_p90_s: number | null;
  csat_avg: number | null;
  csat_count: number;
  by_channel: Record<string, { messages_in: number; messages_out: number }>;
  by_agent: { agent_key: string; agent_name?: string; rooms_handled: number; avg_first_response_s: number | null; avg_resolution_s: number | null }[];
}
interface Series {
  points: { t: string; value: number }[];
}

export const duration = (s: number | null): string => {
  if (s === null) return "n/a";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
};

const RANGES = [
  { id: 7, label: "7 days" },
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
];
const CHANNEL_NAME: Record<string, string> = { dm: "Live chat", sms: "SMS", email: "Email" };

/** Percentage change vs the previous period; null when there is nothing to compare against. */
export function delta(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null || before === 0) return null;
  return ((now - before) / before) * 100;
}

function Delta({ pct, lowerIsBetter }: { pct: number | null; lowerIsBetter?: boolean }) {
  if (pct === null) return <span className="text-xs text-subtle">no earlier data</span>;
  const flat = Math.abs(pct) < 0.5;
  const good = flat ? null : lowerIsBetter ? pct < 0 : pct > 0;
  const Arrow = flat ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", good === null ? "text-subtle" : good ? "text-success-text" : "text-danger-text")}>
      <Arrow className="size-3.5" aria-hidden="true" />
      {flat ? "0%" : `${Math.abs(pct).toFixed(pct > 99 ? 0 : 1)}%`}
      <span className="sr-only"> {flat ? "no change" : pct > 0 ? "up" : "down"} versus the previous period</span>
    </span>
  );
}

function Kpi({ label, value, sub, pct, lowerIsBetter, spark }: { label: string; value: string; sub?: string; pct?: number | null; lowerIsBetter?: boolean; spark?: number[] }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <h2 className="text-[13px] font-medium text-muted-foreground">{label}</h2>
      <div className="flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tabular-nums leading-none">{value}</p>
        {spark && <Sparkline values={spark} />}
      </div>
      <div className="flex min-h-4 items-center gap-2">
        {pct !== undefined && <Delta pct={pct} lowerIsBetter={lowerIsBetter} />}
        {sub && <span className="text-xs text-subtle">{sub}</span>}
      </div>
    </Card>
  );
}

export function AnalyticsPage() {
  const allowed = useCan("analytics:read");
  const [days, setDays] = useState(30);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range = (offsetDays = 0) => {
    const to = new Date(Date.now() - offsetDays * 86400_000);
    const from = new Date(to.getTime() - days * 86400_000);
    return { from: from.toISOString(), to: to.toISOString(), tz };
  };
  const ov = useQuery({ queryKey: ["analytics", "overview", days], queryFn: () => api.get<Overview>("/analytics/overview", range()), enabled: allowed });
  const prev = useQuery({ queryKey: ["analytics", "overview-prev", days], queryFn: () => api.get<Overview>("/analytics/overview", range(days)), enabled: allowed });
  const opened = useQuery({ queryKey: ["analytics", "opened", days], queryFn: () => api.get<Series>("/analytics/timeseries", { ...range(), metric: "rooms_opened", interval: "day" }), enabled: allowed });
  const fr = useQuery({ queryKey: ["analytics", "fr", days], queryFn: () => api.get<Series>("/analytics/timeseries", { ...range(), metric: "first_response_p50", interval: "day" }), enabled: allowed });
  const backlog = useQuery({ queryKey: ["analytics", "backlog", days], queryFn: () => api.get<Series>("/analytics/timeseries", { ...range(), metric: "backlog", interval: "day" }), enabled: allowed });

  if (!allowed) {
    return (
      <main id="main" className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <EmptyState icon={BarChart3} title="Analytics is not part of your role" hint="Ask a workspace owner for access." action={<Link to="/inbox" className="text-sm font-medium text-primary-text hover:underline">Back to inbox</Link>} />
        </div>
      </main>
    );
  }
  const day = (t: string) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const pts = (s?: Series) => (s?.points ?? []).map((p) => ({ label: day(p.t), value: p.value }));
  const spark = (s?: Series) => (s?.points ?? []).map((p) => p.value);
  const o = ov.data;
  const p = prev.data;
  const channels = o ? Object.entries(o.by_channel) : [];
  const channelMax = Math.max(1, ...channels.map(([, c]) => c.messages_in + c.messages_out));

  return (
    <main id="main" className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
            <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
              Response and resolution times count office hours only when your workspace has them enabled, and exclude time a conversation was snoozed. Bots and internal notes never count as a response.
            </p>
          </div>
          <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <TabsList aria-label="Period" className="border-b-0 rounded-lg bg-surface-2 p-0.5">
              {RANGES.map((r) => (
                <TabsTrigger key={r.id} value={String(r.id)} aria-label={`Last ${r.label}`} className="-mb-0 rounded-md border-0 px-3 py-1.5 data-[state=active]:bg-surface data-[state=active]:shadow-xs">
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>

        {ov.isError && <ErrorNotice error={ov.error} onRetry={() => void ov.refetch()} />}

        <section aria-label="Summary" className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3">
          {ov.isPending
            ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-lg" />)
            : o && (
                <>
                  <Kpi label="Conversations opened" value={String(o.rooms_opened)} pct={delta(o.rooms_opened, p?.rooms_opened)} spark={spark(opened.data)} />
                  <Kpi label="Conversations closed" value={String(o.rooms_closed)} pct={delta(o.rooms_closed, p?.rooms_closed)} />
                  <Kpi label="Messages received / sent" value={`${o.messages_in} / ${o.messages_out}`} pct={delta(o.messages_in + o.messages_out, p ? p.messages_in + p.messages_out : null)} />
                  <Kpi label="First response (median, 90th)" value={`${duration(o.first_response_p50_s)}, ${duration(o.first_response_p90_s)}`} pct={delta(o.first_response_p50_s, p?.first_response_p50_s)} lowerIsBetter spark={spark(fr.data)} />
                  <Kpi label="Resolution (median, 90th)" value={`${duration(o.resolution_p50_s)}, ${duration(o.resolution_p90_s)}`} pct={delta(o.resolution_p50_s, p?.resolution_p50_s)} lowerIsBetter />
                  <Kpi label="Customer satisfaction" value={o.csat_avg === null ? "no ratings yet" : `${o.csat_avg} / 5 (${o.csat_count} ratings)`} pct={delta(o.csat_avg, p?.csat_avg)} />
                </>
              )}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="lg:col-span-2">
            <CardContent className="pt-5">
              {opened.isPending ? <Skeleton className="h-52" /> : opened.data && <BarChart title="Conversations opened per day" summary={`${opened.data.points.reduce((a, q) => a + q.value, 0)} conversations opened over ${days} days.`} points={pts(opened.data)} unit="Conversations" />}
              {opened.isError && <ErrorNotice error={opened.error} />}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              {fr.isPending ? <Skeleton className="h-52" /> : fr.data && <LineChart title="Median first response per day" summary="Median time from a customer's first message to a person's first reply, per day." points={pts(fr.data)} unit="Seconds" format={(v) => duration(v)} />}
              {fr.isError && <ErrorNotice error={fr.error} />}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              {backlog.isPending ? <Skeleton className="h-52" /> : backlog.data && <LineChart title="Open conversations at the end of each day" summary="Backlog: conversations opened and not yet closed." points={pts(backlog.data)} unit="Open conversations" />}
              {backlog.isError && <ErrorNotice error={backlog.error} />}
            </CardContent>
          </Card>
        </div>

        {channels.length > 0 && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Messages by channel</CardTitle>
              <div className="flex items-center gap-4 text-xs text-muted-foreground" aria-hidden="true">
                <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary" />Received</span>
                <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary/40" />Sent</span>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-4">
                {channels.map(([ch, c]) => (
                  <li key={ch}>
                    <div className="mb-1.5 flex items-baseline justify-between text-sm">
                      <span className="font-medium">{CHANNEL_NAME[ch] ?? ch}</span>
                      <span className="tabular-nums text-muted-foreground">{c.messages_in} received · {c.messages_out} sent</span>
                    </div>
                    <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                      <div className="bg-primary" style={{ width: `${(c.messages_in / channelMax) * 100}%` }} />
                      <div className="bg-primary/40" style={{ width: `${(c.messages_out / channelMax) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <SupportAnalytics range={range} days={days} />

        {o && o.by_agent.length > 0 && (
          <section aria-label="By teammate" className="flex flex-col gap-3">
            <h2 className="text-[15px] font-semibold">By teammate</h2>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">Teammate</TableHeaderCell>
                  <TableHeaderCell scope="col">Conversations</TableHeaderCell>
                  <TableHeaderCell scope="col">Avg first response</TableHeaderCell>
                  <TableHeaderCell scope="col">Avg resolution</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {o.by_agent.map((a) => (
                  <TableRow key={a.agent_key}>
                    <th scope="row" className="px-4 py-3 text-left font-medium">
                      <span className="flex items-center gap-2.5">
                        <Avatar name={a.agent_name ?? "Teammate"} seed={a.agent_key} size="sm" />
                        {a.agent_name ?? "Teammate"}
                      </span>
                    </th>
                    <TableCell className="tabular-nums">{a.rooms_handled}</TableCell>
                    <TableCell className="tabular-nums">{duration(a.avg_first_response_s)}</TableCell>
                    <TableCell className="tabular-nums">{duration(a.avg_resolution_s)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
      </div>
    </main>
  );
}
