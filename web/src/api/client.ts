import { ApiError, parseErrorResponse } from "../lib/apiError";
import { readStorage, writeStorage } from "../lib/storage";

const TOKEN_KEY = "conversations.token";
const REFRESH_KEY = "conversations.refresh";

let token: string | null = readStorage(TOKEN_KEY);
let refreshToken: string | null = readStorage(REFRESH_KEY);
let unauthorizedHandler: (() => void) | null = null;
let tokenListener: ((t: string | null) => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const getToken = () => token;
export function setToken(next: string | null, refresh?: string | null): void {
  token = next;
  writeStorage(TOKEN_KEY, next);
  if (refresh !== undefined) {
    refreshToken = refresh;
    writeStorage(REFRESH_KEY, refresh);
  }
  if (!next) {
    clearTimeout(refreshTimer);
    refreshToken = null;
    writeStorage(REFRESH_KEY, null);
  }
}
/** Called whenever the access token changes by a refresh (the app state follows it). */
export function onTokenChange(fn: ((t: string | null) => void) | null): void {
  tokenListener = fn;
}

interface RefreshResponse {
  token: string;
  refresh_token: string;
  expires_in: number;
}

let refreshing: Promise<boolean> | null = null;

/**
 * Exchange the refresh token for a new access token. Refresh tokens are single use and the server ends the session if one is replayed, so this
 * must never run twice at once: one in-flight promise per tab, and a cross-tab lock (Web Locks) with a re-read of storage inside it, so a second
 * tab adopts what the first one just obtained instead of presenting the old token.
 */
export function refreshAccess(): Promise<boolean> {
  if (refreshing) return refreshing;
  const seenRefresh = refreshToken;
  const run = async (): Promise<boolean> => {
    // another tab may have refreshed while we waited for the lock
    const storedRefresh = readStorage(REFRESH_KEY);
    const storedToken = readStorage(TOKEN_KEY);
    if (storedRefresh && storedRefresh !== seenRefresh && storedToken) {
      token = storedToken;
      refreshToken = storedRefresh;
      tokenListener?.(token);
      scheduleRefresh(storedToken);
      return true;
    }
    if (!refreshToken) return false;
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }) });
      if (!res.ok) return false;
      const j = (await res.json()) as RefreshResponse;
      setToken(j.token, j.refresh_token);
      tokenListener?.(j.token);
      scheduleRefresh(j.token, j.expires_in);
      return true;
    } catch {
      return false; // offline: keep the session, the next request tries again
    }
  };
  const locks = (navigator as Navigator & { locks?: { request<T>(name: string, fn: () => Promise<T>): Promise<T> } }).locks;
  refreshing = (locks ? locks.request("conversations-refresh", run) : run()).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Renew shortly before the access token expires, so requests rarely meet a 401 at all. */
export function scheduleRefresh(accessToken: string, expiresIn?: number): void {
  clearTimeout(refreshTimer);
  let ms = expiresIn ? expiresIn * 800 : 0;
  if (!expiresIn) {
    try {
      const exp = JSON.parse(atob(accessToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).exp as number;
      ms = Math.max(5_000, (exp * 1000 - Date.now()) * 0.8);
    } catch {
      return;
    }
  }
  refreshTimer = setTimeout(() => void refreshAccess(), ms + Math.random() * 3000);
}
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

type Query = Record<string, string | number | boolean | null | undefined>;
interface Options {
  retried?: boolean;
  query?: Query;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return `/api${path}${qs ? `?${qs}` : ""}`;
}

export async function request<T>(method: string, path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw parseErrorResponse(0, null);
  }
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // an expired access token is routine: renew and repeat the request once before treating it as a sign-out
    if (res.status === 401 && token && !opts.retried && !path.startsWith("/auth/") && (await refreshAccess())) return request<T>(method, path, { ...opts, retried: true });
    if (res.status === 401 && token) unauthorizedHandler?.();
    throw parseErrorResponse(res.status, json);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, file: File | Blob, name?: string, fields?: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields ?? {})) form.append(k, v);
    form.append("file", file, name ?? (file instanceof File ? file.name : "upload"));
    return request<T>("POST", path, { form });
  },
};

export { ApiError };
