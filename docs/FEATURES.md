# Features

One entry per feature, end to end: what a person does, what the server does, where it is configured, who may use it, where it is documented and tested, and what has never been run against a real service. Screens and their controls are in [USER-GUIDE.md](USER-GUIDE.md); modules, jobs, events and tables are in [FUNCTIONS.md](FUNCTIONS.md); the short list of what was checked against real services is [VERIFICATION.md](VERIFICATION.md).

Each entry uses the same fields:

- **Flow**: what happens, from the person's action to what the other side sees.
- **Configure**: the setting (with its default) or environment variable.
- **Permission**: the permission the server checks (see [RBAC.md](RBAC.md)).
- **Docs / tests**: the detailed document and the main test files (`server/tests/`, `web/src/**.test.tsx`, `e2e/tests/`).
- **Not verified**: what was never exercised against the real thing.

Status words: **built** (code, UI and tests exist), **test-only** (built, but every test uses a fake or mocked provider), **not built** (designed or mentioned, no code).

## Contents

- [Customer conversations](#customer-conversations)
- [Contacts](#contacts)
- [Tickets, departments and routing](#tickets-departments-and-routing)
- [AI](#ai)
- [Visitor-facing chat](#visitor-facing-chat)
- [Calls](#calls)
- [Team chat](#team-chat)
- [Notifications](#notifications)
- [Money](#money)
- [Analytics](#analytics)
- [Access and security](#access-and-security)
- [Operating it](#operating-it)
- [Not built](#not-built)

## Customer conversations

### Unified inbox (live chat, SMS, email)

- **Flow**: a contact writes from the widget, the hosted chat, an SMS or an email. The message lands in their one conversation (a *room*, one live room per contact), is stored with a per-room sequence number, written to the outbox in the same transaction and pushed to the team over the socket (`message:new`). An agent replies from the composer, choosing Chat, SMS, Email or Note; SMS and email go out through the delivery pipeline (paced, retried, receipts by webhook).
- **Configure**: inboxes (Settings > Inboxes), SMS numbers, email senders and inbound addresses (Settings > SMS & email).
- **Permission**: `conversations:read` to read, `conversations:reply` to write.
- **Docs / tests**: [CHANNELS.md](CHANNELS.md), [REALTIME.md](REALTIME.md); `rooms.test.ts`, `messages.test.ts`, `channels.test.ts`, `webhooks.test.ts`, `e2e/tests/02-inbox.spec.ts`.
- **Status**: built. Real SMS and email are test-only (see [Channels you connect](#channels-you-connect-twilio-sendgrid)).

### Assignment, snooze, priority, favourites, notes and mentions

- **Flow**: the header menu assigns to people (or round robin), snoozes until a time (a `wake_room` job wakes it, with a 60 s sweep as a safety net), toggles priority and favourite. A note is an internal message the visitor never receives; `@name` in a note creates a mention notification.
- **Configure**: inbox assignment mode; per-agent visibility under Members ("Only assigned" or "Their inboxes").
- **Permission**: `conversations:reply`.
- **Docs / tests**: [USER-GUIDE.md](USER-GUIDE.md#conversation-header); `rooms.test.ts`, `notifications.test.ts`.
- **Status**: built.

### Composer extras

- **Flow**: `/` inserts a reply template (merge fields `{{contact.first_name}}` and others), attachments are uploaded and content-sniffed, voice notes are recorded in the browser, emoji, AI rewrite. Messages can be edited within the edit window and deleted. Receipts (sent, delivered, read) and typing indicators flow both ways.
- **Configure**: templates (Settings > Templates, `templates:manage`), edit window (Settings > General, default 900 s).
- **Docs / tests**: `templates.test.ts`, `attachments.test.ts`, `messages.test.ts`, web composer tests.
- **Status**: built.

### Channels you connect (Twilio, SendGrid)

- **Flow**: a workspace pastes its own Twilio and SendGrid credentials; they are verified, encrypted with `DATA_ENCRYPTION_KEY` and never shown again. Inbound webhooks are signature-checked and deduplicated. Without a connection a channel is in **test mode**: messages are saved, marked "Test mode: not sent", and nothing leaves the server.
- **Configure**: Settings > SMS & email; platform fallback `SMS_PROVIDER`, `EMAIL_PROVIDER` and their keys.
- **Permission**: `channels:manage`.
- **Docs / tests**: [CHANNELS.md](CHANNELS.md); `channel-connections.test.ts`, `providers.test.ts`, `webhooks.test.ts`.
- **Not verified**: a real Twilio or SendGrid account, real carriers and mail servers.

### Transcripts by email

- **Flow**: a visitor presses "Email me a copy" in the widget or hosted chat, or a team member chooses "Email a copy to the contact", or an AI agent uses `send_transcript`, or (optionally) a copy goes out once when a ticket is resolved. The copy goes only to the confirmed email of the conversation's own contact (a verified session, or an address the contact gave with consent outside the pre-chat form), contains only what the visitor saw (no notes, no internal lines), can mask personal data, and has a signed unsubscribe link for the automatic copy. Each send is a row in `transcript_sends`.
- **Configure**: Settings > Tickets > Copies by email: `transcripts.enabled` (off), `send_after_resolve` (off), `redact` (off).
- **Permission**: `conversations:reply` for the team send; visitors are limited to 3 per contact per hour (`transcript.contact`).
- **Docs / tests**: [TRANSCRIPTS.md](TRANSCRIPTS.md); `transcripts.test.ts`, `widget.test.ts`, `TranscriptSettings.test.tsx`, `e2e/tests/19-transcripts.spec.ts`.
- **Not verified**: delivery through a real SendGrid account and how real mail clients render the copy.

## Contacts

### Contact records, notes, followers, import

- **Flow**: contacts are created by the first message on any channel or by hand; the contact panel edits name, email, phone (E.164), tags and custom attributes, adds notes and shows tickets, shared media and other conversations. CSV import creates or updates by email or phone. Email and phone are unique per workspace; an address that belongs to another contact is kept as unverified instead of merged.
- **Permission**: `contacts:read`, `contacts:write`, `contacts:import`.
- **Docs / tests**: `contacts.test.ts`.
- **Status**: built.

## Tickets, departments and routing

### Tickets

- **Flow**: a ticket is one issue inside a conversation. It opens with the first message of an issue, has a per-workspace number, a status (`new`, `bot_handling`, `waiting_for_human`, `open`, `pending_customer`, `resolved`, `closed`), a handler (an AI agent or a person) and a rating card after it is resolved. Sweeps resolve idle tickets and close resolved ones.
- **Configure**: Settings > Tickets (reopen window 72 h, close after 72 h, AI idle 30 min, waiting for customer 72 h, rating on).
- **Permission**: `tickets:read`, `tickets:write`, `tickets:close`, `tickets:merge`.
- **Docs / tests**: [AI-AGENTS.md](AI-AGENTS.md) section 1, [ADR 0027](adr/0027-tickets-inside-rooms.md); `tickets.test.ts`.
- **Status**: built.

### Departments, the handoff engine and routing rules

- **Flow**: each inbox is a department with hours, holidays, a routing mode, capacity and service levels. A ticket that needs a person is routed in one transaction under a per-workspace lock, queues when nobody is free, and is handed out oldest first. Routing rules pick the department of a new conversation from page address, language, channel, tag, email domain or attribute.
- **Configure**: Settings > Departments & routing.
- **Permission**: `departments:manage`.
- **Docs / tests**: [DEPARTMENTS.md](DEPARTMENTS.md), [ADR 0028](adr/0028-departments-are-inboxes.md); `departments.test.ts`, `routing.test.ts`, `routing.concurrency.test.ts`, `routing-rules.test.ts`.
- **Status**: built.

## AI

### AI assistance for the team

- **Flow**: suggested replies, thread summaries, draft rewriting, triage (intent, sentiment, urgency) and a simple auto-responder. Without `ANTHROPIC_API_KEY` an offline heuristic provider answers. Personal data can be masked before text reaches the model.
- **Configure**: Settings > AI assistant (triage off, auto-responder off, redaction off, tone Friendly).
- **Permission**: `ai:use`.
- **Docs / tests**: [AI.md](AI.md); `ai.test.ts`.
- **Not verified**: answer quality with a real model.

### AI support agents in the chat

- **Flow**: up to five agents answer visitors from the knowledge base, ask for details, run a closed list of tools and hand over to a person on triggers (asks for a person, low confidence, sensitive topic, upset, VIP, turn limit and others). Answers carry the agent's name and an AI label. The team can take over, hand back, try an agent in a sandbox and review rated turns and unanswered questions.
- **Configure**: Settings > AI agents (new agents start switched off; the first visit creates "Aria", switched on).
- **Permission**: `agents:manage`.
- **Docs / tests**: [AI-AGENTS.md](AI-AGENTS.md) section 3, [ADR 0029](adr/0029-ai-agent-pipeline.md); `agents.test.ts`, `agents-flow.test.ts`, `agents.eval.test.ts`.
- **Not verified**: a real language model; only scripted models and the offline rules agent were run.

### AI agents on SMS and email

- **Flow**: an inbound SMS or email that an agent may answer goes through the same pipeline with a channel-specific style: plain text, a disclosure line, numbered options ("Reply 1 for..."), SMS segment limits, email threading with quoted history stripped. Loop protection skips auto-replies, bounces, lists, short codes, other bots and STOP/unsubscribed contacts; quiet hours apply to SMS; a daily cap per conversation hands the ticket to a person. Replies go out through the normal delivery pipeline (credits, test mode); bot emails carry `Auto-Submitted: auto-replied`.
- **Configure**: off until both the workspace switch (Settings > AI agents > SMS and email answers: `ai_channels.sms.enabled`, `ai_channels.email.enabled`, both off) and the agent's own channel switch are on.
- **Permission**: `agents:manage` for the agent, `settings:write` for the workspace switch.
- **Docs / tests**: [AI-AGENTS.md](AI-AGENTS.md#ai-agents-on-sms-and-email); `ai-channels.test.ts`, `AiChannelSettings.test.tsx`, `e2e/tests/18-ai-sms-email.spec.ts`.
- **Not verified**: real Twilio and SendGrid, real carriers and out-of-office systems, a real model.

### Knowledge base

- **Flow**: question and answer entries with an optional collection and page address, indexed per workspace (BM25) for agents and suggestions.
- **Permission**: `kb:manage`.
- **Status**: built.

## Visitor-facing chat

### Chat widget and hosted chat

- **Flow**: a one-line script on the customer's site (token per domain) or the full-page `/chat?token=...` for web views and iframes. Pre-chat form, one-time-code verification, attachments, receipts, typing, rating, office hours, away message, five languages in the hosted chat, a documented JavaScript bridge for mobile hosts.
- **Configure**: Settings > Chat widget (Install, Customise), Settings > Embed tokens.
- **Permission**: `settings:write` for appearance, `tokens:manage` for tokens and identity.
- **Docs / tests**: [WIDGET.md](WIDGET.md), [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md), [MOBILE-SDKS.md](MOBILE-SDKS.md); `visitors.test.ts`, `hosted-chat.test.ts`, `bridge.contract.test.ts`, `e2e/tests/04-widget.spec.ts`, `10-hosted-chat.spec.ts`.
- **Not verified**: the iOS and Android wrappers on real devices (see [MOBILE-SDKS.md](MOBILE-SDKS.md)).

### Visitor details, pre-chat custom fields and consent

- **Flow**: for name, email, phone and up to five custom fields (text, choice, checkbox) the workspace chooses never, optional, required or ask-when-needed. Required fields and optional custom fields are in the pre-chat form; the server refuses to start a session without the required ones (`422 REQUIRED_INFO_MISSING`) and validates every value (`422 INVALID_FORM`). Ask-when-needed fields appear as a form card in the thread at the chosen moments, never asking twice. When consent is on, a visitor who types an email or phone must tick the consent box; its text and time are kept on the contact. A department can override the field modes and the consent wording and privacy link.
- **Configure**: Settings > Visitor details (everything off, consent off); Settings > Departments & routing > Visitor details.
- **Permission**: `settings:write`, `departments:manage`.
- **Docs / tests**: [AI-AGENTS.md](AI-AGENTS.md#4-visitor-details-in-the-chat), [ADR 0030](adr/0030-forms-in-the-thread.md); `visitor-info.test.ts`, `prechat.test.ts`, `e2e/tests/20-prechat-fields.spec.ts`.
- **Status**: built.

## Calls

All calls are off by default and never recorded. See [CALLS.md](CALLS.md).

### Browser calls with a visitor

- **Flow**: an agent rings a visitor who is in the chat; the visitor accepts in the widget, hosted chat or a web view. WebRTC between the two browsers, signalling over the existing sockets, a compare-and-set state machine, one live call per conversation, ICE restart, screen sharing, a missed-call callback form.
- **Configure**: Settings > Calls > Browser calls; TURN (`TURN_URLS`, `TURN_SECRET`, or Twilio Network Traversal).
- **Permission**: `calls:make`; `calls:settings` to configure.
- **Docs / tests**: [ADR 0031](adr/0031-calls-signalling-over-sockets.md); `calls.test.ts`, `calls.machine.test.ts`, `e2e/tests/11-calls.spec.ts`.
- **Not verified**: real NATs, a live TURN relay, Safari, Firefox, mobile browsers, real devices.

### Phone calls (click-to-call)

- **Flow**: Twilio rings the team member's phone, then the contact's, from a chosen caller ID. Only contacts who agreed, allowed countries, no calls at night, daily limits.
- **Configure**: Settings > Calls > Phone calls (off; no countries allowed).
- **Permission**: `calls:make`.
- **Docs / tests**: [ADR 0032](adr/0032-phone-calls-through-the-workspaces-twilio.md); `phone-calls.test.ts`.
- **Not verified**: real Twilio and a real phone (test-only).

### Calls with the AI assistant

- **Flow**: a visitor talks to the agent of their chat by voice, or by video with a face. The browser engine uses the visitor's browser speech (free); the optional realtime engine uses OpenAI realtime with a server-issued short-lived secret, a minute budget and automatic fallback. AI is disclosed; the visitor's camera is never sent.
- **Configure**: Settings > Calls > Calls with the AI assistant (off); `AI_REALTIME_ENABLED`, `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`.
- **Docs / tests**: [ADR 0033](adr/0033-ai-calls-browser-speech.md), [ADR 0035](adr/0035-optional-realtime-voice-engine.md); `ai-calls.test.ts`, `ai-calls.realtime.test.ts`, `e2e/tests/12-ai-calls.spec.ts`.
- **Not verified**: real speech recognisers, the real OpenAI realtime service, real devices.

### Photoreal avatar (optional, D-ID)

- **Flow**: an owner connects a D-ID API key in Settings > Calls > Photoreal avatar. The key is stored encrypted (`DATA_ENCRYPTION_KEY`), never returned (only "ends ••••1234"), never logged. "Test connection" calls D-ID's credits endpoint. Avatars come from a D-ID stock presenter id or a photo address (with a consent checkbox); each AI agent can be given one. In an AI video call with the browser engine, the server creates a D-ID stream, relays SDP and ICE, and sends each AI reply as text for the avatar to speak; the visitor's browser receives the video only. On any failure, budget or concurrency limit, the call keeps the built-in face. The instance can use `DID_API_KEY` as a fallback key, and `AVATAR_PHOTOREAL_ENABLED=false` switches it off everywhere.
- **Configure**: `calls.avatar.enabled` (off), `minutes_daily` (10), `max_concurrent` (1). Nothing happens until a key is connected and the switch is on.
- **Permission**: `calls:settings`.
- **Docs / tests**: [CALLS.md](CALLS.md#photoreal-avatar), [ADR 0039](adr/0039-optional-photoreal-avatar.md); `avatar.test.ts`, `aicall.photoreal.test.ts`, `PhotorealAvatarSettings.test.tsx`, `e2e/tests/17-photoreal.spec.ts` (fake provider).
- **Not verified**: the real D-ID service. Request shapes follow D-ID's documentation; what was confirmed from the docs and what is assumed is listed in [VERIFICATION.md](VERIFICATION.md#photoreal-avatar-d-id).

### Calls between teammates (one to one)

- **Flow**: from a direct message or the member list; rings anywhere in the app, respects presence and do-not-disturb, missed-call card.
- **Configure**: Settings > Calls > Calls between teammates (off).
- **Permission**: `calls:internal`.
- **Docs / tests**: [ADR 0036](adr/0036-teammate-calls.md); `team-calls.test.ts`, `e2e/tests/13-team-calls.spec.ts`.
- **Not verified**: real networks and devices beyond Chrome with synthetic media.

### Group calls

- **Flow**: from a channel or group message, a member starts a voice or video call and picks people to ring (up to four including the host). Every pair of browsers connects directly (mesh); the newer joiner sends the offer. Members can join late, be added, leave; one person shares a screen at a time. The channel shows a live card with Join while the call runs. Missed group calls notify and push.
- **Configure**: `calls.internal.group` (on once teammate calls are on), `group_max` (4, range 2 to 4).
- **Permission**: `calls:internal`.
- **Docs / tests**: [CALLS.md](CALLS.md#group-calls), [ADR 0038](adr/0038-group-calls-mesh.md); `group-calls.test.ts`, `groupEngine.test.ts`, `e2e/tests/15-group-calls.spec.ts` (three Chrome contexts).
- **Not verified**: real networks, TURN, other browsers, more than one machine. Mesh upload grows with each person, which is why the cap is four.

### Call links

- **Flow**: an expiring, single-use link that opens `/call/<token>` without login, for a call with the AI or the team; only the token's hash is stored.
- **Configure**: Settings > Calls > Call links (off).
- **Docs / tests**: [ADR 0037](adr/0037-call-links.md); `call-links.test.ts`, `e2e/tests/14-call-links.spec.ts`.
- **Not verified**: real SMS or email delivery of links.

## Team chat

- **Flow**: public and private channels, direct and group messages (up to 8), threads, reactions, pins, search, shared customer-conversation cards that respect conversation access, mute, archive.
- **Permission**: `team_chat:use`, `team_chat:manage_channels`, `team_chat:moderate`.
- **Docs / tests**: [TEAM-CHAT.md](TEAM-CHAT.md); `team-chat.test.ts`, `team-chat.realtime.test.ts`, `e2e/tests/09-team-chat.spec.ts`.
- **Status**: built.

## Notifications

### In-app and email

- **Flow**: assignments, mentions, unassigned conversations, snoozes ending and team mentions create a notification (bell, `notification:new`); an email follows for members who are away, and a digest collects unanswered messages.
- **Configure**: per member, Settings > Notifications & availability.
- **Docs / tests**: [NOTIFICATIONS.md](NOTIFICATIONS.md); `notifications.test.ts`.
- **Status**: built; real email delivery is test-only.

### Web Push

- **Flow**: a member turns push on per device; the browser subscribes with the server's VAPID public key and the subscription is stored (at most 10 per member, endpoints limited to known push services). Missed calls (direct and group), assignments and customer messages in conversations assigned to the member enqueue a `push_send` job per device. The payload is encrypted on the server (RFC 8291) and signed with VAPID (RFC 8292) using only `node:crypto` and `jose`. By default a message notification says only that a customer wrote; the workspace can switch on message previews. Do not disturb pauses push. A device that keeps failing is stopped.
- **Configure**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (generate with `npm run vapid --prefix server`), `PUSH_ALLOWED_HOSTS`; `push_message_previews` (off).
- **Permission**: any signed-in member for their own devices; `settings:write` for previews.
- **Docs / tests**: [NOTIFICATIONS.md](NOTIFICATIONS.md); `push.test.ts` (including the RFC 8291 test vector and a fake push service), `PushSettings.test.tsx`, `e2e/tests/16-push.spec.ts`.
- **Not verified**: real push services (FCM for Chrome, Mozilla autopush, Apple Web Push), real phones, iOS home-screen apps.

### Mobile push (APNs and FCM for native apps)

- **Status**: **not built**. The design is in [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Money

- **Plans, credits, auto-recharge**: Stripe subscriptions, prepaid credits for SMS and email, low-balance email, auto-recharge. `billing:manage`. [STRIPE.md](STRIPE.md); `billing.test.ts`, `plans.test.ts`. Test-only (a fake Stripe in tests).
- **Payment requests**: an agent asks a customer for a payment in the chat, SMS or email; the customer pays into the workspace's own Stripe account (Connect). `payments:request`. Test-only.

## Analytics

- **Dashboard and support analytics**: conversations, response and resolution times, CSAT, tickets, AI containment, hand-offs, calls, photoreal minutes. `analytics:read`. [ANALYTICS.md](ANALYTICS.md); `analytics.test.ts`, `support-analytics.test.ts`.
- **Analytics API v1**: API keys with scopes, pseudonymous NDJSON exports, JSON Schemas with contract tests.

## Access and security

- **Roles and permissions**: 38 permissions, four built-in roles (Owner, Manager, Agent, Viewer) and custom roles, deny by default on every route and socket event. [RBAC.md](RBAC.md); `rbac.test.ts`.
- **Accounts**: sessions with refresh rotation, two-factor (TOTP, recovery codes), invitations, password reset, audit log. `accounts.test.ts`, `auth.test.ts`.
- **Signed visitor identity**: HMAC identity hash for signed-in users of the customer's app. `identity.test.ts`.
- **Rate limiting**: layered limits per IP, workspace, member and event, with Redis or memory stores. [RATE-LIMITING.md](RATE-LIMITING.md).
- **Secrets at rest**: Twilio, SendGrid and D-ID credentials and the identity secret are encrypted with `DATA_ENCRYPTION_KEY`. [SECURITY.md](SECURITY.md).

## Operating it

- **Platform console** at `/admin` with its own operators and mandatory two-factor. [ADMIN.md](ADMIN.md).
- **Scale-out**: PostgreSQL with partitioned messages, Redis for presence, rate limits, locks and the event bus, an outbox, graceful drain. [SCALING.md](SCALING.md), [PERFORMANCE.md](PERFORMANCE.md). Not run at 1,000,000 connections.
- **Monitoring**: optional Sentry with an allow-list scrubber. [MONITORING.md](MONITORING.md).
- **Deploy**: [DEPLOY.md](DEPLOY.md), [RUNBOOK.md](RUNBOOK.md), [CONFIGURATION.md](CONFIGURATION.md).

## Not built

| Item | Where it is described |
| --- | --- |
| Native mobile push (APNs, FCM) for the team app and for visitors | [NOTIFICATIONS.md](NOTIFICATIONS.md) |
| Streaming of AI answers | [AI-AGENTS.md](AI-AGENTS.md) |
| Call recording (deliberately) | [CALLS.md](CALLS.md) |
| Group calls of more than four people (would need a media server) | [ADR 0038](adr/0038-group-calls-mesh.md) |
| Photoreal avatar with the realtime voice engine, and providers other than D-ID | [ADR 0039](adr/0039-optional-photoreal-avatar.md) |
| Kafka and NATS event buses (stubs only) | [FUNCTIONS.md](FUNCTIONS.md) |
