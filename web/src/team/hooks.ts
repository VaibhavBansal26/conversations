import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useSession } from "../auth/AuthContext";
import { newClientMsgId } from "../lib/ids";
import { bumpReply, emptyTeamThread, prependTeam, removeTeam, teamKeys, threadFromPage, upsertTeam } from "./cache";
import type { TeamChannel, TeamMessage, TeamPage, TeamSearchHit, TeamThreadCache } from "./types";

export const useTeamChannels = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: teamKeys.channels, queryFn: async () => (await api.get<{ data: TeamChannel[] }>("/team/channels")).data, staleTime: 30_000, enabled: o.enabled ?? true });

export const useBrowseChannels = (enabled = true) =>
  useQuery({ queryKey: teamKeys.browse, queryFn: async () => (await api.get<{ data: TeamChannel[] }>("/team/channels/browse")).data, enabled });

export const useTeamChannel = (id: string | undefined) =>
  useQuery({ queryKey: teamKeys.channel(id ?? ""), queryFn: () => api.get<TeamChannel>(`/team/channels/${id}`), enabled: !!id, retry: false });

export function useTeamMessages(channelId: string | undefined) {
  return useQuery({
    queryKey: teamKeys.messages(channelId ?? ""),
    queryFn: async () => threadFromPage(await api.get<TeamPage>(`/team/channels/${channelId}/messages`, { limit: 40 })),
    enabled: !!channelId,
    staleTime: Infinity,
    retry: false,
  });
}

export function useLoadOlderTeam(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const cur = qc.getQueryData<TeamThreadCache>(teamKeys.messages(channelId));
      if (!cur?.beforeCursor) return;
      const page = await api.get<TeamPage>(`/team/channels/${channelId}/messages`, { before: cur.beforeCursor, limit: 40 });
      qc.setQueryData<TeamThreadCache>(teamKeys.messages(channelId), (t) => (t ? prependTeam(t, page) : t));
    },
  });
}

export const useTeamThread = (rootId: string | undefined) =>
  useQuery({
    queryKey: teamKeys.thread(rootId ?? ""),
    queryFn: async () => {
      const r = await api.get<{ root: TeamMessage; replies: TeamMessage[] }>(`/team/messages/${rootId}/thread`);
      return { messages: [r.root, ...r.replies], hasMoreBefore: false, beforeCursor: null } as TeamThreadCache;
    },
    enabled: !!rootId,
    staleTime: Infinity,
    retry: false,
  });

export const useTeamPins = (channelId: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: teamKeys.pins(channelId ?? ""), queryFn: async () => (await api.get<{ data: TeamMessage[] }>(`/team/channels/${channelId}/pins`)).data, enabled: enabled && !!channelId });

export const useTeamSearch = (q: string, channelId?: string) =>
  useQuery({
    queryKey: teamKeys.search(q, channelId),
    queryFn: async () => (await api.get<{ data: TeamSearchHit[] }>("/team/search", { q, channel_id: channelId, limit: 20 })).data,
    enabled: q.trim().length >= 2,
    staleTime: 10_000,
  });

/** Put a message into the channel timeline and into the thread it belongs to. */
export function putMessage(qc: QueryClient, m: TeamMessage) {
  if (!m.thread_root_id) qc.setQueryData<TeamThreadCache>(teamKeys.messages(m.channel_id), (t) => upsertTeam(t ?? emptyTeamThread, m));
  else {
    qc.setQueryData<TeamThreadCache>(teamKeys.thread(m.thread_root_id), (t) => (t ? upsertTeam(t, m) : t));
  }
}
export function patchMessage(qc: QueryClient, channelId: string, id: string, fn: (m: TeamMessage) => TeamMessage) {
  const apply = (t: TeamThreadCache | undefined) => (t ? { ...t, messages: t.messages.map((m) => (m.id === id ? fn(m) : m)) } : t);
  qc.setQueryData<TeamThreadCache>(teamKeys.messages(channelId), apply);
  for (const [key] of qc.getQueriesData<TeamThreadCache>({ queryKey: ["team", "thread"] })) qc.setQueryData<TeamThreadCache>(key, apply);
}

export function dropMessage(qc: QueryClient, channelId: string, id: string) {
  qc.setQueryData<TeamThreadCache>(teamKeys.messages(channelId), (t) => (t ? removeTeam(t, id) : t));
  for (const [key] of qc.getQueriesData<TeamThreadCache>({ queryKey: ["team", "thread"] })) qc.setQueryData<TeamThreadCache>(key, (t) => (t ? removeTeam(t, id) : t));
}

export interface SendArgs {
  channelId: string;
  content: string;
  threadRootId?: string | null;
  attachmentIds?: string[];
  shareRoomId?: string;
  clientMsgId?: string;
}

/** Optimistic send with an idempotent client_msg_id: a retry never produces a second message. */
export function useSendTeamMessage() {
  const qc = useQueryClient();
  const { member } = useSession();
  const send = async (a: SendArgs): Promise<TeamMessage> => {
    const clientMsgId = a.clientMsgId ?? newClientMsgId();
    const optimistic: TeamMessage = {
      id: `local-${clientMsgId}`, channel_id: a.channelId, seq: 0, thread_root_id: a.threadRootId ?? null, client_msg_id: clientMsgId,
      sender: { id: member.id, name: member.name }, kind: a.shareRoomId ? "share" : "text", content: a.content, content_text: a.content, attachments: [], mentions: [], mention_all: false,
      reactions: [], reply_count: 0, last_reply_at: null, pinned: false, pinned_at: null, edited_at: null, deleted: false, created_at: new Date().toISOString(), share: null,
      local: { status: "sending", attachmentIds: a.attachmentIds },
    };
    putMessage(qc, optimistic);
    try {
      const confirmed = await api.post<TeamMessage>(`/team/channels/${a.channelId}/messages`, {
        content: a.content || undefined, thread_root_id: a.threadRootId ?? undefined, attachment_ids: a.attachmentIds?.length ? a.attachmentIds : undefined, share_room_id: a.shareRoomId, client_msg_id: clientMsgId,
      });
      putMessage(qc, confirmed);
      if (confirmed.thread_root_id) bumpReply(qc, confirmed);
      return confirmed;
    } catch (e) {
      putMessage(qc, { ...optimistic, local: { status: "failed", error: e instanceof Error ? e.message : "Could not send", attachmentIds: a.attachmentIds } });
      throw e;
    }
  };
  return send;
}
