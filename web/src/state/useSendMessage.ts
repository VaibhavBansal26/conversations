import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { api } from "../api/client";
import type { Message, SendPayload } from "../api/types";
import { useSession } from "../auth/AuthContext";
import { ApiError } from "../lib/apiError";
import { newClientMsgId } from "../lib/ids";
import { useSocket } from "../realtime/SocketProvider";
import { retryLocal, sendNew, type SendTransport } from "./sendFlow";

export type SendInput = Omit<SendPayload, "client_msg_id">;

/** Optimistic send for one room: socket when connected, REST otherwise, one client_msg_id per message. */
export function useSendMessage(roomId: string) {
  const qc = useQueryClient();
  const socket = useSocket();
  const { member } = useSession();

  const transport = useMemo<SendTransport>(
    () => ({
      connected: () => socket.connected,
      viaSocket: async (payload) => {
        const ack = await socket.emit<{ message: Message }>("message:send", { room_id: roomId, ...payload });
        if (!ack.ok) throw new ApiError(422, ack.error.code, ack.error.message);
        return ack.message;
      },
      viaRest: (payload) => api.post<Message>(`/rooms/${roomId}/messages`, payload),
    }),
    [socket, roomId],
  );

  const send = useCallback(
    (input: SendInput) => sendNew(qc, roomId, { ...input, client_msg_id: newClientMsgId() }, { id: member.id, name: member.name }, transport),
    [qc, roomId, member.id, member.name, transport],
  );
  const retry = useCallback((clientMsgId: string) => retryLocal(qc, roomId, clientMsgId, transport), [qc, roomId, transport]);
  return { send, retry };
}
