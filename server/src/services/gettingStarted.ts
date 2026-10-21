import type { AppContext } from "../context.js";
import { channelStatuses } from "./channels.js";

export type StartItemId = "invite_teammates" | "connect_sms" | "connect_email" | "install_widget" | "create_template";

export interface StartItem {
  id: StartItemId;
  done: boolean;
  /** screen in the app that does it */
  href: string;
}

/**
 * The "Getting started" checklist of a new workspace. Every item is derived from real state on each call (a teammate or a pending invitation, a live
 * SMS or email provider, a widget that loaded on a real site, a template) and nothing is stored: doing the thing is the only way to tick it,
 * and undoing it (disconnecting a channel) unticks it.
 */
export async function gettingStarted(ctx: AppContext, ws: string): Promise<{ items: StartItem[]; done: number; total: number }> {
  const count = async (sql: string, ...p: string[]) => Number((await ctx.db.get<{ n: number }>(sql, ...p))?.n ?? 0);
  const [members, invites, templates, seen] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND removed_at IS NULL", ws),
    count("SELECT COUNT(*) AS n FROM invitations WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?", ws, ctx.clock().toISOString()),
    count("SELECT COUNT(*) AS n FROM templates WHERE workspace_id = ?", ws),
    count("SELECT COUNT(*) AS n FROM tokens WHERE workspace_id = ? AND status = 'active' AND last_seen_at IS NOT NULL", ws),
  ]);
  const ch = await channelStatuses(ctx, ws);
  const items: StartItem[] = [
    { id: "invite_teammates", done: members > 1 || invites > 0, href: "/settings/members" },
    { id: "connect_sms", done: ch.sms.mode === "live", href: "/settings/channels" },
    { id: "connect_email", done: ch.email.mode === "live", href: "/settings/channels" },
    { id: "install_widget", done: seen > 0, href: "/settings/widget?tab=install" },
    { id: "create_template", done: templates > 0, href: "/settings/templates" },
  ];
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}
