import { createHmac, randomBytes } from "node:crypto";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { badRequest, unprocessable } from "../errors.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";
import { zonedParts } from "../util/time.js";
import { decryptSecret, encryptSecret } from "../util/totp.js";
import { recordAudit } from "./audit.js";
import type { RoomMetricsRow } from "./roomMetrics.js";

/* ===================================================================================================================================== *
 * Identity pepper: contact_key / phone_key / agent_key
 *
 * Exports never contain raw email, phone or names. A person is identified by HMAC-SHA256(workspace pepper, lower(trim(email))), hex. The pepper
 * is per workspace; the workspace admin can copy it into another system (the Python intelligence service, the Funnels app) so the same person
 * hashes to the same key everywhere and records can be joined without ever exchanging the raw values. Rotating it changes every key.
 * ===================================================================================================================================== */

export async function getPepper(ctx: AppContext, workspaceId: string): Promise<{ pepper: string; version: number }> {
  const row = await ctx.db.get<{ pepper_enc: string; version: number }>("SELECT pepper_enc, version FROM analytics_pepper WHERE workspace_id = ?", workspaceId);
  if (row) return { pepper: decryptSecret(ctx.config.JWT_SECRET, row.pepper_enc), version: row.version };
  const pepper = randomBytes(32).toString("hex");
  // two requests may race to create it: the primary key makes exactly one win, the other reads the winner's
  await ctx.db.run("INSERT OR IGNORE INTO analytics_pepper(workspace_id, pepper_enc, version, rotated_at) VALUES (?,?,1,?)", workspaceId, encryptSecret(ctx.config.JWT_SECRET, pepper), nowIso(ctx));
  const won = (await ctx.db.get<{ pepper_enc: string; version: number }>("SELECT pepper_enc, version FROM analytics_pepper WHERE workspace_id = ?", workspaceId))!;
  return { pepper: decryptSecret(ctx.config.JWT_SECRET, won.pepper_enc), version: won.version };
}

export async function rotatePepper(ctx: AppContext, actor: Actor): Promise<{ pepper: string; version: number }> {
  await getPepper(ctx, actor.workspaceId);
  const pepper = randomBytes(32).toString("hex");
  await ctx.db.run("UPDATE analytics_pepper SET pepper_enc = ?, version = version + 1, rotated_at = ? WHERE workspace_id = ?", encryptSecret(ctx.config.JWT_SECRET, pepper), nowIso(ctx), actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "analytics.pepper_rotated", target: actor.workspaceId });
  return getPepper(ctx, actor.workspaceId);
}

/** The contract's algorithm, exactly: hex(HMAC-SHA256(pepper, lower(trim(value)))). */
export const identityKey = (pepper: string, value: string): string => createHmac("sha256", pepper).update(value.trim().toLowerCase()).digest("hex");
/** Phone numbers are keyed from their E.164 form (already canonical; case and whitespace are normalised the same way). */
export const phoneKey = identityKey;
/** Seat ids are opaque in exports: a keyed hash, never the id itself and never a name. */
export const agentKey = (pepper: string, memberId: string): string => createHmac("sha256", pepper).update(`agent:${memberId}`).digest("hex").slice(0, 32);

/* ===================================================================================================================================== *
 * Query parameters shared by every analytics endpoint
 * ===================================================================================================================================== */

export interface RangeQuery {
  from: Date;
  to: Date;
  tz: string;
  interval: "hour" | "day" | "week" | "month";
}

const MAX_RANGE_DAYS = 366;

function parseInstant(v: string, endOfDay: boolean): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(date ? `${v}T00:00:00.000Z` : v);
  if (Number.isNaN(d.getTime())) throw badRequest("INVALID_DATE", `"${v}" is not an ISO date or datetime`);
  return date && endOfDay ? new Date(d.getTime() + 86400_000) : d;
}

export function parseRange(ctx: AppContext, q: { from?: string; to?: string; tz?: string; interval?: string }): RangeQuery {
  const now = ctx.clock();
  const to = q.to ? parseInstant(q.to, true) : now;
  const from = q.from ? parseInstant(q.from, false) : new Date(to.getTime() - 30 * 86400_000);
  if (from >= to) throw badRequest("INVALID_RANGE", "from must be before to");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400_000) throw badRequest("RANGE_TOO_LARGE", `The range may not exceed ${MAX_RANGE_DAYS} days`);
  const tz = q.tz ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw badRequest("INVALID_TZ", `"${tz}" is not an IANA time zone`);
  }
  const interval = (q.interval ?? "day") as RangeQuery["interval"];
  if (!["hour", "day", "week", "month"].includes(interval)) throw badRequest("INVALID_INTERVAL", "interval must be hour, day, week or month");
  if (interval === "hour" && to.getTime() - from.getTime() > 14 * 86400_000) throw badRequest("RANGE_TOO_LARGE", "Hourly buckets are limited to 14 days; use day for longer ranges");
  return { from, to, tz, interval };
}

/** Bucket start instants covering [from, to), aligned in the caller's time zone (day = local midnight, week = local Monday, month = local 1st). */
export function bucketStarts(r: RangeQuery): Date[] {
  const out: Date[] = [];
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: r.tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const local = (ms: number) => {
    const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
    return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, min: p.minute! };
  };
  // convert a local wall time to an instant by settling the zone offset
  const at = (y: number, m: number, d: number, h = 0) => {
    const guess = Date.UTC(y, m - 1, d, h);
    const off = (u: number) => {
      const l = local(u);
      return Date.UTC(l.y, l.m - 1, l.d, l.h, l.min) - u;
    };
    let t = guess - off(guess);
    t = guess - off(t);
    return t;
  };
  const l0 = local(r.from.getTime());
  let cur: number;
  if (r.interval === "hour") cur = at(l0.y, l0.m, l0.d, l0.h);
  else if (r.interval === "day") cur = at(l0.y, l0.m, l0.d);
  else if (r.interval === "week") {
    const dow = (zonedParts(r.from, r.tz).day + 6) % 7; // 0 = Monday
    cur = at(l0.y, l0.m, l0.d - dow);
  } else cur = at(l0.y, l0.m, 1);
  for (let i = 0; cur < r.to.getTime() && i < 9000; i++) {
    out.push(new Date(cur));
    const l = local(cur + (r.interval === "hour" ? 3600_000 : 0));
    if (r.interval === "hour") cur = cur + 3600_000;
    else if (r.interval === "day") cur = at(l.y, l.m, l.d + 1);
    else if (r.interval === "week") cur = at(l.y, l.m, l.d + 7);
    else cur = at(l.y, l.m + 1, 1);
  }
  return out;
}

/* ===================================================================================================================================== *
 * Aggregates
 * ===================================================================================================================================== */

/** Nearest-rank percentile of a metric column over a filtered set of rooms. PostgreSQL does it in the database; SQLite with a count and an offset. */
async function percentile(ctx: AppContext, col: "first_response_s" | "resolution_s", where: string, params: (string | number)[], p: number): Promise<number | null> {
  const db = ctx.db.read();
  if (ctx.db.dialect === "postgres") {
    const r = await db.get<{ v: number | null }>(`SELECT percentile_disc(${p}) WITHIN GROUP (ORDER BY ${col}) AS v FROM room_metrics WHERE ${where} AND ${col} IS NOT NULL`, ...params);
    return r?.v === null || r?.v === undefined ? null : Number(r.v);
  }
  const n = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM room_metrics WHERE ${where} AND ${col} IS NOT NULL`, ...params))!.n);
  if (!n) return null;
  const r = await db.get<{ v: number }>(`SELECT ${col} AS v FROM room_metrics WHERE ${where} AND ${col} IS NOT NULL ORDER BY ${col} LIMIT 1 OFFSET ?`, ...params, Math.max(0, Math.ceil(p * n) - 1));
  return r ? Number(r.v) : null;
}

export interface Overview {
  from: string;
  to: string;
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
  by_channel: Record<"dm" | "sms" | "email", { messages_in: number; messages_out: number }>;
  by_inbox: { inbox_id: string | null; rooms_opened: number; rooms_closed: number; messages_in: number; messages_out: number; first_response_p50_s: number | null; resolution_p50_s: number | null }[];
  by_agent: { agent_key: string; rooms_handled: number; avg_first_response_s: number | null; avg_resolution_s: number | null; agent_id?: string; agent_name?: string }[];
}

export async function overview(ctx: AppContext, workspaceId: string, r: RangeQuery, opts: { withNames?: boolean } = {}): Promise<Overview> {
  const db = ctx.db.read();
  const from = r.from.toISOString();
  const to = r.to.toISOString();
  const created = "workspace_id = ? AND created_at >= ? AND created_at < ?";
  const closed = "workspace_id = ? AND closed_at >= ? AND closed_at < ?";
  const cp = [workspaceId, from, to];
  const sum = await db.get<Record<string, number | null>>(
    `SELECT COALESCE(SUM(messages_in),0) AS mi, COALESCE(SUM(messages_out),0) AS mo, COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN csat IS NOT NULL THEN 1 ELSE 0 END),0) AS csat_n, AVG(csat) AS csat_avg FROM room_metrics WHERE ${created}`,
    ...cp,
  );
  const closedN = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM room_metrics WHERE ${closed}`, ...cp))!.n);
  // Message volume in range. Whole-UTC-day ranges are served from the daily rollup (maintained by the event consumer, so a few seconds behind);
  // ranges with partial days are counted directly from the messages table (index on workspace and time).
  const aligned = r.from.getTime() % 86400_000 === 0 && r.to.getTime() % 86400_000 === 0;
  const vol = aligned
    ? await db.all<{ channel: string; direction: string; n: number }>(
        "SELECT channel, direction, COALESCE(SUM(messages),0) AS n FROM rollup_messages_daily WHERE workspace_id = ? AND day >= ? AND day < ? GROUP BY channel, direction",
        workspaceId,
        from.slice(0, 10),
        to.slice(0, 10),
      )
    : await db.all<{ channel: string; direction: string; n: number }>(
        `SELECT source AS channel, CASE WHEN sender_type = 'contact' THEN 'in' ELSE 'out' END AS direction, COUNT(*) AS n FROM messages
         WHERE workspace_id = ? AND created_at >= ? AND created_at < ? AND sender_type IN ('contact','agent') AND kind != 'note' AND deleted_at IS NULL GROUP BY 1, 2`,
        workspaceId,
        from,
        to,
      );
  const by_channel = { dm: { messages_in: 0, messages_out: 0 }, sms: { messages_in: 0, messages_out: 0 }, email: { messages_in: 0, messages_out: 0 } };
  for (const v of vol) {
    const c = by_channel[v.channel as "dm" | "sms" | "email"];
    if (c) c[v.direction === "in" ? "messages_in" : "messages_out"] += Number(v.n);
  }
  const messages_in = Object.values(by_channel).reduce((a, c) => a + c.messages_in, 0);
  const messages_out = Object.values(by_channel).reduce((a, c) => a + c.messages_out, 0);

  const inboxes = await db.all<{ inbox_id: string | null; n: number; closed: number; mi: number; mo: number }>(
    `SELECT inbox_id, COUNT(*) AS n, SUM(CASE WHEN closed_at IS NOT NULL AND closed_at < ? THEN 1 ELSE 0 END) AS closed, COALESCE(SUM(messages_in),0) AS mi, COALESCE(SUM(messages_out),0) AS mo
     FROM room_metrics WHERE ${created} GROUP BY inbox_id ORDER BY inbox_id`,
    to,
    ...cp,
  );
  const by_inbox: Overview["by_inbox"] = [];
  for (const i of inboxes) {
    const w = `${created} AND ${i.inbox_id === null ? "inbox_id IS NULL" : "inbox_id = ?"}`;
    const wp = i.inbox_id === null ? cp : [...cp, i.inbox_id];
    by_inbox.push({
      inbox_id: i.inbox_id,
      rooms_opened: Number(i.n),
      rooms_closed: Number(i.closed),
      messages_in: Number(i.mi),
      messages_out: Number(i.mo),
      first_response_p50_s: await percentile(ctx, "first_response_s", w, wp, 0.5),
      resolution_p50_s: await percentile(ctx, "resolution_s", w, wp, 0.5),
    });
  }
  const { pepper } = await getPepper(ctx, workspaceId);
  const agents = await db.all<{ assignee_id: string; n: number; fr: number | null; res: number | null }>(
    `SELECT assignee_id, COUNT(*) AS n, AVG(first_response_s) AS fr, AVG(resolution_s) AS res FROM room_metrics WHERE ${created} AND assignee_id IS NOT NULL GROUP BY assignee_id ORDER BY n DESC, assignee_id LIMIT 200`,
    ...cp,
  );
  let names = new Map<string, string>();
  if (opts.withNames && agents.length) {
    const rows = await db.all<{ id: string; name: string }>(`SELECT m.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.id IN (${agents.map(() => "?").join(",")})`, workspaceId, ...agents.map((a) => a.assignee_id));
    names = new Map(rows.map((x) => [x.id, x.name]));
  }
  return {
    from,
    to,
    rooms_opened: Number(sum!.n),
    rooms_closed: closedN,
    messages_in,
    messages_out,
    first_response_p50_s: await percentile(ctx, "first_response_s", created, cp, 0.5),
    first_response_p90_s: await percentile(ctx, "first_response_s", created, cp, 0.9),
    resolution_p50_s: await percentile(ctx, "resolution_s", created, cp, 0.5),
    resolution_p90_s: await percentile(ctx, "resolution_s", created, cp, 0.9),
    csat_avg: sum!.csat_avg === null ? null : Math.round(Number(sum!.csat_avg) * 100) / 100,
    csat_count: Number(sum!.csat_n),
    by_channel,
    by_inbox,
    by_agent: agents.map((a) => ({
      agent_key: agentKey(pepper, a.assignee_id),
      rooms_handled: Number(a.n),
      avg_first_response_s: a.fr === null ? null : Math.round(Number(a.fr)),
      avg_resolution_s: a.res === null ? null : Math.round(Number(a.res)),
      ...(opts.withNames ? { agent_id: a.assignee_id, agent_name: names.get(a.assignee_id) ?? "Unknown" } : {}),
    })),
  };
}

export const TIMESERIES_METRICS = ["rooms_opened", "messages_in", "messages_out", "first_response_p50", "resolution_p50", "backlog"] as const;
export type TimeseriesMetric = (typeof TIMESERIES_METRICS)[number];

/** Zero-filled series: one point per bucket, `t` is the bucket start (UTC ISO) aligned in the requested time zone. */
export async function timeseries(ctx: AppContext, workspaceId: string, metric: TimeseriesMetric, r: RangeQuery) {
  if (!TIMESERIES_METRICS.includes(metric)) throw badRequest("INVALID_METRIC", `metric must be one of ${TIMESERIES_METRICS.join(", ")}`);
  const starts = bucketStarts(r);
  if (starts.length > 800) throw unprocessable("TOO_MANY_BUCKETS", "That range and interval produce too many points; use a coarser interval");
  const db = ctx.db.read();
  const points: { t: string; value: number | null }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const a = new Date(Math.max(starts[i]!.getTime(), r.from.getTime())).toISOString();
    const b = new Date(Math.min(starts[i + 1]?.getTime() ?? r.to.getTime(), r.to.getTime())).toISOString();
    let value: number | null;
    if (metric === "rooms_opened") value = Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_metrics WHERE workspace_id = ? AND created_at >= ? AND created_at < ?", workspaceId, a, b))!.n);
    else if (metric === "messages_in" || metric === "messages_out") {
      const col = metric === "messages_in" ? "sender_type = 'contact'" : "sender_type = 'agent' AND kind != 'note'";
      value = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND created_at >= ? AND created_at < ? AND ${col} AND deleted_at IS NULL`, workspaceId, a, b))!.n);
    } else if (metric === "backlog") {
      // rooms that existed at the end of the bucket and had not been closed by then
      value = Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_metrics WHERE workspace_id = ? AND created_at < ? AND (closed_at IS NULL OR closed_at >= ?)", workspaceId, b, b))!.n);
    } else {
      const col = metric === "first_response_p50" ? "first_response_s" : "resolution_s";
      value = await percentile(ctx, col, "workspace_id = ? AND created_at >= ? AND created_at < ?", [workspaceId, a, b], 0.5);
    }
    points.push({ t: starts[i]!.toISOString(), value });
  }
  return { interval: r.interval, tz: r.tz, points: points.map((p) => ({ t: p.t, value: p.value ?? 0 })) };
}

/* ===================================================================================================================================== *
 * Streaming exports (NDJSON, keyset paginated)
 * ===================================================================================================================================== */

export const EXPORT_MAX_LIMIT = 5000;

export interface RoomExportLine {
  id: string;
  created_at: string;
  closed_at: string | null;
  contact_key: string | null;
  phone_key: string | null;
  channel_mix: { dm: number; sms: number; email: number };
  inbox_id: string | null;
  assignee_key: string | null;
  priority: 0 | 1;
  status: "open" | "closed";
  messages_in: number;
  messages_out: number;
  first_response_s: number | null;
  resolution_s: number | null;
  reopen_count: number;
  snoozed_count: number;
  ai_intent: string | null;
  ai_sentiment: string | null;
  ai_urgency: number | null;
  csat: number | null;
  hour_of_day_created: number;
  dow_created: number;
}

export interface Page<T> {
  rows: T[];
  next_cursor: string | null;
}

/** One page of room records after `cursor`, ordered by (created_at, id). Batched joins only: three queries per page however many rows. */
export async function exportRooms(ctx: AppContext, workspaceId: string, r: RangeQuery, o: { cursor?: string; limit: number }): Promise<Page<RoomExportLine>> {
  const limit = Math.min(Math.max(o.limit, 1), EXPORT_MAX_LIMIT);
  const c = decodeCursor(o.cursor, 2);
  const db = ctx.db.read();
  const rows = await db.all<RoomMetricsRow & { status: string; priority: number }>(
    `SELECT m.*, r.status AS status, r.priority AS priority FROM room_metrics m JOIN rooms r ON r.id = m.room_id
     WHERE m.workspace_id = ? AND m.created_at >= ? AND m.created_at < ? ${c ? "AND (m.created_at > ? OR (m.created_at = ? AND m.room_id > ?))" : ""}
     ORDER BY m.created_at, m.room_id LIMIT ?`,
    workspaceId,
    r.from.toISOString(),
    r.to.toISOString(),
    ...(c ? [c[0]!, c[0]!, c[1]!] : []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const contactIds = [...new Set(page.map((x) => x.contact_id))];
  const contacts = new Map(
    contactIds.length
      ? (await db.all<{ id: string; email: string | null; phone: string | null }>(`SELECT id, email, phone FROM contacts WHERE workspace_id = ? AND id IN (${contactIds.map(() => "?").join(",")})`, workspaceId, ...contactIds)).map((x) => [x.id, x])
      : [],
  );
  const { pepper } = await getPepper(ctx, workspaceId);
  const out: RoomExportLine[] = page.map((m) => {
    const ct = contacts.get(m.contact_id);
    const local = zonedParts(new Date(m.created_at), r.tz);
    return {
      id: m.room_id,
      created_at: m.created_at,
      closed_at: m.closed_at,
      contact_key: ct?.email ? identityKey(pepper, ct.email) : null,
      phone_key: ct?.phone ? phoneKey(pepper, ct.phone) : null,
      channel_mix: { dm: m.dm_msgs, sms: m.sms_msgs, email: m.email_msgs },
      inbox_id: m.inbox_id,
      assignee_key: m.assignee_id ? agentKey(pepper, m.assignee_id) : null,
      priority: (m.priority ? 1 : 0) as 0 | 1,
      status: m.status as "open" | "closed",
      messages_in: m.messages_in,
      messages_out: m.messages_out,
      first_response_s: m.first_response_s,
      resolution_s: m.resolution_s,
      reopen_count: m.reopen_count,
      snoozed_count: m.snoozed_count,
      ai_intent: m.ai_intent,
      ai_sentiment: m.ai_sentiment,
      ai_urgency: m.ai_urgency,
      csat: m.csat,
      hour_of_day_created: Math.floor(local.minutes / 60),
      dow_created: local.day,
    };
  });
  const last = page[page.length - 1];
  return { rows: out, next_cursor: rows.length > limit && last ? encodeCursor([last.created_at, last.room_id]) : null };
}

export interface MessageMetaLine {
  id: string;
  room_id: string;
  ts: string;
  direction: "in" | "out";
  channel: "dm" | "sms" | "email";
  kind: string;
  length_chars: number;
  delivery_status: string;
  sender_type: string;
}

/** Message metadata only: ids, time, direction, channel, size and delivery state. Content is never selected. */
export async function exportMessagesMeta(ctx: AppContext, workspaceId: string, r: RangeQuery, o: { cursor?: string; limit: number }): Promise<Page<MessageMetaLine>> {
  const limit = Math.min(Math.max(o.limit, 1), EXPORT_MAX_LIMIT);
  const c = decodeCursor(o.cursor, 2);
  const rows = await ctx.db.read().all<{ id: string; room_id: string; created_at: string; sender_type: string; kind: string; source: string; delivery: string; len: number }>(
    `SELECT id, room_id, created_at, sender_type, kind, source, delivery, LENGTH(content_text) AS len FROM messages
     WHERE workspace_id = ? AND created_at >= ? AND created_at < ? AND deleted_at IS NULL AND kind != 'note' AND sender_type != 'system' ${c ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""}
     ORDER BY created_at, id LIMIT ?`,
    workspaceId,
    r.from.toISOString(),
    r.to.toISOString(),
    ...(c ? [c[0]!, c[0]!, c[1]!] : []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((m) => ({
      id: m.id,
      room_id: m.room_id,
      ts: m.created_at,
      direction: m.sender_type === "contact" ? "in" : "out",
      channel: m.source as "dm" | "sms" | "email",
      kind: m.kind,
      length_chars: Number(m.len ?? 0),
      delivery_status: m.delivery,
      sender_type: m.sender_type,
    })),
    next_cursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null,
  };
}
