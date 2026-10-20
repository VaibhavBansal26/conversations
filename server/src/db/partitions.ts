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

/**
 * Detach every monthly leaf older than `olderThanMonths` (all hash partitions). Detaching is a metadata change, so retiring a month is
 * O(1) regardless of its size; the detached tables remain as ordinary tables to pg_dump / copy to object storage and then DROP.
 * `restoreMessagePartition` attaches one back. Returns the table names detached.
 */
export async function detachOldMessagePartitions(db: Db, olderThanMonths: number): Promise<string[]> {
  if (db.dialect !== "postgres") return [];
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - olderThanMonths);
  const cut = `${cutoff.getUTCFullYear()}${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}`;
  const leaves = await db.all<{ name: string; parent: string }>(
    `SELECT c.relname AS name, p.relname AS parent FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname LIKE 'messages_h%' AND p.relname NOT LIKE '%default' AND c.relname ~ '_[0-9]{6}$'`,
  );
  const out: string[] = [];
  for (const l of leaves) {
    const month = l.name.slice(-6);
    if (month >= cut) continue;
    await db.exec(`ALTER TABLE ${l.parent} DETACH PARTITION ${l.name}`);
    out.push(l.name);
  }
  return out;
}

export async function restoreMessagePartition(db: Db, leaf: string): Promise<void> {
  if (db.dialect !== "postgres") return;
  const m = /^(messages_h\d+)_(\d{4})(\d{2})$/.exec(leaf);
  if (!m) throw new Error("not a message partition name");
  const y = Number(m[2]);
  const mo = Number(m[3]);
  const lo = `${m[2]}-${m[3]}-01T00:00:00.000Z`;
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  const hi = `${ny}-${String(nm).padStart(2, "0")}-01T00:00:00.000Z`;
  await db.exec(`ALTER TABLE ${m[1]} ATTACH PARTITION ${leaf} FOR VALUES FROM ('${lo}') TO ('${hi}')`);
}
