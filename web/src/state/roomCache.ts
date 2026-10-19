import type { InfiniteData } from "@tanstack/react-query";
import type { Room, RoomPage, RoomPatch, RoomSort, RoomStatusTab } from "../api/types";

export type RoomListData = InfiniteData<RoomPage>;

export interface ListOptions {
  status: RoomStatusTab;
  sort: RoomSort;
  now: Date;
}

export const isSnoozed = (r: Pick<Room, "snooze_until">, now: Date): boolean => !!r.snooze_until && new Date(r.snooze_until).getTime() > now.getTime();

export function roomMatchesStatus(r: Pick<Room, "status" | "snooze_until">, status: RoomStatusTab, now: Date): boolean {
  if (status === "closed") return r.status === "closed";
  if (r.status !== "open") return false;
  return status === "snoozed" ? isSnoozed(r, now) : !isSnoozed(r, now);
}

export const flattenRooms = (data: RoomListData | undefined): Room[] => data?.pages.flatMap((p) => p.data) ?? [];
export const findRoom = (data: RoomListData | undefined, id: string): Room | undefined => flattenRooms(data).find((r) => r.id === id);

const mapPages = (data: RoomListData, fn: (rooms: Room[]) => Room[]): RoomListData => ({ ...data, pages: data.pages.map((p) => ({ ...p, data: fn(p.data) })) });

export function removeRoom(data: RoomListData, id: string): RoomListData {
  return findRoom(data, id) ? mapPages(data, (rooms) => rooms.filter((r) => r.id !== id)) : data;
}

function moveToFront(data: RoomListData, id: string): RoomListData {
  const room = findRoom(data, id);
  if (!room) return data;
  const pages = data.pages.map((p) => ({ ...p, data: p.data.filter((r) => r.id !== id) }));
  const first = pages[0];
  if (first) first.data.unshift(room);
  return { ...data, pages };
}

export type RoomChange = RoomPatch | ((room: Room) => RoomPatch);

/**
 * Apply a change to a room already in a list: merge fields, drop it when it no longer belongs to the list's status tab,
 * and float it to the top for "newest" sorting when there is new activity.
 */
export function updateRoomInList(data: RoomListData, id: string, change: RoomChange, opts: ListOptions): RoomListData {
  const current = findRoom(data, id);
  if (!current) return data;
  const patch = typeof change === "function" ? change(current) : change;
  const next = { ...current, ...patch, id } as Room;
  const merged = mapPages(data, (rooms) => rooms.map((r) => (r.id === id ? next : r)));
  if (!roomMatchesStatus(next, opts.status, opts.now)) return removeRoom(merged, id);
  const newActivity = (next.last_message_at ?? "") > (current.last_message_at ?? "");
  return opts.sort === "newest" && newActivity ? moveToFront(merged, id) : merged;
}

/** A brand-new room belongs at the top of newest-sorted lists whose status tab it matches (and that are not search results). */
export function insertRoomInList(data: RoomListData, room: Room, opts: ListOptions): RoomListData {
  if (findRoom(data, room.id)) return updateRoomInList(data, room.id, room, opts);
  if (opts.sort !== "newest" || !roomMatchesStatus(room, opts.status, opts.now)) return data;
  const [first, ...rest] = data.pages;
  if (!first) return data;
  return { ...data, pages: [{ ...first, data: [room, ...first.data] }, ...rest] };
}

export const sumUnread = (data: RoomListData | undefined): number => flattenRooms(data).reduce((n, r) => n + (r.unread_count > 0 ? 1 : 0), 0);
