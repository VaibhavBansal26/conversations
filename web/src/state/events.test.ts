import { QueryClient } from "@tanstack/react-query";
import type { MessageEventPayload, NotificationList, Room } from "../api/types";
import { FIXED_NOW, makeMessage, makeRoom, roomPages } from "../test/factories";
import { onMessageDeleted, onMessageNew, onMessageUpdated, onNotificationNew, onNotificationRead, onReceipt, onRoomDeleted, onRoomNew, onRoomUnread, onRoomUpdated, type BridgeContext } from "./events";
import { keys, type RoomListFilters } from "./keys";
import type { Thread } from "./messageCache";
import { flattenRooms, type RoomListData } from "./roomCache";

const OPEN: RoomListFilters = { status: "open", sort: "newest" };
const CLOSED: RoomListFilters = { status: "closed", sort: "newest" };
const ctx = (active: string | null = null): BridgeContext => ({ selfMemberId: "mem_me", activeRoomId: () => active, now: () => FIXED_NOW });

function setup() {
  const qc = new QueryClient();
  const a = makeRoom({ id: "room_a", last_message_at: "2026-01-05T09:00:00.000Z" });
  const b = makeRoom({ id: "room_b", last_message_at: "2026-01-05T08:00:00.000Z" });
  const c = makeRoom({ id: "room_c", last_message_at: "2026-01-05T07:00:00.000Z", unread_count: 2 });
  qc.setQueryData(keys.roomList(OPEN), roomPages([a, b, c]));
  qc.setQueryData(keys.room("room_c"), c);
  qc.setQueryData<Thread>(keys.thread("room_c"), { messages: [], hasMoreBefore: false, beforeCursor: null });
  return { qc, a, b, c };
}
const ids = (qc: QueryClient, f = OPEN) => flattenRooms(qc.getQueryData<RoomListData>(keys.roomList(f))).map((r) => r.id);
const room = (qc: QueryClient, id: string, f = OPEN) => flattenRooms(qc.getQueryData<RoomListData>(keys.roomList(f))).find((r) => r.id === id);

function payload(roomId: string, over: Parameters<typeof makeMessage>[0] = {}, patch: Partial<MessageEventPayload["room"]> = {}): MessageEventPayload {
  const message = makeMessage({ room_id: roomId, ...over });
  return {
    message,
    room: { id: roomId, status: "open", last_message_at: "2026-01-05T11:30:00.000Z", last_message: { id: message.id, kind: "text", source: "dm", sender_type: "contact", sender_name: "Ada", snippet: "hi", created_at: "2026-01-05T11:30:00.000Z" }, ...patch },
  };
}

describe("socket -> cache bridge", () => {
  it("message:new appends to the thread once (dedupes by id and client_msg_id)", () => {
    const { qc } = setup();
    const p = payload("room_c", { client_msg_id: "cid-33333333" });
    onMessageNew(qc, p, ctx());
    onMessageNew(qc, p, ctx());
    onMessageNew(qc, { ...p, message: { ...p.message, id: "other_id" } }, ctx()); // same client_msg_id
    expect(qc.getQueryData<Thread>(keys.thread("room_c"))?.messages).toHaveLength(1);
  });

  it("message:new moves the room to the top, patches last_message and bumps unread", () => {
    const { qc } = setup();
    onMessageNew(qc, payload("room_c"), ctx());
    expect(ids(qc)).toEqual(["room_c", "room_a", "room_b"]);
    expect(room(qc, "room_c")).toMatchObject({ unread_count: 3, last_message: { snippet: "hi" } });
    expect(qc.getQueryData<Room>(keys.room("room_c"))?.unread_count).toBe(3);
  });

  it("does not bump unread for notes, own messages or the room being viewed", () => {
    const { qc } = setup();
    onMessageNew(qc, payload("room_c", { kind: "note", sender: { type: "agent", id: "mem_x", name: "Sam" } }), ctx());
    onMessageNew(qc, payload("room_c", { sender: { type: "agent", id: "mem_me", name: "Me" } }), ctx());
    onMessageNew(qc, payload("room_c"), ctx("room_c"));
    expect(room(qc, "room_c")?.unread_count).toBe(2);
  });

  it("message:new for an unknown room invalidates the lists instead of guessing", () => {
    const { qc } = setup();
    const spy = vi.spyOn(qc, "invalidateQueries");
    onMessageNew(qc, payload("room_zzz"), ctx());
    expect(spy).toHaveBeenCalledWith({ queryKey: keys.rooms });
    expect(ids(qc)).toEqual(["room_a", "room_b", "room_c"]);
  });

  it("a reopened room leaves the closed list when a message arrives", () => {
    const { qc } = setup();
    const closed = makeRoom({ id: "room_x", status: "closed" });
    qc.setQueryData(keys.roomList(CLOSED), roomPages([closed]));
    onMessageNew(qc, payload("room_x", {}, { status: "open" }), ctx());
    expect(ids(qc, CLOSED)).toEqual([]);
  });

  it("message:updated patches delivery state in place without reordering", () => {
    const { qc } = setup();
    const m = makeMessage({ room_id: "room_c", delivery: "sent" });
    onMessageNew(qc, { message: m, room: { id: "room_c", status: "open" } }, ctx());
    onMessageUpdated(qc, { message: { ...m, delivery: "failed", failure_reason: "carrier error" }, room: { id: "room_c", status: "open" } }, ctx());
    const t = qc.getQueryData<Thread>(keys.thread("room_c"))!;
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ delivery: "failed", failure_reason: "carrier error" });
  });

  it("message:deleted removes the message from the thread", () => {
    const { qc } = setup();
    const p = payload("room_c");
    onMessageNew(qc, p, ctx());
    onMessageDeleted(qc, { message_id: p.message.id, room_id: "room_c" });
    expect(qc.getQueryData<Thread>(keys.thread("room_c"))?.messages).toHaveLength(0);
  });

  it("message:receipt marks the team's messages read", () => {
    const { qc } = setup();
    const m = makeMessage({ room_id: "room_c", seq: 4, sender: { type: "agent", id: "mem_me", name: "Me" } });
    onMessageNew(qc, { message: m, room: { id: "room_c", status: "open" } }, ctx());
    onReceipt(qc, { room_id: "room_c", reader: { type: "contact" }, up_to_seq: 4, up_to_message_id: m.id, at: "2026-01-05T12:00:00.000Z" });
    expect(qc.getQueryData<Thread>(keys.thread("room_c"))?.messages[0]).toMatchObject({ read: true, delivery: "delivered" });
  });

  it("room:new inserts at the top of matching lists only", () => {
    const { qc } = setup();
    qc.setQueryData(keys.roomList(CLOSED), roomPages([]));
    onRoomNew(qc, makeRoom({ id: "room_new" }), ctx());
    expect(ids(qc)[0]).toBe("room_new");
    expect(ids(qc, CLOSED)).toEqual([]);
    onRoomNew(qc, makeRoom({ id: "room_new" }), ctx()); // replay does not duplicate
    expect(ids(qc).filter((i) => i === "room_new")).toHaveLength(1);
  });

  it("room:updated merges shared fields but keeps this viewer's unread count and favorite", () => {
    const { qc, c } = setup();
    onRoomUpdated(qc, { ...c, assignee_ids: ["mem_1"], priority: 1, unread_count: 0, favorite: true }, ctx());
    expect(room(qc, "room_c")).toMatchObject({ assignee_ids: ["mem_1"], priority: 1, unread_count: 2, favorite: false });
  });

  it("room:updated to closed drops the room from the open list", () => {
    const { qc, a } = setup();
    onRoomUpdated(qc, { ...a, status: "closed" }, ctx());
    expect(ids(qc)).toEqual(["room_b", "room_c"]);
  });

  it("room:unread sets the exact server count", () => {
    const { qc } = setup();
    onRoomUnread(qc, "room_c", 0, ctx());
    expect(room(qc, "room_c")?.unread_count).toBe(0);
  });

  it("room:deleted removes the room and its caches", () => {
    const { qc } = setup();
    onRoomDeleted(qc, "room_c");
    expect(ids(qc)).toEqual(["room_a", "room_b"]);
    expect(qc.getQueryData(keys.room("room_c"))).toBeUndefined();
    expect(qc.getQueryData(keys.thread("room_c"))).toBeUndefined();
  });

  it("notification events update the cached feed and unread badge", () => {
    const qc = new QueryClient();
    const n = { id: "n1", type: "mention", room_id: "room_a", message_id: null, title: "Sam mentioned you", body: "hi", created_at: "2026-01-05T11:00:00.000Z", read_at: null };
    qc.setQueryData<NotificationList>(keys.notifications, { data: [], unread_count: 0 });
    onNotificationNew(qc, { notification: n, unread_count: 1 });
    onNotificationNew(qc, { notification: n, unread_count: 1 });
    expect(qc.getQueryData<NotificationList>(keys.notifications)).toMatchObject({ unread_count: 1, data: [{ id: "n1" }] });
    onNotificationRead(qc, { all: true, unread_count: 0 });
    const after = qc.getQueryData<NotificationList>(keys.notifications)!;
    expect(after.unread_count).toBe(0);
    expect(after.data[0]?.read_at).not.toBeNull();
  });
});
