import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "./client";
import type { AiTone, EmbedToken, KbEntry, LedgerEntry, Session, Workspace, WorkspaceSettings } from "./types";
import { keys } from "../state/keys";

export type WorkspacePatch = { name?: string; settings?: Partial<Omit<WorkspaceSettings, "widget">> & { widget?: Partial<WorkspaceSettings["widget"]> } };

export function useSaveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: WorkspacePatch) => api.patch<Workspace>("/workspace", patch),
    onSuccess: (workspace) => qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, workspace } : s)),
  });
}

/** Mutation that refreshes the given list queries when it succeeds. */
export function useListMutation<V, R = unknown>(fn: (v: V) => Promise<R>, ...invalidate: QueryKey[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useTokens = () => useQuery({ queryKey: keys.tokens, queryFn: async () => (await api.get<{ data: EmbedToken[] }>("/tokens")).data });
export const useKb = () => useQuery({ queryKey: keys.kb, queryFn: async () => (await api.get<{ data: KbEntry[] }>("/kb")).data });
export const useAiStatus = () =>
  useQuery({ queryKey: keys.aiStatus, queryFn: () => api.get<{ provider: string; offline_heuristics: boolean }>("/ai/status"), retry: false });
export const useCredits = () => useQuery({ queryKey: keys.credits, queryFn: () => api.get<{ balance: number; ledger: LedgerEntry[] }>("/credits") });

export const AI_TONES: AiTone[] = ["friendly", "professional", "concise", "empathetic"];
