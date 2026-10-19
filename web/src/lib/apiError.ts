/** Error carrying the API error model `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function parseErrorResponse(status: number, body: unknown): ApiError {
  const err = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  if (err && typeof err.message === "string") {
    return new ApiError(status, typeof err.code === "string" ? err.code : "ERROR", err.message, err.details);
  }
  return new ApiError(status, status === 0 ? "NETWORK_ERROR" : "HTTP_ERROR", status === 0 ? "Cannot reach the server" : `Request failed (${status})`);
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(0, "UNKNOWN", e instanceof Error ? e.message : "Something went wrong");
}

export const errorMessage = (e: unknown): string => toApiError(e).message;
export const isAiUnavailable = (e: unknown): boolean => toApiError(e).code === "AI_UNAVAILABLE";

/** Maps zod-style `details: [{ path, message }]` to a field -> message record. */
export function fieldErrors(e: unknown): Record<string, string> {
  const details = toApiError(e).details;
  const out: Record<string, string> = {};
  if (Array.isArray(details)) {
    for (const d of details as { path?: unknown; message?: unknown }[]) {
      if (typeof d?.path === "string" && typeof d.message === "string" && !(d.path in out)) out[d.path] = d.message;
    }
  }
  return out;
}
