import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { newId } from "../util/ids.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";

export interface AuditEntry {
  workspaceId?: string | null;
  actor: { type: "member" | "platform_admin" | "system" | "api_key" | "anonymous"; id?: string | null };
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Append one record to the audit log. The table is append-only at the database level (triggers reject UPDATE and DELETE), so this is
 * the only write path that exists. Never put secrets, passwords, tokens or message content in `detail`.
 */
export async function recordAudit(ctx: AppContext, e: AuditEntry): Promise<string> {
  const id = newId("aud");
  await ctx.db.run(
    "INSERT INTO audit_log(id, workspace_id, actor_type, actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?,?,?)",
    id,
    e.workspaceId ?? null,
    e.actor.type,
    e.actor.id ?? null,
    e.action,
    e.target ?? null,
    JSON.stringify(e.detail ?? {}),
    nowIso(ctx),
  );
  return id;
}

export interface AuditRow {
  id: string;
  workspace_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  detail: string;
  created_at: string;
}

/** Newest first, keyset-paged on (created_at, id). */
export async function listAudit(ctx: AppContext, workspaceId: string, q: { limit: number; cursor?: string; action?: string }) {
  const limit = Math.min(Math.max(q.limit, 1), 200);
  const where = ["workspace_id = ?"];
  const params: (string | number)[] = [workspaceId];
  if (q.action) {
    where.push("action LIKE ?");
    params.push(`${q.action.replace(/[%_]/g, "")}%`);
  }
  if (q.cursor) {
    const c = decodeCursor(q.cursor, 2)!;
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(c[0] as string, c[0] as string, c[1] as string);
  }
  const rows = await ctx.db.read().all<AuditRow>(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> })),
    next_cursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null,
  };
}
