import type { AppContext } from "../context.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";
import { zonedParts } from "../util/time.js";
import { agentKey, EXPORT_MAX_LIMIT, getPepper, identityKey, type Page, type RangeQuery } from "./analytics.js";

/**
 * Analytics of the support side: tickets, AI agents, departments and calls (docs/ANALYTICS.md). Same conventions as the room analytics: keyed
 * hashes instead of ids of people, no free text, no names, additive within API v1.
 */

const num = (v: unknown): number => Number(v ?? 0);
const round = (v: number | null, digits = 2): number | null => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.5 * s.length) - 1)]!;
};
const seconds = (a: string | null, b: string | null): number | null => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);

export interface SupportOverview {
  from: string;
  to: string;
  tickets: {
    opened: number;
    resolved: number;
    by_resolution: Record<"bot_resolved" | "human_resolved" | "abandoned" | "auto_closed" | "merged", number>;
    /** of the tickets an AI agent worked on: the share it resolved without a person (null when no ticket had an AI agent) */
    containment_rate: number | null;
    /** share of opened tickets that were handed to a person */
    handoff_rate: number | null;
    handoff_reasons: { reason: string; count: number }[];
    /** median seconds from the hand-off to the first reply of a person (null without data) */
    wait_for_human_p50_s: number | null;
    sla_first_response_breaches: number;
    sla_resolution_breaches: number;
    csat: { bot_avg: number | null; bot_count: number; human_avg: number | null; human_count: number };
    queue_length_now: number;
  };
  by_department: { department_id: string | null; tickets: number; handoffs: number; resolved: number; csat_avg: number | null; sla_breaches: number }[];
  ai_agents: { agent_key: string; turns: number; answered: number; handoffs: number; resolved: number; refused: number; helpful: number; not_helpful: number }[];
  calls: {
    total: number;
    answered: number;
    missed: number;
    declined: number;
    failed: number;
    total_duration_s: number;
    avg_duration_s: number | null;
    by_transport: Record<"webrtc" | "phone" | "ai", number>;
    by_kind: Record<"voice" | "video" | "ai_voice" | "ai_video", number>;
  };
  /** calls with the AI assistant (also counted in `calls`) */
  ai_calls: {
    total: number;
    total_duration_s: number;
    avg_duration_s: number | null;
    handed_to_person: number;
    handoff_rate: number | null;
    by_engine: { browser: number; realtime: number };
    by_end_reason: Record<string, number>;
    by_handoff_reason: { reason: string; count: number }[];
    /** the realtime engine only: minutes used, and an estimate from AI_REALTIME_COST_PER_MINUTE_USD (null when that is not set: no price is assumed) */
    realtime: { calls: number; minutes: number; estimated_cost_usd: number | null };
    /** the photoreal avatar (ADR 0039): sessions, minutes of video, sessions that fell back to the built-in face, and an estimate from AVATAR_COST_PER_MINUTE_USD */
    photoreal: { sessions: number; minutes: number; fell_back: number; estimated_cost_usd: number | null };
  };
}

export async function supportOverview(ctx: AppContext, ws: string, r: RangeQuery): Promise<SupportOverview> {
  const db = ctx.db.read();
  const from = r.from.toISOString();
  const to = r.to.toISOString();
  const opened = "workspace_id = ? AND opened_at >= ? AND opened_at < ?";
  const op = [ws, from, to];
  const total = num((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE ${opened}`, ...op))!.n);
  const resolved = num((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND resolved_at >= ? AND resolved_at < ?", ...op))!.n);
  const res = await db.all<{ resolution: string | null; n: number }>(`SELECT resolution, COUNT(*) AS n FROM tickets WHERE ${opened} AND resolution IS NOT NULL GROUP BY resolution`, ...op);
  const by_resolution = { bot_resolved: 0, human_resolved: 0, abandoned: 0, auto_closed: 0, merged: 0 };
  for (const x of res) if (x.resolution && x.resolution in by_resolution) by_resolution[x.resolution as keyof typeof by_resolution] = num(x.n);
  const withBot = num((await db.get<{ n: number }>(`SELECT COUNT(DISTINCT t.id) AS n FROM tickets t JOIN ai_turns a ON a.ticket_id = t.id WHERE t.${opened.replace(/ AND /g, " AND t.")}`, ...op))!.n);
  const botResolved = num((await db.get<{ n: number }>(`SELECT COUNT(DISTINCT t.id) AS n FROM tickets t JOIN ai_turns a ON a.ticket_id = t.id WHERE t.${opened.replace(/ AND /g, " AND t.")} AND t.resolution = 'bot_resolved'`, ...op))!.n);
  const handoffs = num((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE ${opened} AND handoff_at IS NOT NULL`, ...op))!.n);
  const reasons = await db.all<{ reason: string; n: number }>(`SELECT COALESCE(handoff_reason, 'unknown') AS reason, COUNT(*) AS n FROM tickets WHERE ${opened} AND handoff_at IS NOT NULL GROUP BY 1 ORDER BY n DESC, reason LIMIT 20`, ...op);
  const waits = await db.all<{ handoff_at: string; first_human_response_at: string }>(`SELECT handoff_at, first_human_response_at FROM tickets WHERE ${opened} AND handoff_at IS NOT NULL AND first_human_response_at IS NOT NULL LIMIT 5000`, ...op);
  const sla1 = num((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE ${opened} AND sla_first_response_breached_at IS NOT NULL`, ...op))!.n);
  const sla2 = num((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE ${opened} AND sla_resolution_breached_at IS NOT NULL`, ...op))!.n);
  const csat = await db.all<{ resolution: string; avg: number | null; n: number }>(`SELECT resolution, AVG(csat) AS avg, COUNT(*) AS n FROM tickets WHERE ${opened} AND csat IS NOT NULL AND resolution IN ('bot_resolved','human_resolved') GROUP BY resolution`, ...op);
  const cs = (k: string) => csat.find((x) => x.resolution === k);
  const queue = num((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND status = 'waiting_for_human' AND handler IS NULL", ws))!.n);
  const depts = await db.all<{ department_id: string | null; n: number; h: number; res: number; csat: number | null; sla: number }>(
    `SELECT department_id, COUNT(*) AS n, SUM(CASE WHEN handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS h, SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS res, AVG(csat) AS csat,
            SUM(CASE WHEN sla_first_response_breached_at IS NOT NULL OR sla_resolution_breached_at IS NOT NULL THEN 1 ELSE 0 END) AS sla
     FROM tickets WHERE ${opened} GROUP BY department_id ORDER BY n DESC, department_id LIMIT 100`,
    ...op,
  );
  const { pepper } = await getPepper(ctx, ws);
  const turns = await db.all<{ agent_id: string; outcome: string; n: number }>("SELECT agent_id, outcome, COUNT(*) AS n FROM ai_turns WHERE workspace_id = ? AND created_at >= ? AND created_at < ? GROUP BY agent_id, outcome", ...op);
  const votes = await db.all<{ agent_id: string; rating: number; n: number }>("SELECT agent_id, rating, COUNT(*) AS n FROM ai_feedback WHERE workspace_id = ? AND agent_id IS NOT NULL AND created_at >= ? AND created_at < ? GROUP BY agent_id, rating", ...op);
  const agents = new Map<string, SupportOverview["ai_agents"][number]>();
  const agent = (id: string) => {
    let a = agents.get(id);
    if (!a) agents.set(id, (a = { agent_key: agentKey(pepper, id), turns: 0, answered: 0, handoffs: 0, resolved: 0, refused: 0, helpful: 0, not_helpful: 0 }));
    return a;
  };
  for (const t of turns) {
    const a = agent(t.agent_id);
    a.turns += num(t.n);
    if (t.outcome === "answered") a.answered += num(t.n);
    else if (t.outcome === "handoff" || t.outcome === "suggested") a.handoffs += num(t.n);
    else if (t.outcome === "resolved") a.resolved += num(t.n);
    else if (t.outcome === "refused") a.refused += num(t.n);
  }
  for (const v of votes) agent(v.agent_id)[v.rating === 1 ? "helpful" : "not_helpful"] += num(v.n);
  const calls = await db.all<{ state: string; transport: string; kind: string; n: number; dur: number | null }>("SELECT state, transport, kind, COUNT(*) AS n, SUM(duration_s) AS dur FROM calls WHERE workspace_id = ? AND created_at >= ? AND created_at < ? GROUP BY state, transport, kind", ...op);
  const c = { total: 0, answered: 0, missed: 0, declined: 0, failed: 0, total_duration_s: 0, avg_duration_s: null as number | null, by_transport: { webrtc: 0, phone: 0, ai: 0 }, by_kind: { voice: 0, video: 0, ai_voice: 0, ai_video: 0 } };
  let answeredWithDuration = 0;
  for (const x of calls) {
    const n = num(x.n);
    c.total += n;
    c.by_transport[x.transport as "webrtc" | "phone" | "ai"] += n;
    c.by_kind[x.kind as "voice" | "video" | "ai_voice" | "ai_video"] += n;
    if (x.state === "missed") c.missed += n;
    else if (x.state === "declined") c.declined += n;
    else if (x.state === "failed") c.failed += n;
    else if (x.state === "ended") {
      c.answered += n;
      c.total_duration_s += num(x.dur);
      answeredWithDuration += n;
    }
  }
  c.avg_duration_s = answeredWithDuration ? Math.round(c.total_duration_s / answeredWithDuration) : null;
  const aiRows = await db.all<{ engine: string | null; state: string; end_reason: string | null; handoff_reason: string | null; duration_s: number | null }>("SELECT engine, state, end_reason, handoff_reason, duration_s FROM calls WHERE workspace_id = ? AND transport = 'ai' AND created_at >= ? AND created_at < ?", ...op);
  const ai: SupportOverview["ai_calls"] = { total: aiRows.length, total_duration_s: 0, avg_duration_s: null, handed_to_person: 0, handoff_rate: null, by_engine: { browser: 0, realtime: 0 }, by_end_reason: {}, by_handoff_reason: [], realtime: { calls: 0, minutes: 0, estimated_cost_usd: null }, photoreal: { sessions: 0, minutes: 0, fell_back: 0, estimated_cost_usd: null } };
  const handoffReasons = new Map<string, number>();
  let realtimeSeconds = 0;
  for (const x of aiRows) {
    ai.total_duration_s += num(x.duration_s);
    ai.by_engine[x.engine === "realtime" ? "realtime" : "browser"]++;
    if (x.end_reason) ai.by_end_reason[x.end_reason] = (ai.by_end_reason[x.end_reason] ?? 0) + 1;
    if (x.handoff_reason) (ai.handed_to_person++, handoffReasons.set(x.handoff_reason, (handoffReasons.get(x.handoff_reason) ?? 0) + 1));
    if (x.engine === "realtime") (ai.realtime.calls++, (realtimeSeconds += num(x.duration_s)));
  }
  ai.avg_duration_s = ai.total ? Math.round(ai.total_duration_s / ai.total) : null;
  ai.handoff_rate = ai.total ? round(ai.handed_to_person / ai.total, 4) : null;
  ai.by_handoff_reason = [...handoffReasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  ai.realtime.minutes = round(realtimeSeconds / 60, 2) ?? 0;
  const perMinute = ctx.config.AI_REALTIME_COST_PER_MINUTE_USD;
  ai.realtime.estimated_cost_usd = perMinute === undefined ? null : round(ai.realtime.minutes * perMinute, 2);
  const av = await db.all<{ state: string; seconds: number | null }>("SELECT state, seconds FROM avatar_sessions WHERE workspace_id = ? AND started_at >= ? AND started_at < ?", ...op);
  ai.photoreal.sessions = av.length;
  ai.photoreal.fell_back = av.filter((x) => x.state === "failed").length;
  ai.photoreal.minutes = round(av.reduce((s, x) => s + num(x.seconds), 0) / 60, 2) ?? 0;
  const avPrice = ctx.config.AVATAR_COST_PER_MINUTE_USD;
  ai.photoreal.estimated_cost_usd = avPrice === undefined ? null : round(ai.photoreal.minutes * avPrice, 2);
  return {
    from,
    to,
    tickets: {
      opened: total,
      resolved,
      by_resolution,
      containment_rate: withBot ? round(botResolved / withBot, 4) : null,
      handoff_rate: total ? round(handoffs / total, 4) : null,
      handoff_reasons: reasons.map((x) => ({ reason: x.reason, count: num(x.n) })),
      wait_for_human_p50_s: median(waits.map((w) => seconds(w.handoff_at, w.first_human_response_at)!).filter((x) => x !== null)),
      sla_first_response_breaches: sla1,
      sla_resolution_breaches: sla2,
      csat: { bot_avg: round(cs("bot_resolved")?.avg ?? null), bot_count: num(cs("bot_resolved")?.n), human_avg: round(cs("human_resolved")?.avg ?? null), human_count: num(cs("human_resolved")?.n) },
      queue_length_now: queue,
    },
    by_department: depts.map((d) => ({ department_id: d.department_id, tickets: num(d.n), handoffs: num(d.h), resolved: num(d.res), csat_avg: round(d.csat), sla_breaches: num(d.sla) })),
    ai_agents: [...agents.values()].sort((a, b) => b.turns - a.turns),
    calls: c,
    ai_calls: ai,
  };
}

/* ---------- exports ---------- */

export interface TicketExportLine {
  id: string;
  number: number;
  room_id: string;
  created_at: string;
  closed_at: string | null;
  status: string;
  handler_type: "bot" | "human" | null;
  handler_key: string | null;
  department_id: string | null;
  priority: number;
  resolution: string | null;
  handoff_reason: string | null;
  channel: string;
  contact_key: string | null;
  first_response_s: number | null;
  wait_for_human_s: number | null;
  resolution_s: number | null;
  csat: number | null;
  sla_first_response_breached: boolean;
  sla_resolution_breached: boolean;
  bot_turns: number;
  calls: number;
  hour_of_day_created: number;
  dow_created: number;
}

interface TicketRow {
  id: string;
  number: number;
  room_id: string;
  contact_id: string;
  opened_at: string;
  closed_at: string | null;
  resolved_at: string | null;
  status: string;
  handler: string | null;
  department_id: string | null;
  priority: number;
  resolution: string | null;
  handoff_reason: string | null;
  handoff_at: string | null;
  channel: string;
  first_response_at: string | null;
  first_human_response_at: string | null;
  csat: number | null;
  sla_first_response_breached_at: string | null;
  sla_resolution_breached_at: string | null;
}

/** One page of tickets after `cursor`, ordered by (opened_at, id). No subject, summary, notes or names; a person is a keyed hash. */
export async function exportTickets(ctx: AppContext, ws: string, r: RangeQuery, o: { cursor?: string; limit: number }): Promise<Page<TicketExportLine>> {
  const limit = Math.min(Math.max(o.limit, 1), EXPORT_MAX_LIMIT);
  const c = decodeCursor(o.cursor, 2);
  const db = ctx.db.read();
  const rows = await db.all<TicketRow>(
    `SELECT id, number, room_id, contact_id, opened_at, closed_at, resolved_at, status, handler, department_id, priority, resolution, handoff_reason, handoff_at, channel, first_response_at, first_human_response_at, csat,
            sla_first_response_breached_at, sla_resolution_breached_at FROM tickets
     WHERE workspace_id = ? AND opened_at >= ? AND opened_at < ? ${c ? "AND (opened_at > ? OR (opened_at = ? AND id > ?))" : ""} ORDER BY opened_at, id LIMIT ?`,
    ws,
    r.from.toISOString(),
    r.to.toISOString(),
    ...(c ? [c[0]!, c[0]!, c[1]!] : []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const ids = page.map((t) => t.id);
  const contacts = new Map(
    page.length ? (await db.all<{ id: string; email: string | null }>(`SELECT id, email FROM contacts WHERE workspace_id = ? AND id IN (${[...new Set(page.map((t) => t.contact_id))].map(() => "?").join(",")})`, ws, ...new Set(page.map((t) => t.contact_id)))).map((x) => [x.id, x.email]) : [],
  );
  const turnCounts = new Map(ids.length ? (await db.all<{ ticket_id: string; n: number }>(`SELECT ticket_id, COUNT(*) AS n FROM ai_turns WHERE ticket_id IN (${ids.map(() => "?").join(",")}) GROUP BY ticket_id`, ...ids)).map((x) => [x.ticket_id, num(x.n)]) : []);
  const callCounts = new Map(ids.length ? (await db.all<{ ticket_id: string; n: number }>(`SELECT ticket_id, COUNT(*) AS n FROM calls WHERE ticket_id IN (${ids.map(() => "?").join(",")}) GROUP BY ticket_id`, ...ids)).map((x) => [x.ticket_id, num(x.n)]) : []);
  const { pepper } = await getPepper(ctx, ws);
  const out: TicketExportLine[] = page.map((t) => {
    const local = zonedParts(new Date(t.opened_at), r.tz);
    const email = contacts.get(t.contact_id);
    const [kind, who] = t.handler ? (t.handler.split(":") as ["bot" | "human", string]) : [null, null];
    return {
      id: t.id,
      number: t.number,
      room_id: t.room_id,
      created_at: t.opened_at,
      closed_at: t.closed_at,
      status: t.status,
      handler_type: kind,
      handler_key: who ? agentKey(pepper, who) : null,
      department_id: t.department_id,
      priority: t.priority,
      resolution: t.resolution,
      handoff_reason: t.handoff_reason,
      channel: t.channel,
      contact_key: email ? identityKey(pepper, email) : null,
      first_response_s: seconds(t.opened_at, t.first_response_at),
      wait_for_human_s: seconds(t.handoff_at, t.first_human_response_at),
      resolution_s: seconds(t.opened_at, t.resolved_at),
      csat: t.csat,
      sla_first_response_breached: !!t.sla_first_response_breached_at,
      sla_resolution_breached: !!t.sla_resolution_breached_at,
      bot_turns: turnCounts.get(t.id) ?? 0,
      calls: callCounts.get(t.id) ?? 0,
      hour_of_day_created: Math.floor(local.minutes / 60),
      dow_created: local.day,
    };
  });
  const last = page[page.length - 1];
  return { rows: out, next_cursor: rows.length > limit && last ? encodeCursor([last.opened_at, last.id]) : null };
}

export interface CallExportLine {
  id: string;
  room_id: string;
  ticket_id: string | null;
  ts: string;
  transport: "webrtc" | "phone" | "ai";
  kind: "voice" | "video" | "ai_voice" | "ai_video";
  state: string;
  duration_s: number | null;
  ended_by: string | null;
  end_reason: string | null;
  /** AI calls: the speech engine ("browser" or "realtime") and why the call went to a person; null for other calls */
  engine: string | null;
  handoff_reason: string | null;
  /** keyed hash of the team member who placed the call, or of the AI agent that took it */
  agent_key: string;
}

/** Calls: when, how, how it ended and how long. No numbers, no names, no transcript (there is none). */
export async function exportCalls(ctx: AppContext, ws: string, r: RangeQuery, o: { cursor?: string; limit: number }): Promise<Page<CallExportLine>> {
  const limit = Math.min(Math.max(o.limit, 1), EXPORT_MAX_LIMIT);
  const c = decodeCursor(o.cursor, 2);
  const rows = await ctx.db.read().all<{ id: string; room_id: string; ticket_id: string | null; created_at: string; transport: "webrtc" | "phone" | "ai"; kind: "voice" | "video" | "ai_voice" | "ai_video"; state: string; duration_s: number | null; ended_by: string | null; end_reason: string | null; initiated_by: string; ai_agent_id: string | null; engine: string | null; handoff_reason: string | null }>(
    `SELECT id, room_id, ticket_id, created_at, transport, kind, state, duration_s, ended_by, end_reason, initiated_by, ai_agent_id, engine, handoff_reason FROM calls
     WHERE workspace_id = ? AND created_at >= ? AND created_at < ? ${c ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""} ORDER BY created_at, id LIMIT ?`,
    ws,
    r.from.toISOString(),
    r.to.toISOString(),
    ...(c ? [c[0]!, c[0]!, c[1]!] : []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const { pepper } = await getPepper(ctx, ws);
  const last = page[page.length - 1];
  return {
    rows: page.map((x) => ({ id: x.id, room_id: x.room_id, ticket_id: x.ticket_id, ts: x.created_at, transport: x.transport, kind: x.kind, state: x.state, duration_s: x.duration_s, ended_by: x.ended_by, end_reason: x.end_reason, engine: x.transport === "ai" ? x.engine : null, handoff_reason: x.handoff_reason, agent_key: agentKey(pepper, x.ai_agent_id ? `bot:${x.ai_agent_id}` : x.initiated_by) })),
    next_cursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null,
  };
}
