import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { maybeAutoRespond, triageMessage } from "../ai/service.js";
import { textToHtml } from "../util/html.js";
import { addSeconds } from "../util/time.js";
import { emitInserted, insertMessage, type MessageRow } from "./messageStore.js";
import { notifyContactMessage, notifyMentions } from "./notifications.js";
import { isOpen, nextOpening } from "./office.js";
import { getRoomRow, type RoomRow } from "./roomStore.js";
import { getSettings } from "./workspaces.js";

export const BOT_NAME = "Chatbot";
const AWAY_COOLDOWN_SECONDS = 6 * 3600;

export function postBotMessage(ctx: AppContext, room: RoomRow, text: string, meta: Record<string, unknown>): MessageRow {
  const r = insertMessage(ctx, {
    workspaceId: room.workspace_id, roomId: room.id, senderType: "bot", senderId: "bot", senderName: BOT_NAME,
    kind: "text", source: "dm", content: textToHtml(text), contentText: text, meta,
  });
  emitInserted(ctx, r);
  return r.message;
}

/** Outside office hours, tell the visitor when someone will be back (at most once per cooldown window). */
export function maybeAwayMessage(ctx: AppContext, room: RoomRow): boolean {
  const widget = getSettings(ctx, room.workspace_id).widget;
  const now = ctx.clock();
  if (isOpen(widget.office_hours, now)) return false;
  const recent = ctx.db.get(
    "SELECT 1 FROM messages WHERE room_id = ? AND sender_type = 'bot' AND created_at > ? AND meta LIKE '%\"away\":true%' LIMIT 1",
    room.id, addSeconds(now, -AWAY_COOLDOWN_SECONDS).toISOString(),
  );
  if (recent) return false;
  const next = nextOpening(widget.office_hours, now);
  postBotMessage(ctx, getRoomRow(ctx, room.workspace_id, room.id), `${widget.away_message}${next ? ` We'll be back ${next}.` : ""}`, { away: true, at: nowIso(ctx) });
  return true;
}

/** Everything that should happen after a contact message is stored. Never blocks or fails the inbound path. */
export function onContactMessage(ctx: AppContext, room: RoomRow, message: MessageRow): void {
  ctx.background.run(async () => {
    notifyContactMessage(ctx, getRoomRow(ctx, room.workspace_id, room.id), message);
    await triageMessage(ctx, room, message);
    const bot = await maybeAutoRespond(ctx, room, message);
    if (message.source === "dm" && bot !== "answered") maybeAwayMessage(ctx, room);
  });
}

export function onAgentMessage(ctx: AppContext, room: RoomRow, message: MessageRow, actor: Actor, mentions: string[]): void {
  if (mentions.length) ctx.background.run(() => notifyMentions(ctx, room, message, actor, mentions));
}
