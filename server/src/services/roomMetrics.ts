import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { writeOutbox } from "../events/outbox.js";
import type { RoomRow } from "./roomStore.js";
import type { MessageRow } from "./messageStore.js";
import { getSettings } from "./workspaces.js";
import { businessSeconds } from "./office.js";

export const TOPIC_ROOMS = "room.events";

export interface RoomMetricsRow {
  room_id: string;
  workspace_id: string;
  inbox_id: string | null;
  contact_id: string;
  created_at: string;
  messages_in: number;
  messages_out: number;
  dm_msgs: number;
  sms_msgs: number;
  email_msgs: number;
  first_contact_at: string | null;
  first_response_at: string | null;
  first_response_s: number | null;
  closed_at: string | null;
  resolution_s: number | null;
  reopen_count: number;
  opened_at: string;
  snoozed_count: number;
  snooze_started_at: string | null;
  snoozed_s: number;
  assignee_id: string | null;
  csat: number | null;
  csat_at: string | null;
  csat_comment: string | null;
  ai_intent: string | null;
  ai_sentiment: string | null;
  ai_urgency: number | null;
}

/**
 * Per-room analytics facts, maintained by the same transactions that change the room, so they are always consistent with it and never need
 * a backfill job. Definitions (also in docs/ANALYTICS.md):
 *  - first response: first contact message -> first message by a HUMAN AGENT (kind not note/system; bots and system lines never count)
 *  - resolution: start of the open interval (creation, or the latest reopen) -> the close, minus time spent snoozed
 *  - both are BUSINESS seconds when the workspace has office hours enabled, calendar seconds otherwise
 */
async function elapsed(ctx: AppContext, workspaceId: string, from: string, to: string): Promise<number> {
  const oh = (await getSettings(ctx, workspaceId)).widget.office_hours;
  return businessSeconds(oh, new Date(from), new Date(to));
}

export async function metricsCreated(ctx: AppContext, room: RoomRow): Promise<void> {
  await ctx.db.run(
    "INSERT OR IGNORE INTO room_metrics(room_id, workspace_id, inbox_id, contact_id, created_at, opened_at) VALUES (?,?,?,?,?,?)",
    room.id,
    room.workspace_id,
    room.inbox_id,
    room.contact_id,
    room.created_at,
    room.created_at,
  );
  await writeOutbox(ctx, TOPIC_ROOMS, room.id, { type: "room.opened", workspace_id: room.workspace_id, room_id: room.id, inbox_id: room.inbox_id, at: room.created_at, reopen: false });
}

/** Called for every stored message, inside the insert transaction. `reopened`: the message reopened a closed room. */
export async function metricsMessage(ctx: AppContext, room: RoomRow, m: MessageRow, reopened: boolean, at: string): Promise<void> {
  if (m.sender_type === "system") return;
  if (reopened) await metricsStatus(ctx, room, "open", at);
  const real = m.kind !== "note"; // internal notes are not part of the conversation with the contact
  const src = m.source === "sms" ? "sms_msgs" : m.source === "email" ? "email_msgs" : "dm_msgs";
  if (m.sender_type === "contact") {
    await ctx.db.run(`UPDATE room_metrics SET messages_in = messages_in + 1, ${src} = ${src} + 1, first_contact_at = COALESCE(first_contact_at, ?) WHERE room_id = ?`, at, room.id);
    return;
  }
  if (m.sender_type !== "agent" || !real) return; // bots and notes: counted nowhere
  await ctx.db.run(`UPDATE room_metrics SET messages_out = messages_out + 1, ${src} = ${src} + 1 WHERE room_id = ?`, room.id);
  const row = await ctx.db.get<{ first_contact_at: string | null; first_response_at: string | null }>("SELECT first_contact_at, first_response_at FROM room_metrics WHERE room_id = ?", room.id);
  if (row?.first_contact_at && !row.first_response_at) {
    const s = await elapsed(ctx, room.workspace_id, row.first_contact_at, at);
    await ctx.db.run("UPDATE room_metrics SET first_response_at = ?, first_response_s = ? WHERE room_id = ? AND first_response_at IS NULL", at, s, room.id);
    await writeOutbox(ctx, TOPIC_ROOMS, room.id, { type: "room.first_response", workspace_id: room.workspace_id, room_id: room.id, inbox_id: room.inbox_id, at, first_response_s: s });
  }
}

export async function metricsStatus(ctx: AppContext, room: RoomRow, status: "open" | "closed", at: string = nowIso(ctx)): Promise<void> {
  const m = await ctx.db.get<RoomMetricsRow>("SELECT * FROM room_metrics WHERE room_id = ?", room.id);
  if (!m) return;
  if (status === "closed") {
    if (m.closed_at && m.closed_at >= m.opened_at) return; // already closed in this interval
    // close ends a snooze that was still running
    let snoozed = m.snoozed_s;
    if (m.snooze_started_at) snoozed += await elapsed(ctx, room.workspace_id, m.snooze_started_at, at);
    const total = await elapsed(ctx, room.workspace_id, m.opened_at, at);
    const res = Math.max(0, total - snoozed);
    await ctx.db.run("UPDATE room_metrics SET closed_at = ?, resolution_s = ?, snoozed_s = ?, snooze_started_at = NULL WHERE room_id = ?", at, res, snoozed, room.id);
    await writeOutbox(ctx, TOPIC_ROOMS, room.id, { type: "room.closed", workspace_id: room.workspace_id, room_id: room.id, inbox_id: room.inbox_id, at, first_response_s: m.first_response_s, resolution_s: res });
  } else if (m.closed_at && m.closed_at >= m.opened_at) {
    await ctx.db.run("UPDATE room_metrics SET opened_at = ?, reopen_count = reopen_count + 1, snoozed_s = 0, csat = NULL, csat_at = NULL, csat_comment = NULL WHERE room_id = ?", at, room.id);
    await writeOutbox(ctx, TOPIC_ROOMS, room.id, { type: "room.opened", workspace_id: room.workspace_id, room_id: room.id, inbox_id: room.inbox_id, at, reopen: true });
  }
}

export async function metricsSnoozed(ctx: AppContext, roomId: string, at: string = nowIso(ctx)): Promise<void> {
  await ctx.db.run("UPDATE room_metrics SET snoozed_count = snoozed_count + 1, snooze_started_at = COALESCE(snooze_started_at, ?) WHERE room_id = ?", at, roomId);
}

/** Snooze ended (woken, manually unsnoozed, or ended by a new message): the snoozed time leaves the resolution clock. */
export async function metricsUnsnoozed(ctx: AppContext, workspaceId: string, roomId: string, at: string = nowIso(ctx)): Promise<void> {
  const m = await ctx.db.get<{ snooze_started_at: string | null }>("SELECT snooze_started_at FROM room_metrics WHERE room_id = ?", roomId);
  if (!m?.snooze_started_at) return;
  const s = await elapsed(ctx, workspaceId, m.snooze_started_at, at);
  await ctx.db.run("UPDATE room_metrics SET snoozed_s = snoozed_s + ?, snooze_started_at = NULL WHERE room_id = ?", s, roomId);
}

export async function metricsAssignee(ctx: AppContext, roomId: string, memberId: string | null): Promise<void> {
  await ctx.db.run("UPDATE room_metrics SET assignee_id = ? WHERE room_id = ?", memberId, roomId);
}

export async function metricsTriage(ctx: AppContext, roomId: string, t: { intent?: string; sentiment?: string; urgency?: number }): Promise<void> {
  await ctx.db.run("UPDATE room_metrics SET ai_intent = ?, ai_sentiment = ?, ai_urgency = ? WHERE room_id = ?", t.intent ?? null, t.sentiment ?? null, t.urgency ?? null, roomId);
}

/** Customer satisfaction, 1 to 5, once per close. */
export async function recordCsat(ctx: AppContext, room: RoomRow, score: number, comment?: string): Promise<boolean> {
  const at = nowIso(ctx);
  const r = await ctx.db.run(
    "UPDATE room_metrics SET csat = ?, csat_at = ?, csat_comment = ? WHERE room_id = ? AND closed_at IS NOT NULL AND closed_at >= opened_at AND csat IS NULL",
    score,
    at,
    comment?.slice(0, 500) ?? null,
    room.id,
  );
  if (!r.changes) return false;
  await writeOutbox(ctx, TOPIC_ROOMS, room.id, { type: "room.csat", workspace_id: room.workspace_id, room_id: room.id, inbox_id: room.inbox_id, at, score });
  return true;
}
