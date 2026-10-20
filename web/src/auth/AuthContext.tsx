import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, onTokenChange, onUnauthorized, scheduleRefresh, setToken } from "../api/client";
import type { AuthResponse, MfaRequired, Session } from "../api/types";
import { toApiError } from "../lib/apiError";
import { keys } from "../state/keys";

type Status = "loading" | "authed" | "anon" | "error";

interface AuthValue {
  status: Status;
  token: string | null;
  session: Session | null;
  error: unknown;
  /** resolves to the MFA challenge when the account needs a second step */
  login(email: string, password: string): Promise<MfaRequired | null>;
  completeMfa(mfaToken: string, code: string): Promise<void>;
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
    onTokenChange(setTokenState);
    const t = getToken();
    if (t) scheduleRefresh(t);
    return () => {
      onUnauthorized(null);
      onTokenChange(null);
    };
  }, [logout]);

  const me = useQuery({ queryKey: keys.me, queryFn: () => api.get<Session>("/auth/me"), enabled: !!token, retry: false, staleTime: Infinity });

  const accept = useCallback(
    (res: AuthResponse) => {
      setToken(res.token, res.refresh_token);
      setTokenState(res.token);
      scheduleRefresh(res.token, res.expires_in);
      qc.setQueryData<Session>(keys.me, { user: res.user, member: res.member, workspace: res.workspace });
    },
    [qc],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<MfaRequired | null> => {
      const res = await api.post<AuthResponse | MfaRequired>("/auth/login", { email, password });
      if ("mfa_required" in res) return res;
      accept(res);
      return null;
    },
    [accept],
  );
  const completeMfa = useCallback(async (mfaToken: string, code: string) => accept(await api.post<AuthResponse>("/auth/mfa/verify", { mfa_token: mfaToken, code })), [accept]);
  const register = useCallback(async (input: { name: string; email: string; password: string; workspace_name: string }) => accept(await api.post<AuthResponse>("/auth/register", input)), [accept]);

  const value = useMemo<AuthValue>(() => {
    let status: Status = "anon";
    if (token) status = me.data ? "authed" : me.isError && toApiError(me.error).status !== 401 ? "error" : "loading";
    return { status, token, session: token ? (me.data ?? null) : null, error: me.error, login, completeMfa, register, logout, retry: () => void me.refetch() };
  }, [token, me, login, completeMfa, register, logout]);

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

/** Does the signed-in seat hold this permission? (the server enforces the same check; this only decides what to show) */
export const useCan = (permission: string): boolean => {
  const m = useSession().member as { permissions?: string[]; role: string };
  return m.permissions ? m.permissions.includes(permission) : m.role === "owner";
};
