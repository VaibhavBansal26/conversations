import type { Message, SendPayload } from "../api/types";
import { upsertMessage, type Thread } from "./messageCache";

export type SendState = "sending" | "sent" | "failed";
export type SendEvent = "ack" | "fail" | "retry";

/** sending --ack--> sent; sending --fail--> failed; failed --retry--> sending. Anything else is ignored. */
export function nextSendState(state: SendState, event: SendEvent): SendState {
  if (state === "sending" && event === "ack") return "sent";
  if (state === "sending" && event === "fail") return "failed";
  if (state === "failed" && event === "retry") return "sending";
  return state;
}

export const sendStateOf = (m: Message): SendState => (m.local ? m.local.status : "sent");

export function buildOptimistic(payload: SendPayload, roomId: string, sender: { id: string; name: string }, now: Date = new Date()): Message {
  return {
    id: `local-${payload.client_msg_id}`,
    room_id: roomId,
    seq: 0,
    client_msg_id: payload.client_msg_id,
    sender: { type: "agent", id: sender.id, name: sender.name },
    kind: payload.kind,
    source: payload.source,
    content: payload.content,
    content_text: payload.content,
    subject: payload.subject ?? null,
    ref: null,
    attachments: [],
    meta: {},
    delivery: "pending",
    failure_reason: null,
    delivered_at: null,
    opened_at: null,
    read: false,
    edited_at: null,
    deleted: false,
    created_at: now.toISOString(),
    local: { status: "sending", payload },
  };
}

const withLocal = (thread: Thread, clientMsgId: string, fn: (m: Message) => Message): Thread => {
  const target = thread.messages.find((m) => m.client_msg_id === clientMsgId && m.local);
  return target ? upsertMessage(thread, fn(target)) : thread;
};

/** Add the optimistic bubble (no-op when a bubble with that client_msg_id already exists). */
export function addOptimistic(thread: Thread, message: Message): Thread {
  return thread.messages.some((m) => m.client_msg_id === message.client_msg_id) ? thread : upsertMessage(thread, message);
}

/** The server confirmed the message (ack or REST response); it replaces the bubble sharing its client_msg_id. */
export const markSent = (thread: Thread, confirmed: Message): Thread => upsertMessage(thread, { ...confirmed, local: undefined });

export const markFailed = (thread: Thread, clientMsgId: string, error: string): Thread =>
  withLocal(thread, clientMsgId, (m) => ({
    ...m,
    delivery: "failed",
    failure_reason: error,
    local: { ...m.local!, status: nextSendState(m.local!.status, "fail"), error },
  }));

/** Retry keeps the same client_msg_id, so a send that actually reached the server is not duplicated. */
export const markRetrying = (thread: Thread, clientMsgId: string): Thread =>
  withLocal(thread, clientMsgId, (m) => ({
    ...m,
    delivery: "pending",
    failure_reason: null,
    local: { ...m.local!, status: nextSendState(m.local!.status, "retry"), error: undefined },
  }));

export const payloadOf = (thread: Thread, clientMsgId: string): SendPayload | undefined =>
  thread.messages.find((m) => m.client_msg_id === clientMsgId)?.local?.payload;
