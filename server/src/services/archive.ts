import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { newId } from "../util/ids.js";
import { notFound } from "../errors.js";
import { purgeTickets } from "./tickets.js";

/**
 * Tiering, retention and erasure for the (large) messages table.
 *  - archiveMessages: export messages older than a cutoff for one workspace to object storage as gzip NDJSON, verify, then delete them
 *  - restoreArchive: put an archive back (idempotent: rows that already exist are skipped)
 *  - purgeWorkspaceMessages: GDPR erasure of a tenant, in batches so it never holds a long lock
 *  - retentionSweep: applies each workspace's `retention_days`
 * On PostgreSQL, whole months can also be detached (partitions.ts) and dumped with pg_dump instead; this path works on both backends.
 */

const COLS = [
  "id", "workspace_id", "room_id", "seq", "client_msg_id", "sender_type", "sender_id", "sender_name", "kind", "source", "content", "content_text", "subject",
  "ref_message_id", "attachments", "meta", "delivery", "failure_reason", "provider_message_id", "rfc_message_id", "in_reply_to", "references_hdr", "from_addr",
  "to_addr", "retry_count", "delivered_at", "opened_at", "edited_at", "deleted_at", "deleted_by", "ticket_id", "created_at",
] as const;

type Row = Record<(typeof COLS)[number], string | number | null>;

export interface ArchiveResult {
  archives: number;
  rows: number;
  keys: string[];
}

export async function archiveMessages(ctx: AppContext, workspaceId: string, before: Date, opts: { batch?: number; keepRows?: boolean } = {}): Promise<ArchiveResult> {
  const batch = opts.batch ?? 5000;
  const cutoff = before.toISOString();
  const out: ArchiveResult = { archives: 0, rows: 0, keys: [] };
  for (;;) {
    const rows = await ctx.db.all<Row>(`SELECT ${COLS.join(", ")} FROM messages WHERE workspace_id = ? AND created_at < ? ORDER BY created_at, id LIMIT ?`, workspaceId, cutoff, batch);
    if (!rows.length) break;
    const body = gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    const sha = createHash("sha256").update(body).digest("hex");
    const stored = await ctx.storage.put(workspaceId, { name: `messages-${rows[0]!.created_at}.ndjson.gz`, contentType: "application/gzip", content: body });
    // verify before deleting anything: read it back and compare
    const back = await ctx.storage.read(stored.key);
    if (!back || createHash("sha256").update(back).digest("hex") !== sha) throw new Error("archive verification failed; nothing was deleted");
    const id = newId("arc");
    await ctx.db.tx(async () => {
      await ctx.db.run(
        "INSERT INTO archive_manifest(id, workspace_id, storage_key, rows, from_created_at, to_created_at, sha256, created_at) VALUES (?,?,?,?,?,?,?,?)",
        id, workspaceId, stored.key, rows.length, rows[0]!.created_at, rows[rows.length - 1]!.created_at, sha, nowIso(ctx),
      );
      if (!opts.keepRows) {
        const ids = rows.map((r) => r.id as string);
        await ctx.db.run(`DELETE FROM message_mentions WHERE message_id IN (${ids.map(() => "?").join(",")})`, ...ids);
        await ctx.db.run(`DELETE FROM messages WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`, workspaceId, ...ids);
      }
    });
    out.archives++;
    out.rows += rows.length;
    out.keys.push(stored.key);
    if (opts.keepRows) break; // a dry export would loop forever on the same rows
    if (rows.length < batch) break;
  }
  return out;
}

export async function restoreArchive(ctx: AppContext, manifestId: string): Promise<{ restored: number; skipped: number }> {
  const m = await ctx.db.get<{ workspace_id: string; storage_key: string; sha256: string }>("SELECT workspace_id, storage_key, sha256 FROM archive_manifest WHERE id = ?", manifestId);
  if (!m) throw notFound("Archive");
  const body = await ctx.storage.read(m.storage_key);
  if (!body) throw new Error("archive file is missing from storage");
  if (createHash("sha256").update(body).digest("hex") !== m.sha256) throw new Error("archive checksum mismatch");
  const rows = gunzipSync(body).toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
  let restored = 0;
  let skipped = 0;
  await ctx.db.tx(async () => {
    for (const r of rows) {
      const exists = await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND id = ?", r.room_id as string, r.id as string);
      if (exists) {
        skipped++;
        continue;
      }
      await ctx.db.run(`INSERT INTO messages(${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})`, ...COLS.map((c) => r[c] as never));
      restored++;
    }
    await ctx.db.run("UPDATE archive_manifest SET restored_at = ? WHERE id = ?", nowIso(ctx), manifestId);
  });
  return { restored, skipped };
}

/** GDPR: remove every message of a workspace in bounded batches (each batch its own short transaction). */
export async function purgeWorkspaceMessages(ctx: AppContext, workspaceId: string, batch = 2000): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = (await ctx.db.all<{ id: string }>("SELECT id FROM messages WHERE workspace_id = ? ORDER BY created_at, id LIMIT ?", workspaceId, batch)).map((r) => r.id);
    if (!ids.length) break;
    await ctx.db.tx(async () => {
      await ctx.db.run(`DELETE FROM message_mentions WHERE message_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      await ctx.db.run(`DELETE FROM messages WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`, workspaceId, ...ids);
    });
    total += ids.length;
  }
  await purgeTickets(ctx, workspaceId);
  await ctx.db.run("DELETE FROM message_qids WHERE room_id IN (SELECT id FROM rooms WHERE workspace_id = ?)", workspaceId);
  await ctx.db.run("UPDATE rooms SET last_brief = NULL, last_message_id = NULL WHERE workspace_id = ?", workspaceId);
  return total;
}

/** Daily: archive (and remove) messages older than each workspace's retention_days. Returns rows archived per workspace. */
export async function retentionSweep(ctx: AppContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const wss = await ctx.db.all<{ id: string; settings: string }>("SELECT id, settings FROM workspaces");
  for (const w of wss) {
    let days = 0;
    try {
      days = Number((JSON.parse(w.settings) as { retention_days?: number }).retention_days ?? 0);
    } catch {
      /* ignore unparsable settings */
    }
    if (days <= 0) continue;
    const cutoff = new Date(ctx.clock().getTime() - days * 86400_000);
    const r = await archiveMessages(ctx, w.id, cutoff);
    if (r.rows) out[w.id] = r.rows;
    await purgeTickets(ctx, w.id, cutoff);
  }
  // idempotency keys only need to outlive the client retry window
  await ctx.db.run("DELETE FROM message_qids WHERE created_at < ?", new Date(ctx.clock().getTime() - 30 * 86400_000).toISOString());
  return out;
}
