# Changelog

All notable user-visible changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/) (the HTTP API and socket protocol are the public surface; the analytics API has its own `schema_version`).

## [Unreleased]

### Added
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
- Rotating `JWT_SECRET` no longer breaks the identity pepper endpoint and the analytics exports (the pepper was encrypted under it).
- `npm run seed` exits when done (it stayed alive until killed); regression test spawns the script.
- `dow_created` (Sunday = 0), the `phone_key` extra field, the export page maximum (5,000) and how `Retry-After` relates to the `RateLimit` reset are now documented; the schemas say so.
- Event bus: after a consumer takeover the new owner now drains the previous owner's unacknowledged entries **before** reading new ones (per-key order could be violated); regression test added.
- Rate limiter: a 24-hour penalty no longer forgives itself; the Lua and TypeScript implementations agree.
- Webhook signature failures are counted from the response status (Hono turns thrown errors into responses).
