# Migration notes: legacy "Support" conversations -> Conversations

Scope: only **generation A** (the "Support" inbox: live chat, SMS, email) was rebuilt. Out of scope, deliberately not ported:

- **Generation B** (internal team chat: `conversations.rooms/messages`, direct/channel rooms, reactions, reminders, favorites on messages). Backend-only in the legacy app and hidden in its UI. **Rebuilt cleanly since** as [team chat](TEAM-CHAT.md) (section 8 below lists what differs); nothing of the legacy collections was reused.
- **Generation C** (legacy channels/prospect/groups collections, the Socket.IO integration in the general socket). No frontend consumer; its collection names even collided with generation B.
- Platform couplings that do not belong in a standalone product: the multi-account agency/white-label hierarchy, CASL front-end rules, push (FCM/Expo), the OneBalance wallet, Reputation/Instasite/Instareport/payment-request cards, GIF-provider calls from the browser, Teamwork-chat abuse webhooks, the build-time copying of `shared/` into the socket service.

## 1. Collections -> tables

| Legacy | New | Notes |
| --- | --- | --- |
| `Conversation` (`conversations`, a per-user "team seat" - confusingly not a thread) | `members` (+ `users`) | seat flags: `live_seat`, `availability` (was `support_status`), `dnd_until`, `notification_prefs`, `inbox_visibility` |
| `User.scope[]`, `is_owner` | `members.role` (`owner/manager/agent`) + `inbox_visibility` | scope strings collapse into three roles plus one per-seat visibility switch |
| `Account` (+ `preferences.conversations.*`) | `workspaces` (+ `settings` JSON, `credit_balance`) | |
| `crm.contacts` (external CRM) | `contacts`, `contact_notes`, `contact_followers` | minimal built-in CRM; E.164 phones, dedupe indexes |
| `SupportConversation` (contact's identity in chat) | folded into `contacts` + `visitor_sessions` | no separate identity record |
| `SupportSessions` | `visitor_sessions` | adds hashed secret, `otp_*` columns, per-event workspace check |
| `SupportTokens` | `tokens` | one active token per domain per workspace (legacy: per domain globally) |
| `SupportInbox` | `inboxes`, `inbox_members` | `algorithm` `manual|round_robin`; member order is stored (`position`) |
| `SupportRoom` | `rooms`, `room_assignees`, `room_favorites`, `room_reads` | `unread_count[]` dropped (computed); `last_message_read[]` -> `room_reads`; `support_last_read` -> `rooms.visitor_read_seq`; `snooze_time` -> `snooze_until/snoozed_by`; `status active` -> `open`; `archived` kept as soft delete |
| `SupportMessage` | `messages`, `message_mentions` | see vocabulary below; `hr_time` -> per-room `seq`; `read_by[]` -> cursors; `delivered` -> `delivery` state machine |
| `SupportMessageLock` | `message_locks` | unique indexes make the lock a real constraint |
| `TwilioNumber` | `sms_numbers` | globally unique E.164 (inbound routing key) |
| (email sender / inbound config in account prefs) | `email_senders`, `inbound_addresses` | |
| `Communication`, `DND` | `messages` (provider ids, delivery) + `contacts.sms_opt_out` | no separate communication log |
| `OnebalanceQueue`, `verifyBalance` | `usage_ledger`, `workspaces.credit_balance`, `verifyBalance` | simple credits, unlimited by default |
| BullMQ queues + `*_in_progress` flags + node-cron polling | `jobs` table + in-process scheduler | idempotent passes, no flag fields |
| `Log` audit of every socket event | structured JSON logs | |
| Templates module | `templates` | merge fields `{{contact.first_name\|fallback}}` rendered server-side |
| (nothing) | `kb_entries`, `notifications`, `attachments`, `webhook_events` | new |

### Vocabulary

| Legacy | New |
| --- | --- |
| `sender_type: conversation` (agent) / `support` (contact or visitor) / `bot` | `sender_type: agent / contact / bot / system` |
| `message_type` image, voice, gif, note, ref, text, system, attachment | `kind` (same values) |
| `source` email, sms, dm | `source` (same) |
| `message_sub_type` name/participant/snooze/status/create | `meta.sub_type` on system messages (`assignee`, `status`, `snooze`, `snooze_ended`, `create`, `sms_consent`) |
| `::{USER}`, `::{CONTACT}` tokens rendered by the client | system messages store plain text plus structured `meta` |

## 2. REST endpoints

| Legacy (`/v1/conv/support/...`) | New |
| --- | --- |
| `POST/GET /token`, `POST /token/retract`, `DELETE /token/:id` | `GET/POST /api/tokens`, `POST /api/tokens/:id/rotate`, `DELETE /api/tokens/:id` |
| `GET/POST /inboxes`, `GET/PUT/DELETE /inboxes/:id`, `POST/DELETE /inboxes/:id/member` | `GET/POST /api/inboxes`, `GET/PATCH/DELETE /api/inboxes/:id`, `POST/DELETE /api/inboxes/:id/members/:memberId`, `GET /api/inboxes/counts` |
| `POST/GET/PUT /room`, `GET /room/:id`, `PUT /room/status`, `GET /room/get-room-id` | `POST/GET /api/rooms`, `GET/PATCH/DELETE /api/rooms/:id`, `GET /api/rooms?contact_id=` |
| `PUT /room/update-assignee` | `POST /api/rooms/:id/assign` |
| `PUT /room/snooze/:roomId` | `POST/DELETE /api/rooms/:id/snooze` |
| `GET /room/widget` | `GET /api/dashboard/counts` (adds `snoozed`) |
| `POST /message`, `GET /message?upperRef&lowerRef&search` | `POST/GET /api/rooms/:id/messages` (`before`/`after`), `GET /api/messages/search` |
| `DELETE|PUT /message/:id` (frontend called them, backend lacked them), `PUT /room/favorite/:id` (same) | `DELETE/PATCH /api/messages/:id`, `PUT/DELETE /api/rooms/:id/favorite` |
| `GET /v1/conv/`, `PUT /update-details`, `/update-status`, `/update-support-status`, `GET /associated` | `GET/PATCH /api/members/me`, `GET /api/members`, `GET /api/auth/me` |
| `/v1/users/me/config` (generic prefs) | `GET/PATCH /api/workspace`, `/api/members/me` |
| (templates module) | `/api/templates` |
| (CRM) | `/api/contacts` |
| widget: `POST /conversation`, `GET /conversation/config`, `POST/GET /conversation/room`, `POST /send-otp`, `POST /verify-otp`, `POST/GET /conversation/message`, header `x-support-session`, `x-origin` | `POST /public/sessions`, `GET /public/widget/config`, `GET/POST /public/rooms`, `POST /public/otp/send|verify`, `GET/POST /public/rooms/:id/messages`; headers `x-api-key`, `x-device-id`, `x-support-session`, browser `Origin` (legacy trusted a client-sent `x-origin`) |
| Twilio inbound / SendGrid inbound parse + event webhooks (separate external service) | `POST /webhooks/twilio/sms|status`, `POST /webhooks/sendgrid/inbound|events` (in-process, signed) |
| `POST /emit` (server-to-server socket injection, JWT) | none: services call the `RealtimeBus` interface directly |
| notification service `GET /run-service?type=...` | in-process jobs |

## 3. Socket events

Legacy namespace `/<accountId>` with `auth.session` -> `/ws/<workspaceId>` with `auth.token` (team JWT) or `auth.session` + `deviceId` (visitor), both verified against the namespace.

| Legacy | New |
| --- | --- |
| `support:newMessage` | `message:new` |
| `support:updatedMessage` (never emitted by the legacy server) | `message:updated` |
| (none) | `message:deleted` |
| `support:msgAck` | `message:receipt` (+ `room:unread` for the reader) |
| `support:newRoom` | `room:new` |
| `support:room:updated {type}` | `room:updated` |
| `support:room:deleted` | `room:deleted` |
| `support:newInbox`, `support:inboxUpdated` | `inbox:new`, `inbox:updated` (+ `GET /api/inboxes/counts`) |
| `actives` / `support:actives` / `support_actives` | `presence:update` (agents, refcounted), `visitor:presence` |
| `typing <roomId>` (no listener in the UI) | `typing` |
| `support:user:otpVerified` | `session:verified` |
| `support:user:removed` | `member:removed` + disconnect |
| `support:sendMessage`, `support:sendUserMessage` | `message:send` (team or visitor, with `client_msg_id`) |
| `support:message:ack` | `message:read` |
| `support:createRoom`, `support:createInternalRoom` | `room:create` |
| `support:room:update`, `support:room:updatePriority` | `room:update` |
| `support:room:updateAssignee` | `room:assign` |
| `support:user:verifyOTP` | `otp:verify` |
| `support:updateInbox`, `support:joinRooms`, `joinRoom`, `support:sendAwayNotification` | removed: counts via REST, joins are server-managed, away message is posted automatically |

## 4. Legacy defects deliberately not carried over

| Legacy behaviour | Now |
| --- | --- |
| no server-side idempotency on sends (client `qid` only) | unique `(room_id, client_msg_id)`; replays return the original; safe under concurrency |
| "one room per contact" enforced by a read-then-insert | partial unique index + upsert transaction; parallel creates converge |
| presence: closing one of several tabs marked the user offline; sets in Redis without refcount | refcounted per seat with a grace period |
| visitor session not checked against the namespace's account (cross-tenant gap) | session must belong to the namespace workspace; device-or-IP, expiry and token origin re-checked |
| socket handlers did not re-check scope per event | every event re-reads the seat and re-checks room scope; removed seats are disconnected |
| `snooze` wrote to the database before validating the time | validated first (future, <= 1 year, room open) |
| message search threw (`$and` undefined) | literal substring search, scope-aware |
| `waiting_longest` sort used a broken sub-lookup | computed from the first unanswered contact message |
| unread: stored counters (also buggy in generation B), unbounded read-ack that loaded every unread message | computed from per-seat cursors; mark-read is one upsert that only moves forward |
| failed provider send **deleted** the message | message kept as `failed` with the reason, automatic backoff retry for transient errors, manual retry endpoint |
| delivery status via 5 s polling cron + in-progress flags | provider status webhooks + periodic reconciliation; idempotent passes |
| notification stream required a MongoDB replica set; digest job returned early on an array check and never sent | in-app feed + offline emails + a digest with per-room cursors and per-seat dedupe that sends exactly once |
| round robin: unknown `last_assigned` -> `indexOf = -1` quirks | deterministic restart at the first eligible member, pointer advances in the same transaction; inactive seats skipped |
| realtime events were injected through an HTTP `/emit` endpoint guarded by service-minted bearer JWTs (the SendGrid webhook minted non-expiring ones) | no such endpoint; services call `RealtimeBus` in-process. Webhooks are verified by Twilio HMAC-SHA1 / SendGrid ECDSA or shared secret with timestamp tolerance, replay detection and idempotency |
| `autoHealAccount` referenced an undefined variable | no such path |
| frontend called message edit/delete and room favorite routes that did not exist | implemented |
| confusing `sender_type conversation/support` | `agent/contact/bot/system` |
| system messages with client-rendered placeholder tokens | plain text + structured meta |
| OTP: 5 digits, 2-minute expiry (kept); attempt limits, resend cooldown, single use and storage details are not described in the legacy analysis | 5 attempts, 30 s resend cooldown, single use, HMAC at rest, constant-time compare, bound to the session |
| `Origin` taken from a client-supplied `x-origin` header | the browser's real `Origin` header is matched (exact / wildcard / port) |
| all-origins CORS on the socket server | team sockets are bearer-token only; visitor sockets are origin-checked against the embed token |

## 5. Not carried over (product decisions)

Channels/prospect, message forwarding (legacy stub), help-center page, review-request/instasite/instareport cards (payment-request cards **are** now built, see section 7), GIF picker integration (a `gif` message can still carry an https URL), web/mobile push, contact-facing "unread reply" digest email, the legacy widget bot persona "Annie" (replaced by a neutral `Chatbot` and an explicit `AI Assistant`).

## 6a. Added after the first rebuild (phases 2 and 3)

| Legacy | Now |
| --- | --- |
| `User.scope[]` strings and CASL front-end rules | 38 permissions, four built-in roles plus custom roles, enforced in one place for REST and sockets ([RBAC.md](RBAC.md)); legacy `owner/manager/agent` map to Owner/Manager/Agent, and Viewer is new |
| single non-expiring-style sessions | 15-minute access tokens, rotating single-use refresh tokens, reuse detection, TOTP, password reset, email invitations, append-only audit log |
| `OnebalanceQueue` wallet | prepaid **credits** in `usage_ledger`, bought with Stripe Checkout, plus plans, auto-recharge and a failed-payment soft lock ([STRIPE.md](STRIPE.md)) |
| payment-request cards (platform payments) | payment requests paid on the workspace's **own** Stripe account through Connect Standard; the card is `message.meta.card` and updates live |
| multi-account agency / white-label hierarchy | not ported; replaced by a flat, platform-level operator console ([ADMIN.md](ADMIN.md)) |
| (no analytics API) | per-room metrics, dashboard and the versioned analytics API for the intelligence service ([ANALYTICS.md](ANALYTICS.md)) |
| single MongoDB instance | PostgreSQL partitioned by room and month, Redis, an outbox and event bus; the realtime and rate-limit design is in [SCALING.md](SCALING.md) and [RATE-LIMITING.md](RATE-LIMITING.md) |

## 6. Secrets hygiene

The legacy repository ships a `.env.sample` for the conversation socket service that contains a **committed MongoDB connection string with credentials**. It was not read into, copied into or referenced by this repository. **Treat that credential as exposed and rotate it**, then purge it from the legacy history. Conversations has no hard-coded credentials; `.env.example` contains only empty placeholders.

## 8. Team chat (legacy generation B) rebuilt: what differs

The legacy generation B shared the customer-conversation collections (`rooms` and `messages` with direct/channel room types) and had no frontend. The rebuild is a separate set of tables and a Team section in the app.

| Legacy generation B | Now |
| --- | --- |
| internal rooms and customer rooms in the same collections, told apart by a room type | separate tables (`team_channels`, `team_messages`, ...): customer conversations can never leak into team chat or the other way round, and the customer-room rules (one room per contact, scope by assignment) do not apply |
| membership by a `members` array on the room, checked in the client | `team_channel_members` rows, enforced by the server on every read, send, search and socket event; a private channel or a DM does not exist (404) for non-members |
| unread as stored counters | computed from each member's read cursor (`last_read_seq`), the same approach as customer threads |
| no idempotency | `client_msg_id` unique per channel |
| reactions as an array on the message | one row per (message, member, emoji); toggles are idempotent and capped at 20 kinds per message |
| reminders and favorites on messages | not rebuilt; pinned messages and per-channel mute instead |
| no permissions beyond "signed in" | `team_chat:use`, `team_chat:manage_channels`, `team_chat:moderate`; every REST route and socket event is declared, rate limited and tested |
| no #general, no threads, no search, no attachments | #general per workspace, one-level threads, search, attachments through the same upload pipeline and limits, shared customer-conversation cards that only people who may open the conversation can read |
| deletes removed the document | soft delete, purged after 30 days; per-workspace `team_retention_days` |

