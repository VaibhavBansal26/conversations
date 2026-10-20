import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { useCan } from "../auth/AuthContext";
import { BarChart, LineChart } from "../components/charts/Charts";
import { ErrorNotice } from "../ui";

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
  { id: 7, label: "Last 7 days" },
  { id: 30, label: "Last 30 days" },
  { id: 90, label: "Last 90 days" },
];

export function AnalyticsPage() {
  const allowed = useCan("analytics:read");
  const [days, setDays] = useState(30);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range = () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400_000);
    return { from: from.toISOString(), to: to.toISOString(), tz };
  };
  const ov = useQuery({ queryKey: ["analytics", "overview", days], queryFn: () => api.get<Overview>("/analytics/overview", range()), enabled: allowed });
  const opened = useQuery({ queryKey: ["analytics", "opened", days], queryFn: () => api.get<Series>("/analytics/timeseries", { ...range(), metric: "rooms_opened", interval: "day" }), enabled: allowed });
  const fr = useQuery({ queryKey: ["analytics", "fr", days], queryFn: () => api.get<Series>("/analytics/timeseries", { ...range(), metric: "first_response_p50", interval: "day" }), enabled: allowed });
  const backlog = useQuery({ queryKey: ["analytics", "backlog", days], queryFn: () => api.get<Series>("/analytics/timeseries", { ...range(), metric: "backlog", interval: "day" }), enabled: allowed });

  if (!allowed) {
    return (
      <main id="main" className="analytics">
        <h1>Analytics</h1>
        <p>Your role does not include analytics. Ask a workspace owner for access.</p>
        <Link to="/inbox">Back to inbox</Link>
      </main>
    );
  }
  const day = (t: string) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const pts = (s?: Series) => (s?.points ?? []).map((p) => ({ label: day(p.t), value: p.value }));
  const o = ov.data;
  const cards = o
    ? [
        ["Conversations opened", String(o.rooms_opened)],
        ["Conversations closed", String(o.rooms_closed)],
        ["Messages received / sent", `${o.messages_in} / ${o.messages_out}`],
        ["First response (median, 90th)", `${duration(o.first_response_p50_s)}, ${duration(o.first_response_p90_s)}`],
        ["Resolution (median, 90th)", `${duration(o.resolution_p50_s)}, ${duration(o.resolution_p90_s)}`],
        ["Customer satisfaction", o.csat_avg === null ? "no ratings yet" : `${o.csat_avg} / 5 (${o.csat_count} ratings)`],
      ]
    : [];
  return (
    <main id="main" className="analytics">
      <header>
        <Link to="/inbox" className="back-link">
          Back to inbox
        </Link>
        <h1>Analytics</h1>
        <label>
          Period{" "}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <p className="muted">Response and resolution times count office hours only when your workspace has them enabled, and exclude time a conversation was snoozed. Bots and internal notes never count as a response.</p>
      {ov.isError && <ErrorNotice error={ov.error} />}
      <section aria-label="Summary" className="cards">
        {cards.map(([k, v]) => (
          <div key={k} className="card">
            <h2>{k}</h2>
            <p>{v}</p>
          </div>
        ))}
      </section>
      {opened.data && <BarChart title="Conversations opened per day" summary={`${opened.data.points.reduce((a, p) => a + p.value, 0)} conversations opened over ${days} days.`} points={pts(opened.data)} unit="Conversations" />}
      {fr.data && <LineChart title="Median first response per day" summary="Median time from a customer's first message to a person's first reply, per day." points={pts(fr.data)} unit="Seconds" format={(v) => duration(v)} />}
      {backlog.data && <LineChart title="Open conversations at the end of each day" summary="Backlog: conversations opened and not yet closed." points={pts(backlog.data)} unit="Open conversations" />}
      {o && o.by_agent.length > 0 && (
        <section aria-label="By teammate">
          <h2>By teammate</h2>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Teammate</th>
                <th scope="col">Conversations</th>
                <th scope="col">Avg first response</th>
                <th scope="col">Avg resolution</th>
              </tr>
            </thead>
            <tbody>
              {o.by_agent.map((a) => (
                <tr key={a.agent_key}>
                  <th scope="row">{a.agent_name ?? "Teammate"}</th>
                  <td>{a.rooms_handled}</td>
                  <td>{duration(a.avg_first_response_s)}</td>
                  <td>{duration(a.avg_resolution_s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
