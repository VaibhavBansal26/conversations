import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { adminApi, onAdminExpired, setAdminToken, type AdminIdentity } from "./adminApi";

interface Value {
  admin: AdminIdentity | null;
  /** step 1: returns what the second step is */
  login(email: string, password: string): Promise<{ mfaToken: string; mode: "verify" | "enrol" }>;
  /** enrolment: start (returns the secret to show) */
  startEnrol(mfaToken: string): Promise<{ secret: string; otpauth_url: string }>;
  finish(mode: "verify" | "enrol", mfaToken: string, code: string): Promise<void>;
  logout(): void;
  /** true for superadmin: hides controls a support admin cannot use (the server enforces it regardless) */
  canChange: boolean;
}

const Ctx = createContext<Value | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const logout = useCallback(() => {
    setAdminToken(null);
    setAdmin(null);
  }, []);
  useEffect(() => {
    onAdminExpired(logout);
    return () => onAdminExpired(null);
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await adminApi.post<{ mfa_token: string; mfa_required?: true; mfa_setup_required?: true }>("/login", { email, password });
    return { mfaToken: r.mfa_token, mode: r.mfa_setup_required ? ("enrol" as const) : ("verify" as const) };
  }, []);
  const startEnrol = useCallback((mfaToken: string) => adminApi.post<{ secret: string; otpauth_url: string }>("/mfa/setup", { mfa_token: mfaToken }), []);
  const finish = useCallback(async (mode: "verify" | "enrol", mfaToken: string, code: string) => {
    const r = await adminApi.post<{ token: string; admin: AdminIdentity }>(mode === "enrol" ? "/mfa/enable" : "/mfa/verify", { mfa_token: mfaToken, code });
    setAdminToken(r.token);
    setAdmin(r.admin);
  }, []);

  const value = useMemo<Value>(() => ({ admin, login, startEnrol, finish, logout, canChange: admin?.role === "superadmin" }), [admin, login, startEnrol, finish, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): Value {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAdmin must be used inside <AdminProvider>");
  return v;
}
