import type { Message, Room } from "../api/types";

/** Mirrors the server rule: notes, system lines and the viewer's own messages never count as unread. */
export function countsAsUnread(message: Pick<Message, "kind" | "sender">, selfMemberId: string): boolean {
  if (message.kind === "note" || message.kind === "system") return false;
  if (message.sender.type === "system") return false;
  return !(message.sender.type === "agent" && message.sender.id === selfMemberId);
}

export const formatBadge = (n: number): string => (n > 99 ? "99+" : String(n));

/** Number of rooms with something unread (what the tab title / nav badge shows). */
export const totalUnreadRooms = (rooms: Pick<Room, "unread_count">[]): number => rooms.filter((r) => r.unread_count > 0).length;

export const documentTitle = (unreadRooms: number): string => (unreadRooms > 0 ? `(${formatBadge(unreadRooms)}) Conversations` : "Conversations");
