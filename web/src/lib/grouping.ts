import type { Message } from "../api/types";
import { dayKey, dayLabel } from "./time";

export const GROUP_WINDOW_MS = 5 * 60_000;

export type ListItem =
  | { type: "day"; key: string; label: string }
  | { type: "message"; key: string; message: Message; first: boolean; last: boolean };

const senderKey = (m: Message) => `${m.sender.type}:${m.sender.id ?? m.sender.name}`;

/** Messages from the same sender within five minutes (same day, same note-ness) share a visual group. */
export function sameGroup(prev: Message, next: Message): boolean {
  if (prev.kind === "system" || next.kind === "system") return false;
  if ((prev.kind === "note") !== (next.kind === "note")) return false;
  if (senderKey(prev) !== senderKey(next) || dayKey(prev.created_at) !== dayKey(next.created_at)) return false;
  return new Date(next.created_at).getTime() - new Date(prev.created_at).getTime() <= GROUP_WINDOW_MS;
}

export function buildItems(messages: Message[], now: Date = new Date()): ListItem[] {
  const items: ListItem[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) items.push({ type: "day", key: `day-${dayKey(m.created_at)}`, label: dayLabel(m.created_at, now) });
    items.push({
      type: "message",
      key: m.client_msg_id ?? m.id,
      message: m,
      first: !prev || !sameGroup(prev, m),
      last: !next || !sameGroup(m, next),
    });
  });
  return items;
}
