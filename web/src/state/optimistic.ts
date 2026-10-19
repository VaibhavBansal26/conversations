import type { LocalState, Message, SendPayload } from "../api/types";
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

/** Apply a send-state transition to the local (unconfirmed) bubble with this client_msg_id. */
function transition(thread: Thread, clientMsgId: string, event: "fail" | "retry", patch: (m: Message, local: LocalState) => Message): Thread {
  const target = thread.messages.find((m) => m.client_msg_id === clientMsgId && m.local);
  if (!target?.local) return thread;
  const status = nextSendState(target.local.status, event);
  if (status === "sent") return thread;
  return upsertMessage(thread, patch(target, { ...target.local, status }));
}

/** Add the optimistic bubble (no-op when a bubble with that client_msg_id already exists). */
export function addOptimistic(thread: Thread, message: Message): Thread {
  return thread.messages.some((m) => m.client_msg_id === message.client_msg_id) ? thread : upsertMessage(thread, message);
}

/** The server confirmed the message (ack or REST response); it replaces the bubble sharing its client_msg_id. */
export const markSent = (thread: Thread, confirmed: Message): Thread => upsertMessage(thread, { ...confirmed, local: undefined });

export const markFailed = (thread: Thread, clientMsgId: string, error: string): Thread =>
  transition(thread, clientMsgId, "fail", (m, local) => ({ ...m, delivery: "failed", failure_reason: error, local: { ...local, error } }));

/** Retry keeps the same client_msg_id, so a send that actually reached the server is not duplicated. */
export const markRetrying = (thread: Thread, clientMsgId: string): Thread =>
  transition(thread, clientMsgId, "retry", (m, local) => ({ ...m, delivery: "pending", failure_reason: null, local: { ...local, error: undefined } }));

export const payloadOf = (thread: Thread, clientMsgId: string): SendPayload | undefined =>
  thread.messages.find((m) => m.client_msg_id === clientMsgId)?.local?.payload;
