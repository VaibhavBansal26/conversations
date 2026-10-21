import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useInboxes } from "../api/hooks";
import { Card, CardContent, CardHeader, CardTitle, ErrorNotice, Skeleton, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "../ui";

export interface SupportOverview {
  tickets: {
    opened: number;
    resolved: number;
    by_resolution: Record<string, number>;
    containment_rate: number | null;
    handoff_rate: number | null;
    handoff_reasons: { reason: string; count: number }[];
    wait_for_human_p50_s: number | null;
    sla_first_response_breaches: number;
    sla_resolution_breaches: number;
    csat: { bot_avg: number | null; bot_count: number; human_avg: number | null; human_count: number };
    queue_length_now: number;
  };
  by_department: { department_id: string | null; tickets: number; handoffs: number; resolved: number; csat_avg: number | null; sla_breaches: number }[];
  ai_agents: { agent_key: string; turns: number; answered: number; handoffs: number; resolved: number; refused: number; helpful: number; not_helpful: number }[];
  calls: { total: number; answered: number; missed: number; declined: number; failed: number; total_duration_s: number; avg_duration_s: number | null; by_transport: { webrtc: number; phone: number }; by_kind: { voice: number; video: number } };
}

const REASON: Record<string, string> = {
  customer_requested_human: "Asked for a person", low_confidence: "AI not confident", no_answer: "No answer found", repeated_rephrase: "Rephrased repeatedly", negative_sentiment: "Upset customer", high_urgency: "Urgent",
  sensitive_topic: "Sensitive topic", vip_contact: "VIP contact", max_turns: "Turn limit", outside_hours: "AI outside hours", suspicious_input: "Suspicious input", unsafe_answer: "Answer blocked", suggest_only: "Suggest-only mode",
  tool_failure: "Action failed", call_requested: "Asked for a call", transfer: "Transferred", sla_escalation: "Service level", agent_unavailable: "Person unavailable", unknown: "Not recorded",
};
const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const dur = (s: number | null) => (s === null ? "n/a" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <h3 className="text-[13px] font-medium text-muted-foreground">{label}</h3>
      <p className="text-2xl font-semibold tabular-nums leading-none">{value}</p>
      <p className="min-h-4 text-xs text-subtle">{sub}</p>
    </Card>
  );
}

/** Tickets, AI agents, departments and calls for the period of the dashboard. */
export function SupportAnalytics({ range, days }: { range: () => { from: string; to: string; tz: string }; days: number }) {
  const q = useQuery({ queryKey: ["analytics", "support", days], queryFn: () => api.get<SupportOverview>("/analytics/support", range()) });
  const inboxes = useInboxes().data ?? [];
  const name = (id: string | null) => (id === null ? "No department" : inboxes.find((i) => i.id === id)?.name ?? "A deleted department");
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton className="h-40 rounded-lg" />;
  const { tickets: t, calls: c } = q.data;
  const maxReason = Math.max(1, ...t.handoff_reasons.map((r) => r.count));
  return (
    <section aria-label="Support" className="flex flex-col gap-4">
      <h2 className="text-[15px] font-semibold">Support</h2>
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3">
        <Tile label="Tickets opened" value={String(t.opened)} sub={`${t.resolved} resolved, ${t.queue_length_now} waiting for a person now`} />
        <Tile label="Resolved by the AI agent" value={pct(t.containment_rate)} sub="of the tickets it worked on, without a person" />
        <Tile label="Handed to a person" value={pct(t.handoff_rate)} sub={`${t.by_resolution.bot_resolved ?? 0} by AI, ${t.by_resolution.human_resolved ?? 0} by people`} />
        <Tile label="Wait for a person (median)" value={dur(t.wait_for_human_p50_s)} sub="from the hand-off to the first reply" />
        <Tile label="Service level breaches" value={String(t.sla_first_response_breaches + t.sla_resolution_breaches)} sub={`${t.sla_first_response_breaches} first response, ${t.sla_resolution_breaches} resolution`} />
        <Tile label="Satisfaction: AI / people" value={`${t.csat.bot_avg ?? "n/a"} / ${t.csat.human_avg ?? "n/a"}`} sub={`${t.csat.bot_count} and ${t.csat.human_count} ratings`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Why tickets go to a person</CardTitle>
        </CardHeader>
        <CardContent>
          {t.handoff_reasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tickets were handed over in this period.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {t.handoff_reasons.map((r) => (
                <li key={r.reason}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="font-medium">{REASON[r.reason] ?? r.reason}</span>
                    <span className="tabular-nums text-muted-foreground">{r.count}</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                    <div className="h-full bg-primary" style={{ width: `${(r.count / maxReason) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {q.data.by_department.length > 0 && (
        <Table aria-label="By department">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">Department</TableHeaderCell>
              <TableHeaderCell scope="col">Tickets</TableHeaderCell>
              <TableHeaderCell scope="col">Handed over</TableHeaderCell>
              <TableHeaderCell scope="col">Resolved</TableHeaderCell>
              <TableHeaderCell scope="col">Satisfaction</TableHeaderCell>
              <TableHeaderCell scope="col">Breaches</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {q.data.by_department.map((d) => (
              <TableRow key={d.department_id ?? "none"}>
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  {name(d.department_id)}
                </th>
                <TableCell className="tabular-nums">{d.tickets}</TableCell>
                <TableCell className="tabular-nums">{d.handoffs}</TableCell>
                <TableCell className="tabular-nums">{d.resolved}</TableCell>
                <TableCell className="tabular-nums">{d.csat_avg ?? "n/a"}</TableCell>
                <TableCell className="tabular-nums">{d.sla_breaches}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {q.data.ai_agents.length > 0 && (
        <Table aria-label="By AI agent">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">AI agent</TableHeaderCell>
              <TableHeaderCell scope="col">Turns</TableHeaderCell>
              <TableHeaderCell scope="col">Answered</TableHeaderCell>
              <TableHeaderCell scope="col">Handed over</TableHeaderCell>
              <TableHeaderCell scope="col">Helpful / not</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {q.data.ai_agents.map((a, i) => (
              <TableRow key={a.agent_key}>
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  AI agent {i + 1}
                </th>
                <TableCell className="tabular-nums">{a.turns}</TableCell>
                <TableCell className="tabular-nums">{a.answered}</TableCell>
                <TableCell className="tabular-nums">{a.handoffs}</TableCell>
                <TableCell className="tabular-nums">
                  {a.helpful} / {a.not_helpful}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
        <Tile label="Calls" value={String(c.total)} sub={`${c.by_transport.webrtc} in the browser, ${c.by_transport.phone} by phone`} />
        <Tile label="Answered" value={String(c.answered)} sub={`${c.declined} declined, ${c.failed} failed`} />
        <Tile label="Missed" value={String(c.missed)} sub="nobody picked up" />
        <Tile label="Call length" value={dur(c.avg_duration_s)} sub={`${dur(c.total_duration_s)} in total`} />
      </div>
    </section>
  );
}
