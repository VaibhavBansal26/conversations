# Testing

## Strategy

- **Vitest everywhere.** `server/tests` (741 test cases: 689 run on the default in-memory SQLite configuration and 52 more only with PostgreSQL or Redis; **all 741 run in CI** against `postgres:17` and `redis:7`), `web/src` (193) and `edge` (3). Counts as of 2026-10-20.
- **Services are tested directly** with an in-memory SQLite database (`:memory:`), a fake clock, a `RecordingBus` (captures realtime events), `FakeSmsProvider` / `FakeEmailProvider` (deterministic ids, programmable failures) and an injected `AiProvider`.
- **HTTP integration** goes through `app.request()` (no port): auth, tenancy, validation, error envelope, webhooks, widget/public endpoints, uploads.
- **Realtime tests use real Socket.IO**: `tests/rt-helpers.ts` boots the real Hono server + `SocketBus` on an ephemeral port and connects real `socket.io-client` sockets (team JWT and visitor sessions), so namespace middleware, joins, acks, rate limits and presence run for real.
- **Time is injected.** `ctx.clock()` is the only clock services read, so OTP expiry boundaries, 30-day sessions, snooze, edit window, retry backoff and digests are asserted at exact instants (`TestClock.advance`).
- **No test touches the network.** Twilio/SendGrid adapters are tested with a mocked `fetch`; AI with fake providers.
- **End-to-end proof** against the *built* server: `npm run e2e` (see below).
- Each test builds its own world (`fullApp()`, `seedWorkspace()`), so tests are independent and order-free.

- **The same suite on every backend.** `TEST_DATABASE_URL=postgres://...` gives each test its own schema in a real PostgreSQL; `TEST_REDIS_URL=redis://...` runs the whole suite on the Redis paths (limiter, presence, locks, cache invalidation) with a per-context key prefix. The default run needs neither. The last full run before this document: SQLite 689 passed, 52 skipped; PostgreSQL + Redis 741 passed (against a local PostgreSQL 18 and Redis; CI uses `postgres:17`, `redis:7`).
- **Contracts are tested against schemas and declarations.** Analytics responses are validated with Ajv against the JSON Schemas; every REST route and socket event must appear in the authorisation, rate-limit and API-documentation tables (a test per pair); a role-by-route matrix sends a request for every protected route as owner, manager, agent and viewer.
- **Documentation is tested.** `tests/docs.test.ts` runs the same checks as `npm run docs:check`: relative links and anchors, the docs index, generated files (configuration, API, OpenAPI, realtime events, rate-limit table, analytics schemas), Mermaid parsing, route/event/permission coverage, changelog. `tests/docs.examples.test.ts` runs the curl flow of `docs/API.md` against an in-process app.
- **Fakes for money.** `FakeBilling` records every Stripe call and builds correctly signed webhook payloads; `StripeBilling` is tested against a recording stub of the SDK. Nothing in the suite talks to Stripe.
- **Faults and load are not in `npm test`.** They live in `loadtest/` (node kill, Redis restart, PostgreSQL freeze, storms, 50M-row dataset) and their results are in [PERFORMANCE.md](PERFORMANCE.md).

## Running

```bash
npm run setup        # installs server/ and web/
npm run typecheck    # tsc --noEmit for both packages
npm test             # vitest run for both packages
npm run build        # tsc (server) + tsc && vite build (web)
npm run e2e          # requires a prior build: boots dist/index.js and drives it with real HTTP + sockets
npm run test --prefix server -- tests/rooms.test.ts   # one file
```

## Test files (server)

| File | Tests | Focus |
| --- | ---: | --- |
| `auth.test.ts` | 14 | register/login, token tampering/expiry, seat re-check, cross-tenant 404, role rules, last owner, config validation, headers/CORS/body limit |
| `contacts.test.ts` | 27 | phone normalisation table, dedupe, find-or-create, search with wildcard/SQL input, tags, notes, CSV import |
| `html.test.ts` | 18 | sanitiser attack table, text/html conversion, SMS vs dm/email content processing |
| `inboxes.test.ts` | 13 | round robin determinism, stale pointer, removed members, concurrency, inbox CRUD/defaults/visibility |
| `rooms.test.ts` | 40 | one room per contact race, reopen matrix, snooze, filters/sorts incl. `waiting_longest`, scope matrix, assignment effects, bulk, counts |
| `messages.test.ts` | 36 | idempotency (incl. concurrent), ordering with equal timestamps, pagination boundaries, search, edit/delete, mentions, notes, unread math, bounded mark-read |
| `channels.test.ts` | 66 | SMS/email rules, keyword matrix, number locks, subject derivation, threading, failure/retry/backoff/cap, credits |
| `providers.test.ts` | 11 | Twilio and SendGrid adapters (mocked `fetch`), fake/console providers, storage signing/traversal, AI provider factory |
| `webhooks.test.ts` | 33 | signature vectors, Twilio inbound/status, SendGrid inbound/events (ECDSA, stale, replayed, shared secret), reconciliation |
| `visitors.test.ts` | 59 | origin matching table, tokens, sessions, device/IP check, expiry, visibility, OTP, away message, rate limits |
| `realtime.test.ts` | 25 | socket auth and tenancy, chat flow, receipts, per-event authorization, rate limit, malformed payloads, presence |
| `presence.test.ts` | 5 | refcount and grace period with fake timers |
| `notifications.test.ts` | 22 | recipient tiers, feed, offline emails, DND/online/snooze suppression, job queue, digest |
| `templates.test.ts` | 10 | merge fields, fallbacks, unknown fields, HTML escaping, API |
| `attachments.test.ts` | 31 | magic bytes, filename sanitising, allow-list, size, signed URLs, traversal |
| `ai.test.ts` | 43 | suggestions, summary, rephrase, triage, auto-responder, redaction, truncation, injection, malformed output, BM25, heuristics |
| `settings.test.ts` | 12 | workspace settings, numbers/senders/addresses, KB, members, live seats, static serving |

### Added in the scale, access, money and operator work

| File | Focus |
| --- | --- |
| `ratelimit.algorithms.test.ts`, `ratelimit.http.test.ts`, `ratelimit.ws.test.ts`, `ratelimit.redis.test.ts` | GCRA, windows, concurrency leases, penalty box and decay, local lease tier never over-admits, fail-open/closed with the breaker, route and event coverage, WebSocket flood and cost-weighted pacing, Redis store parity |
| `eventbus.test.ts` | contract for the memory and Redis Streams buses (order per key, groups, retries, dead letters, takeover, takeover ordering regression), outbox atomicity, relay idempotency, rollup counted once under duplicates |
| `redis.test.ts`, `redis-recovery.test.ts` | presence, locks, cache invalidation, `server:resync` after a Redis outage |
| `scale.test.ts`, `archive.test.ts`, `fairness.test.ts`, `workers.test.ts` | partition planning and pruning (EXPLAIN), archival and restore, fair per-tenant scheduling, worker pool |
| `rbac.test.ts`, `accounts.test.ts` | declaration coverage, role matrix, escalation, immutability, sessions, refresh rotation and reuse, MFA, reset, invitations, lockouts |
| `pepper.test.ts` | importing a pepper (rules, fingerprint, audit), pepper endpoint auth (session or key scopes), DATA_ENCRYPTION_KEY, migration from JWT_SECRET, `PEPPER_UNREADABLE` recovery |
| `ratelimit.analytics.test.ts` | analytics key limits as observed: separate read/export budgets, shared workspace quota, Retry-After vs reset, no penalty box |
| `entrypoints.test.ts` | `npm run seed` in a child process: seeds and exits |
| `analytics.test.ts` | metric definitions, API keys (scope, expiry, CIDR), isolation, exports, pepper algorithm, JSON Schema contract |
| `billing.test.ts`, `stripe-provider.test.ts` | webhook signatures, idempotency and ordering, plan lifecycle, grace and soft lock, seats, auto-recharge, Connect payment requests, request shapes against the SDK stub |
| `admin.test.ts` | operator sign-in and MFA, token separation, roles, directory, suspension everywhere, credits, tier and region, support access (REST and sockets), audit, rate-limit lists |
| `docs.test.ts`, `docs.examples.test.ts` | documentation drift and the documented examples |

Web: `BillingSettings.test.tsx`, `PaymentCard.test.tsx`, `money.test.ts`, `admin/AdminApp.test.tsx`, `ImpersonatePage.test.tsx`, `widget.test.ts` (payment card, CSAT), `AnalyticsPage` and the role/security settings pages.

## Edge-case catalogue (requirement -> where it is tested)

| Required edge case | Test |
| --- | --- |
| idempotent send under concurrent duplicate qids | `messages.test.ts` "is safe under concurrent duplicate sends"; `realtime.test.ts` "is idempotent on client_msg_id over sockets"; `channels.test.ts` "two concurrent identical sends call the provider once" |
| ordering with equal timestamps (seq) | `messages.test.ts` "keeps insertion order when timestamps are identical" |
| pagination boundaries | `messages.test.ts` "ordering and pagination": empty room, exactly `limit`, before/after walk, cursor edges, deleted messages, foreign/dual cursors, limit range |
| message search (no match, special chars, SQL-like) | `messages.test.ts` "message search" |
| unread math | `messages.test.ts` "unread math": notes/system excluded, own messages, unassigned vs assigned, cursor at end, backwards no-op, bounded (exactly one row changed) |
| room reopen matrix | `rooms.test.ts` "room status rules (reopen matrix)" |
| snooze validate-before-write, wake job, clear on message | `rooms.test.ts` "snooze" |
| one-room-per-contact race | `rooms.test.ts` "one room per contact" (service-level and HTTP parallel creates, raw duplicate rejected by the unique index) |
| round-robin determinism, member removed, stale last_assigned, concurrent assignment | `inboxes.test.ts` "round robin" |
| visibility/scope matrix owner/manager/agent x list/get/send/socket-join | `rooms.test.ts` "visibility by scope"; `realtime.test.ts` "per-event authorization" |
| cross-tenant isolation (REST and sockets, visitor session on another namespace) | `auth.test.ts` "returns 404 (not 403)..."; `visitors.test.ts` "cross-tenant"; `realtime.test.ts` "socket authentication and tenancy" |
| SMS rules: empty/invalid phone, 1599/1600/1601, opt-out words + variants, all numbers locked, number freed on close | `channels.test.ts` "SMS keyword classification" and "outbound SMS rules"; `webhooks.test.ts` opt-out/opt-in |
| email rules: no email, subject 70-char boundary, threading headers, inbound unknown sender, In-Reply-To vs lock | `channels.test.ts` "outbound email rules"; `webhooks.test.ts` "SendGrid inbound parse" |
| webhook signatures valid/invalid/replayed/stale | `webhooks.test.ts` "signature primitives", "Twilio inbound SMS webhook", "SendGrid event webhook" |
| provider failure -> failed + retry + backoff cap | `channels.test.ts` "delivery failure, retry and backoff" |
| credit balance insufficient | `channels.test.ts` "credits" |
| attachment allow-list, size, spoofed ext/magic, traversal filename, signed URL expiry/tamper | `attachments.test.ts`, `providers.test.ts` "LocalDiskStorage" |
| widget token origin matching (exact, wildcard, case, port, missing, null) | `visitors.test.ts` "origin matching" (29-row table) |
| session expiry, IP-or-device check | `visitors.test.ts` "visitor sessions" |
| OTP: expiry boundary 2:00, wrong code, attempt cap, resend cooldown, replay | `visitors.test.ts` "OTP verification" |
| presence refcount (2 tabs, close 1, grace) | `presence.test.ts` (fake timers), `realtime.test.ts` "presence" (real sockets) |
| socket per-event authorization, rate limit, malformed payloads | `realtime.test.ts` |
| templates merge fields | `templates.test.ts` |
| notification tiers, dedupe, online/DND/snooze suppression | `notifications.test.ts` |
| digest sends once | `notifications.test.ts` "delayed-message digest" |
| AI cases (fake provider, malformed output, injection, huge threads, PII redaction, provider failure) | `ai.test.ts` |
| HTML sanitiser (script, onerror, javascript:, data:, style expression, malformed) | `html.test.ts` |
| phone normalisation table, contacts dedupe | `contacts.test.ts` |

## End-to-end script (`server/scripts/e2e.mjs`)

Spawns the **built** server (`node dist/index.js`, `NODE_ENV=production`, temp database) and proves, with real HTTP and real Socket.IO clients: register -> create inbox/contact/number/token -> widget session (foreign origin rejected, cross-tenant namespace rejected) -> visitor message reaches the agent over the socket -> agent reply reaches the visitor -> read receipts both ways (and the computed unread count) -> duplicate `client_msg_id` is idempotent -> an inbound SMS webhook with a valid Twilio signature creates a room (unsigned and replayed requests handled). It exits non-zero on the first failed assertion. CI runs it after the build.

## Web tests

`web/src/**/*.test.ts(x)` (193 tests, Vitest + Testing Library + jsdom):

- socket-to-cache bridge (`message:new` dedupe by id and `client_msg_id`, updated/deleted/receipt, room reorder + unread bump, `room:*`, notifications)
- optimistic send state machine (ack before/after broadcast, failure, retry with the same `client_msg_id`, socket-to-REST fallback)
- composer channel rules (SMS 1599/1600, missing phone/email, opt-out, email sender/subject, notes always chat)
- unread badge logic, keyboard shortcuts (ignored while typing), grouping/day separators, mentions, relative times, filter params
- components: login, API error display incl. `AI_UNAVAILABLE`, message bubble variants, room list item, snooze menu, keyboard menu, widget preview
- `widget.test.ts`: the embeddable `server/public/widget.js` in jsdom with a fake fetch and fake Socket.IO client: shadow-DOM rendering, pre-chat form, optimistic send + ack merge, same-`client_msg_id` retry, REST fallback and resend on reconnect, typing/unread/receipts, safe text rendering, OTP flow, polling fallback, session restore
