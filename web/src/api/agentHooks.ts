import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { AgentTurnOutcome, AgentTurnPage, AiAgent, SandboxResult, UnansweredCluster } from "./types";
import { keys } from "../state/keys";

export type AgentDraft = Omit<AiAgent, "id" | "created_at" | "updated_at" | "avatar_uploaded">;

export const useAgents = (enabled = true) => useQuery({ queryKey: keys.agents, enabled, queryFn: async () => (await api.get<{ data: AiAgent[] }>("/agents")).data });

export function useAgentMutations() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.agents });
  return {
    create: useMutation({ mutationFn: (d: Partial<AgentDraft> & { name: string }) => api.post<AiAgent>("/agents", d), onSuccess: refresh }),
    update: useMutation({ mutationFn: ({ id, ...d }: Partial<AgentDraft> & { id: string }) => api.patch<AiAgent>(`/agents/${id}`, d), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`/agents/${id}`), onSuccess: refresh }),
    /** the cropped portrait, with its alternative text (PNG, JPEG or WebP, 1 MB; the server validates it again and strips metadata) */
    uploadAvatar: useMutation({
      mutationFn: ({ id, blob, alt }: { id: string; blob: Blob; alt: string }) => {
        return api.upload<AiAgent>(`/agents/${id}/avatar`, blob, "portrait.webp", { alt });
      },
      onSuccess: refresh,
    }),
  };
}

export interface SandboxInput {
  message: string;
  history: { role: "visitor" | "assistant"; text: string }[];
  contact?: { name: string; tags: string[] };
  department_id?: string | null;
  turns?: number;
}
export const useSandbox = (agentId: string) => useMutation({ mutationFn: (b: SandboxInput) => api.post<SandboxResult>(`/agents/${agentId}/sandbox`, b) });

export interface TurnFilters {
  agent_id?: string;
  outcome?: AgentTurnOutcome;
  rated?: "up" | "down" | "any";
}
export const useAgentTurns = (f: TurnFilters, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.agentTurns(f),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<AgentTurnPage>("/agents/turns", { ...f, cursor: pageParam, limit: 20 }),
    getNextPageParam: (last) => last.pagination.next_cursor ?? undefined,
  });

export const useUnanswered = (days: number, enabled = true) =>
  useQuery({ queryKey: [...keys.unanswered, days], enabled, queryFn: async () => (await api.get<{ data: UnansweredCluster[] }>("/agents/unanswered", { days })).data });

/** A team member's thumbs on a bot answer. */
export const useRateAnswer = () => useMutation({ mutationFn: (v: { messageId: string; roomId: string; rating: 1 | -1 }) => api.post<{ ok: true }>(`/messages/${v.messageId}/feedback?room_id=${encodeURIComponent(v.roomId)}`, { rating: v.rating }) });
