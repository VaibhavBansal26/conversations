import type { Db } from "./index.js";

/**
 * Keep monthly message partitions created ahead of time (pg_partman style). PostgreSQL only; a no-op on SQLite. Safe to call from every
 * node: creation is idempotent and runs inside the database function from migration 008.
 */
export async function ensureMessagePartitions(db: Db, monthsAhead = 3, monthsBack = 1): Promise<number> {
  if (db.dialect !== "postgres") return 0;
  const r = await db.get<{ n: number }>(
    "SELECT conv_ensure_message_partitions((date_trunc('month', now()) - make_interval(months => ?))::date, (date_trunc('month', now()) + make_interval(months => ?))::date) AS n",
    monthsBack,
    monthsAhead,
  );
  return Number(r?.n ?? 0);
}

/** Leaf partitions of `messages` with row estimates and sizes (admin/ops view and tests). */
export async function listMessagePartitions(db: Db): Promise<{ name: string; parent: string; bytes: number; rows: number }[]> {
  if (db.dialect !== "postgres") return [];
  return db.all(
    `SELECT c.relname AS name, p.relname AS parent, pg_total_relation_size(c.oid) AS bytes, GREATEST(c.reltuples, 0)::bigint AS rows
     FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class p ON p.oid = i.inhparent
     WHERE c.relkind = 'r' AND p.relname LIKE 'messages_h%' ORDER BY c.relname`,
  );
}
