import { parseErrorResponse } from "../lib/apiError";

/**
 * Client for the platform console API (/admin/api). The platform token lives in memory only: it is never written to localStorage,
 * sessionStorage or a cookie, so closing the tab or reloading signs the operator out (the token is valid for 30 minutes anyway).
 */
let token: string | null = null;
let onExpired: (() => void) | null = null;

export const setAdminToken = (t: string | null) => {
  token = t;
};
export const getAdminToken = () => token;
export const onAdminExpired = (fn: (() => void) | null) => {
  onExpired = fn;
};

export async function adminRequest<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { Accept: "application/json", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/admin/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw parseErrorResponse(0, null);
  }
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // a 401 on an authenticated call means the 30-minute token ended (or the admin was disabled): back to sign-in
    if (res.status === 401 && token) onExpired?.();
    throw parseErrorResponse(res.status, json);
  }
  return json as T;
}

export const adminApi = {
  get: <T>(path: string, query?: Record<string, string | number | boolean | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") qs.set(k, String(v));
    return adminRequest<T>("GET", `${path}${qs.toString() ? `?${qs}` : ""}`);
  },
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => adminRequest<T>("POST", path, body ?? {}, headers),
  put: <T>(path: string, body?: unknown) => adminRequest<T>("PUT", path, body ?? {}),
  delete: <T>(path: string) => adminRequest<T>("DELETE", path),
};

export interface AdminIdentity {
  id: string;
  email: string;
  name: string;
  role: "superadmin" | "support";
}
