import { dayKey, dayLabel } from "../lib/time";
import type { TeamMessage } from "./types";

export const TEAM_GROUP_WINDOW_MS = 5 * 60_000;

export type TeamItem =
  | { type: "day"; key: string; label: string }
  | { type: "message"; key: string; message: TeamMessage; first: boolean; last: boolean };

/** Same sender, same day, within five minutes, no thread summary or share card in between: one visual group. */
export function sameTeamGroup(prev: TeamMessage, next: TeamMessage): boolean {
  if (prev.kind === "system" || next.kind === "system") return false;
  if (prev.sender.id !== next.sender.id || dayKey(prev.created_at) !== dayKey(next.created_at)) return false;
  return new Date(next.created_at).getTime() - new Date(prev.created_at).getTime() <= TEAM_GROUP_WINDOW_MS;
}

export function buildTeamItems(messages: TeamMessage[], now: Date = new Date()): TeamItem[] {
  const items: TeamItem[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) items.push({ type: "day", key: `day-${dayKey(m.created_at)}`, label: dayLabel(m.created_at, now) });
    items.push({ type: "message", key: m.client_msg_id ?? m.id, message: m, first: !prev || !sameTeamGroup(prev, m), last: !next || !sameTeamGroup(m, next) });
  });
  return items;
}
