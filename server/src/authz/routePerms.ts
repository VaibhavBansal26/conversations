import type { Permission } from "./permissions.js";

/**
 * Authorisation declaration: for every REST route, who may call it.
 *   a Permission   the caller's role must hold it (`can()`)
 *   "authed"       any signed-in, live team member (own profile, notifications); services still apply ownership rules
 *   "public"       no team session: visitors (session token + embed token), provider webhooks, unauthenticated auth endpoints, static files
 * Deny by default: an authenticated route missing from this table is refused with 403 NO_POLICY, and a test fails the build.
 * The rate-limit declaration (ratelimit/routePolicies.ts) has the same route keys; a test keeps the two tables in step.
 */
export type RouteAccess = Permission | "authed" | "public" | "apikey";

const GROUPS: [RouteAccess, string[]][] = [
  ["public", [
    "POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/refresh", "POST /api/auth/logout", "POST /api/auth/mfa/verify", "POST /api/auth/password/forgot", "POST /api/auth/password/reset",
    "GET /api/auth/invitations/:token", "POST /api/auth/invitations/accept",
    "GET /public/widget/config", "POST /public/sessions", "GET /public/session", "GET /public/rooms", "POST /public/rooms", "GET /public/rooms/:id/messages", "POST /public/rooms/:id/messages",
    "POST /public/rooms/:id/read", "POST /public/rooms/:id/csat", "POST /public/otp/send", "POST /public/otp/verify",
    "POST /webhooks/stripe", "POST /webhooks/stripe/connect", "POST /webhooks/twilio/sms", "POST /webhooks/twilio/status", "POST /webhooks/sendgrid/inbound", "POST /webhooks/sendgrid/events",
    "GET /files/*", "GET /widget.js", "GET /widget-demo.html",
  ]],
  ["apikey", ["GET /api/v1/analytics/overview", "GET /api/v1/analytics/timeseries", "GET /api/v1/analytics/schema", "GET /api/v1/analytics/identity-pepper", "GET /api/v1/analytics/export/rooms", "GET /api/v1/analytics/export/messages-meta"]],
  ["authed", ["GET /api/auth/me", "GET /api/auth/sessions", "DELETE /api/auth/sessions/:id", "POST /api/auth/password/change", "POST /api/auth/mfa/setup", "POST /api/auth/mfa/enable", "POST /api/auth/mfa/disable", "GET /api/members/me", "PATCH /api/members/me", "PATCH /api/members/:id", "GET /api/notifications", "POST /api/notifications/read-all", "POST /api/notifications/:id/read", "GET /api/ai/status"]],
  ["conversations:read", [
    "GET /api/dashboard/counts", "GET /api/inboxes", "GET /api/inboxes/counts", "GET /api/inboxes/:id", "GET /api/rooms", "GET /api/rooms/:id", "GET /api/rooms/:id/messages", "GET /api/rooms/:id/payment-requests", "GET /api/messages/search",
    "PUT /api/rooms/:id/favorite", "DELETE /api/rooms/:id/favorite", "POST /api/rooms/:id/read", "GET /api/templates",
  ]],
  ["conversations:reply", [
    "POST /api/rooms", "POST /api/rooms/bulk", "PATCH /api/rooms/:id", "POST /api/rooms/:id/snooze", "DELETE /api/rooms/:id/snooze", "POST /api/rooms/:id/messages", "PATCH /api/messages/:id",
    "DELETE /api/messages/:id", "POST /api/messages/:id/retry", "POST /api/attachments", "POST /api/templates/:id/render", "POST /api/rooms/:id/assign",
  ]],
  ["conversations:delete", ["DELETE /api/rooms/:id"]],
  ["contacts:read", ["GET /api/contacts", "GET /api/contacts/:id", "GET /api/contacts/:id/notes", "GET /api/contacts/:id/rooms"]],
  ["contacts:write", ["POST /api/contacts", "PATCH /api/contacts/:id", "POST /api/contacts/:id/notes", "DELETE /api/contacts/:id/notes/:noteId"]],
  ["contacts:import", ["POST /api/contacts/import"]],
  ["contacts:delete", ["DELETE /api/contacts/:id"]],
  ["inboxes:manage", ["POST /api/inboxes", "PATCH /api/inboxes/:id", "DELETE /api/inboxes/:id", "POST /api/inboxes/:id/members/:memberId", "DELETE /api/inboxes/:id/members/:memberId"]],
  ["members:read", ["GET /api/members", "GET /api/presence", "GET /api/roles"]],
  ["members:manage", ["POST /api/members", "DELETE /api/members/:id", "GET /api/invitations", "POST /api/invitations", "DELETE /api/invitations/:id"]],
  ["roles:manage", ["POST /api/roles", "PATCH /api/roles/:id", "DELETE /api/roles/:id", "PUT /api/members/:id/role"]],
  ["audit:read", ["GET /api/audit"]],
  ["api_keys:manage", ["GET /api/v1/api-keys", "POST /api/v1/api-keys", "DELETE /api/v1/api-keys/:id"]],
  ["analytics:read", ["GET /api/analytics/overview", "GET /api/analytics/timeseries"]],
  ["analytics_identity:manage", ["GET /api/analytics/identity-pepper", "POST /api/analytics/identity-pepper/rotate"]],
  ["settings:read", ["GET /api/workspace", "GET /api/credits", "GET /api/sms-numbers", "GET /api/email-senders", "GET /api/inbound-addresses"]],
  ["settings:write", ["PATCH /api/workspace"]],
  ["billing:manage", [
    "POST /api/credits/grant", "GET /api/billing", "POST /api/billing/checkout/subscription", "POST /api/billing/checkout/topup", "POST /api/billing/portal", "PATCH /api/billing/automation",
    "POST /api/billing/connect/onboard", "POST /api/billing/connect/refresh",
  ]],
  ["payments:request", ["POST /api/rooms/:id/payment-requests", "POST /api/payment-requests/:id/cancel"]],
  ["channels:manage", ["POST /api/sms-numbers", "POST /api/sms-numbers/:id/default", "DELETE /api/sms-numbers/:id", "POST /api/email-senders", "PATCH /api/email-senders/:id", "DELETE /api/email-senders/:id", "POST /api/inbound-addresses", "DELETE /api/inbound-addresses/:address"]],
  ["tokens:manage", ["GET /api/tokens", "POST /api/tokens", "POST /api/tokens/:id/rotate", "DELETE /api/tokens/:id"]],
  ["templates:manage", ["POST /api/templates", "PATCH /api/templates/:id", "DELETE /api/templates/:id"]],
  ["kb:manage", ["GET /api/kb", "POST /api/kb", "PUT /api/kb/:id", "DELETE /api/kb/:id"]],
  ["ai:use", ["POST /api/ai/suggest-replies", "POST /api/ai/summary", "POST /api/ai/rephrase"]],
];

export const ROUTE_ACCESS: ReadonlyMap<string, RouteAccess> = (() => {
  const m = new Map<string, RouteAccess>();
  for (const [access, routes] of GROUPS) {
    for (const r of routes) {
      if (m.has(r)) throw new Error(`route ${r} is declared twice in routePerms.ts`);
      m.set(r, access);
    }
  }
  return m;
})();

/** Routes that authenticate by something other than a team session and bring their own rules (API keys, platform admin sessions). Listed so the coverage test can account for them. */
export const SELF_AUTHENTICATED_PREFIXES = ["/api/v1/analytics/", "/admin/"];

/**
 * Socket events: the permission a TEAM socket needs. Visitor sockets are authorised by their session scope and the per-event audience
 * check ("team" / "visitor") in realtime/socket.ts, not by roles. A test requires an entry for every registered event.
 */
export const EVENT_ACCESS: Record<string, Permission | "authed" | "visitor-only"> = {
  "message:send": "conversations:reply",
  "message:read": "conversations:read",
  "room:create": "conversations:reply",
  "room:update": "conversations:reply",
  "room:assign": "conversations:reply",
  typing: "conversations:reply",
  "otp:verify": "visitor-only",
  "presence:list": "members:read",
};
