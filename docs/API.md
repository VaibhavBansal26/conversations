# REST API

Base URL: `http://localhost:3000` in development (`PUBLIC_URL` in production). JSON in, JSON out, UTC ISO-8601 timestamps, opaque string ids. Machine-readable spec: [openapi.json](openapi.json) (OpenAPI 3.1, generated). Socket.IO protocol: [REALTIME.md](REALTIME.md). Platform operator API (`/admin/api`): [ADMIN.md](ADMIN.md). Analytics API (`/api/v1/analytics`, API keys): [ANALYTICS.md](ANALYTICS.md).

This page is generated from the code (`npm run docs:api` in `server/`); `docs:check` fails when it is stale or when a route has no entry. The examples below are exercised by `server/tests/docs.examples.test.ts`.

## Authentication

| Surface | Credential | How to get it |
| --- | --- | --- |
| Team API `/api/*` | `Authorization: Bearer <access token>` (15 minutes) | `POST /api/auth/login` or `/register`; renew with `POST /api/auth/refresh` (single-use refresh token, rotated) |
| Analytics API `/api/v1/analytics/*` | `Authorization: Bearer ca_live_...` | `POST /api/v1/api-keys` (permission `api_keys:manage`) |
| Widget `/public/*` | `x-api-key: cvt_...` embed token (bound to a domain) plus `x-support-session` after `POST /public/sessions` | Settings > Embed tokens |
| Webhooks `/webhooks/*` | provider signature (Twilio, SendGrid, Stripe) | configured in the provider |
| Platform console `/admin/api/*` | operator token (30 minutes, mandatory TOTP) | `POST /admin/api/login` then `/mfa/verify` |

What each route requires (a permission, "signed in", "public", "API key", "operator") is in the *Access* column of the reference; permissions are explained in [RBAC.md](RBAC.md). A route without a rule is refused (`403 NO_POLICY`).

```bash
BASE=http://localhost:3000

# 1. create a workspace (returns a session)
curl -s $BASE/api/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","password":"correct horse battery","workspace_name":"Acme"}'
# => {"token":"eyJ...","refresh_token":"...","expires_in":900,"user":{...},"member":{...},"workspace":{...}}

TOKEN=eyJ...   # the "token" above

# 2. create a contact and a conversation
curl -s $BASE/api/contacts -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Casey","email":"casey@example.test"}'
curl -s $BASE/api/rooms -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"contact_id":"<contact id>"}'
# => {"room":{"id":"...",...},"created":true}

# 3. send a chat message; the same client_msg_id sent twice stores ONE message
curl -s $BASE/api/rooms/<room id>/messages -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"text","source":"dm","content":"Hi Casey","client_msg_id":"7d1c5f4e-1111-4a6b-9c0e-000000000001"}'

# 4. read the history (keyset cursor, newest page first)
curl -s "$BASE/api/rooms/<room id>/messages?limit=30" -H "authorization: Bearer $TOKEN"
```

## Errors

Every error is `{"error": {"code": "...", "message": "...", "details"?: ...}}` with a matching HTTP status. `code` is stable and meant for programs; `message` is for people.

| Status | Typical codes |
| --- | --- |
| 400 | `VALIDATION_ERROR` (with `details: [{path, message}]`), `INVALID_JSON`, `INVALID_CURSOR` |
| 401 | `UNAUTHORIZED`, `INVALID_TOKEN`, `SESSION_REVOKED`, `INVALID_CREDENTIALS`, `WEBHOOK_SIGNATURE` |
| 402 | `INSUFFICIENT_CREDITS`, `ACCOUNT_LOCKED`, `SEAT_LIMIT` |
| 403 | `PERMISSION_DENIED` (with `details.permission`), `PRIVILEGE_ESCALATION`, `WORKSPACE_SUSPENDED`, `IMPERSONATION_READ_ONLY`, `NO_POLICY` |
| 404 | `NOT_FOUND` (also for another workspace's ids: existence is never confirmed across tenants) |
| 409 | `CONFLICT`-class codes such as `ALREADY_SUBSCRIBED`, `ROLE_IN_USE`, `NOT_OPEN` |
| 413 | `BODY_TOO_LARGE`, `FILE_TOO_LARGE` |
| 421 | `WRONG_REGION` (the workspace lives in another region; `details.region` says which) |
| 422 | semantic failures: `EMPTY_MESSAGE`, `CONTACT_PHONE_REQUIRED`, `SMS_TOO_LONG`, `INVALID_CODE` |
| 429 | `RATE_LIMITED` |
| 503 | `BILLING_NOT_CONFIGURED`, overload shedding, fail-closed limiter with the store down |
| 504 | `REQUEST_TIMEOUT` |

## Pagination

Lists use **keyset cursors**, never offsets: `?limit=<n>&cursor=<opaque>` returns `{data: [...], next_cursor | pagination: {...}}` and the next page is requested with the returned cursor. Message history uses `before` / `after` message ids. Cursors are opaque and stable under concurrent inserts. Exports (`/api/v1/analytics/export/*`) return NDJSON and an `X-Next-Cursor` header.

## Idempotency

Sending a message with the same `client_msg_id` in the same room is applied once; a repeat returns the stored message (`created: false`) even when two requests race. Webhooks are idempotent on provider ids (Stripe event ids, Twilio `MessageSid`). Platform credit adjustments accept an `Idempotency-Key` header.

## Rate limits

Every successful response on a limited route carries the standard `RateLimit-Policy` and `RateLimit` headers plus `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` for the tightest limit that applied. A `429` has `Retry-After` (seconds), and the body names the policy:

```json
{"error": {"code": "RATE_LIMITED", "message": "Too many requests", "policy": "api.write", "retry_after_s": 2}}
```

Clients should wait `Retry-After` plus jitter. The policy table (algorithms, limits per plan, fail-open or fail-closed) is [RATE-LIMITING.md](RATE-LIMITING.md); the last column of the reference lists the policies each route passes through.

## Versioning

The team API is unversioned and changes additively; the analytics API is `v1` (fields are only added, consumers ignore unknown fields, `GET /api/v1/analytics/schema` returns `schema_version`). Breaking changes are listed in [CHANGELOG.md](../CHANGELOG.md).

## Reference

<!-- Generated by `npm run docs:api` from server/src/apidoc/meta.ts, the authorisation table, the rate-limit table and the zod schemas. Do not edit below this line. -->

191 routes. The same content in machine-readable form: [openapi.json](openapi.json). Field types and limits are in the OpenAPI schemas; the policy ids are explained in [RATE-LIMITING.md](RATE-LIMITING.md).

### Auth

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `POST /api/auth/register` | Create a workspace and its owner; returns a session | public | body: `email*`, `password*`, `name*`, `workspace_name*` | `auth.register.ip` |
| `POST /api/auth/login` | Sign in; returns a session, or `{mfa_required, mfa_token}` when two-factor is on | public | body: `email*`, `password*`, `workspace_id` | `auth.login.ip` `auth.fail.account` `auth.fail.ip` |
| `POST /api/auth/refresh` | Exchange a refresh token for a new session (single use, rotated) | public | body: `refresh_token*` | `auth.refresh.ip` |
| `POST /api/auth/logout` | End the session of a refresh token | public |  | `auth.refresh.ip` |
| `POST /api/auth/mfa/verify` | Second step of a two-factor sign-in | public | body: `mfa_token*`, `code*` | `auth.mfa.ip` `auth.fail.mfa` |
| `POST /api/auth/password/forgot` | Email a password-reset link (answers the same whether or not the address exists) | public | body: `email*` | `auth.forgot.ip` `auth.forgot.email` |
| `POST /api/auth/password/reset` | Set a new password with a reset token (revokes all sessions) | public | body: `token*`, `password*` | `auth.reset.ip` |
| `GET /api/auth/invitations/:token` | Describe an invitation (workspace, role, inviter) | public |  | `auth.reset.ip` |
| `POST /api/auth/invitations/accept` | Accept an invitation and sign in | public | body: `token*`, `name`, `password*` | `auth.reset.ip` |
| `GET /api/auth/me` | The signed-in user, member, permissions and workspace (including `billing_access`) | signed in |  | `api.read` |
| `GET /api/auth/sessions` | Your active sessions | signed in |  | `api.read` |
| `DELETE /api/auth/sessions/:id` | Revoke one of your sessions | signed in |  | `api.write` |
| `POST /api/auth/password/change` | Change your password (revokes your other sessions) | signed in | body: `current_password*`, `new_password*` | `api.write` |
| `POST /api/auth/mfa/setup` | Start two-factor enrolment; returns the secret and `otpauth://` URL | signed in |  | `api.write` |
| `POST /api/auth/mfa/enable` | Confirm enrolment with a code; returns 10 single-use recovery codes | signed in | body: `code*` | `api.write` |
| `POST /api/auth/mfa/disable` | Turn two-factor off (needs password and a code) | signed in | body: `password*`, `code*` | `api.write` |

### Workspace

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/workspace` | The workspace: settings, credit balance, plan, `billing_access`, currency, `public_url` (what snippets and webhook URLs must contain) | `settings:read` |  | `api.read` |
| `PATCH /api/workspace` | Change the name and settings (widget, office hours, retention, AI flags, credits) | `settings:write` | body: `name`, `settings` (object) | `api.write` |
| `GET /api/credits` | Credit balance and recent ledger | `settings:read` |  | `api.read` |
| `POST /api/credits/grant` | Add credits by hand (owners; refused with `CREDIT_GRANT_DISABLED` when Stripe is configured) | `billing:manage` | body: `amount*` (integer), `note` | `api.write` |
| `GET /api/dashboard/counts` | Open/unread/assigned counts for the inbox sidebar | `conversations:read` |  | `api.read` |

### Team

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/members` | Team members | `members:read` |  | `api.read` |
| `POST /api/members` | Add a member with a temporary password | `members:manage` | body: `email*`, `name*`, `password`, `role` (manager\|agent), `live_seat` (boolean), `inbox_visibility` (assigned\|assigned_inbox) | `api.write` |
| `GET /api/members/me` | Your member record | signed in |  | `api.read` |
| `PATCH /api/members/me` | Edit your name, availability, do-not-disturb and notification preferences | signed in | body: `name`, `role` (owner\|manager\|agent), `live_seat` (boolean), `inbox_visibility` (assigned\|assigned_inbox), `availability` (active\|away\|inactive), `dnd_until`, `notification_prefs` (object) | `api.write` |
| `PATCH /api/members/:id` | Edit a member (role, seat and visibility need manager permissions) | signed in | body: `name`, `role` (owner\|manager\|agent), `live_seat` (boolean), `inbox_visibility` (assigned\|assigned_inbox), `availability` (active\|away\|inactive), `dnd_until`, `notification_prefs` (object) | `api.write` |
| `DELETE /api/members/:id` | Remove a member; their rooms are unassigned or re-routed | `members:manage` |  | `api.write` |
| `GET /api/presence` | Online member ids | `members:read` |  | `api.read` |

### Roles

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/roles` | Built-in and custom roles with their permissions | `members:read` |  | `api.read` |
| `POST /api/roles` | Create a custom role | `roles:manage` | body: `name*`, `description`, `base_role*` (manager\|agent), `permissions*` (array) | `api.write` |
| `PATCH /api/roles/:id` | Edit a custom role | `roles:manage` | body: `name`, `description`, `base_role` (manager\|agent), `permissions` (array) | `api.write` |
| `DELETE /api/roles/:id` | Delete an unused custom role | `roles:manage` |  | `api.write` |
| `PUT /api/members/:id/role` | Change a member's role | `roles:manage` | body: `role_id*` | `api.write` |
| `GET /api/invitations` | Pending invitations | `members:manage` |  | `api.read` |
| `POST /api/invitations` | Invite someone by email with a role (valid 7 days) | `members:manage` | body: `email*`, `name`, `role_id*` | `api.write` |
| `DELETE /api/invitations/:id` | Revoke an invitation | `members:manage` |  | `api.write` |

### Audit

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/audit` | Workspace audit log, newest first, keyset paged | `audit:read` | query: `limit` (integer), `cursor`, `action` | `api.read` |

### Notifications

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/notifications` | Your notifications and unread count | signed in |  | `api.read` |
| `POST /api/notifications/read-all` | Mark all your notifications read | signed in |  | `api.write` |
| `POST /api/notifications/:id/read` | Mark one notification read | signed in |  | `api.write` |

### Inboxes

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/inboxes` | Inboxes you can see | `conversations:read` |  | `api.read` |
| `GET /api/inboxes/counts` | Open conversation counts per inbox | `conversations:read` |  | `api.read` |
| `GET /api/inboxes/:id` | One inbox with its members | `conversations:read` |  | `api.read` |
| `POST /api/inboxes` | Create an inbox | `inboxes:manage` | body: `name*`, `icon`, `algorithm` (manual\|round_robin), `live_routing_visibility` (boolean), `default_email_inbound` (boolean), `default_sms_inbound` (boolean), `member_ids` (array) | `api.write` |
| `PATCH /api/inboxes/:id` | Edit an inbox (routing, office hours) | `inboxes:manage` | body: `name`, `icon`, `algorithm` (manual\|round_robin), `live_routing_visibility` (boolean), `default_email_inbound` (boolean), `default_sms_inbound` (boolean), `member_ids` (array) | `api.write` |
| `DELETE /api/inboxes/:id` | Delete an inbox | `inboxes:manage` |  | `api.write` |
| `POST /api/inboxes/:id/members/:memberId` | Add a member to an inbox | `inboxes:manage` |  | `api.write` |
| `DELETE /api/inboxes/:id/members/:memberId` | Remove a member from an inbox | `inboxes:manage` |  | `api.write` |

### Conversations

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/rooms` | List conversations (filters, sort, keyset cursor) | `conversations:read` | query: `page` (integer), `limit` (integer), `status` (open\|closed\|snoozed\|all), `filter` (all\|assigned_to_me\|unassigned\|mentions\|priority\|favorites), `inbox_id`, `contact_id`, `search`, `sort` (newest\|oldest\|waiting_longest\|priority_first), `cursor`, `unassigned` (0\|1\|true\|false), `mentions` (0\|1\|true\|false), `priority` (0\|1\|true\|false), `assigned_to_me` (0\|1\|true\|false) | `api.read` |
| `POST /api/rooms` | Start a conversation with a contact | `conversations:reply` | body: `contact_id`, `contact` (object), `inbox_id`, `subject`, `message` (object) | `api.write` |
| `POST /api/rooms/bulk` | Close, reopen, assign, prioritise or tag many conversations | `conversations:reply` | body: `room_ids*` (array), `action*` (close\|reopen\|assign\|priority\|tag), `member_ids` (array), `priority`, `tags` (array) | `api.write` |
| `GET /api/rooms/:id` | One conversation | `conversations:read` |  | `api.read` |
| `PATCH /api/rooms/:id` | Change status, priority, subject, inbox | `conversations:reply` | body: `status` (open\|closed), `priority`, `subject`, `snooze_until` | `api.write` |
| `DELETE /api/rooms/:id` | Archive a conversation | `conversations:delete` |  | `api.write` |
| `POST /api/rooms/:id/assign` | Assign to members, to an inbox, or round-robin | `conversations:reply` | body: `member_ids` (array), `inbox_id`, `auto` (boolean) | `api.write` |
| `POST /api/rooms/:id/snooze` | Snooze until a time | `conversations:reply` | body: `until*` | `api.write` |
| `DELETE /api/rooms/:id/snooze` | Wake a snoozed conversation | `conversations:reply` |  | `api.write` |
| `PUT /api/rooms/:id/favorite` | Star a conversation for yourself | `conversations:read` |  | `api.write` |
| `DELETE /api/rooms/:id/favorite` | Remove your star | `conversations:read` |  | `api.write` |
| `POST /api/rooms/:id/read` | Mark read up to a message | `conversations:read` | body: `message_id*` | `api.write` |

### Messages

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/rooms/:id/messages` | History page (keyset: `before` / `after`) | `conversations:read` | query: `before`, `after`, `limit` (integer) | `api.read` |
| `POST /api/rooms/:id/messages` | Send a message or note on chat, SMS or email (idempotent on `client_msg_id`) | `conversations:reply` | body: `kind` (text\|image\|voice\|gif\|attachment\|ref\|note), `source` (dm\|sms\|email), `content`, `format` (text\|html), `subject`, `from`, `ref_message_id`, `attachment_ids` (array), `client_msg_id` | `api.send` `msg.room` `msg.workspace` `sms.workspace` `email.workspace` `sms.contact` `sms.number` `email.sender` |
| `GET /api/messages/search` | Search message text you can see | `conversations:read` | query: `q*`, `room_id`, `limit` (integer) | `api.read` |
| `PATCH /api/messages/:id` | Edit your message inside the edit window | `conversations:reply` | body: `content*`, `format` (text\|html) | `api.write` |
| `DELETE /api/messages/:id` | Delete a message (soft delete) | `conversations:reply` |  | `api.write` |
| `POST /api/messages/:id/retry` | Retry a failed delivery, or send a message that was stored in test mode (`not_sent_test_mode`) | `conversations:reply` |  | `api.write` |
| `POST /api/attachments` | Upload an attachment (multipart `file`); returns an id to reference when sending | `conversations:reply` |  | `api.upload` |

### Templates

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/templates` | Reply templates | `conversations:read` |  | `api.read` |
| `POST /api/templates` | Create a template | `templates:manage` | body: `name*`, `channel` (any\|email\|sms\|dm), `subject`, `body*`, `shortcut` | `api.write` |
| `PATCH /api/templates/:id` | Edit a template | `templates:manage` | body: `name`, `channel` (any\|email\|sms\|dm), `subject`, `body`, `shortcut` | `api.write` |
| `DELETE /api/templates/:id` | Delete a template | `templates:manage` |  | `api.write` |
| `POST /api/templates/:id/render` | Render a template for a contact or room | `conversations:reply` | body: `contact_id`, `room_id`, `format` (text\|html) | `api.write` |

### Contacts

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/contacts` | List contacts (search, keyset cursor) | `contacts:read` |  | `api.read` |
| `POST /api/contacts` | Create a contact | `contacts:write` | body: `name`, `email`, `phone`, `attrs` (object), `tags` (array) | `api.write` |
| `GET /api/contacts/:id` | One contact | `contacts:read` |  | `api.read` |
| `PATCH /api/contacts/:id` | Edit a contact | `contacts:write` | body: `name`, `email`, `phone`, `attrs` (object), `tags` (array), `sms_opt_out` (boolean), `unsubscribed` (boolean) | `api.write` |
| `DELETE /api/contacts/:id` | Delete a contact and its conversations (GDPR) | `contacts:delete` |  | `api.write` |
| `GET /api/contacts/:id/notes` | Notes on a contact | `contacts:read` |  | `api.read` |
| `POST /api/contacts/:id/notes` | Add a note | `contacts:write` |  | `api.write` |
| `DELETE /api/contacts/:id/notes/:noteId` | Delete a note | `contacts:write` |  | `api.write` |
| `GET /api/contacts/:id/rooms` | Conversations of a contact | `contacts:read` |  | `api.read` |
| `POST /api/contacts/import` | Import contacts from CSV (multipart `file`, max 5 MB) | `contacts:import` |  | `api.import` `heavy.concurrency` |

### Channels

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/channels/status` | Per channel (`sms`, `email`): mode (`live` or `test`), whether a real provider is connected, provider, details and the last provider error. Never contains credentials | `conversations:read` |  | `api.read` |
| `GET /api/channels/connections` | The workspace's own Twilio (SMS) and SendGrid (email) connections: status, masked hints (last four characters), account facts and the webhook URLs to paste into the provider console. Credentials are never returned | `channels:manage` |  | `api.read` |
| `PUT /api/channels/sms/connection` | Save the workspace's Twilio credentials (encrypted at rest). Sending stops until `verify` succeeds; the old credentials are replaced | `channels:manage` | body: `account_sid*`, `auth_token*`, `api_key_sid`, `api_key_secret` | `api.write` |
| `PUT /api/channels/email/connection` | Save the workspace's SendGrid API key (encrypted at rest), optionally the inbound domain and the event-webhook verification key | `channels:manage` | body: `api_key*`, `inbound_domain`, `event_public_key` | `api.write` |
| `PATCH /api/channels/email/connection` | Change the inbound domain and the event-webhook verification key without re-entering the API key | `channels:manage` | body: `inbound_domain`, `event_public_key` | `api.write` |
| `DELETE /api/channels/:channel/connection` | Disconnect `sms` or `email`: the credentials are deleted; numbers and senders stay | `channels:manage` |  | `api.write` |
| `POST /api/channels/:channel/verify` | Read-only provider check (Twilio: fetch the account; SendGrid: key scopes, verified senders, authenticated domains). Provider problems answer 422/502 with a `CHANNEL_*` code and a fix-it message | `channels:manage` |  | `api.write` `channels.verify` |
| `GET /api/channels/sms/numbers` | Phone numbers on the connected Twilio account, with `imported` flags | `channels:manage` |  | `api.read` |
| `POST /api/channels/sms/numbers/import` | Add numbers from the Twilio account to the workspace (only numbers Twilio lists for the account are accepted) | `channels:manage` | body: `e164s*` (array) | `api.write` `channels.verify` |
| `POST /api/channels/email/senders/import` | Add the verified single senders of the SendGrid account as verified senders | `channels:manage` |  | `api.write` `channels.verify` |
| `POST /api/channels/email/webhook-secret/rotate` | Generate a new secret for the SendGrid webhook URLs (the old URLs stop working) | `channels:manage` |  | `api.write` |
| `POST /api/channels/:channel/test` | Send a test text or email to `to` through the connected provider (10 per workspace per hour) | `channels:manage` | body: `to*` | `api.write` `channels.test` |
| `GET /api/channels/:channel/events` | The latest inbound provider events received for the channel and their outcome ("Check webhook") | `channels:manage` |  | `api.read` |
| `GET /api/sms-numbers` | SMS numbers | `settings:read` |  | `api.read` |
| `POST /api/sms-numbers` | Register an SMS number | `channels:manage` | body: `e164*`, `label`, `is_default` (boolean) | `api.write` |
| `POST /api/sms-numbers/:id/default` | Make a number the default | `channels:manage` |  | `api.write` |
| `DELETE /api/sms-numbers/:id` | Remove a number | `channels:manage` |  | `api.write` |
| `GET /api/email-senders` | Email sender addresses | `settings:read` |  | `api.read` |
| `POST /api/email-senders` | Add a sender address | `channels:manage` | body: `address*`, `display_name`, `verified` (boolean), `is_default` (boolean) | `api.write` |
| `PATCH /api/email-senders/:id` | Edit a sender | `channels:manage` | body: `display_name`, `verified` (boolean), `is_default` (boolean) | `api.write` |
| `DELETE /api/email-senders/:id` | Remove a sender | `channels:manage` |  | `api.write` |
| `GET /api/inbound-addresses` | Inbound email addresses | `settings:read` |  | `api.read` |
| `POST /api/inbound-addresses` | Add an inbound address | `channels:manage` | body: `address*` | `api.write` |
| `DELETE /api/inbound-addresses/:address` | Remove an inbound address | `channels:manage` |  | `api.write` |

### Widget

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/tokens` | Widget embed tokens | `tokens:manage` |  | `api.read` |
| `POST /api/tokens` | Create an embed token bound to a domain | `tokens:manage` | body: `domain*` | `api.write` |
| `POST /api/tokens/:id/rotate` | Rotate an embed token | `tokens:manage` |  | `api.write` |
| `POST /api/tokens/:id/preview` | A signed, 10-minute link to a page that runs the real widget on the app's own origin for this token ("Try it now"); the domain check for real sites is untouched | `tokens:manage` |  | `api.write` |
| `DELETE /api/tokens/:id` | Revoke an embed token | `tokens:manage` |  | `api.write` |

### AI

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/kb` | Knowledge-base entries | `kb:manage` |  | `api.read` |
| `POST /api/kb` | Add an entry | `kb:manage` | body: `question*`, `answer*` | `api.write` |
| `PUT /api/kb/:id` | Replace an entry | `kb:manage` | body: `question*`, `answer*` | `api.write` |
| `DELETE /api/kb/:id` | Delete an entry | `kb:manage` |  | `api.write` |
| `GET /api/ai/status` | Which AI provider is active | signed in |  | `api.read` |
| `POST /api/ai/suggest-replies` | Suggest replies for a conversation | `ai:use` | body: `room_id*` | `ai.minute` `ai.workspace` `ai.concurrency` |
| `POST /api/ai/summary` | Summarise a conversation | `ai:use` | body: `room_id*` | `ai.minute` `ai.workspace` `ai.concurrency` |
| `POST /api/ai/rephrase` | Rewrite a draft in a tone | `ai:use` | body: `text*`, `mode` (improve\|fix_grammar\|shorten\|friendly\|professional\|empathetic), `room_id` | `ai.minute` `ai.workspace` `ai.concurrency` |

### Analytics

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/analytics/overview` | Dashboard overview (same definitions as the API) | `analytics:read` | query: `from`, `to`, `tz`, `interval` | `api.read` |
| `GET /api/analytics/timeseries` | Dashboard time series | `analytics:read` | query: `from`, `to`, `tz`, `interval`, `metric*` | `api.read` |
| `GET /api/analytics/identity-pepper` | View the workspace identity pepper | `analytics_identity:manage` |  | `api.read` |
| `PUT /api/analytics/identity-pepper` | Set (import) the identity pepper so two apps derive the same `contact_key` (alias of `PUT /api/v1/analytics/identity-pepper`) | `analytics_identity:manage` | body: `pepper*`, `confirm` | `api.write` |
| `POST /api/analytics/identity-pepper/rotate` | Rotate the identity pepper (changes every `contact_key`) | `analytics_identity:manage` |  | `api.write` |

### API keys

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/v1/api-keys` | List API keys (never the secret) | `api_keys:manage` |  | `api.read` |
| `POST /api/v1/api-keys` | Create an API key; the plaintext is returned once | `api_keys:manage` | body: `name*`, `scopes*` (array), `ip_allowlist` (array), `expires_at` | `api.write` |
| `DELETE /api/v1/api-keys/:id` | Revoke an API key | `api_keys:manage` |  | `api.write` |

### Billing

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/billing` | Plan, seats, credits, saved card (brand and last four), automation, Connect state | `billing:manage` |  | `api.read` |
| `POST /api/billing/checkout/subscription` | Start Stripe Checkout for a plan; returns `{url}` | `billing:manage` | body: `plan*` | `billing.checkout` |
| `POST /api/billing/checkout/topup` | Start Stripe Checkout for a credit pack or amount; returns `{url, credits, amount_cents}` | `billing:manage` | body: `pack`, `credits` (integer) | `billing.checkout` |
| `POST /api/billing/portal` | Open the Stripe customer portal; returns `{url}` | `billing:manage` |  | `billing.checkout` |
| `PATCH /api/billing/automation` | Low-balance alert and auto-recharge settings | `billing:manage` | body: `auto_recharge_enabled` (boolean), `auto_recharge_threshold` (integer), `auto_recharge_credits` (integer), `low_balance_threshold` (integer) | `api.write` |
| `POST /api/billing/connect/onboard` | Start or resume Stripe Connect onboarding; returns `{url}` | `billing:manage` |  | `billing.checkout` |
| `POST /api/billing/connect/refresh` | Ask Stripe whether the connected account can take payments | `billing:manage` |  | `billing.checkout` |

### Payments

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/rooms/:id/payment-requests` | Payment requests of a conversation | `conversations:read` |  | `api.read` |
| `POST /api/rooms/:id/payment-requests` | Ask the customer to pay; sends a payment card on the chosen channel | `payments:request` | body: `amount*` (integer), `currency`, `description*`, `source` (dm\|sms\|email), `expires_in_hours` (integer), `client_msg_id` | `api.write` `payments.workspace` |
| `POST /api/payment-requests/:id/cancel` | Cancel an open payment request | `payments:request` |  | `api.write` |

### Analytics API

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /api/v1/analytics/overview` | Overview for a range (API key, `analytics:read`) | API key | query: `from`, `to`, `tz`, `interval` | `analytics.read` `analytics.workspace` |
| `GET /api/v1/analytics/timeseries` | Zero-filled time series (API key, `analytics:read`) | API key | query: `from`, `to`, `tz`, `interval`, `metric*` | `analytics.read` `analytics.workspace` |
| `GET /api/v1/analytics/schema` | The JSON Schemas and `schema_version` | API key |  | `analytics.read` `analytics.workspace` |
| `GET /api/v1/analytics/identity-pepper` | The identity pepper and its fingerprint: a user session with `analytics_identity:manage` + `analytics:export`, or an API key with the scopes `analytics:export` + `analytics_identity:manage` | API key |  | `analytics.read` `analytics.workspace` |
| `PUT /api/v1/analytics/identity-pepper` | Set (import) the identity pepper (session with `analytics_identity:manage` only; audited; bumps `version`) | API key | body: `pepper*`, `confirm` | `api.write` |
| `POST /api/v1/analytics/identity-pepper/rotate` | Replace the pepper with a new random one (session with `analytics_identity:manage` only; audited) | API key |  | `api.write` |
| `GET /api/v1/analytics/export/rooms` | NDJSON export of rooms, keyset paged (`X-Next-Cursor`) | API key | query: `from`, `to`, `tz`, `interval`, `limit` (integer), `cursor` | `analytics.export` `analytics.workspace` `analytics.concurrency` |
| `GET /api/v1/analytics/export/messages-meta` | NDJSON export of message metadata, no content | API key | query: `from`, `to`, `tz`, `interval`, `limit` (integer), `cursor` | `analytics.export` `analytics.workspace` `analytics.concurrency` |

### Widget (public)

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /public/widget/config` | Widget configuration for an embed token (`x-api-key`, `Origin`) | public |  | `public.config` |
| `POST /public/sessions` | Create a visitor session | public | body: `name`, `email`, `phone` | `public.session` |
| `GET /public/session` | The current visitor session | public |  | `public.query` |
| `GET /public/rooms` | The visitor's conversations | public |  | `public.query` |
| `POST /public/rooms` | Start a conversation | public |  | `public.room` |
| `GET /public/rooms/:id/messages` | Messages of the visitor's conversation: no notes and only customer-facing system lines (conversation started, payments); `room` states the status and the close marker the rating prompt needs | public | query: `before`, `after`, `limit` (integer) | `public.query` |
| `POST /public/rooms/:id/messages` | Visitor sends a message | public | body: `content*`, `client_msg_id` | `public.send` `msg.room` `msg.workspace` |
| `POST /public/rooms/:id/read` | Visitor read receipt | public | body: `message_id*` | `public.read` |
| `POST /public/rooms/:id/csat` | Satisfaction score after the conversation is closed | public | body: `score*` (integer), `comment` | `public.read` |
| `POST /public/otp/send` | Send a one-time code to verify the visitor | public |  | `public.otp.send` `public.otp.contact` `public.otp.ip` |
| `POST /public/otp/verify` | Verify the one-time code | public | body: `code*` | `public.otp.verify` |

### Webhooks

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `POST /webhooks/stripe` | Stripe platform events (signature `Stripe-Signature`); see docs/STRIPE.md | public |  | `webhook.stripe` `webhook.badsig` |
| `POST /webhooks/stripe/connect` | Stripe Connect events (signature `Stripe-Signature`) | public |  | `webhook.stripe` `webhook.badsig` |
| `POST /webhooks/twilio/sms` | Inbound SMS from Twilio (signature `X-Twilio-Signature`) | public |  | `webhook.provider` `webhook.badsig` |
| `POST /webhooks/twilio/status` | SMS delivery status from Twilio | public |  | `webhook.provider` `webhook.badsig` |
| `POST /webhooks/sendgrid/inbound` | Inbound email from SendGrid Inbound Parse (shared secret) | public |  | `webhook.provider` `webhook.badsig` |
| `POST /webhooks/sendgrid/events` | Email events (delivered, bounce, open) from SendGrid (signature) | public |  | `webhook.provider` `webhook.badsig` |
| `POST /webhooks/c/:id/twilio/sms` | Inbound SMS for one workspace's Twilio account; `:id` is the connection's webhook id; verified with that workspace's auth token | public |  | `webhook.provider` `webhook.connection` `webhook.badsig` |
| `POST /webhooks/c/:id/twilio/status` | SMS delivery status for one workspace's Twilio account (that workspace's signature) | public |  | `webhook.provider` `webhook.connection` `webhook.badsig` |
| `POST /webhooks/c/:id/sendgrid/inbound` | Inbound Parse for one workspace's SendGrid account (the connection's `secret` query parameter) | public |  | `webhook.provider` `webhook.connection` `webhook.badsig` |
| `POST /webhooks/c/:id/sendgrid/events` | Event webhook for one workspace's SendGrid account (the connection's verification key, else its `secret`) | public |  | `webhook.provider` `webhook.connection` `webhook.badsig` |

### Files

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `GET /files/*` | Signed attachment download (`exp` and `sig` query parameters) | public |  |  |
| `GET /widget.js` | The embeddable widget script | public |  |  |
| `GET /widget-demo.html` | Pointer to the in-app widget preview (the old token-by-hand demo was replaced) | public |  |  |
| `GET /widget-preview` | The in-app "Try it now" page: the real widget on the app's own origin, bound to one token by the signed `p` flag (10 minutes); 403 when the flag is invalid or expired | public |  |  |

### Platform admin

| Route | What it does | Access | Request (`*` = required) | Rate-limit policies |
| --- | --- | --- | --- | --- |
| `POST /admin/api/login` | Password step of an operator sign-in; returns `{mfa_required | mfa_setup_required, mfa_token}` | operator | body: `email*`, `password*` | `admin.login.ip` `admin.fail.account` `admin.fail.ip` `admin.fail.mfa` |
| `POST /admin/api/mfa/setup` | Start authenticator enrolment with the step token | operator | body: `mfa_token*` | `admin.login.ip` `admin.fail.account` `admin.fail.ip` `admin.fail.mfa` |
| `POST /admin/api/mfa/enable` | Confirm enrolment with a code; returns the 30-minute admin token | operator | body: `mfa_token*`, `code*` | `admin.login.ip` `admin.fail.account` `admin.fail.ip` `admin.fail.mfa` |
| `POST /admin/api/mfa/verify` | Second step for enrolled operators; returns the admin token | operator | body: `mfa_token*`, `code*` | `admin.login.ip` `admin.fail.account` `admin.fail.ip` `admin.fail.mfa` |
| `GET /admin/api/me` | The signed-in operator | operator |  | `admin.api` |
| `GET /admin/api/stats` | Installation-wide counts | operator |  | `admin.api` |
| `GET /admin/api/workspaces` | Workspace directory (search, plan, suspended, keyset cursor) | operator | query: `search`, `plan`, `suspended` (true\|false), `limit` (integer), `cursor` | `admin.api` |
| `GET /admin/api/workspaces/:id` | Workspace detail: plan, billing state, seats, usage, members, ledger, audit (no content) | operator |  | `admin.api` |
| `GET /admin/api/audit` | Platform-wide audit log | operator | query: `workspace_id`, `action`, `actor_type`, `limit` (integer), `cursor` | `admin.api` |
| `GET /admin/api/ratelimit` | Allow and deny lists and recently limited keys | operator |  | `admin.api` |
| `GET /admin/api/admins` | Operators | operator |  | `admin.api` |
| `POST /admin/api/workspaces/:id/impersonate` | Mint a 15-minute read-only support token (reason required) | operator | body: `reason`, `member_id` | `admin.api` |
| `POST /admin/api/workspaces/:id/suspend` | Suspend a workspace (reason required) | operator | body: `reason` | `admin.api` |
| `POST /admin/api/workspaces/:id/unsuspend` | Lift a suspension | operator | body: `reason` | `admin.api` |
| `POST /admin/api/workspaces/:id/credits` | Add or remove credits (reason required; `Idempotency-Key` supported) | operator | body: `amount*` (integer), `note` | `admin.api` |
| `PUT /admin/api/workspaces/:id/tier` | Override the rate-limit tier or clear it | operator | body: `tier*`, `note` | `admin.api` |
| `PUT /admin/api/workspaces/:id/region` | Set or clear the workspace's home region (multi-region routing key) | operator | body: `region*` | `admin.api` |
| `POST /admin/api/ratelimit/:kind` | Add an expiring `allow` or `deny` entry | operator | body: `entity*`, `ttl_seconds*` (integer), `note` | `admin.api` |
| `DELETE /admin/api/ratelimit/:kind/:entity` | Remove an entry | operator |  | `admin.api` |
| `POST /admin/api/admins/:id/disable` | Disable an operator | operator |  | `admin.api` |
| `POST /admin/api/admins/:id/enable` | Re-enable an operator | operator |  | `admin.api` |
