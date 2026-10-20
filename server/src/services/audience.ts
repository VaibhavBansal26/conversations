import type { AppContext } from "../context.js";

export interface RoomAudience {
  inboxId: string | null;
  assignees: string[];
}

/**
 * Who can see a room, as data. Team events for a room are fanned out to this audience (see `audienceChannels`) instead of to a per-room
 * channel that every eligible agent socket has to join: a socket's channel set no longer grows with the number of rooms, connecting is
 * O(inboxes) rather than O(rooms), and an assignment change is a cache invalidation instead of a membership rewrite on every node.
 * Cached briefly (CACHE_TTL_MS) with cluster-wide invalidation when the audience changes (`SocketBus.refreshRoomAccess`).
 */
export async function roomAudience(ctx: AppContext, workspaceId: string, roomId: string): Promise<RoomAudience> {
  return ctx.cache.wrap(`aud:${roomId}`, async () => {
    const room = await ctx.db.get<{ inbox_id: string | null }>("SELECT inbox_id FROM rooms WHERE id = ? AND workspace_id = ?", roomId, workspaceId);
    const rows = await ctx.db.all<{ member_id: string }>("SELECT member_id FROM room_assignees WHERE room_id = ?", roomId);
    return { inboxId: room?.inbox_id ?? null, assignees: rows.map((r) => r.member_id) };
  });
}

/**
 * Channels whose members may see a room, mirroring `roomVisibility`:
 *   managers            owners and managers (see everything)
 *   inboxv:<inboxId>    agents with inbox visibility "assigned_inbox" who belong to the room's inbox
 *   member:<id>         each assignee (all of that seat's tabs)
 * Socket.IO delivers once per socket even when a socket is in several of these.
 */
export async function audienceChannels(ctx: AppContext, workspaceId: string, roomId: string): Promise<string[]> {
  const a = await roomAudience(ctx, workspaceId, roomId);
  return ["managers", ...(a.inboxId ? [`inboxv:${a.inboxId}`] : []), ...a.assignees.map((m) => `member:${m}`)];
}
