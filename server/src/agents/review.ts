import { z } from "zod";
import type { AppContext } from "../context.js";
import type { Actor } from "../domain/types.js";
import { notFound } from "../errors.js";
import { tokenize } from "../ai/retrieval.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";
import { parseJson } from "../util/json.js";
import { findMessageRow } from "../services/messageStore.js";
import { getVisibleRoom } from "../services/roomStore.js";
import { similarity } from "./safety.js";
import { saveFeedback } from "./visitorActions.js";
import type { Source } from "./pipeline.js";

/** The quality loop: every turn the agents took, the thumbs people gave, and the questions the knowledge base could not answer. */

export const TurnQuery = z.object({
  agent_id: z.string().max(64).optional(),
  outcome: z.enum(["answered", "suggested", "clarified", "refused", "handoff", "resolved", "skipped"]).optional(),
  rated: z.enum(["up", "down", "any"]).optional(),
  ticket_id: z.string().max(64).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const UnansweredQuery = z.object({ days: z.coerce.number().int().min(1).max(180).default(30), agent_id: z.string().max(64).optional() });
export const FeedbackBody = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().trim().max(500).optional() });

interface TurnRow {
  id: string;
  created_at: string;
  ticket_id: string;
  room_id: string;
  agent_id: string;
  trigger_message_id: string | null;
  message_id: string | null;
  outcome: string;
  intent: string | null;
  department_id: string | null;
  confidence: number | null;
  reason: string | null;
  sources: string;
  actions: string;
  query: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
}

export async function listTurns(ctx: AppContext, actor: Actor, q: z.infer<typeof TurnQuery>) {
  const where = ["t.workspace_id = ?"];
  const params: (string | number)[] = [actor.workspaceId];
  if (q.agent_id) (where.push("t.agent_id = ?"), params.push(q.agent_id));
  if (q.outcome) (where.push("t.outcome = ?"), params.push(q.outcome));
  if (q.ticket_id) (where.push("t.ticket_id = ?"), params.push(q.ticket_id));
  if (q.rated === "down") where.push("EXISTS (SELECT 1 FROM ai_feedback f WHERE f.message_id = t.message_id AND f.rating = -1)");
  if (q.rated === "up") where.push("EXISTS (SELECT 1 FROM ai_feedback f WHERE f.message_id = t.message_id AND f.rating = 1)");
  if (q.rated === "any") where.push("EXISTS (SELECT 1 FROM ai_feedback f WHERE f.message_id = t.message_id)");
  const cur = decodeCursor(q.cursor, 2);
  if (cur) (where.push("(t.created_at, t.id) < (?, ?)"), params.push(cur[0]!, cur[1]!));
  const rows = await ctx.db.read().all<TurnRow & { number: number | null; answer: string | null; visitor_text: string | null }>(
    `SELECT t.*, k.number AS number, m.content_text AS answer, v.content_text AS visitor_text
     FROM ai_turns t LEFT JOIN tickets k ON k.id = t.ticket_id
       LEFT JOIN messages m ON m.room_id = t.room_id AND m.id = t.message_id
       LEFT JOIN messages v ON v.room_id = t.room_id AND v.id = t.trigger_message_id
     WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    ...params,
    q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const ids = page.map((r) => r.message_id).filter((x): x is string => !!x);
  const votes = new Map<string, { up: number; down: number }>();
  if (ids.length) {
    for (const f of await ctx.db.read().all<{ message_id: string; rating: number; n: number }>(`SELECT message_id, rating, COUNT(*) AS n FROM ai_feedback WHERE message_id IN (${ids.map(() => "?").join(",")}) GROUP BY message_id, rating`, ...ids)) {
      const v = votes.get(f.message_id) ?? { up: 0, down: 0 };
      if (f.rating === 1) v.up = Number(f.n);
      else v.down = Number(f.n);
      votes.set(f.message_id, v);
    }
  }
  const last = page[page.length - 1];
  return {
    data: page.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      ticket_id: r.ticket_id,
      ticket_number: r.number,
      room_id: r.room_id,
      agent_id: r.agent_id,
      outcome: r.outcome,
      intent: r.intent,
      department_id: r.department_id,
      confidence: r.confidence,
      reason: r.reason,
      visitor_text: r.visitor_text ?? r.query,
      answer: r.answer,
      sources: parseJson<Source[]>(r.sources, []),
      actions: parseJson<{ tool: string; ok: boolean }[]>(r.actions, []),
      provider: r.provider,
      tokens: { in: r.tokens_in, out: r.tokens_out },
      latency_ms: r.latency_ms,
      votes: (r.message_id && votes.get(r.message_id)) || { up: 0, down: 0 },
      message_id: r.message_id,
    })),
    pagination: { limit: q.limit, has_more: rows.length > q.limit, next_cursor: rows.length > q.limit && last ? encodeCursor([last.created_at, last.id]) : null },
  };
}

export interface UnansweredCluster {
  count: number;
  sample: string;
  examples: string[];
  last_seen: string;
  /** a title to start the knowledge-base entry from */
  suggested_question: string;
}

/**
 * Questions the knowledge base could not answer (the agent asked for details or handed over for lack of an answer), grouped by what they share:
 * each question joins the first group it resembles (at least half of its distinct words in common), so "how do I change my invoice email" and
 * "change the email on my invoices?" count as one. Largest groups first: the order to write knowledge-base entries in.
 */
export async function unansweredQuestions(ctx: AppContext, actor: Actor, q: z.infer<typeof UnansweredQuery>): Promise<{ data: UnansweredCluster[]; since: string }> {
  const since = new Date(ctx.clock().getTime() - q.days * 86400_000).toISOString();
  const rows = await ctx.db.read().all<{ query: string; created_at: string }>(
    `SELECT query, created_at FROM ai_turns WHERE workspace_id = ? AND created_at >= ? AND query <> '' AND (outcome = 'clarified' OR (outcome IN ('handoff','suggested') AND reason IN ('no_answer','low_confidence')))
       ${q.agent_id ? "AND agent_id = ?" : ""} ORDER BY created_at DESC LIMIT 2000`,
    ...(q.agent_id ? [actor.workspaceId, since, q.agent_id] : [actor.workspaceId, since]),
  );
  const clusters: { words: Set<string>; items: { text: string; at: string }[] }[] = [];
  for (const r of rows) {
    const words = new Set(tokenize(r.query));
    if (words.size < 2) continue;
    const home = clusters.find((c) => similarity(r.query, c.items[0]!.text) >= 0.5);
    if (home) home.items.push({ text: r.query, at: r.created_at });
    else clusters.push({ words, items: [{ text: r.query, at: r.created_at }] });
  }
  return {
    since,
    data: clusters
      .map((c) => ({
        count: c.items.length,
        sample: c.items[0]!.text,
        examples: [...new Set(c.items.map((i) => i.text))].slice(0, 3),
        last_seen: c.items.reduce((m, i) => (i.at > m ? i.at : m), ""),
        suggested_question: c.items[0]!.text.replace(/[?.!\s]+$/, "").slice(0, 120),
      }))
      .sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen))
      .slice(0, 50),
  };
}

/** A member of the team rates a bot answer in a conversation they can see. */
export async function memberFeedback(ctx: AppContext, actor: Actor, messageId: string, input: z.infer<typeof FeedbackBody>, roomHint?: string) {
  const m = await findMessageRow(ctx, actor.workspaceId, messageId, roomHint);
  if (!m || m.deleted_at || m.sender_type !== "bot" || !parseJson<{ ai?: boolean }>(m.meta, {}).ai) throw notFound("Message");
  await getVisibleRoom(ctx, actor, m.room_id);
  await saveFeedback(ctx, { workspaceId: actor.workspaceId, message: m, raterType: "member", raterId: actor.memberId, rating: input.rating, comment: input.comment });
  return { ok: true as const };
}
