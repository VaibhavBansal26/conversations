import type { ZodType } from "zod";
import * as S from "../schemas.js";
import * as authR from "../routes/auth.js";
import * as billingR from "../routes/billing.js";
import * as adminR from "../routes/admin.js";
import * as rolesR from "../routes/roles.js";
import * as invR from "../routes/invitations.js";
import * as anR from "../routes/analytics.js";
import * as anApiR from "../routes/analyticsApi.js";
import * as pubR from "../routes/public.js";

/**
 * The documented surface of the REST API: one entry per route registered on the app (a test requires an entry for every route and a route
 * for every entry). `docs/openapi.json` and `docs/API.md` are generated from this plus the authorisation table (routePerms.ts), the rate-limit
 * table (routePolicies.ts) and the zod schemas of the request bodies and queries, so none of those can drift from the code.
 */
export interface ApiMeta {
  tag: string;
  summary: string;
  /** request body schema (JSON) */
  body?: ZodType;
  /** query string schema */
  query?: ZodType;
  /** success status when it is not 200 */
  status?: number;
  /** response media type when it is not JSON */
  media?: string;
  /** short description of the success response */
  returns?: string;
}

type Opt = Partial<Omit<ApiMeta, "tag" | "summary">>;
const rows: [string, string, string, Opt?][] = [
  // ---- auth
  ["POST /api/auth/register", "Auth", "Create a workspace and its owner; returns a session", { body: S.RegisterBody, status: 201, returns: "`{token, refresh_token, expires_in, user, member, workspace}`" }],
  ["POST /api/auth/login", "Auth", "Sign in; returns a session, or `{mfa_required, mfa_token}` when two-factor is on", { body: S.LoginBody }],
  ["POST /api/auth/refresh", "Auth", "Exchange a refresh token for a new session (single use, rotated)", { body: authR.Refresh }],
  ["POST /api/auth/logout", "Auth", "End the session of a refresh token", { status: 204 }],
  ["POST /api/auth/mfa/verify", "Auth", "Second step of a two-factor sign-in", { body: authR.MfaVerify }],
  ["POST /api/auth/password/forgot", "Auth", "Email a password-reset link (answers the same whether or not the address exists)", { body: authR.Forgot }],
  ["POST /api/auth/password/reset", "Auth", "Set a new password with a reset token (revokes all sessions)", { body: authR.Reset }],
  ["GET /api/auth/invitations/:token", "Auth", "Describe an invitation (workspace, role, inviter)"],
  ["POST /api/auth/invitations/accept", "Auth", "Accept an invitation and sign in", { body: authR.Accept, status: 201 }],
  ["GET /api/auth/me", "Auth", "The signed-in user, member, permissions and workspace (including `billing_access`)"],
  ["GET /api/auth/sessions", "Auth", "Your active sessions"],
  ["DELETE /api/auth/sessions/:id", "Auth", "Revoke one of your sessions", { status: 204 }],
  ["POST /api/auth/password/change", "Auth", "Change your password (revokes your other sessions)", { body: authR.Change }],
  ["POST /api/auth/mfa/setup", "Auth", "Start two-factor enrolment; returns the secret and `otpauth://` URL"],
  ["POST /api/auth/mfa/enable", "Auth", "Confirm enrolment with a code; returns 10 single-use recovery codes", { body: authR.MfaEnable }],
  ["POST /api/auth/mfa/disable", "Auth", "Turn two-factor off (needs password and a code)", { body: authR.MfaDisable, status: 204 }],

  // ---- workspace, team
  ["GET /api/workspace", "Workspace", "The workspace: settings, credit balance, plan, `billing_access`, currency"],
  ["PATCH /api/workspace", "Workspace", "Change the name and settings (widget, office hours, retention, AI flags, credits)", { body: S.WorkspacePatch }],
  ["GET /api/credits", "Workspace", "Credit balance and recent ledger"],
  ["POST /api/credits/grant", "Workspace", "Add credits by hand (owners; refused with `CREDIT_GRANT_DISABLED` when Stripe is configured)", { body: S.CreditGrant, status: 201 }],
  ["GET /api/dashboard/counts", "Workspace", "Open/unread/assigned counts for the inbox sidebar"],
  ["GET /api/members", "Team", "Team members"],
  ["POST /api/members", "Team", "Add a member with a temporary password", { body: S.MemberCreate, status: 201 }],
  ["GET /api/members/me", "Team", "Your member record"],
  ["PATCH /api/members/me", "Team", "Edit your name, availability, do-not-disturb and notification preferences", { body: S.MemberPatch }],
  ["PATCH /api/members/:id", "Team", "Edit a member (role, seat and visibility need manager permissions)", { body: S.MemberPatch }],
  ["DELETE /api/members/:id", "Team", "Remove a member; their rooms are unassigned or re-routed", { status: 204 }],
  ["GET /api/presence", "Team", "Online member ids"],
  ["GET /api/roles", "Roles", "Built-in and custom roles with their permissions"],
  ["POST /api/roles", "Roles", "Create a custom role", { body: rolesR.RoleBody, status: 201 }],
  ["PATCH /api/roles/:id", "Roles", "Edit a custom role", { body: rolesR.RolePatch }],
  ["DELETE /api/roles/:id", "Roles", "Delete an unused custom role", { status: 204 }],
  ["PUT /api/members/:id/role", "Roles", "Change a member's role", { body: rolesR.MemberRoleBody }],
  ["GET /api/invitations", "Roles", "Pending invitations"],
  ["POST /api/invitations", "Roles", "Invite someone by email with a role (valid 7 days)", { body: invR.Invite, status: 201 }],
  ["DELETE /api/invitations/:id", "Roles", "Revoke an invitation", { status: 204 }],
  ["GET /api/audit", "Audit", "Workspace audit log, newest first, keyset paged", { query: rolesR.AuditQuery }],
  ["GET /api/notifications", "Notifications", "Your notifications and unread count"],
  ["POST /api/notifications/read-all", "Notifications", "Mark all your notifications read"],
  ["POST /api/notifications/:id/read", "Notifications", "Mark one notification read"],

  // ---- inboxes, rooms, messages
  ["GET /api/inboxes", "Inboxes", "Inboxes you can see"],
  ["GET /api/inboxes/counts", "Inboxes", "Open conversation counts per inbox"],
  ["GET /api/inboxes/:id", "Inboxes", "One inbox with its members"],
  ["POST /api/inboxes", "Inboxes", "Create an inbox", { body: S.InboxBody, status: 201 }],
  ["PATCH /api/inboxes/:id", "Inboxes", "Edit an inbox (routing, office hours)", { body: S.InboxPatch }],
  ["DELETE /api/inboxes/:id", "Inboxes", "Delete an inbox", { status: 204 }],
  ["POST /api/inboxes/:id/members/:memberId", "Inboxes", "Add a member to an inbox", { status: 204 }],
  ["DELETE /api/inboxes/:id/members/:memberId", "Inboxes", "Remove a member from an inbox", { status: 204 }],
  ["GET /api/rooms", "Conversations", "List conversations (filters, sort, keyset cursor)", { query: S.RoomQuery }],
  ["POST /api/rooms", "Conversations", "Start a conversation with a contact", { body: S.RoomCreate, status: 201 }],
  ["POST /api/rooms/bulk", "Conversations", "Close, reopen, assign, prioritise or tag many conversations", { body: S.BulkBody }],
  ["GET /api/rooms/:id", "Conversations", "One conversation"],
  ["PATCH /api/rooms/:id", "Conversations", "Change status, priority, subject, inbox", { body: S.RoomPatch }],
  ["DELETE /api/rooms/:id", "Conversations", "Archive a conversation", { status: 204 }],
  ["POST /api/rooms/:id/assign", "Conversations", "Assign to members, to an inbox, or round-robin", { body: S.AssignBody }],
  ["POST /api/rooms/:id/snooze", "Conversations", "Snooze until a time", { body: S.SnoozeBody }],
  ["DELETE /api/rooms/:id/snooze", "Conversations", "Wake a snoozed conversation", { status: 204 }],
  ["PUT /api/rooms/:id/favorite", "Conversations", "Star a conversation for yourself"],
  ["DELETE /api/rooms/:id/favorite", "Conversations", "Remove your star"],
  ["POST /api/rooms/:id/read", "Conversations", "Mark read up to a message", { body: S.ReadBody }],
  ["GET /api/rooms/:id/messages", "Messages", "History page (keyset: `before` / `after`)", { query: S.MessageListQuery }],
  ["POST /api/rooms/:id/messages", "Messages", "Send a message or note on chat, SMS or email (idempotent on `client_msg_id`)", { body: S.SendMessageBody, status: 201 }],
  ["GET /api/messages/search", "Messages", "Search message text you can see", { query: S.SearchQuery }],
  ["PATCH /api/messages/:id", "Messages", "Edit your message inside the edit window", { body: S.EditMessageBody }],
  ["DELETE /api/messages/:id", "Messages", "Delete a message (soft delete)", { status: 204 }],
  ["POST /api/messages/:id/retry", "Messages", "Retry a failed delivery"],
  ["POST /api/attachments", "Messages", "Upload an attachment (multipart `file`); returns an id to reference when sending", { status: 201 }],
  ["GET /api/templates", "Templates", "Reply templates"],
  ["POST /api/templates", "Templates", "Create a template", { body: S.TemplateBody, status: 201 }],
  ["PATCH /api/templates/:id", "Templates", "Edit a template", { body: S.TemplateBody.partial() }],
  ["DELETE /api/templates/:id", "Templates", "Delete a template", { status: 204 }],
  ["POST /api/templates/:id/render", "Templates", "Render a template for a contact or room", { body: S.TemplateRender }],

  // ---- contacts
  ["GET /api/contacts", "Contacts", "List contacts (search, keyset cursor)"],
  ["POST /api/contacts", "Contacts", "Create a contact", { body: S.ContactBody, status: 201 }],
  ["GET /api/contacts/:id", "Contacts", "One contact"],
  ["PATCH /api/contacts/:id", "Contacts", "Edit a contact", { body: S.ContactPatch }],
  ["DELETE /api/contacts/:id", "Contacts", "Delete a contact and its conversations (GDPR)", { status: 204 }],
  ["GET /api/contacts/:id/notes", "Contacts", "Notes on a contact"],
  ["POST /api/contacts/:id/notes", "Contacts", "Add a note", { status: 201 }],
  ["DELETE /api/contacts/:id/notes/:noteId", "Contacts", "Delete a note", { status: 204 }],
  ["GET /api/contacts/:id/rooms", "Contacts", "Conversations of a contact"],
  ["POST /api/contacts/import", "Contacts", "Import contacts from CSV (multipart `file`, max 5 MB)"],

  // ---- channels and settings
  ["GET /api/sms-numbers", "Channels", "SMS numbers"],
  ["POST /api/sms-numbers", "Channels", "Register an SMS number", { body: S.SmsNumberBody, status: 201 }],
  ["POST /api/sms-numbers/:id/default", "Channels", "Make a number the default"],
  ["DELETE /api/sms-numbers/:id", "Channels", "Remove a number", { status: 204 }],
  ["GET /api/email-senders", "Channels", "Email sender addresses"],
  ["POST /api/email-senders", "Channels", "Add a sender address", { body: S.SenderBody, status: 201 }],
  ["PATCH /api/email-senders/:id", "Channels", "Edit a sender", { body: S.SenderBody.omit({ address: true }).partial() }],
  ["DELETE /api/email-senders/:id", "Channels", "Remove a sender", { status: 204 }],
  ["GET /api/inbound-addresses", "Channels", "Inbound email addresses"],
  ["POST /api/inbound-addresses", "Channels", "Add an inbound address", { body: S.InboundAddressBody, status: 201 }],
  ["DELETE /api/inbound-addresses/:address", "Channels", "Remove an inbound address", { status: 204 }],
  ["GET /api/tokens", "Widget", "Widget embed tokens"],
  ["POST /api/tokens", "Widget", "Create an embed token bound to a domain", { body: S.TokenBody, status: 201 }],
  ["POST /api/tokens/:id/rotate", "Widget", "Rotate an embed token"],
  ["DELETE /api/tokens/:id", "Widget", "Revoke an embed token", { status: 204 }],
  ["GET /api/kb", "AI", "Knowledge-base entries"],
  ["POST /api/kb", "AI", "Add an entry", { body: S.KbBody, status: 201 }],
  ["PUT /api/kb/:id", "AI", "Replace an entry", { body: S.KbBody }],
  ["DELETE /api/kb/:id", "AI", "Delete an entry", { status: 204 }],
  ["GET /api/ai/status", "AI", "Which AI provider is active"],
  ["POST /api/ai/suggest-replies", "AI", "Suggest replies for a conversation", { body: S.AiRoomBody }],
  ["POST /api/ai/summary", "AI", "Summarise a conversation", { body: S.AiRoomBody }],
  ["POST /api/ai/rephrase", "AI", "Rewrite a draft in a tone", { body: S.RephraseBody }],

  // ---- analytics (session) and API keys
  ["GET /api/analytics/overview", "Analytics", "Dashboard overview (same definitions as the API)", { query: anR.Range }],
  ["GET /api/analytics/timeseries", "Analytics", "Dashboard time series", { query: anR.Range.extend({ metric: anApiR.TsQ.shape.metric }) }],
  ["GET /api/analytics/identity-pepper", "Analytics", "View the workspace identity pepper"],
  ["POST /api/analytics/identity-pepper/rotate", "Analytics", "Rotate the identity pepper (changes every `contact_key`)"],
  ["GET /api/v1/api-keys", "API keys", "List API keys (never the secret)"],
  ["POST /api/v1/api-keys", "API keys", "Create an API key; the plaintext is returned once", { body: anR.KeyBody, status: 201 }],
  ["DELETE /api/v1/api-keys/:id", "API keys", "Revoke an API key", { status: 204 }],

  // ---- billing
  ["GET /api/billing", "Billing", "Plan, seats, credits, saved card (brand and last four), automation, Connect state"],
  ["POST /api/billing/checkout/subscription", "Billing", "Start Stripe Checkout for a plan; returns `{url}`", { body: billingR.Subscribe }],
  ["POST /api/billing/checkout/topup", "Billing", "Start Stripe Checkout for a credit pack or amount; returns `{url, credits, amount_cents}`", { body: billingR.TopUp }],
  ["POST /api/billing/portal", "Billing", "Open the Stripe customer portal; returns `{url}`"],
  ["PATCH /api/billing/automation", "Billing", "Low-balance alert and auto-recharge settings", { body: billingR.Automation }],
  ["POST /api/billing/connect/onboard", "Billing", "Start or resume Stripe Connect onboarding; returns `{url}`"],
  ["POST /api/billing/connect/refresh", "Billing", "Ask Stripe whether the connected account can take payments"],
  ["GET /api/rooms/:id/payment-requests", "Payments", "Payment requests of a conversation"],
  ["POST /api/rooms/:id/payment-requests", "Payments", "Ask the customer to pay; sends a payment card on the chosen channel", { body: billingR.PaymentRequest, status: 201 }],
  ["POST /api/payment-requests/:id/cancel", "Payments", "Cancel an open payment request"],

  // ---- analytics API (API key)
  ["GET /api/v1/analytics/overview", "Analytics API", "Overview for a range (API key, `analytics:read`)", { query: anApiR.Range }],
  ["GET /api/v1/analytics/timeseries", "Analytics API", "Zero-filled time series (API key, `analytics:read`)", { query: anApiR.TsQ }],
  ["GET /api/v1/analytics/schema", "Analytics API", "The JSON Schemas and `schema_version`"],
  ["GET /api/v1/analytics/identity-pepper", "Analytics API", "The identity pepper (API key, `analytics:export`)"],
  ["GET /api/v1/analytics/export/rooms", "Analytics API", "NDJSON export of rooms, keyset paged (`X-Next-Cursor`)", { query: anApiR.ExportQ, media: "application/x-ndjson" }],
  ["GET /api/v1/analytics/export/messages-meta", "Analytics API", "NDJSON export of message metadata, no content", { query: anApiR.ExportQ, media: "application/x-ndjson" }],

  // ---- public widget
  ["GET /public/widget/config", "Widget (public)", "Widget configuration for an embed token (`x-api-key`, `Origin`)"],
  ["POST /public/sessions", "Widget (public)", "Create a visitor session", { body: S.SessionBody, status: 201 }],
  ["GET /public/session", "Widget (public)", "The current visitor session"],
  ["GET /public/rooms", "Widget (public)", "The visitor's conversations"],
  ["POST /public/rooms", "Widget (public)", "Start a conversation", { status: 201 }],
  ["GET /public/rooms/:id/messages", "Widget (public)", "Messages of the visitor's conversation", { query: S.MessageListQuery }],
  ["POST /public/rooms/:id/messages", "Widget (public)", "Visitor sends a message", { body: S.VisitorSend, status: 201 }],
  ["POST /public/rooms/:id/read", "Widget (public)", "Visitor read receipt", { body: S.ReadBody }],
  ["POST /public/rooms/:id/csat", "Widget (public)", "Satisfaction score after the conversation is closed", { body: pubR.Csat }],
  ["POST /public/otp/send", "Widget (public)", "Send a one-time code to verify the visitor"],
  ["POST /public/otp/verify", "Widget (public)", "Verify the one-time code", { body: S.OtpVerify }],

  // ---- webhooks and static
  ["POST /webhooks/stripe", "Webhooks", "Stripe platform events (signature `Stripe-Signature`); see docs/STRIPE.md"],
  ["POST /webhooks/stripe/connect", "Webhooks", "Stripe Connect events (signature `Stripe-Signature`)"],
  ["POST /webhooks/twilio/sms", "Webhooks", "Inbound SMS from Twilio (signature `X-Twilio-Signature`)", { media: "text/xml" }],
  ["POST /webhooks/twilio/status", "Webhooks", "SMS delivery status from Twilio", { status: 204 }],
  ["POST /webhooks/sendgrid/inbound", "Webhooks", "Inbound email from SendGrid Inbound Parse (shared secret)"],
  ["POST /webhooks/sendgrid/events", "Webhooks", "Email events (delivered, bounce, open) from SendGrid (signature)"],
  ["GET /files/*", "Files", "Signed attachment download (`exp` and `sig` query parameters)", { media: "application/octet-stream" }],
  ["GET /widget.js", "Files", "The embeddable widget script", { media: "application/javascript" }],
  ["GET /widget-demo.html", "Files", "Widget demo page", { media: "text/html" }],

  // ---- platform admin
  ["POST /admin/api/login", "Platform admin", "Password step of an operator sign-in; returns `{mfa_required | mfa_setup_required, mfa_token}`", { body: adminR.Login }],
  ["POST /admin/api/mfa/setup", "Platform admin", "Start authenticator enrolment with the step token", { body: adminR.Step }],
  ["POST /admin/api/mfa/enable", "Platform admin", "Confirm enrolment with a code; returns the 30-minute admin token", { body: adminR.StepCode }],
  ["POST /admin/api/mfa/verify", "Platform admin", "Second step for enrolled operators; returns the admin token", { body: adminR.StepCode }],
  ["GET /admin/api/me", "Platform admin", "The signed-in operator"],
  ["GET /admin/api/stats", "Platform admin", "Installation-wide counts"],
  ["GET /admin/api/workspaces", "Platform admin", "Workspace directory (search, plan, suspended, keyset cursor)", { query: adminR.WsQuery }],
  ["GET /admin/api/workspaces/:id", "Platform admin", "Workspace detail: plan, billing state, seats, usage, members, ledger, audit (no content)"],
  ["GET /admin/api/audit", "Platform admin", "Platform-wide audit log", { query: adminR.AuditQuery }],
  ["GET /admin/api/ratelimit", "Platform admin", "Allow and deny lists and recently limited keys"],
  ["GET /admin/api/admins", "Platform admin", "Operators"],
  ["POST /admin/api/workspaces/:id/impersonate", "Platform admin", "Mint a 15-minute read-only support token (reason required)", { body: adminR.Impersonate }],
  ["POST /admin/api/workspaces/:id/suspend", "Platform admin", "Suspend a workspace (reason required)", { body: adminR.Reason, status: 204 }],
  ["POST /admin/api/workspaces/:id/unsuspend", "Platform admin", "Lift a suspension", { body: adminR.Reason, status: 204 }],
  ["POST /admin/api/workspaces/:id/credits", "Platform admin", "Add or remove credits (reason required; `Idempotency-Key` supported)", { body: adminR.Credits, status: 201 }],
  ["PUT /admin/api/workspaces/:id/tier", "Platform admin", "Override the rate-limit tier or clear it", { body: adminR.Tier, status: 204 }],
  ["PUT /admin/api/workspaces/:id/region", "Platform admin", "Set or clear the workspace's home region (multi-region routing key)", { body: adminR.Region, status: 204 }],
  ["POST /admin/api/ratelimit/:kind", "Platform admin", "Add an expiring `allow` or `deny` entry", { body: adminR.ListEntry, status: 204 }],
  ["DELETE /admin/api/ratelimit/:kind/:entity", "Platform admin", "Remove an entry"],
  ["POST /admin/api/admins/:id/disable", "Platform admin", "Disable an operator", { status: 204 }],
  ["POST /admin/api/admins/:id/enable", "Platform admin", "Re-enable an operator", { status: 204 }],
];

export const API_META: ReadonlyMap<string, ApiMeta> = new Map(rows.map(([k, tag, summary, o]) => [k, { tag, summary, ...(o ?? {}) }]));
