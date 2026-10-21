import type { Permission } from "./permissions.js";

/**
 * Authorisation declaration: for every REST route, who may call it.
 *   a Permission   the caller's role must hold it (`can()`)
 *   "authed"       any signed-in, live team member (own profile, notifications); services still apply ownership rules
 *   "public"       no team session: visitors (session token + embed token), provider webhooks, unauthenticated auth endpoints, static files
 * Deny by default: an authenticated route missing from this table is refused with 403 NO_POLICY, and a test fails the build.
 * The rate-limit declaration (ratelimit/routePolicies.ts) has the same route keys; a test keeps the two tables in step.
 */
export type RouteAccess = Permission | "authed" | "public" | "apikey" | "platform";

const GROUPS: [RouteAccess, string[]][] = [
  ["public", [
    "POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/refresh", "POST /api/auth/logout", "POST /api/auth/mfa/verify", "POST /api/auth/password/forgot", "POST /api/auth/password/reset",
    "GET /api/auth/invitations/:token", "POST /api/auth/invitations/accept",
    "GET /public/widget/config", "POST /public/call-links/preview", "POST /public/call-links/redeem", "GET /call/:token", "POST /public/sessions", "GET /public/session", "GET /public/rooms", "POST /public/rooms", "GET /public/rooms/:id/messages", "POST /public/rooms/:id/messages",
    "POST /public/rooms/:id/read", "POST /public/rooms/:id/csat", "POST /public/rooms/:id/ticket-csat", "POST /public/rooms/:id/quick-reply", "POST /public/rooms/:id/request-human", "POST /public/rooms/:id/forms/:messageId", "POST /public/rooms/:id/forms/:messageId/skip", "POST /public/rooms/:id/messages/:messageId/feedback", "POST /public/otp/send", "POST /public/otp/verify",
    "DELETE /public/session", "POST /public/session/attributes", "POST /public/attachments",
    "GET /chat", "GET /chat/bridge-test", "GET /chat/assets/:file",
    "POST /webhooks/stripe", "POST /webhooks/stripe/connect", "POST /webhooks/twilio/sms", "POST /webhooks/twilio/status", "POST /webhooks/sendgrid/inbound", "POST /webhooks/sendgrid/events",
    "POST /webhooks/c/:id/twilio/sms", "POST /webhooks/c/:id/twilio/status", "POST /webhooks/c/:id/twilio/voice/connect", "POST /webhooks/c/:id/twilio/voice/status", "POST /webhooks/c/:id/sendgrid/inbound", "POST /webhooks/c/:id/sendgrid/events",
    "GET /files/*", "GET /avatars/agent/:id", "GET /avatars/:file", "GET /widget.js", "GET /widget-demo.html", "GET /widget-preview", "GET /runtime-config.json",
  ]],
  ["platform", [
    "POST /admin/api/login", "POST /admin/api/mfa/setup", "POST /admin/api/mfa/enable", "POST /admin/api/mfa/verify", "GET /admin/api/me", "GET /admin/api/stats", "GET /admin/api/workspaces", "GET /admin/api/workspaces/:id",
    "GET /admin/api/audit", "GET /admin/api/ratelimit", "GET /admin/api/admins", "POST /admin/api/workspaces/:id/impersonate", "POST /admin/api/workspaces/:id/suspend", "POST /admin/api/workspaces/:id/unsuspend",
    "POST /admin/api/workspaces/:id/credits", "PUT /admin/api/workspaces/:id/tier", "PUT /admin/api/workspaces/:id/region", "POST /admin/api/monitoring/test", "POST /admin/api/ratelimit/:kind", "DELETE /admin/api/ratelimit/:kind/:entity", "POST /admin/api/admins/:id/disable", "POST /admin/api/admins/:id/enable",
  ]],
  ["apikey", ["GET /api/v1/analytics/overview", "GET /api/v1/analytics/timeseries", "GET /api/v1/analytics/schema", "GET /api/v1/analytics/identity-pepper", "PUT /api/v1/analytics/identity-pepper", "POST /api/v1/analytics/identity-pepper/rotate", "GET /api/v1/analytics/export/rooms", "GET /api/v1/analytics/export/messages-meta", "GET /api/v1/analytics/support", "GET /api/v1/analytics/export/tickets", "GET /api/v1/analytics/export/calls"]],
  ["authed", ["GET /api/auth/me", "GET /api/auth/sessions", "DELETE /api/auth/sessions/:id", "POST /api/auth/password/change", "POST /api/auth/mfa/setup", "POST /api/auth/mfa/enable", "POST /api/auth/mfa/disable", "GET /api/members/me", "PATCH /api/members/me", "PATCH /api/members/:id", "GET /api/notifications", "POST /api/notifications/read-all", "POST /api/notifications/:id/read", "GET /api/ai/status"]],
  ["conversations:read", [
    "GET /api/dashboard/counts", "GET /api/inboxes", "GET /api/inboxes/counts", "GET /api/inboxes/:id", "GET /api/rooms", "GET /api/rooms/:id", "GET /api/rooms/:id/messages", "GET /api/rooms/:id/payment-requests", "GET /api/messages/search",
    "GET /api/rooms/:id/calls", "PUT /api/rooms/:id/favorite", "DELETE /api/rooms/:id/favorite", "POST /api/rooms/:id/read", "GET /api/templates", "GET /api/channels/status",
  ]],
  ["conversations:reply", [
    "POST /api/rooms", "POST /api/rooms/bulk", "PATCH /api/rooms/:id", "POST /api/rooms/:id/snooze", "DELETE /api/rooms/:id/snooze", "POST /api/rooms/:id/messages", "PATCH /api/messages/:id",
    "DELETE /api/messages/:id", "POST /api/messages/:id/retry", "POST /api/attachments", "POST /api/templates/:id/render", "POST /api/rooms/:id/assign", "POST /api/messages/:id/feedback",
  ]],
  ["conversations:delete", ["DELETE /api/rooms/:id"]],
  ["tickets:read", ["GET /api/tickets", "GET /api/tickets/counts", "GET /api/tickets/:id", "GET /api/rooms/:id/tickets", "GET /api/contacts/:id/tickets", "GET /api/department-status"]],
  ["tickets:write", ["PATCH /api/tickets/:id", "POST /api/tickets/:id/reopen", "POST /api/tickets/:id/claim", "POST /api/tickets/:id/hand-back", "POST /api/tickets/:id/transfer"]],
  ["calls:make", ["POST /api/rooms/:id/call-links", "GET /api/rooms/:id/call-links", "DELETE /api/rooms/:id/call-links/:linkId", "GET /api/calls/config", "POST /api/rooms/:id/phone-call", "POST /api/rooms/:id/phone-call/consent", "POST /api/calls/:id/hangup"]],
  ["calls:settings", ["PATCH /api/calls/settings"]],
  ["calls:internal", ["GET /api/team-calls/config"]],
  ["agents:manage", ["GET /api/agents/presets", "GET /api/agents", "POST /api/agents", "GET /api/agents/turns", "GET /api/agents/unanswered", "GET /api/agents/:id", "PATCH /api/agents/:id", "DELETE /api/agents/:id", "POST /api/agents/:id/sandbox", "POST /api/agents/:id/avatar", "DELETE /api/agents/:id/avatar"]],
  ["departments:manage", [
    "GET /api/departments", "GET /api/departments/:id", "PATCH /api/departments/:id", "GET /api/routing-rules", "POST /api/routing-rules", "PUT /api/routing-rules/order",
    "POST /api/routing-rules/test", "PATCH /api/routing-rules/:id", "DELETE /api/routing-rules/:id",
  ]],
  ["tickets:close", ["POST /api/tickets/:id/resolve", "POST /api/tickets/:id/close", "POST /api/tickets/bulk"]],
  ["tickets:merge", ["POST /api/tickets/:id/merge"]],
  ["team_chat:use", [
    "GET /api/team/channels", "GET /api/team/channels/browse", "POST /api/team/dms", "GET /api/team/channels/:id", "POST /api/team/channels/:id/join", "POST /api/team/channels/:id/leave",
    "POST /api/team/channels/:id/members", "DELETE /api/team/channels/:id/members/:memberId", "PUT /api/team/channels/:id/mute", "POST /api/team/channels/:id/read",
    "GET /api/team/channels/:id/messages", "POST /api/team/channels/:id/messages", "GET /api/team/channels/:id/pins", "GET /api/team/messages/:id/thread", "PATCH /api/team/messages/:id",
    "DELETE /api/team/messages/:id", "POST /api/team/messages/:id/reactions", "PUT /api/team/messages/:id/pin", "DELETE /api/team/messages/:id/pin", "GET /api/team/search", "POST /api/team/attachments",
    "PATCH /api/team/channels/:id",
  ]],
  ["team_chat:manage_channels", ["POST /api/team/channels"]],
  ["team_chat:moderate", ["DELETE /api/team/channels/:id/messages/:messageId"]],
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
  ["analytics:read", ["GET /api/analytics/overview", "GET /api/analytics/timeseries", "GET /api/analytics/support"]],
  ["analytics_identity:manage", ["GET /api/analytics/identity-pepper", "PUT /api/analytics/identity-pepper", "POST /api/analytics/identity-pepper/rotate"]],
  ["settings:read", ["GET /api/getting-started", "GET /api/workspace", "GET /api/credits", "GET /api/sms-numbers", "GET /api/email-senders", "GET /api/inbound-addresses"]],
  ["settings:write", ["PATCH /api/workspace"]],
  ["billing:manage", [
    "POST /api/credits/grant", "GET /api/billing", "POST /api/billing/checkout/subscription", "POST /api/billing/checkout/topup", "POST /api/billing/portal", "PATCH /api/billing/automation",
    "POST /api/billing/connect/onboard", "POST /api/billing/connect/refresh",
  ]],
  ["payments:request", ["POST /api/rooms/:id/payment-requests", "POST /api/payment-requests/:id/cancel"]],
  ["channels:manage", [
    "GET /api/channels/connections", "PUT /api/channels/sms/connection", "PUT /api/channels/email/connection", "PATCH /api/channels/email/connection", "DELETE /api/channels/:channel/connection",
    "POST /api/channels/:channel/verify", "GET /api/channels/sms/numbers", "POST /api/channels/sms/numbers/import", "POST /api/channels/email/senders/import",
    "POST /api/channels/email/webhook-secret/rotate", "POST /api/channels/:channel/test", "GET /api/channels/:channel/events",
    "POST /api/sms-numbers", "POST /api/sms-numbers/:id/default", "DELETE /api/sms-numbers/:id", "POST /api/email-senders", "PATCH /api/email-senders/:id", "DELETE /api/email-senders/:id", "POST /api/inbound-addresses", "DELETE /api/inbound-addresses/:address"]],
  ["tokens:manage", ["GET /api/tokens", "POST /api/tokens", "PATCH /api/tokens/:id", "POST /api/tokens/:id/rotate", "POST /api/tokens/:id/preview", "DELETE /api/tokens/:id", "GET /api/identity", "POST /api/identity/rotate", "PATCH /api/identity"]],
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
  "call:invite": "calls:make",
  "call:request": "visitor-only",
  "aicall:start": "visitor-only",
  "aicall:say": "visitor-only",
  "aicall:end": "visitor-only",
  "aicall:handoff": "visitor-only",
  "aicall:tool": "visitor-only",
  "aicall:transcript": "visitor-only",
  "aicall:fallback": "visitor-only",
  "call:accept": "visitor-only",
  "call:decline": "visitor-only",
  "call:end": "calls:make",
  "call:connected": "calls:make",
  "call:failed": "calls:make",
  "call:resume": "calls:make",
  "call:offer": "calls:make",
  "call:answer": "calls:make",
  "call:ice": "calls:make",
  "tcall:invite": "calls:internal",
  "tcall:accept": "calls:internal",
  "tcall:decline": "calls:internal",
  "tcall:end": "calls:internal",
  "tcall:connected": "calls:internal",
  "tcall:failed": "calls:internal",
  "tcall:resume": "calls:internal",
  "tcall:offer": "calls:internal",
  "tcall:answer": "calls:internal",
  "tcall:ice": "calls:internal",
  "team:message:send": "team_chat:use",
  "team:typing": "team_chat:use",
  "team:read": "team_chat:use",
  "team:reaction": "team_chat:use",
};
