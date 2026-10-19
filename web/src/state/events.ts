import type { QueryClient } from "@tanstack/react-query";
import type { MessageEventPayload, NotificationList, ReceiptPayload, Room, RoomPatch } from "../api/types";
import { countsAsUnread } from "../lib/unread";
import { keys, type RoomListFilters } from "./keys";
import { applyReceipt, removeMessage, upsertMessage, type Thread } from "./messageCache";
import { findRoom, insertRoomInList, updateRoomInList, type RoomListData, type RoomChange } from "./roomCache";

export interface BridgeContext {
  selfMemberId: string;
  /** Room currently open and visible; its messages are read immediately, so they do not bump unread. */
  activeRoomId: () => string | null;
  now?: () => Date;
}

const nowOf = (ctx: BridgeContext) => (ctx.now ?? (() => new Date()))();

const listQueries = (qc: QueryClient) => qc.getQueriesData<RoomListData>({ queryKey: keys.rooms });

/** Apply `change` to the room in every cached list and in the single-room cache. Returns whether any list knew the room. */
export function patchRoomEverywhere(qc: QueryClient, id: string, change: RoomChange, now: Date): boolean {
  let known = false;
  let moved = false;
  for (const [key, data] of listQueries(qc)) {
    if (!data || !findRoom(data, id)) continue;
    known = true;
    const filters = key[1] as RoomListFilters;
    const next = updateRoomInList(data, id, change, { status: filters.status, sort: filters.sort, now });
    qc.setQueryData<RoomListData>(key, next);
    // The room moved to another status tab: that tab's list must be refreshed to show it.
    if (!findRoom(next, id)) moved = true;
  }
  if (moved) void qc.invalidateQueries({ queryKey: keys.rooms });
  qc.setQueryData<Room>(keys.room(id), (cur) => {
    if (!cur) return cur;
    const patch = typeof change === "function" ? change(cur) : change;
    return { ...cur, ...patch, id };
  });
  return known;
}

const scheduleCounts = (qc: QueryClient) => void qc.invalidateQueries({ queryKey: keys.counts });

export function onMessageNew(qc: QueryClient, payload: MessageEventPayload, ctx: BridgeContext): void {
  const { message, room } = payload;
  qc.setQueryData<Thread>(keys.thread(message.room_id), (cur) => (cur ? upsertMessage(cur, message) : cur));
  const bump = countsAsUnread(message, ctx.selfMemberId) && ctx.activeRoomId() !== message.room_id ? 1 : 0;
  const known = patchRoomEverywhere(qc, message.room_id, (r) => ({ ...room, id: r.id, unread_count: r.unread_count + bump }), nowOf(ctx));
  // A room we have never loaded (e.g. reopened from another list) needs the server's view.
  if (!known) void qc.invalidateQueries({ queryKey: keys.rooms });
  scheduleCounts(qc);
}

export function onMessageUpdated(qc: QueryClient, payload: MessageEventPayload, ctx: BridgeContext): void {
  const { message, room } = payload;
  qc.setQueryData<Thread>(keys.thread(message.room_id), (cur) => (cur ? upsertMessage(cur, message) : cur));
  patchRoomEverywhere(qc, message.room_id, room, nowOf(ctx));
}

export function onMessageDeleted(qc: QueryClient, payload: { message_id: string; room_id: string }): void {
  qc.setQueryData<Thread>(keys.thread(payload.room_id), (cur) => (cur ? removeMessage(cur, payload.message_id) : cur));
  void qc.invalidateQueries({ queryKey: keys.rooms });
}

export function onReceipt(qc: QueryClient, payload: ReceiptPayload): void {
  qc.setQueryData<Thread>(keys.thread(payload.room_id), (cur) => (cur ? applyReceipt(cur, payload) : cur));
}

export function onRoomNew(qc: QueryClient, room: Room, ctx: BridgeContext): void {
  const now = nowOf(ctx);
  for (const [key, data] of listQueries(qc)) {
    if (!data) continue;
    const f = key[1] as RoomListFilters;
    qc.setQueryData<RoomListData>(key, insertRoomInList(data, room, { status: f.status, sort: f.sort, now }));
  }
  scheduleCounts(qc);
}

export function onRoomUpdated(qc: QueryClient, room: Room, ctx: BridgeContext): void {
  const { unread_count: _u, favorite: _f, ...shared } = room; // broadcast snapshots are viewer independent
  const known = patchRoomEverywhere(qc, room.id, shared as RoomPatch, nowOf(ctx));
  if (!known) void qc.invalidateQueries({ queryKey: keys.rooms });
  scheduleCounts(qc);
}

export function onRoomDeleted(qc: QueryClient, roomId: string): void {
  for (const [key, data] of listQueries(qc)) {
    if (!data) continue;
    qc.setQueryData<RoomListData>(key, {
      ...data,
      pages: data.pages.map((p) => ({ ...p, data: p.data.filter((r) => r.id !== roomId) })),
    });
  }
  qc.removeQueries({ queryKey: keys.room(roomId) });
  qc.removeQueries({ queryKey: keys.thread(roomId) });
  scheduleCounts(qc);
}

export function onRoomUnread(qc: QueryClient, roomId: string, unreadCount: number, ctx: BridgeContext): void {
  patchRoomEverywhere(qc, roomId, { id: roomId, unread_count: unreadCount }, nowOf(ctx));
  scheduleCounts(qc);
}

export function onNotificationNew(qc: QueryClient, payload: { notification: NotificationList["data"][number]; unread_count: number }): void {
  qc.setQueryData<NotificationList>(keys.notifications, (cur) =>
    cur ? { data: [payload.notification, ...cur.data.filter((n) => n.id !== payload.notification.id)], unread_count: payload.unread_count } : cur,
  );
}

export function onNotificationRead(qc: QueryClient, payload: { id?: string; all?: boolean; unread_count: number }): void {
  qc.setQueryData<NotificationList>(keys.notifications, (cur) => {
    if (!cur) return cur;
    const at = new Date().toISOString();
    return {
      unread_count: payload.unread_count,
      data: cur.data.map((n) => (payload.all || n.id === payload.id ? { ...n, read_at: n.read_at ?? at } : n)),
    };
  });
}
