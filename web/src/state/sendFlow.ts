import type { QueryClient } from "@tanstack/react-query";
import type { Message, SendPayload } from "../api/types";
import { ApiError, toApiError } from "../lib/apiError";
import { emptyThread, type Thread } from "./messageCache";
import { addOptimistic, buildOptimistic, markFailed, markRetrying, markSent, payloadOf } from "./optimistic";
import { keys } from "./keys";

export interface SendTransport {
  connected: () => boolean;
  /** Socket send; resolves with the acked message or rejects with ApiError (server said no) / Error (transport trouble). */
  viaSocket: (payload: SendPayload) => Promise<Message>;
  viaRest: (payload: SendPayload) => Promise<Message>;
}

const updateThread = (qc: QueryClient, roomId: string, fn: (t: Thread) => Thread) =>
  qc.setQueryData<Thread>(keys.thread(roomId), (cur) => fn(cur ?? emptyThread));

/**
 * Sends one payload. Prefers the socket, falls back to REST on transport failure. Both are idempotent on
 * client_msg_id, so the fallback (or a later retry) can never produce a duplicate message.
 */
export async function transmit(qc: QueryClient, roomId: string, payload: SendPayload, transport: SendTransport): Promise<boolean> {
  try {
    let message: Message;
    if (transport.connected()) {
      try {
        message = await transport.viaSocket(payload);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        message = await transport.viaRest(payload);
      }
    } else message = await transport.viaRest(payload);
    updateThread(qc, roomId, (t) => markSent(t, message));
    return true;
  } catch (e) {
    updateThread(qc, roomId, (t) => markFailed(t, payload.client_msg_id, toApiError(e).message));
    return false;
  }
}

export function sendNew(qc: QueryClient, roomId: string, payload: SendPayload, sender: { id: string; name: string }, transport: SendTransport): Promise<boolean> {
  updateThread(qc, roomId, (t) => addOptimistic(t, buildOptimistic(payload, roomId, sender)));
  return transmit(qc, roomId, payload, transport);
}

/** Resend a failed local message with its original client_msg_id. */
export function retryLocal(qc: QueryClient, roomId: string, clientMsgId: string, transport: SendTransport): Promise<boolean> {
  const thread = qc.getQueryData<Thread>(keys.thread(roomId)) ?? emptyThread;
  const payload = payloadOf(thread, clientMsgId);
  if (!payload) return Promise.resolve(false);
  updateThread(qc, roomId, (t) => markRetrying(t, clientMsgId));
  return transmit(qc, roomId, payload, transport);
}
