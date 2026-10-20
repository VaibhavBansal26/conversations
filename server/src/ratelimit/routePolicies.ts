import { POLICY_MAP } from "./policies.js";

/**
 * Route and socket-event -> limiter policy declaration. This is the single place that says which limits guard which entry point; the
 * authorisation layer (RBAC, when it lands) will reference the same keys. Two tests keep it honest:
 *  - every route registered on the app, and every socket event registered by the socket server, must appear here (and vice versa), so a new
 *    endpoint cannot ship without a limiter decision;
 *  - every policy id used here must exist in policies.ts.
 *
 * `pre`   policies are keyed by something known before authentication (IP, Origin) and run first, cheapest first.
 * `post`  policies are keyed by the authenticated principal (user, workspace, visitor session) and run once the principal is known.
 * `inHandler` policies need the request body or a loaded entity (contact, room), so the handler or service applies them; they are listed
 *             so the declaration stays complete and the test can verify they exist.
 * Every non-exempt request also passes `ip.global` first.
 */
export interface RouteSpec {
  pre?: string[];
  post?: string[];
  inHandler?: string[];
  /** per-policy cost override */
  cost?: Record<string, number>;
}

const READ: RouteSpec = { post: ["api.read", "api.workspace"] };
const WRITE: RouteSpec = { post: ["api.write", "api.workspace"] };
const AI_CALL: RouteSpec = { post: ["ai.minute", "api.workspace"], inHandler: ["ai.workspace", "ai.concurrency"] };

/** Routes that bypass every limiter, each with the reason. Health probes and metrics are private-network endpoints and must stay reachable under overload. */
export const EXEMPT: Record<string, string> = {
  "GET /healthz": "liveness probe, must answer under overload",
  "GET /readyz": "readiness probe, must answer under overload",
  "GET /metrics": "scraped from the private network; guarded by METRICS_TOKEN",
};

const GROUPS: { spec: RouteSpec; routes: string[] }[] = [
  { spec: { pre: ["auth.register.ip"] }, routes: ["POST /api/auth/register"] },
  { spec: { pre: ["auth.refresh.ip"] }, routes: ["POST /api/auth/refresh", "POST /api/auth/logout"] },
  { spec: { pre: ["auth.mfa.ip"], inHandler: ["auth.fail.mfa"] }, routes: ["POST /api/auth/mfa/verify"] },
  { spec: { pre: ["auth.forgot.ip"], inHandler: ["auth.forgot.email"] }, routes: ["POST /api/auth/password/forgot"] },
  { spec: { pre: ["auth.reset.ip"] }, routes: ["POST /api/auth/password/reset", "GET /api/auth/invitations/:token", "POST /api/auth/invitations/accept"] },
  { spec: { pre: ["auth.login.ip"], inHandler: ["auth.fail.account", "auth.fail.ip"] }, routes: ["POST /api/auth/login"] },
  {
    spec: READ,
    routes: [
      "GET /api/auth/me", "GET /api/auth/sessions", "GET /api/invitations", "GET /api/workspace", "GET /api/credits", "GET /api/dashboard/counts", "GET /api/members", "GET /api/members/me", "GET /api/presence",
      "GET /api/inboxes", "GET /api/inboxes/counts", "GET /api/inboxes/:id", "GET /api/contacts", "GET /api/contacts/:id", "GET /api/contacts/:id/notes", "GET /api/contacts/:id/rooms",
      "GET /api/rooms", "GET /api/rooms/:id", "GET /api/rooms/:id/messages", "GET /api/messages/search", "GET /api/notifications", "GET /api/sms-numbers", "GET /api/email-senders",
      "GET /api/inbound-addresses", "GET /api/tokens", "GET /api/templates", "GET /api/kb", "GET /api/ai/status", "GET /api/roles", "GET /api/audit", "GET /api/v1/api-keys", "GET /api/analytics/overview", "GET /api/analytics/timeseries", "GET /api/analytics/identity-pepper",
    ],
  },
  {
    spec: WRITE,
    routes: [
      "PATCH /api/workspace", "DELETE /api/auth/sessions/:id", "POST /api/auth/password/change", "POST /api/auth/mfa/setup", "POST /api/auth/mfa/enable", "POST /api/auth/mfa/disable", "POST /api/invitations", "DELETE /api/invitations/:id", "POST /api/credits/grant", "POST /api/members", "PATCH /api/members/me", "PATCH /api/members/:id", "DELETE /api/members/:id",
      "POST /api/inboxes", "PATCH /api/inboxes/:id", "DELETE /api/inboxes/:id", "POST /api/inboxes/:id/members/:memberId", "DELETE /api/inboxes/:id/members/:memberId",
      "POST /api/contacts", "PATCH /api/contacts/:id", "DELETE /api/contacts/:id", "POST /api/contacts/:id/notes", "DELETE /api/contacts/:id/notes/:noteId",
      "POST /api/rooms", "POST /api/rooms/bulk", "PATCH /api/rooms/:id", "DELETE /api/rooms/:id", "POST /api/rooms/:id/assign", "POST /api/rooms/:id/snooze", "DELETE /api/rooms/:id/snooze",
      "PUT /api/rooms/:id/favorite", "DELETE /api/rooms/:id/favorite", "POST /api/rooms/:id/read", "PATCH /api/messages/:id", "DELETE /api/messages/:id", "POST /api/messages/:id/retry",
      "POST /api/notifications/read-all", "POST /api/notifications/:id/read", "POST /api/sms-numbers", "POST /api/sms-numbers/:id/default", "DELETE /api/sms-numbers/:id",
      "POST /api/email-senders", "PATCH /api/email-senders/:id", "DELETE /api/email-senders/:id", "POST /api/inbound-addresses", "DELETE /api/inbound-addresses/:address",
      "POST /api/tokens", "POST /api/tokens/:id/rotate", "DELETE /api/tokens/:id", "POST /api/templates", "PATCH /api/templates/:id", "DELETE /api/templates/:id", "POST /api/templates/:id/render",
      "POST /api/kb", "PUT /api/kb/:id", "DELETE /api/kb/:id", "POST /api/roles", "PATCH /api/roles/:id", "DELETE /api/roles/:id", "PUT /api/members/:id/role", "POST /api/v1/api-keys", "DELETE /api/v1/api-keys/:id", "POST /api/analytics/identity-pepper/rotate",
    ],
  },
  { spec: { post: ["api.send", "api.workspace"], inHandler: ["msg.room", "msg.workspace", "sms.workspace", "email.workspace", "sms.contact", "sms.number", "email.sender"] }, routes: ["POST /api/rooms/:id/messages"] },
  { spec: { post: ["api.upload", "api.workspace"] }, routes: ["POST /api/attachments"] },
  { spec: { post: ["api.import", "api.workspace"], inHandler: ["heavy.concurrency"] }, routes: ["POST /api/contacts/import"] },
  { spec: AI_CALL, routes: ["POST /api/ai/suggest-replies", "POST /api/ai/summary", "POST /api/ai/rephrase"] },

  { spec: { post: ["analytics.read", "analytics.workspace"] }, routes: ["GET /api/v1/analytics/overview", "GET /api/v1/analytics/timeseries", "GET /api/v1/analytics/schema", "GET /api/v1/analytics/identity-pepper"] },
  { spec: { post: ["analytics.export", "analytics.workspace"], inHandler: ["analytics.concurrency"] }, routes: ["GET /api/v1/analytics/export/rooms", "GET /api/v1/analytics/export/messages-meta"] },
  { spec: { pre: ["public.config"] }, routes: ["GET /public/widget/config"] },
  { spec: { pre: ["public.session"] }, routes: ["POST /public/sessions"] },
  { spec: { post: ["public.query"] }, routes: ["GET /public/session", "GET /public/rooms", "GET /public/rooms/:id/messages"] },
  { spec: { post: ["public.room"] }, routes: ["POST /public/rooms"] },
  { spec: { post: ["public.send"], inHandler: ["msg.room", "msg.workspace"] }, routes: ["POST /public/rooms/:id/messages"] },
  { spec: { post: ["public.read"] }, routes: ["POST /public/rooms/:id/read", "POST /public/rooms/:id/csat"] },
  { spec: { post: ["public.otp.send"], inHandler: ["public.otp.contact", "public.otp.ip"] }, routes: ["POST /public/otp/send"] },
  { spec: { post: ["public.otp.verify"] }, routes: ["POST /public/otp/verify"] },

  { spec: { pre: ["webhook.provider"], inHandler: ["webhook.badsig"] }, routes: ["POST /webhooks/twilio/sms", "POST /webhooks/twilio/status", "POST /webhooks/sendgrid/inbound", "POST /webhooks/sendgrid/events"] },
  { spec: {}, routes: ["GET /files/*", "GET /widget.js", "GET /widget-demo.html"] },
];

export const ROUTE_LIMITS: ReadonlyMap<string, RouteSpec> = (() => {
  const m = new Map<string, RouteSpec>();
  for (const g of GROUPS) for (const r of g.routes) {
    if (m.has(r)) throw new Error(`route ${r} is declared twice in routePolicies.ts`);
    m.set(r, g.spec);
  }
  return m;
})();

/** Socket events. `cost` weights the per-socket bucket (a cheap `typing` ping costs a quarter of a `message:send`), `inHandler` lists extra policies the handler applies. */
export interface EventSpec {
  cost: number;
  inHandler?: string[];
}
export const EVENT_LIMITS: Record<string, EventSpec> = {
  "message:send": { cost: 2, inHandler: ["msg.room", "msg.workspace", "sms.workspace", "email.workspace", "sms.contact", "sms.number", "email.sender"] },
  "message:read": { cost: 1 },
  "room:create": { cost: 5 },
  "room:update": { cost: 2 },
  "room:assign": { cost: 2 },
  typing: { cost: 0.25 },
  "otp:verify": { cost: 5 },
  "presence:list": { cost: 1 },
};

export function routeKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

/** every policy id referenced by the declaration (for the existence test) */
export function referencedPolicies(): string[] {
  const ids = new Set<string>();
  for (const s of ROUTE_LIMITS.values()) for (const id of [...(s.pre ?? []), ...(s.post ?? []), ...(s.inHandler ?? [])]) ids.add(id);
  for (const e of Object.values(EVENT_LIMITS)) for (const id of e.inHandler ?? []) ids.add(id);
  return [...ids].filter((id) => !POLICY_MAP.has(id));
}
