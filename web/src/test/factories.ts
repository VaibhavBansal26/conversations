import type { InfiniteData } from "@tanstack/react-query";
import type { Message, Room, RoomPage } from "../api/types";

let n = 0;

export function makeMessage(over: Partial<Message> = {}): Message {
  n += 1;
  return {
    id: `msg_${n}`,
    room_id: "room_1",
    seq: n,
    client_msg_id: null,
    sender: { type: "contact", id: "con_1", name: "Ada" },
    kind: "text",
    source: "dm",
    content: `hello ${n}`,
    content_text: `hello ${n}`,
    subject: null,
    ref: null,
    attachments: [],
    meta: {},
    delivery: "sent",
    failure_reason: null,
    delivered_at: null,
    opened_at: null,
    read: false,
    edited_at: null,
    deleted: false,
    created_at: new Date(Date.UTC(2026, 0, 5, 10, 0, n)).toISOString(),
    ...over,
  };
}

export function makeRoom(over: Partial<Room> = {}): Room {
  n += 1;
  return {
    id: `room_${n}`,
    contact: { id: `con_${n}`, name: "Ada Lovelace", email: "ada@example.test", phone: "+14155550123", sms_opt_out: false },
    contact_id: `con_${n}`,
    inbox_id: null,
    assignee_ids: [],
    status: "open",
    priority: 0,
    snooze_until: null,
    snoozed_by: null,
    subject: null,
    room_type: "inbound",
    verified_session: false,
    last_message: null,
    last_message_at: "2026-01-05T10:00:00.000Z",
    last_contact_message_at: null,
    waiting_since: null,
    unread_count: 0,
    favorite: false,
    bot_paused: false,
    triage: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-05T10:00:00.000Z",
    ...over,
  };
}

export const roomPages = (...pages: Room[][]): InfiniteData<RoomPage> => ({
  pages: pages.map((data, i) => ({ data, pagination: { page: i + 1, limit: 30, has_more: i < pages.length - 1 } })),
  pageParams: pages.map((_, i) => i + 1),
});

export const FIXED_NOW = new Date("2026-01-05T12:00:00.000Z");
