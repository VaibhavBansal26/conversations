import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, onUnauthorized, setToken } from "../api/client";
import type { AuthResponse, Session } from "../api/types";
import { toApiError } from "../lib/apiError";
import { keys } from "../state/keys";

type Status = "loading" | "authed" | "anon" | "error";

interface AuthValue {
  status: Status;
  token: string | null;
  session: Session | null;
  error: unknown;
  login(email: string, password: string): Promise<void>;
  register(input: { name: string; email: string; password: string; workspace_name: string }): Promise<void>;
  logout(): void;
  retry(): void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setTokenState] = useState<string | null>(getToken());

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    onUnauthorized(logout);
    return () => onUnauthorized(null);
  }, [logout]);

  const me = useQuery({ queryKey: keys.me, queryFn: () => api.get<Session>("/auth/me"), enabled: !!token, retry: false, staleTime: Infinity });

  const accept = useCallback(
    (res: AuthResponse) => {
      setToken(res.token);
      setTokenState(res.token);
      qc.setQueryData<Session>(keys.me, { user: res.user, member: res.member, workspace: res.workspace });
    },
    [qc],
  );

  const login = useCallback(async (email: string, password: string) => accept(await api.post<AuthResponse>("/auth/login", { email, password })), [accept]);
  const register = useCallback(async (input: { name: string; email: string; password: string; workspace_name: string }) => accept(await api.post<AuthResponse>("/auth/register", input)), [accept]);

  const value = useMemo<AuthValue>(() => {
    let status: Status = "anon";
    if (token) status = me.data ? "authed" : me.isError && toApiError(me.error).status !== 401 ? "error" : "loading";
    return { status, token, session: token ? (me.data ?? null) : null, error: me.error, login, register, logout, retry: () => void me.refetch() };
  }, [token, me, login, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

/** Session for screens that only render when authenticated. */
export function useSession(): Session {
  const { session } = useAuth();
  if (!session) throw new Error("useSession used without an authenticated session");
  return session;
}

export const useIsManager = (): boolean => {
  const role = useSession().member.role;
  return role === "owner" || role === "manager";
};
