import type { RoomDiff, RoomSig } from "../protocol";

/** What changed between two renderings of the room list (same sort order): used to flash rooms that moved or updated after a resync. */
export function diffRooms(prev: RoomSig[], next: RoomSig[]): RoomDiff {
  const before = new Map(prev.map((r, i) => [r.id, { sig: r.sig, i }]));
  const after = new Set(next.map((r) => r.id));
  const out: RoomDiff = { added: [], removed: [], changed: [], moved: [] };
  next.forEach((r, i) => {
    const b = before.get(r.id);
    if (!b) out.added.push(r.id);
    else {
      if (b.sig !== r.sig) out.changed.push(r.id);
      else if (b.i !== i) out.moved.push(r.id);
    }
  });
  for (const r of prev) if (!after.has(r.id)) out.removed.push(r.id);
  return out;
}

export const roomSig = (r: { updated_at: string; unread_count: number; status: string; priority: number; assignee_ids: string[] }): string =>
  `${r.updated_at}|${r.unread_count}|${r.status}|${r.priority}|${r.assignee_ids.join(",")}`;
