import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Ticket, TicketCounts, TicketPage, TicketPriority } from "./types";
import { keys } from "../state/keys";

export interface TicketFilters {
  /** `live` (default), `all` or a comma list of statuses */
  status?: string;
  handler?: string;
  department_id?: string;
  q?: string;
}

const PAGE = 30;

export const useTickets = (f: TicketFilters, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.ticketList(f),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<TicketPage>("/tickets", { ...f, cursor: pageParam, limit: PAGE }),
    getNextPageParam: (last) => last.pagination.next_cursor ?? undefined,
  });

export const useTicketCounts = (enabled = true) => useQuery({ queryKey: keys.ticketCounts, enabled, queryFn: () => api.get<TicketCounts>("/tickets/counts"), staleTime: 15_000 });
export const useRoomTickets = (roomId: string | undefined) =>
  useQuery({ queryKey: keys.roomTickets(roomId ?? ""), enabled: !!roomId, queryFn: async () => (await api.get<{ data: Ticket[] }>(`/rooms/${roomId}/tickets`)).data });

/** One mutation per ticket verb; whatever the server sends back, the socket event `ticket:updated` refreshes every view, so these only refetch. */
export function useTicketActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.tickets });
  return {
    resolve: useMutation({ mutationFn: (id: string) => api.post<Ticket>(`/tickets/${id}/resolve`), onSuccess: refresh }),
    close: useMutation({ mutationFn: (id: string) => api.post<Ticket>(`/tickets/${id}/close`), onSuccess: refresh }),
    reopen: useMutation({ mutationFn: (id: string) => api.post<Ticket>(`/tickets/${id}/reopen`), onSuccess: refresh }),
    patch: useMutation({
      mutationFn: ({ id, ...body }: { id: string; subject?: string; priority?: TicketPriority; tags?: string[]; status?: "open" | "pending_customer" }) => api.patch<Ticket>(`/tickets/${id}`, body),
      onSuccess: refresh,
    }),
    claim: useMutation({ mutationFn: (id: string) => api.post<Ticket>(`/tickets/${id}/claim`), onSuccess: refresh }),
    transfer: useMutation({ mutationFn: (v: { id: string; department_id: string; note?: string }) => api.post<{ outcome: string }>(`/tickets/${v.id}/transfer`, { department_id: v.department_id, note: v.note }), onSuccess: refresh }),
    bulk: useMutation({ mutationFn: (v: { ticket_ids: string[]; action: "resolve" | "close" }) => api.post<{ succeeded: number; failed: number }>("/tickets/bulk", v), onSuccess: refresh }),
  };
}
