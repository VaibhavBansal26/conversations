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
import * as depRoutes from "../routes/departments.js";
import * as depR from "../services/departments.js";
import * as rulesR from "../services/routingRules.js";

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
  ["GET /api/workspace", "Workspace", "The workspace: settings, credit balance, plan, `billing_access`, currency, `public_url` (what snippets and webhook URLs must contain)"],
  ["PATCH /api/workspace", "Workspace", "Change the name and settings (widget, office hours, retention, AI flags, credits)", { body: S.WorkspacePatch }],
  ["GET /api/getting-started", "Workspace", "The new-workspace checklist (invite teammates, connect SMS, connect email, install the widget, create a template), each derived from real state on every call", { returns: "`{items: [{id, done, href}], done, total}`" }],
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
  ["POST /api/messages/:id/retry", "Messages", "Retry a failed delivery, or send a message that was stored in test mode (`not_sent_test_mode`)"],
  ["POST /api/attachments", "Messages", "Upload an attachment (multipart `file`); returns an id to reference when sending", { status: 201 }],
  ["GET /api/templates", "Templates", "Reply templates"],
  ["POST /api/templates", "Templates", "Create a template", { body: S.TemplateBody, status: 201 }],
  ["PATCH /api/templates/:id", "Templates", "Edit a template", { body: S.TemplateBody.partial() }],
  ["DELETE /api/templates/:id", "Templates", "Delete a template", { status: 204 }],
  ["POST /api/templates/:id/render", "Templates", "Render a template for a contact or room", { body: S.TemplateRender }],

  // ---- tickets
  ["GET /api/tickets", "Tickets", "List tickets in your scope (a ticket follows the visibility of its conversation): filter by `status` (`live`, `all` or a comma list), `handler` (`bot`, `human`, `unassigned`, `me`, `bot:<id>`, `human:<id>`), `department_id`, `priority_min`, `contact_id`, `room_id`, `q` (number or subject); keyset paged", { query: S.TicketQuery }],
  ["GET /api/tickets/counts", "Tickets", "Live tickets per status in your scope", { returns: "`{new, bot_handling, waiting_for_human, open, pending_customer, resolved, closed, total_live}`" }],
  ["POST /api/tickets/bulk", "Tickets", "Resolve or close up to 100 tickets; each result is reported on its own", { body: S.TicketBulk }],
  ["GET /api/tickets/:id", "Tickets", "One ticket with its event timeline (opened, handed off, taken over, resolved, rated, merged)"],
  ["PATCH /api/tickets/:id", "Tickets", "Edit subject, priority, tags, summary, or set `open` / `pending_customer`", { body: S.TicketPatch }],
  ["POST /api/tickets/:id/resolve", "Tickets", "Resolve a ticket; the customer sees the closing message and a rating card (`tickets.closing_message`, `tickets.csat_prompt`)"],
  ["POST /api/tickets/:id/close", "Tickets", "Close a ticket (resolves it first when needed). The conversation itself stays open"],
  ["POST /api/tickets/:id/reopen", "Tickets", "Reopen a resolved ticket, or a closed one when the conversation has no live ticket"],
  ["POST /api/tickets/:id/merge", "Tickets", "Merge a duplicate into another ticket of the same conversation: its messages move over and it closes as `merged`", { body: S.TicketMerge }],
  ["GET /api/rooms/:id/tickets", "Tickets", "Every ticket of a conversation, newest first"],
  ["GET /api/contacts/:id/tickets", "Tickets", "Ticket history of a contact (the contact panel)"],

  ["POST /api/tickets/:id/claim", "Tickets", "Take a ticket that is waiting (in the queue, or assigned to nobody); the first claim wins (`409 TICKET_TAKEN`)"],
  ["POST /api/tickets/:id/transfer", "Tickets", "Move a ticket to another department: it is routed there by that department's mode, the room follows, and the team gets an internal note (the visitor is told too)", { body: S.TicketTransfer }],

  // ---- departments and routing
  ["GET /api/departments", "Departments", "Every inbox as a department: description, hours and holidays, routing mode, capacity, service levels, overflow, auto-replies, members with skills, languages and capacity, and live status (open, free people, queue)"],
  ["GET /api/department-status", "Departments", "Every department of the workspace with open or closed, free people, queue length and typical wait (names and counts only: the transfer menu and the queue overview)"],
  ["GET /api/departments/:id", "Departments", "One department with its configuration and status"],
  ["PATCH /api/departments/:id", "Departments", "Change a department's routing configuration (audited). `overflow_inbox_id` loops are refused (`OVERFLOW_LOOP`)", { body: depR.DepartmentPatchSchema }],
  ["GET /api/routing-rules", "Departments", "Routing rules in priority order"],
  ["POST /api/routing-rules", "Departments", "Create a rule: all conditions must hold, the first matching rule picks the department of a new conversation", { body: rulesR.RuleBodySchema, status: 201 }],
  ["PUT /api/routing-rules/order", "Departments", "Set the order (priority) of all rules", { body: depRoutes.RuleOrderBody }],
  ["POST /api/routing-rules/test", "Departments", "Sandbox: which department a conversation with this page address, language, channel, tags and attributes would go to, and which rules were evaluated", { body: depRoutes.RuleTestBody }],
  ["PATCH /api/routing-rules/:id", "Departments", "Edit a rule", { body: rulesR.RulePatchSchema }],
  ["DELETE /api/routing-rules/:id", "Departments", "Delete a rule", { status: 204 }],

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
  ["GET /api/channels/status", "Channels", "Per channel (`sms`, `email`): mode (`live` or `test`), whether a real provider is connected, provider, details and the last provider error. Never contains credentials", { returns: "`{sms, email, system_email}`" }],
  ["GET /api/channels/connections", "Channels", "The workspace's own Twilio (SMS) and SendGrid (email) connections: status, masked hints (last four characters), account facts and the webhook URLs to paste into the provider console. Credentials are never returned", { returns: "`{sms, email}`, each a connection or `null`" }],
  ["PUT /api/channels/sms/connection", "Channels", "Save the workspace's Twilio credentials (encrypted at rest). Sending stops until `verify` succeeds; the old credentials are replaced", { body: S.TwilioConnectBody }],
  ["PUT /api/channels/email/connection", "Channels", "Save the workspace's SendGrid API key (encrypted at rest), optionally the inbound domain and the event-webhook verification key", { body: S.SendGridConnectBody }],
  ["PATCH /api/channels/email/connection", "Channels", "Change the inbound domain and the event-webhook verification key without re-entering the API key", { body: S.EmailSettingsBody }],
  ["DELETE /api/channels/:channel/connection", "Channels", "Disconnect `sms` or `email`: the credentials are deleted; numbers and senders stay", { status: 204 }],
  ["POST /api/channels/:channel/verify", "Channels", "Read-only provider check (Twilio: fetch the account; SendGrid: key scopes, verified senders, authenticated domains). Provider problems answer 422/502 with a `CHANNEL_*` code and a fix-it message"],
  ["GET /api/channels/sms/numbers", "Channels", "Phone numbers on the connected Twilio account, with `imported` flags"],
  ["POST /api/channels/sms/numbers/import", "Channels", "Add numbers from the Twilio account to the workspace (only numbers Twilio lists for the account are accepted)", { body: S.ImportNumbersBody }],
  ["POST /api/channels/email/senders/import", "Channels", "Add the verified single senders of the SendGrid account as verified senders"],
  ["POST /api/channels/email/webhook-secret/rotate", "Channels", "Generate a new secret for the SendGrid webhook URLs (the old URLs stop working)"],
  ["POST /api/channels/:channel/test", "Channels", "Send a test text or email to `to` through the connected provider (10 per workspace per hour)", { body: S.TestSendBody }],
  ["GET /api/channels/:channel/events", "Channels", "The latest inbound provider events received for the channel and their outcome (\"Check webhook\")"],
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
  ["PATCH /api/tokens/:id", "Widget", "Switch the hosted full-page chat (`/chat`, for native web views and iframes) on or off for a token; audited", { body: S.TokenPatch }],
  ["GET /api/identity", "Widget", "Identity verification status: `{configured, enforce, rotated_at}` (never the secret)"],
  ["POST /api/identity/rotate", "Widget", "Create or replace the workspace's identity secret (`cvi_...`); returned once. Your backend signs `external_id|email` with it (docs/MOBILE-BRIDGE.md)", { status: 201 }],
  ["PATCH /api/identity", "Widget", "Turn enforcement on or off: when on, identity params without a valid hash are ignored and the visitor stays anonymous", { body: S.IdentityPatch }],
  ["POST /api/tokens/:id/rotate", "Widget", "Rotate an embed token"],
  ["POST /api/tokens/:id/preview", "Widget", "A signed, 10-minute link to a page that runs the real widget on the app's own origin for this token (\"Try it now\"); the domain check for real sites is untouched", { status: 201 }],
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
  ["PUT /api/analytics/identity-pepper", "Analytics", "Set (import) the identity pepper so two apps derive the same `contact_key` (alias of `PUT /api/v1/analytics/identity-pepper`)", { body: anR.PepperBody }],
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
  ["GET /api/v1/analytics/identity-pepper", "Analytics API", "The identity pepper and its fingerprint: a user session with `analytics_identity:manage` + `analytics:export`, or an API key with the scopes `analytics:export` + `analytics_identity:manage`"],
  ["PUT /api/v1/analytics/identity-pepper", "Analytics API", "Set (import) the identity pepper (session with `analytics_identity:manage` only; audited; bumps `version`)", { body: anR.PepperBody }],
  ["POST /api/v1/analytics/identity-pepper/rotate", "Analytics API", "Replace the pepper with a new random one (session with `analytics_identity:manage` only; audited)"],
  ["GET /api/v1/analytics/export/rooms", "Analytics API", "NDJSON export of rooms, keyset paged (`X-Next-Cursor`)", { query: anApiR.ExportQ, media: "application/x-ndjson" }],
  ["GET /api/v1/analytics/export/messages-meta", "Analytics API", "NDJSON export of message metadata, no content", { query: anApiR.ExportQ, media: "application/x-ndjson" }],

  // ---- public widget
  ["GET /public/widget/config", "Widget (public)", "Widget configuration for an embed token (`x-api-key`, `Origin`)"],
  ["POST /public/sessions", "Widget (public)", "Create a visitor session. With `external_id` + `identity_hash` the session is identified and verified (no code); see docs/MOBILE-BRIDGE.md", { body: S.SessionBody, status: 201 }],
  ["GET /public/session", "Widget (public)", "The current visitor session"],
  ["GET /public/rooms", "Widget (public)", "The visitor's conversations"],
  ["POST /public/rooms", "Widget (public)", "Start a conversation. Optional `department_id` (a department marked visible in the widget), `page_url` (origin and path are kept) and `locale`; without a department the first matching routing rule decides, then the widget default", { body: S.PublicRoomBody, status: 201 }],
  ["GET /public/rooms/:id/messages", "Widget (public)", "Messages of the visitor's conversation: no notes and only customer-facing system lines (conversation started, payments); `room` states the status and the close marker the rating prompt needs", { query: S.MessageListQuery }],
  ["POST /public/rooms/:id/messages", "Widget (public)", "Visitor sends a message", { body: S.VisitorSend, status: 201 }],
  ["DELETE /public/session", "Widget (public)", "End the visitor session (the host app's log-out); the session secret stops working at once", { status: 204 }],
  ["POST /public/session/attributes", "Widget (public)", "Attach up to 20 host-app attributes (plan, app version) to the contact, stored under `attrs.app`; visitor-supplied, so treat as untrusted", { body: S.SessionAttributes }],
  ["POST /public/attachments", "Widget (public)", "Upload a picture or PDF (multipart field `file`); returns an attachment id to pass in `attachment_ids` of a message", { status: 201 }],
  ["POST /public/rooms/:id/read", "Widget (public)", "Visitor read receipt", { body: S.ReadBody }],
  ["POST /public/rooms/:id/csat", "Widget (public)", "Satisfaction score after the conversation is closed", { body: pubR.Csat }],
  ["POST /public/rooms/:id/ticket-csat", "Widget (public)", "Rating (1 to 5) of the latest resolved ticket, once; `409 CSAT_NOT_AVAILABLE` when nothing is waiting for one", { body: S.TicketCsat }],
  ["POST /public/otp/send", "Widget (public)", "Send a one-time code to verify the visitor"],
  ["POST /public/otp/verify", "Widget (public)", "Verify the one-time code", { body: S.OtpVerify }],

  // ---- team chat
  ["GET /api/team/channels", "Team chat", "Channels, direct and group messages you belong to, with unread and mention counts computed from your read cursors", { returns: "`{data: Channel[]}`" }],
  ["GET /api/team/channels/browse", "Team chat", "Public channels you have not joined"],
  ["POST /api/team/channels", "Team chat", "Create a public or private channel (`team_chat:manage_channels`)", { body: S.TeamChannelCreate, status: 201 }],
  ["POST /api/team/dms", "Team chat", "Open (or reuse) the direct message with one person, yourself, or a group message with up to 7 others; the same people always give the same conversation", { body: S.TeamDmBody }],
  ["GET /api/team/channels/:id", "Team chat", "One channel with its members (404 for a private channel you are not in)"],
  ["PATCH /api/team/channels/:id", "Team chat", "Rename, set the topic or archive a channel (name and archive need `team_chat:manage_channels`; #general is protected)", { body: S.TeamChannelPatch }],
  ["POST /api/team/channels/:id/join", "Team chat", "Join a public channel"],
  ["POST /api/team/channels/:id/leave", "Team chat", "Leave a channel", { status: 204 }],
  ["POST /api/team/channels/:id/members", "Team chat", "Add people to a channel (managers, the channel owner, or any member of a public channel)", { body: S.TeamMembersBody }],
  ["DELETE /api/team/channels/:id/members/:memberId", "Team chat", "Remove someone from a channel (managers or the channel owner)", { status: 204 }],
  ["PUT /api/team/channels/:id/mute", "Team chat", "Mute or unmute a channel for yourself (mentions by name still notify)", { body: S.TeamMuteBody }],
  ["POST /api/team/channels/:id/read", "Team chat", "Move your read cursor to a message (default: the newest); it never moves back", { body: S.TeamReadBody }],
  ["GET /api/team/channels/:id/messages", "Team chat", "History page of top-level messages (keyset: `before` / `after` by per-channel seq)", { query: S.TeamListQuery }],
  ["POST /api/team/channels/:id/messages", "Team chat", "Send a message, a thread reply (`thread_root_id`), attachments, or share a customer conversation (`share_room_id`); idempotent on `client_msg_id`", { body: S.TeamSendBody, status: 201 }],
  ["GET /api/team/channels/:id/pins", "Team chat", "Pinned messages of a channel"],
  ["GET /api/team/messages/:id/thread", "Team chat", "A thread: the first message and its replies"],
  ["PATCH /api/team/messages/:id", "Team chat", "Edit your own message", { body: S.TeamEditBody }],
  ["DELETE /api/team/messages/:id", "Team chat", "Delete your own message (soft delete)", { status: 204 }],
  ["DELETE /api/team/channels/:id/messages/:messageId", "Team chat", "Moderation: delete another member's message in a channel you can access (`team_chat:moderate`, audited)", { status: 204 }],
  ["POST /api/team/messages/:id/reactions", "Team chat", "Toggle your emoji reaction on a message", { body: S.TeamReactionBody }],
  ["PUT /api/team/messages/:id/pin", "Team chat", "Pin a message"],
  ["DELETE /api/team/messages/:id/pin", "Team chat", "Unpin a message"],
  ["GET /api/team/search", "Team chat", "Search messages in your channels and public channels", { query: S.TeamSearchQuery }],
  ["POST /api/team/attachments", "Team chat", "Upload an attachment for a team message (same limits and checks as customer attachments); returns an id to reference when sending", { status: 201 }],

  // ---- webhooks and static
  ["POST /webhooks/stripe", "Webhooks", "Stripe platform events (signature `Stripe-Signature`); see docs/STRIPE.md"],
  ["POST /webhooks/stripe/connect", "Webhooks", "Stripe Connect events (signature `Stripe-Signature`)"],
  ["POST /webhooks/twilio/sms", "Webhooks", "Inbound SMS from Twilio (signature `X-Twilio-Signature`)", { media: "text/xml" }],
  ["POST /webhooks/twilio/status", "Webhooks", "SMS delivery status from Twilio", { status: 204 }],
  ["POST /webhooks/sendgrid/inbound", "Webhooks", "Inbound email from SendGrid Inbound Parse (shared secret)"],
  ["POST /webhooks/sendgrid/events", "Webhooks", "Email events (delivered, bounce, open) from SendGrid (signature)"],
  ["POST /webhooks/c/:id/twilio/sms", "Webhooks", "Inbound SMS for one workspace's Twilio account; `:id` is the connection's webhook id; verified with that workspace's auth token", { media: "text/xml" }],
  ["POST /webhooks/c/:id/twilio/status", "Webhooks", "SMS delivery status for one workspace's Twilio account (that workspace's signature)", { status: 204 }],
  ["POST /webhooks/c/:id/sendgrid/inbound", "Webhooks", "Inbound Parse for one workspace's SendGrid account (the connection's `secret` query parameter)"],
  ["POST /webhooks/c/:id/sendgrid/events", "Webhooks", "Event webhook for one workspace's SendGrid account (the connection's verification key, else its `secret`)"],
  ["GET /files/*", "Files", "Signed attachment download (`exp` and `sig` query parameters)", { media: "application/octet-stream" }],
  ["GET /widget.js", "Files", "The embeddable widget script", { media: "application/javascript" }],
  ["GET /chat", "Files", "The hosted full-page chat (`?token=cvt_...` plus optional `locale`, `theme`, and the page-side parameters in docs/MOBILE-BRIDGE.md). 403 unless the token has the hosted chat enabled; CSP `frame-ancestors` is limited to the token's domain", { media: "text/html" }],
  ["GET /chat/bridge-test", "Files", "Bridge conformance page: drives every host command and checks every page event against docs/bridge/*.schema.json", { media: "text/html" }],
  ["GET /chat/assets/:file", "Files", "Static assets of the hosted chat (chat.js, bridge.js, i18n.js, chat.css)", { media: "application/octet-stream" }],
  ["GET /widget-demo.html", "Files", "Pointer to the in-app widget preview (the old token-by-hand demo was replaced)", { media: "text/html" }],
  ["GET /runtime-config.json", "Files", "Public runtime settings for the web app (currently the browser Sentry DSN, or `sentry: null`). Served uncached so one build works in every environment", { media: "application/json" }],
  ["GET /widget-preview", "Files", "The in-app \"Try it now\" page: the real widget on the app's own origin, bound to one token by the signed `p` flag (10 minutes); 403 when the flag is invalid or expired", { media: "text/html" }],

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
  ["POST /admin/api/monitoring/test", "Platform admin", "Send one synthetic error to the configured Sentry project and wait for delivery; `{enabled:false}` when SENTRY_DSN is unset"],
  ["POST /admin/api/ratelimit/:kind", "Platform admin", "Add an expiring `allow` or `deny` entry", { body: adminR.ListEntry, status: 204 }],
  ["DELETE /admin/api/ratelimit/:kind/:entity", "Platform admin", "Remove an entry"],
  ["POST /admin/api/admins/:id/disable", "Platform admin", "Disable an operator", { status: 204 }],
  ["POST /admin/api/admins/:id/enable", "Platform admin", "Re-enable an operator", { status: 204 }],
];

export const API_META: ReadonlyMap<string, ApiMeta> = new Map(rows.map(([k, tag, summary, o]) => [k, { tag, summary, ...(o ?? {}) }]));
