import type { AppContext } from "../context.js";

/** Title and status of a conversation for a shared-conversation card. Callers have already checked that the viewer may open the room. */
export async function contactDisplay(ctx: AppContext, ws: string, roomId: string): Promise<{ title: string; status: string } | undefined> {
  const r = await ctx.db.get<{ status: string; name: string | null; email: string | null; phone: string | null; subject: string | null }>(
    "SELECT r.status AS status, r.subject AS subject, c.name AS name, c.email AS email, c.phone AS phone FROM rooms r JOIN contacts c ON c.id = r.contact_id WHERE r.id = ? AND r.workspace_id = ?",
    roomId,
    ws,
  );
  if (!r) return undefined;
  const who = r.name || r.email || r.phone || "Contact";
  return { title: r.subject ? `${who}: ${r.subject}` : who, status: r.status };
}
