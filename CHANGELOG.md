# Changelog

All notable user-visible changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/) (the HTTP API and socket protocol are the public surface; the analytics API has its own `schema_version`).

## [Unreleased]

### Fixed (widget)
- **The widget no longer shows the team's internal system lines** ("Olivia assigned this conversation to Sam", closed/reopened, snoozed, SMS consent, unknown kinds). Visitors get only an allow-list of system lines (`create`, `payment`) over REST and sockets; notes were already excluded. The satisfaction prompt is driven by `room.closed_marker` from the server instead of the close line.

### Added (per-workspace channel connections)
- **Settings > Channels: Connect Twilio and Connect SendGrid.** A workspace admin pastes their own credentials (encrypted at rest with `DATA_ENCRYPTION_KEY`, masked to the last four characters, never logged), verifies them with a read-only provider call, imports numbers from Twilio or verified senders from SendGrid, sends a test text or email, and copies the exact webhook URLs for Twilio (SMS webhook, status callback) and SendGrid (Inbound Parse, Event Webhook). "Check webhook" shows the latest inbound events and their outcome. Provider errors are mapped to fix-it messages (bad credentials, unverified sender, trial restriction, insufficient funds, rate limit, timeout). See [docs/CHANNELS.md](docs/CHANNELS.md) and [ADR 0019](docs/adr/0019-per-workspace-channel-connections.md).
- Per-workspace inbound endpoints `POST /webhooks/c/:id/twilio/{sms,status}` and `/sendgrid/{inbound,events}`, each verified with that workspace's own credentials (Twilio Auth Token, SendGrid verification key or URL secret); the platform-wide endpoints remain for the environment default.
- New routes under `/api/channels/*` (permission `channels:manage`), rate-limit policies `channels.verify`, `channels.test`, `webhook.connection`, `PROVIDER_TIMEOUT_MS`, audit entries `channel.*`, migration 022, `npm run smoke:channels --prefix server` (real-provider smoke test with your own credentials; nothing in `npm test` reaches Twilio or SendGrid).

### Changed
- `SMS_PROVIDER` / `EMAIL_PROVIDER` / `TWILIO_*` / `SENDGRID_*` are now the optional platform default for workspaces that have no connection of their own.
- Adding an SMS number by hand is refused (`NUMBER_NOT_OWNED`) when the workspace has a verified Twilio connection and Twilio does not list that number for the account.

### Fixed (SMS and email honesty)
- **A message is never shown as sent or delivered when nothing was sent.** With the console provider (the default when no provider is configured) SMS and email are stored as `not_sent_test_mode`: a "Test mode: not sent" badge replaces the ticks, a banner above the composer and on Settings > Channels says "SMS is not connected. Messages are saved but not sent. Connect Twilio in Settings > Channels.", nothing is billed, and "send it now" delivers the message after a provider is connected ([ADR 0018](docs/adr/0018-test-mode-delivery.md)).
- New `GET /api/channels/status` (mode, connected, provider, details, last error; no credentials).
- Migration 020 (`messages.delivery` accepts `not_sent_test_mode`; SQLite and PostgreSQL) and 021 (`channel_health`). The analytics export's `delivery_status` enum gained the new value.

### Changed (web redesign)
- **New design system for the whole web app** (Tailwind CSS v4 tokens, Radix-based components in `web/src/ui`, lucide icons; [docs/design/DESIGN.md](docs/design/DESIGN.md), [ADR 0017](docs/adr/0017-tailwind-and-headless-primitives.md)): light, dark and system themes with a manual toggle, AA contrast checked in CI, visible focus rings, reduced-motion support, layouts from 360 px to 1920 px. The handwritten stylesheets are gone.
- **Inbox**: three columns (views and inboxes with counts, virtualised conversation list with avatars, snippets, unread, priority, assignee, channel and time, thread) with a collapsible contact panel; drawers on tablets, separate list and chat screens with bottom navigation on phones.
- **Thread**: grouped bubbles with day separators, delivery and read ticks, failed sends with retry, notes and system lines, quote and reply, image previews with a viewer, voice-note player, payment-request card, AI suggestion strip.
- **Composer**: channel tabs (chat, SMS, email) and a note tab, From and Subject for email, template picker next to the `/` shortcut, emoji, mentions, rewrite, attachments by picker, paste and drag-and-drop.
- **Settings, analytics, billing, members, roles, tokens, security and the operator console** redesigned; confirmation dialogs replace `window.confirm`; toasts confirm saves.
- Widget customiser with a live preview (screens, light/dark, desktop/phone), launcher styles, corner radius, AA contrast check; the embeddable widget was restyled (Shadow DOM, dark mode, focus management, Escape closes) and honours the new settings `launcher_style`, `launcher_label` and `radius`.

### Added
- Command palette (Cmd/Ctrl+K): jump to a conversation, open pages, run actions on the open conversation. New shortcuts: `/` search, `n` new conversation, `i` contact panel, `p` priority, `f` favorite, `s` snooze; the help dialog (`?`) lists them all.
- Browser end-to-end suite (`e2e/`, Playwright) with axe accessibility checks, responsive checks, a 3,000-room scroll test and the screenshot matrix in `docs/design/`.
- `docs/PROVENANCE.md`: what the redesign adapted from the legacy UI.
- **Shareable identity pepper**: `PUT /api/v1/analytics/identity-pepper` imports a pepper (validated, audited, `version` bumps) so two apps of one customer derive the same `contact_key`; responses carry a `fingerprint` (first 8 hex characters of SHA-256) to compare apps without showing the pepper. `GET` takes a session or an API key with `analytics:export` + `analytics_identity:manage`; response `{pepper, version, algorithm: "HMAC-SHA256", fingerprint, rotatedAt}`. The old `/api/analytics/identity-pepper` paths remain as aliases. See [docs/ANALYTICS.md](docs/ANALYTICS.md).
- `DATA_ENCRYPTION_KEY` and `DATA_ENCRYPTION_KEY_PREVIOUS`: a dedicated key for the identity pepper, with key-versioned ciphertext. **Production now requires `DATA_ENCRYPTION_KEY` once analytics is used**; existing peppers are re-encrypted from `JWT_SECRET` on first read. An unreadable pepper answers `409 PEPPER_UNREADABLE` instead of `500`.
- `render.yaml` blueprint, manual `deploy-check` workflow and `docs/DEPLOY.md` for a free Render deployment.
- **Billing with Stripe** ([docs/STRIPE.md](docs/STRIPE.md)): plans (Free, Pro, Business) with seat limits, Checkout and customer portal, credit top-ups, monthly plan credits, low-balance alerts, auto-recharge on a saved card, failed-payment grace period and soft lock, signed and idempotent webhooks (`/webhooks/stripe`, `/webhooks/stripe/connect`).
- **Customer payment requests** through Stripe Connect Standard: a payment card in the conversation (agent app and widget) that updates live when the customer pays; new permission `payments:request`.
- **Platform console** (`/admin`, [docs/ADMIN.md](docs/ADMIN.md)): operator sign-in with mandatory TOTP, workspace directory, suspension, credit adjustments, rate-limit tier overrides, read-only support access that is visible in the customer's own audit log, platform audit view. Operators are created with `npm run admin -- create`.
- **Roles and permissions** ([docs/RBAC.md](docs/RBAC.md)): 26 permissions, four immutable built-in roles, custom roles, deny-by-default route and socket-event authorisation, sessions with rotating single-use refresh tokens and reuse detection, TOTP two-factor with recovery codes, password reset, email invitations, append-only audit log.
- **Analytics** ([docs/ANALYTICS.md](docs/ANALYTICS.md)): per-room metrics (first response and resolution in business time, snooze excluded, CSAT), dashboard with accessible SVG charts, workspace API keys (hashed, scoped, CIDR allow-list), `/api/v1/analytics/*` with keyset-paged NDJSON exports, HMAC identity keys, JSON Schemas with contract tests, CSAT prompt in the widget.
- **Scale-out** ([docs/SCALING.md](docs/SCALING.md)): messages hash-partitioned by room and monthly, PgBouncer compatibility, read replicas with read-your-writes, transactional outbox feeding an event bus (Redis Streams; Kafka and NATS stubs), computed audiences instead of per-room channels, admission control and load shedding, fair per-tenant job scheduling, archival and GDPR purge, Redis presence, worker threads for large HTML.
- **Layered rate limiter** ([docs/RATE-LIMITING.md](docs/RATE-LIMITING.md)): GCRA, sliding windows, concurrency leases, penalty box, local lease tier, plan tiers, per-route and per-event declarations with coverage tests.
- **Load-test kit** (`loadtest/`): multi-process Socket.IO generators with sequence checking, fault injection (node kill, Redis restart, PostgreSQL freeze), 50M-row dataset loader, k6 scripts, Kubernetes/KEDA manifests ([docs/CLOUD-LOADTEST.md](docs/CLOUD-LOADTEST.md)).
- Multi-region routing hook: `REGION` and an operator-set workspace home region; a workspace homed elsewhere is refused with `421 WRONG_REGION`.
- Documentation set with generated, drift-checked references: `docs/CONFIGURATION.md`, `docs/API.md` + `docs/openapi.json`, `docs/REALTIME.md`, runbook, security notes, glossary, ADRs; `npm run docs:check` in `npm test` and CI.

### Changed
- `GET /api/workspace` and the login/session payloads include `plan`, `billing_access`, `billing_grace_until` and `currency`.
- `POST /api/credits/grant` answers `403 CREDIT_GRANT_DISABLED` when Stripe is configured (credits are bought).
- Message `meta.card` is passed through to the widget's copy of a message.

### Fixed
- Typing straight after picking an @mention no longer drops or misplaces characters (the caret is restored before paint instead of on a timer); room-list snippets show @mentions as names instead of raw `@[Name](id)` tokens.
- Rotating `JWT_SECRET` no longer breaks the identity pepper endpoint and the analytics exports (the pepper was encrypted under it).
- `npm run seed` exits when done (it stayed alive until killed); regression test spawns the script.
- `dow_created` (Sunday = 0), the `phone_key` extra field, the export page maximum (5,000) and how `Retry-After` relates to the `RateLimit` reset are now documented; the schemas say so.
- Event bus: after a consumer takeover the new owner now drains the previous owner's unacknowledged entries **before** reading new ones (per-key order could be violated); regression test added.
- Rate limiter: a 24-hour penalty no longer forgives itself; the Lua and TypeScript implementations agree.
- Webhook signature failures are counted from the response status (Hono turns thrown errors into responses).
