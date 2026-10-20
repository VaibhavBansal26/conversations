import type { AppContext } from "../context.js";
import type { MessageRow } from "./messageStore.js";

export type RefKind = "provider" | "rfc" | "id";

/** Record how to find a message without knowing its room (see migration 011). Idempotent. */
export async function putRef(ctx: AppContext, kind: RefKind, ref: string, m: { id: string; workspace_id: string; room_id: string }): Promise<void> {
  await ctx.db.run("INSERT OR IGNORE INTO message_refs(kind, ref, workspace_id, message_id, room_id) VALUES (?,?,?,?,?)", kind, ref, m.workspace_id, m.id, m.room_id);
}

/** Find a message by an external reference with one locator read plus a single-partition query. */
export async function getByRef(ctx: AppContext, kind: RefKind, ref: string, o: { workspaceId?: string; source?: string } = {}): Promise<MessageRow | undefined> {
  const loc = o.workspaceId
    ? await ctx.db.get<{ message_id: string; room_id: string }>("SELECT message_id, room_id FROM message_refs WHERE kind = ? AND ref = ? AND workspace_id = ?", kind, ref, o.workspaceId)
    : await ctx.db.get<{ message_id: string; room_id: string }>("SELECT message_id, room_id FROM message_refs WHERE kind = ? AND ref = ? LIMIT 1", kind, ref);
  if (!loc) return undefined;
  const m = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND id = ?", loc.room_id, loc.message_id);
  return m && (!o.source || m.source === o.source) ? m : undefined;
}
