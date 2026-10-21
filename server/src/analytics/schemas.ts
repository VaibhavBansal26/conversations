/**
 * JSON Schemas (draft 2020-12) for the analytics API v1. `npm run docs:analytics-schemas` writes them to docs/analytics-api/ and `docs:check`
 * fails when the files are stale. Contract tests validate real responses against these objects.
 * Compatibility rule: within v1 only fields are ADDED; consumers must ignore unknown fields (so `additionalProperties` stays true).
 */
export const SCHEMA_VERSION = 1;

const nullable = (t: string | string[]) => ({ type: (Array.isArray(t) ? [...t, "null"] : [t, "null"]) as string[] });
const iso = { type: "string", format: "date-time" };

export const SCHEMAS: Record<string, object> = {
  error: {
    $id: "error.schema.json",
    type: "object",
    required: ["error"],
    properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, retry_after_s: { type: "integer" }, policy: { type: "string" } } } },
  },
  overview: {
    $id: "overview.schema.json",
    type: "object",
    required: ["rooms_opened", "rooms_closed", "messages_in", "messages_out", "first_response_p50_s", "first_response_p90_s", "resolution_p50_s", "resolution_p90_s", "by_channel", "by_inbox", "by_agent"],
    properties: {
      from: iso,
      to: iso,
      rooms_opened: { type: "integer", minimum: 0 },
      rooms_closed: { type: "integer", minimum: 0 },
      messages_in: { type: "integer", minimum: 0 },
      messages_out: { type: "integer", minimum: 0 },
      first_response_p50_s: nullable("number"),
      first_response_p90_s: nullable("number"),
      resolution_p50_s: nullable("number"),
      resolution_p90_s: nullable("number"),
      csat_avg: nullable("number"),
      csat_count: { type: "integer", minimum: 0 },
      by_channel: {
        type: "object",
        required: ["dm", "sms", "email"],
        properties: Object.fromEntries(["dm", "sms", "email"].map((c) => [c, { type: "object", required: ["messages_in", "messages_out"], properties: { messages_in: { type: "integer" }, messages_out: { type: "integer" } } }])),
      },
      by_inbox: {
        type: "array",
        items: { type: "object", required: ["inbox_id", "rooms_opened", "rooms_closed", "messages_in", "messages_out"], properties: { inbox_id: nullable("string"), rooms_opened: { type: "integer" }, rooms_closed: { type: "integer" }, messages_in: { type: "integer" }, messages_out: { type: "integer" }, first_response_p50_s: nullable("number"), resolution_p50_s: nullable("number") } },
      },
      by_agent: {
        type: "array",
        items: { type: "object", required: ["agent_key", "rooms_handled", "avg_first_response_s", "avg_resolution_s"], properties: { agent_key: { type: "string", pattern: "^[0-9a-f]{32}$" }, rooms_handled: { type: "integer" }, avg_first_response_s: nullable("number"), avg_resolution_s: nullable("number") } },
      },
    },
  },
  timeseries: {
    $id: "timeseries.schema.json",
    type: "object",
    required: ["interval", "points"],
    properties: { interval: { enum: ["hour", "day", "week", "month"] }, tz: { type: "string" }, points: { type: "array", items: { type: "object", required: ["t", "value"], properties: { t: iso, value: { type: "number" } } } } },
  },
  "export-rooms-line": {
    $id: "export-rooms-line.schema.json",
    description: "One NDJSON line of GET /export/rooms. contact_key is hex(HMAC-SHA256(pepper, lower(trim(email)))); no raw email, phone or name ever appears.",
    type: "object",
    required: ["id", "created_at", "closed_at", "contact_key", "channel_mix", "inbox_id", "assignee_key", "priority", "status", "messages_in", "messages_out", "first_response_s", "resolution_s", "reopen_count", "snoozed_count", "ai_intent", "ai_sentiment", "ai_urgency", "csat", "hour_of_day_created", "dow_created"],
    properties: {
      id: { type: "string" },
      created_at: iso,
      closed_at: { type: ["string", "null"], format: "date-time" },
      contact_key: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
      phone_key: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$", description: "Extra field (not required by the contract): HMAC-SHA256(pepper, lower(trim(E.164 phone))) hex, null without a phone number." },
      channel_mix: { type: "object", required: ["dm", "sms", "email"], properties: { dm: { type: "integer" }, sms: { type: "integer" }, email: { type: "integer" } } },
      inbox_id: nullable("string"),
      assignee_key: { type: ["string", "null"], pattern: "^[0-9a-f]{32}$" },
      priority: { enum: [0, 1] },
      status: { enum: ["open", "closed"] },
      messages_in: { type: "integer", minimum: 0 },
      messages_out: { type: "integer", minimum: 0 },
      first_response_s: nullable("integer"),
      resolution_s: nullable("integer"),
      reopen_count: { type: "integer", minimum: 0 },
      snoozed_count: { type: "integer", minimum: 0 },
      ai_intent: nullable("string"),
      ai_sentiment: nullable("string"),
      ai_urgency: nullable("number"),
      csat: { type: ["integer", "null"], minimum: 1, maximum: 5 },
      hour_of_day_created: { type: "integer", minimum: 0, maximum: 23, description: "Hour of `created_at` in the request's `tz` (UTC by default)." },
      dow_created: { type: "integer", minimum: 0, maximum: 6, description: "Day of week of `created_at` in the request's `tz` (UTC by default), JavaScript getDay(): Sunday = 0, Monday = 1, ... Saturday = 6." },
    },
  },
  "export-messages-meta-line": {
    $id: "export-messages-meta-line.schema.json",
    description: "One NDJSON line of GET /export/messages-meta. Message content is never exported.",
    type: "object",
    required: ["id", "room_id", "ts", "direction", "channel", "kind", "length_chars", "delivery_status", "sender_type"],
    properties: {
      id: { type: "string" },
      room_id: { type: "string" },
      ts: iso,
      direction: { enum: ["in", "out"] },
      channel: { enum: ["dm", "sms", "email"] },
      kind: { type: "string" },
      length_chars: { type: "integer", minimum: 0 },
      delivery_status: { enum: ["pending", "sent", "delivered", "failed", "not_sent_test_mode"] },
      sender_type: { enum: ["agent", "contact", "bot", "system"] },
    },
  },
  "identity-pepper": {
    $id: "identity-pepper.schema.json",
    type: "object",
    required: ["pepper", "version", "algorithm", "fingerprint", "rotatedAt"],
    properties: {
      pepper: { type: "string", minLength: 32, maxLength: 256, description: "The HMAC key, used exactly as given (UTF-8). Generated peppers are 64 hex characters; an imported one may be any acceptable string of 32 to 256 characters." },
      version: { type: "integer", minimum: 1, description: "Starts at 1; every change of value (rotate, or set to a different value) adds 1." },
      algorithm: { const: "HMAC-SHA256", description: "contact_key = hex(HMAC-SHA256(pepper, lower(trim(email))))" },
      fingerprint: { type: "string", pattern: "^[0-9a-f]{8}$", description: "First 8 hex characters of SHA-256 over the pepper (UTF-8): compare it between apps without showing the pepper." },
      rotatedAt: { type: "string", format: "date-time", description: "When the value last changed (rotate or set)." },
    },
  },
};
