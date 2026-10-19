import { ApiError, parseErrorResponse } from "../lib/apiError";
import { readStorage, writeStorage } from "../lib/storage";

const TOKEN_KEY = "conversations.token";

let token: string | null = readStorage(TOKEN_KEY);
let unauthorizedHandler: (() => void) | null = null;

export const getToken = () => token;
export function setToken(next: string | null): void {
  token = next;
  writeStorage(TOKEN_KEY, next);
}
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

type Query = Record<string, string | number | boolean | null | undefined>;
interface Options {
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
  upload: <T>(path: string, file: File | Blob, name?: string) => {
    const form = new FormData();
    form.append("file", file, name ?? (file instanceof File ? file.name : "upload"));
    return request<T>("POST", path, { form });
  },
};

export { ApiError };
