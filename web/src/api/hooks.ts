import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  ChannelStatuses, Contact, ContactNote, Counts, EmailSender, Inbox, InboundAddress, Member, MessagePage, NotificationList, Room, RoomPage, RoomPatch, SmsNumber, Template,
} from "./types";
import { keys, type RoomListFilters } from "../state/keys";
import { prependOlder, threadFromPage, type Thread } from "../state/messageCache";
import { patchRoomEverywhere } from "../state/events";

const PAGE = 30;

export const useCounts = () => useQuery({ queryKey: keys.counts, queryFn: () => api.get<Counts>("/inboxes/counts"), staleTime: 15_000 });
export const useInboxes = () => useQuery({ queryKey: keys.inboxes, queryFn: async () => (await api.get<{ data: Inbox[] }>("/inboxes")).data, staleTime: 60_000 });
export const useMembers = () => useQuery({ queryKey: keys.members, queryFn: async () => (await api.get<{ data: Member[] }>("/members")).data, staleTime: 60_000 });
export const useTemplates = () => useQuery({ queryKey: keys.templates, queryFn: async () => (await api.get<{ data: Template[] }>("/templates")).data, staleTime: 60_000 });
export const useEmailSenders = () => useQuery({ queryKey: keys.senders, queryFn: async () => (await api.get<{ data: EmailSender[] }>("/email-senders")).data, staleTime: 60_000 });
export const useSmsNumbers = () => useQuery({ queryKey: keys.smsNumbers, queryFn: async () => (await api.get<{ data: SmsNumber[] }>("/sms-numbers")).data });
export const useInboundAddresses = () => useQuery({ queryKey: keys.inbound, queryFn: async () => (await api.get<{ data: InboundAddress[] }>("/inbound-addresses")).data });
export const useChannelStatus = () => useQuery({ queryKey: keys.channelStatus, queryFn: () => api.get<ChannelStatuses>("/channels/status"), staleTime: 30_000 });
export const useNotifications = () => useQuery({ queryKey: keys.notifications, queryFn: () => api.get<NotificationList>("/notifications", { limit: 30 }) });
export const useContact = (id: string | undefined) =>
  useQuery({ queryKey: keys.contact(id ?? ""), queryFn: () => api.get<Contact>(`/contacts/${id}`), enabled: !!id });
export const useContactNotes = (id: string | undefined) =>
  useQuery({ queryKey: keys.contactNotes(id ?? ""), queryFn: async () => (await api.get<{ data: ContactNote[] }>(`/contacts/${id}/notes`)).data, enabled: !!id });
export const useContactRooms = (id: string | undefined) =>
  useQuery({ queryKey: keys.contactRooms(id ?? ""), queryFn: async () => (await api.get<RoomPage>(`/contacts/${id}/rooms`)).data, enabled: !!id });

export interface RoomPageParam {
  cursor?: string;
  page: number;
}

/** Keyset cursors where the server offers them (stable under live inserts); page numbers only for the computed waiting_longest sort. */
export function nextRoomPageParam(last: RoomPage): RoomPageParam | undefined {
  if (!last.pagination.has_more) return undefined;
  if (last.pagination.next_cursor) return { cursor: last.pagination.next_cursor, page: 1 };
  return { page: last.pagination.page + 1 };
}

export function useRoomList(filters: RoomListFilters) {
  return useInfiniteQuery({
    queryKey: keys.roomList(filters),
    initialPageParam: { page: 1 } as RoomPageParam,
    queryFn: ({ pageParam }) =>
      api.get<RoomPage>("/rooms", {
        status: filters.status, filter: filters.filter, inbox_id: filters.inbox_id, search: filters.search, sort: filters.sort,
        cursor: pageParam.cursor, page: pageParam.cursor ? undefined : pageParam.page, limit: PAGE,
      }),
    getNextPageParam: nextRoomPageParam,
  });
}

export const useRoom = (id: string | undefined) => useQuery({ queryKey: keys.room(id ?? ""), queryFn: () => api.get<Room>(`/rooms/${id}`), enabled: !!id });

export function useThread(roomId: string) {
  return useQuery({
    queryKey: keys.thread(roomId),
    queryFn: async () => threadFromPage(await api.get<MessagePage>(`/rooms/${roomId}/messages`, { limit: 50 })),
    staleTime: Infinity,
  });
}

/** Fetch the page before the oldest loaded message and merge it into the cached thread. */
export function useLoadOlder(roomId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const cur = qc.getQueryData<Thread>(keys.thread(roomId));
      if (!cur?.beforeCursor) return;
      const page = await api.get<MessagePage>(`/rooms/${roomId}/messages`, { before: cur.beforeCursor, limit: 50 });
      qc.setQueryData<Thread>(keys.thread(roomId), (t) => (t ? prependOlder(t, page) : t));
    },
  });
}

/** Apply a full room DTO returned by a REST action to every cache that shows it. */
export function useApplyRoom() {
  const qc = useQueryClient();
  return (room: RoomPatch) => {
    patchRoomEverywhere(qc, room.id, room, new Date());
    void qc.invalidateQueries({ queryKey: keys.counts });
  };
}

export function useRoomActions(roomId: string) {
  const apply = useApplyRoom();
  const run = <B,>(fn: (body: B) => Promise<Room>) => useMutation({ mutationFn: fn, onSuccess: apply });
  return {
    patch: run((body: { status?: "open" | "closed"; priority?: 0 | 1; subject?: string | null }) => api.patch<Room>(`/rooms/${roomId}`, body)),
    assign: run((body: { member_ids?: string[]; inbox_id?: string | null; auto?: boolean }) => api.post<Room>(`/rooms/${roomId}/assign`, body)),
    snooze: run((until: string | null) => (until ? api.post<Room>(`/rooms/${roomId}/snooze`, { until }) : api.delete<Room>(`/rooms/${roomId}/snooze`))),
    favorite: useMutation({
      mutationFn: async (on: boolean) => {
        await (on ? api.put(`/rooms/${roomId}/favorite`) : api.delete(`/rooms/${roomId}/favorite`));
        return on;
      },
      onSuccess: (favorite) => apply({ id: roomId, favorite }),
    }),
  };
}
