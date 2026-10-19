import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { enqueueJob } from "../jobs/queue.js";
import { addMinutes } from "../util/time.js";
import { newId } from "../util/ids.js";
import { snippet } from "../util/html.js";
import { prefsOf } from "./members.js";
import { canEmail, selectRecipients } from "./notifications.js";
import { unreadCount } from "./rooms.js";
import type { RoomRow } from "./roomStore.js";

interface DigestItem {
  room_id: string;
  contact: string;
  count: number;
  last_snippet: string;
  tier: string;
}

/**
 * Delayed-message digest. Looks at contact messages that nobody has answered for MIN..MAX minutes, picks recipients by
 * tier (assigned to you / your team / unassigned for managers) honouring per-seat preferences, and queues ONE email job per seat.
 * `rooms.digest_seq` is advanced in the same pass, so a message is digested at most once no matter how often this runs.
 * Seats already emailed immediately about the same messages are skipped.
 */
export async function collectDigests(ctx: AppContext): Promise<{ rooms: number; queued: number }> {
  const now = ctx.clock();
  const minAge = addMinutes(now, -ctx.config.DIGEST_MIN_AGE_MINUTES).toISOString();
  const maxAge = addMinutes(now, -ctx.config.DIGEST_MAX_AGE_MINUTES).toISOString();
  const rooms = await ctx.db.all<RoomRow>(
    `SELECT r.* FROM rooms r WHERE r.digest_due = 1 AND r.archived = 0 AND r.status = 'open' AND EXISTS (
       SELECT 1 FROM messages m WHERE m.room_id = r.id AND m.seq > r.digest_seq AND m.sender_type = 'contact' AND m.deleted_at IS NULL AND m.created_at <= ?)`,
    minAge,
  );
  const perMember = new Map<string, DigestItem[]>();
  for (const room of rooms) {
    const pending = await ctx.db.all<{ seq: number; content_text: string; created_at: string }>(
      "SELECT seq, content_text, created_at FROM messages WHERE room_id = ? AND seq > ? AND sender_type = 'contact' AND deleted_at IS NULL AND created_at <= ? ORDER BY seq",
      room.id,
      room.digest_seq,
      minAge,
    );
    if (!pending.length) continue;
    const maxSeq = pending[pending.length - 1]!.seq;
    const newest = pending[pending.length - 1]!;
    // advance first: even if nobody qualifies, these messages are never reconsidered
    await ctx.db.run(
      `UPDATE rooms SET digest_seq = ?, digest_due = CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.room_id = rooms.id AND m.seq > ? AND m.sender_type = 'contact' AND m.deleted_at IS NULL) THEN 1 ELSE 0 END WHERE id = ?`,
      maxSeq,
      maxSeq,
      room.id,
    );
    if (newest.created_at < maxAge) continue;
    const contact = await ctx.db.get<{ name: string; email: string | null; phone: string | null }>(
      "SELECT name, email, phone FROM contacts WHERE id = ?",
      room.contact_id,
    );
    for (const r of await selectRecipients(ctx, room)) {
      if (!prefsOf(r.member).delayed_msgs || !(await canEmail(ctx, r.member))) continue;
      if ((await unreadCount(ctx, room.id, r.member.id)) === 0) continue;
      const alreadyEmailed = await ctx.db.get(
        `SELECT 1 FROM notifications n JOIN messages m ON m.id = n.message_id
         WHERE n.member_id = ? AND n.room_id = ? AND n.emailed_at IS NOT NULL AND m.seq > ? AND m.seq <= ?`,
        r.member.id,
        room.id,
        room.digest_seq,
        maxSeq,
      );
      if (alreadyEmailed) continue;
      const items = perMember.get(r.member.id) ?? [];
      items.push({
        room_id: room.id,
        contact: contact?.name || contact?.email || contact?.phone || "Contact",
        count: pending.length,
        last_snippet: snippet(newest.content_text, 100),
        tier: r.tier,
      });
      perMember.set(r.member.id, items);
    }
  }
  let queued = 0;
  for (const [memberId, items] of perMember) {
    const key = `digest:${memberId}:${items
      .map((i) => i.room_id)
      .sort()
      .join(",")}:${nowIso(ctx)}`;
    if (await enqueueJob(ctx, "digest_email", { member_id: memberId, items }, { dedupeKey: key })) queued++;
  }
  return { rooms: rooms.length, queued };
}

export async function sendDigestEmail(ctx: AppContext, payload: { member_id: string; items: DigestItem[] }): Promise<void> {
  const m = await ctx.db.get<{ email: string; name: string }>(
    "SELECT u.email, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.removed_at IS NULL",
    payload.member_id,
  );
  if (!m || !payload.items.length) return;
  const base = ctx.config.PUBLIC_URL.replace(/\/$/, "");
  const lines = payload.items.map((i) => `- ${i.contact}: ${i.count} new message${i.count === 1 ? "" : "s"} ("${i.last_snippet}") ${base}/inbox/${i.room_id}`);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  await ctx.email.send({
    from: { address: ctx.config.SYSTEM_EMAIL_FROM, name: "Conversations" },
    to: m.email,
    subject: payload.items.length === 1 ? `Unanswered message from ${payload.items[0]!.contact}` : `${payload.items.length} conversations are waiting for a reply`,
    text: `Hi ${m.name},\n\nThese conversations have unread messages:\n\n${lines.join("\n")}\n`,
    html: `<p>Hi ${esc(m.name)},</p><p>These conversations have unread messages:</p><ul>${payload.items
      .map((i) => `<li><a href="${base}/inbox/${i.room_id}">${esc(i.contact)}</a>: ${i.count} new (${esc(i.last_snippet)})</li>`)
      .join("")}</ul>`,
    messageId: `<${newId("d")}@${ctx.config.SYSTEM_EMAIL_FROM.split("@")[1] ?? "localhost"}>`,
  });
}
