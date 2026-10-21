import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../api/client";
import { useSocket } from "../realtime/SocketProvider";
import { toast } from "../ui";
import { teamKeys } from "./cache";
import { dropMessage, patchMessage, putMessage, useSendTeamMessage } from "./hooks";
import type { TeamChannel, TeamMessage, TeamReaction } from "./types";

/** Everything a person can do to a message or a channel from the UI. Each call is a REST request (the socket only carries the fast paths). */
export function useTeamActions(channelId: string) {
  const qc = useQueryClient();
  const send = useSendTeamMessage();
  const socket = useSocket();
  const fail = (title: string) => (e: unknown) => toast({ title, description: e instanceof Error ? e.message : undefined, tone: "error" });

  const react = useCallback(
    async (m: TeamMessage, emoji: string) => {
      try {
        const r = await api.post<{ reactions: TeamReaction[] }>(`/team/messages/${m.id}/reactions`, { emoji });
        patchMessage(qc, channelId, m.id, (x) => ({ ...x, reactions: r.reactions }));
      } catch (e) {
        fail("Could not react")(e);
      }
    },
    [qc, channelId],
  );
  const edit = useCallback(
    async (m: TeamMessage, content: string) => {
      try {
        putMessage(qc, await api.patch<TeamMessage>(`/team/messages/${m.id}`, { content }));
      } catch (e) {
        fail("Could not edit the message")(e);
      }
    },
    [qc],
  );
  const remove = useCallback(
    async (m: TeamMessage, moderate: boolean) => {
      try {
        await api.delete(moderate ? `/team/channels/${channelId}/messages/${m.id}` : `/team/messages/${m.id}`);
        dropMessage(qc, channelId, m.id);
      } catch (e) {
        fail("Could not delete the message")(e);
      }
    },
    [qc, channelId],
  );
  const pin = useCallback(
    async (m: TeamMessage, pinned: boolean) => {
      try {
        const r = pinned ? await api.put<TeamMessage>(`/team/messages/${m.id}/pin`) : await api.delete<TeamMessage>(`/team/messages/${m.id}/pin`);
        putMessage(qc, r ?? { ...m, pinned });
        void qc.invalidateQueries({ queryKey: teamKeys.pins(channelId) });
      } catch (e) {
        fail("Could not change the pin")(e);
      }
    },
    [qc, channelId],
  );
  const retry = useCallback(
    (m: TeamMessage) => {
      void send({ channelId, content: m.content, threadRootId: m.thread_root_id, attachmentIds: m.local?.attachmentIds, clientMsgId: m.client_msg_id ?? undefined }).catch(() => undefined);
    },
    [send, channelId],
  );
  /** Move the read cursor to the newest message (REST; the server confirms with team:read to your other tabs). */
  const markRead = useCallback(
    (unreadNow: boolean) => {
      if (!unreadNow) return;
      qc.setQueryData<TeamChannel[]>(teamKeys.channels, (cur) => cur?.map((c) => (c.id === channelId ? { ...c, unread: 0, mention_unread: 0 } : c)));
      if (socket.connected) void socket.emit("team:read", { channel_id: channelId }).catch(() => void api.post(`/team/channels/${channelId}/read`, {}).catch(() => undefined));
      else void api.post(`/team/channels/${channelId}/read`, {}).catch(() => undefined);
    },
    [qc, channelId, socket],
  );
  return { send, react, edit, remove, pin, retry, markRead };
}
