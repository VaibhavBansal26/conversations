import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { newId } from "../util/ids.js";
import { unreadNotificationCount } from "../services/notifications.js";

/** Whole-number money for text: 1999 USD -> "$19.99"; zero-decimal currencies (JPY) are handled by Intl's own digit count. */
export function formatMoney(minor: number, currency: string): string {
  const f = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
  return f.format(minor / 10 ** digits);
}

/**
 * Tell the workspace owners about a billing event: an in-app notification (live over the socket) and an email. Billing mail is not
 * suppressed by presence or do-not-disturb the way chat notifications are; it is rare and the owner needs to act on it.
 */
export async function notifyMember(ctx: AppContext, workspaceId: string, memberId: string, n: { type: string; title: string; body: string; roomId?: string }): Promise<void> {
  const id = newId("ntf");
  await ctx.db.run("INSERT INTO notifications(id, workspace_id, member_id, type, room_id, title, body, created_at) VALUES (?,?,?,?,?,?,?,?)", id, workspaceId, memberId, n.type, n.roomId ?? null, n.title, n.body, nowIso(ctx));
  ctx.bus.toMember(workspaceId, memberId, "notification:new", {
    notification: { id, type: n.type, room_id: n.roomId ?? null, message_id: null, title: n.title, body: n.body, read_at: null, created_at: nowIso(ctx) },
    unread_count: await unreadNotificationCount(ctx, memberId),
  });
}

export async function notifyOwners(ctx: AppContext, workspaceId: string, n: { type: string; title: string; body: string; roomId?: string }): Promise<void> {
  const owners = await ctx.db.all<{ id: string; email: string }>(
    "SELECT m.id, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner' AND m.removed_at IS NULL",
    workspaceId,
  );
  const link = `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/settings/billing`;
  for (const o of owners) {
    const id = newId("ntf");
    await ctx.db.run("INSERT INTO notifications(id, workspace_id, member_id, type, room_id, title, body, created_at) VALUES (?,?,?,?,?,?,?,?)", id, workspaceId, o.id, n.type, n.roomId ?? null, n.title, n.body, nowIso(ctx));
    ctx.bus.toMember(workspaceId, o.id, "notification:new", {
      notification: { id, type: n.type, room_id: n.roomId ?? null, message_id: null, title: n.title, body: n.body, read_at: null, created_at: nowIso(ctx) },
      unread_count: await unreadNotificationCount(ctx, o.id),
    });
    try {
      await ctx.email.send({
        from: { address: ctx.config.SYSTEM_EMAIL_FROM, name: "Conversations billing" },
        to: o.email,
        subject: n.title,
        text: `${n.body}\n\nManage billing: ${link}`,
        html: `<p>${n.body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p><p><a href="${link}">Manage billing</a></p>`,
        messageId: `<${newId("b")}@${ctx.config.SYSTEM_EMAIL_FROM.split("@")[1] ?? "localhost"}>`,
      });
    } catch (e) {
      ctx.log.warn("billing email failed", { workspace_id: workspaceId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
