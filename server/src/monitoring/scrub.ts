import { createHash } from "node:crypto";

/**
 * Error-monitoring scrubber. Everything that leaves the process for Sentry goes through `scrubEvent`, which BUILDS a new event from an allow-list
 * instead of deleting known-bad fields from the SDK's event: a field this file does not name is never sent, so a new SDK integration cannot
 * start leaking by adding one. Free text that is allowed (exception messages, function names) is additionally pattern-redacted.
 *
 * Never sent: request bodies, headers, cookies, query strings, user/IP, breadcrumbs, extra, contexts other than runtime, local variables,
 * message text, contact data, provider credentials, session or widget tokens.
 */

const PATTERNS: [RegExp, string][] = [
  [/\b[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, "[call-link]"],
  [/\/call\/[^/?#\s"']+/g, "/call/[link]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, "[jwt]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[auth]"],
  [/\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[sendgrid-key]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/g, "[stripe-key]"],
  [/\bwhsec_[A-Za-z0-9]{6,}/g, "[stripe-secret]"],
  [/\b(?:cvt|ses|wgt|inv|rst)_[A-Za-z0-9_-]{8,}/g, "[token]"],
  [/\b(?:AC|SK)[0-9a-f]{32}\b/gi, "[twilio-sid]"],
  [/\b[0-9a-f]{24,}\b/gi, "[hex]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]"],
  [/(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g, "[number]"],
  [/([?&](?:token|key|api_key|apikey|secret|code|signature|sig|p|password|auth|access_token)=)[^&\s"']+/gi, "$1[redacted]"],
];

export function scrubString(input: string, max = 1000): string {
  let out = input.length > max * 2 ? input.slice(0, max * 2) : input;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** `/api/rooms/room_abc/messages?x=1` -> `/api/rooms/:id/messages`. Only used as a fallback when no route pattern is known. */
export function scrubPath(path: string): string {
  const noQuery = path.split("?")[0] ?? "";
  return noQuery
    .split("/")
    .map((seg) => (/^[a-z]{1,8}_[A-Za-z0-9]{6,}$/.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || seg.length > 40 ? ":id" : seg))
    .join("/");
}

/** Tag names that may be sent; values are always scrubbed strings. */
export const ALLOWED_TAGS = new Set(["route", "method", "status", "request_id", "socket_id", "workspace", "plan", "event", "job_type", "area", "runtime", "handled", "source"]);

type Obj = Record<string, any>;

function frames(list: unknown): Obj[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.slice(-50).map((f: Obj) => ({
    filename: typeof f?.filename === "string" ? scrubString(f.filename.replace(/^.*?(\/(?:src|dist|node_modules|assets)\/)/, "$1"), 200) : undefined,
    function: typeof f?.function === "string" ? scrubString(f.function, 120) : undefined,
    module: typeof f?.module === "string" ? scrubString(f.module, 120) : undefined,
    lineno: typeof f?.lineno === "number" ? f.lineno : undefined,
    colno: typeof f?.colno === "number" ? f.colno : undefined,
    in_app: typeof f?.in_app === "boolean" ? f.in_app : undefined,
    // no vars, pre_context, context_line or post_context: they are source lines and local variables
  }));
}

function tags(t: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (t && typeof t === "object") {
    for (const [k, v] of Object.entries(t as Obj)) {
      if (ALLOWED_TAGS.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) out[k] = scrubString(String(v), 100);
    }
  }
  return out;
}

function exceptions(ex: unknown): Obj | undefined {
  const values = (ex as Obj | undefined)?.values;
  if (!Array.isArray(values)) return undefined;
  return {
    values: values.slice(0, 10).map((v: Obj) => ({
      type: typeof v?.type === "string" ? scrubString(v.type, 100) : undefined,
      value: typeof v?.value === "string" ? scrubString(v.value, 500) : undefined,
      mechanism: v?.mechanism && typeof v.mechanism === "object" ? { type: String(v.mechanism.type ?? "").slice(0, 50), handled: !!v.mechanism.handled } : undefined,
      stacktrace: v?.stacktrace ? { frames: frames(v.stacktrace.frames) } : undefined,
    })),
  };
}

/** The event that may be sent, or null to drop it. */
export function scrubEvent<T extends Obj>(event: T): T | null {
  const e = event as Obj;
  const out: Obj = {
    event_id: e.event_id,
    timestamp: e.timestamp,
    platform: e.platform,
    level: e.level,
    release: typeof e.release === "string" ? scrubString(e.release, 100) : undefined,
    environment: typeof e.environment === "string" ? scrubString(e.environment, 50) : undefined,
    sdk: e.sdk && typeof e.sdk === "object" ? { name: e.sdk.name, version: e.sdk.version } : undefined,
    tags: tags(e.tags),
    exception: exceptions(e.exception),
    // `message` is free text from callers; keep a scrubbed, short form only for non-exception events
    message: !e.exception && typeof e.message === "string" ? scrubString(e.message, 300) : undefined,
    transaction: typeof e.transaction === "string" ? scrubPath(e.transaction) : undefined,
    fingerprint: Array.isArray(e.fingerprint) ? e.fingerprint.map((f: unknown) => scrubString(String(f), 100)).slice(0, 5) : undefined,
    contexts: {
      runtime: e.contexts?.runtime ? { name: e.contexts.runtime.name, version: e.contexts.runtime.version } : undefined,
      ...(e.contexts?.trace ? { trace: { trace_id: e.contexts.trace.trace_id, span_id: e.contexts.trace.span_id, op: e.contexts.trace.op, status: e.contexts.trace.status } } : {}),
    },
    // request: method only. url, query_string, headers, cookies and data are never copied.
    request: e.request?.method ? { method: String(e.request.method).slice(0, 10) } : undefined,
  };
  if (e.type === "transaction") {
    out.type = "transaction";
    out.start_timestamp = e.start_timestamp;
    out.transaction_info = { source: "route" };
    out.spans = Array.isArray(e.spans)
      ? e.spans.slice(0, 100).map((s: Obj) => ({ span_id: s.span_id, parent_span_id: s.parent_span_id, trace_id: s.trace_id, op: s.op, start_timestamp: s.start_timestamp, timestamp: s.timestamp, status: s.status })) // no descriptions: SQL and URLs carry values
      : undefined;
  }
  return JSON.parse(JSON.stringify(out)) as T; // drops undefined keys
}

/** Entries that are expected operational noise, not defects. */
export function shouldIgnore(err: unknown): boolean {
  const e = err as { name?: string; code?: string; status?: number; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.status === "number" && e.status < 500) return true; // 4xx: client errors, validation, rate limits, auth
  if (e.name === "AbortError" || e.code === "ABORT_ERR" || e.code === "ECONNRESET" || e.code === "EPIPE" || e.code === "ERR_STREAM_PREMATURE_CLOSE") return true;
  if (e.name === "ZodError" || e.name === "RateLimitedError") return true;
  if (/transport (?:close|error)|client namespace disconnect|ping timeout|aborted/i.test(String(e.message ?? ""))) return true;
  return false;
}

export function hashId(salt: string, id: string): string {
  return createHash("sha256").update(`${salt}:${id}`).digest("hex").slice(0, 16);
}
