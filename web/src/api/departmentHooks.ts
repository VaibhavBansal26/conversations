import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Department, DepartmentVisitorInfo, DepartmentHours, DepartmentStatus, RoutingMode, RoutingRule, RuleCondition, RuleTestResult } from "./types";
import { keys } from "../state/keys";

export interface DepartmentPatch {
  description?: string;
  routing_mode?: RoutingMode | null;
  capacity?: number;
  hours?: DepartmentHours;
  sla_first_response_s?: number | null;
  sla_resolution_s?: number | null;
  overflow_inbox_id?: string | null;
  auto_reply_closed?: string;
  auto_reply_queued?: string;
  live_routing_visibility?: boolean;
  visitor_info?: DepartmentVisitorInfo;
  members?: { member_id: string; skills?: string[]; languages?: string[]; capacity?: number | null }[];
}

export const useDepartments = (enabled = true) =>
  useQuery({ queryKey: keys.departments, enabled, queryFn: async () => (await api.get<{ data: Department[] }>("/departments")).data });

/** Open or closed, free people and queue, for the departments a seat can see (refreshes while the screen is open). */
export const useDepartmentStatus = (enabled = true) =>
  useQuery({ queryKey: keys.departmentStatus, enabled, queryFn: async () => (await api.get<{ data: DepartmentStatus[] }>("/department-status")).data, refetchInterval: 30_000 });

export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: DepartmentPatch & { id: string }) => api.patch<Department>(`/departments/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.departments });
      void qc.invalidateQueries({ queryKey: keys.inboxes });
    },
  });
}

export const useRoutingRules = (enabled = true) =>
  useQuery({ queryKey: keys.routingRules, enabled, queryFn: async () => (await api.get<{ data: RoutingRule[] }>("/routing-rules")).data });

export interface RuleDraft {
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  department_id: string;
}

export function useRuleMutations() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.routingRules });
  return {
    create: useMutation({ mutationFn: (d: RuleDraft) => api.post<RoutingRule>("/routing-rules", d), onSuccess: refresh }),
    update: useMutation({ mutationFn: ({ id, ...d }: Partial<RuleDraft> & { id: string }) => api.patch<RoutingRule>(`/routing-rules/${id}`, d), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`/routing-rules/${id}`), onSuccess: refresh }),
    reorder: useMutation({ mutationFn: (ids: string[]) => api.put<{ data: RoutingRule[] }>("/routing-rules/order", { ids }), onSuccess: refresh }),
    test: useMutation({ mutationFn: (x: { page_url?: string; locale?: string; channel?: "dm" | "sms" | "email"; tags?: string[]; email?: string }) => api.post<RuleTestResult>("/routing-rules/test", x) }),
  };
}
