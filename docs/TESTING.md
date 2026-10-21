# Testing

## Strategy

- **Vitest everywhere.** `server/tests` (763 test cases: 711 run on the default in-memory SQLite configuration and 52 more only with PostgreSQL or Redis; the PostgreSQL/Redis jobs run them in CI against `postgres:17` and `redis:7`), `web/src` (219) and `edge` (3), plus 63 browser tests in `e2e/` (Playwright, real Chrome). Counts as of 2026-10-20; the server count includes tests added by the billing, operator and widget work since the earlier 741.
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
| `migrations.upgrade.test.ts` | upgrade of a populated database created by the previous release (migrations up to 019 plus representative rows in every table) through the real runner on SQLite and, with `TEST_DB=postgres`, PostgreSQL: no error, row counts and `messages` / `message_mentions` unchanged, `foreign_key_check` clean, new delivery value storable, indexes and triggers kept, idempotent re-run, schema equal to a fresh database (drift guard), rollback of a migration that breaks a foreign key; migration 020 also under `.dbconfig defensive on` when the `sqlite3` shell is installed (node:sqlite 24.11 cannot enable defensive mode) |
| `tickets.test.ts` | tickets: opening and numbering (per workspace, parallel opens), the state machine by sender (customer, agent, bot, note), resolve, close, reopen window and new ticket after it, the idle sweep per workspace setting, rating over the widget API, listing filters and keyset paging, scope (agents, other workspace: 404), bulk, merge, permissions, realtime payloads (full for the team, minimal for the visitor), EXPLAIN of the hot queries, retention and erasure, settings validation |
| `migrations.lint.test.ts` | no migration uses `writable_schema`, touches `sqlite_master` / `sqlite_schema` or runs a `PRAGMA`; a SQLite migration that drops a referenced table must carry `-- @sqlite-foreign-keys-off` |
| `migrations.upgrade.test.ts` (tickets part) | migrations 027 and 028 on a populated 026 database (SQLite, PostgreSQL): nothing lost, no backfill, live-ticket and number uniqueness, cascades, system roles equal the catalogue, custom roles keep what they had, the guard trigger is back, drift against a fresh schema; on SQLite the application then opens ticket 1 for an old room with its next message |
| `channel-status.test.ts` | test-mode delivery (`not_sent_test_mode`) with SMS and email, `GET /api/channels/status` in every state, migration 020 on SQLite, the getting-started checklist |
| `channel-connections.test.ts` | per-workspace Twilio and SendGrid connections with mocked `fetch`: masking and encryption, verify (success, 401, suspended, timeout, malformed, 429, 5xx), sends through the workspace account, fail-closed, number import and ownership, per-workspace inbound signature verification (valid, other workspace, platform token, unsigned, unknown id, replay, cross-workspace replay), SendGrid secret rotation and event signatures, test sends and limits, permissions, tenant isolation, audit, no credentials in logs |
| `visitor-internal-lines.test.ts` | internal system lines never reach visitors (REST and sockets) while agents still see them; the server-stated closed marker |
| `widget-preview.test.ts` | install verification (`last_seen_*`), the signed preview flag (expiry boundary, tamper, other workspace, own-origin only, session expiry, sockets), the production Origin check unchanged, the preview and demo pages |
| `team-chat.test.ts`, `team-chat.realtime.test.ts`, `team-chat.plans.test.ts` | team chat: #general, DMs and groups, channels and privacy (404 for outsiders), ordering, idempotency, cursors, threads, edit and delete, reactions, pins, search, unread math, mentions and notifications (mute, preferences, DND), shared conversation cards, permissions, tenant isolation, retention; real sockets (delivery to members only, removal cuts delivery, typing, read, reactions, rate limits); EXPLAIN checks on SQLite and PostgreSQL |

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

## Browser end-to-end tests (`e2e/`, Playwright)

Drive the **built** server and web app in a real Chrome with real clicks, typing and keyboard input. `e2e/support/stack.mjs` starts `server/dist` on a free port with a throwaway SQLite database, the demo seed, an operator account and extra data created through the public and REST APIs (a website visitor writing in, images and a voice note). Nothing is mocked; the realtime path, uploads and the widget run for real. Requires `npm run build` first.

```bash
npm ci --prefix e2e
npm run build
npm run e2e:ui                         # all specs (Chrome from the machine; E2E_CHANNEL= to use Playwright's Chromium, as CI does)
npm run shots                          # screenshot matrix into docs/design/
E2E_REUSE=1 E2E_PORT=45555 npx playwright test tests/02-inbox.spec.ts   # against `node e2e/support/stack.mjs` you started yourself
```

| Spec | What it proves |
| --- | --- |
| `01-auth` | wrong password message, password toggle, sign in and out through the account menu, theme switch on the sign-in page survives a reload |
| `02-inbox` | list with unread badges and counts; open a conversation; send by typing and Enter, Shift+Enter; notes with the @mention picker; templates by `/` and by the picker; emoji; channel tabs (SMS counter, email From/Subject); image attachments with the viewer and arrow keys; real audio playing in the voice-note player; reply and quote; edit and delete with confirmation; failed send and Retry while offline; assign, priority, favorite, snooze, close and reopen; sidebar views and URL-kept search; search inside a conversation; AI suggestions; contact panel edit, tag and note; new conversation; `j`/`k`, `?`, `p`, `i`, `c`, `/`; letter shortcuts ignored while typing; Cmd/Ctrl+K palette; theme toggle changes real colours and persists; notifications; a new visitor message arrives live |
| `03-settings` | grouped navigation, saving General, templates, inboxes, roles panel; the widget customiser preview follows title, colour and launcher style and the change persists; low-contrast colours are flagged and fixed |
| `04-widget` | a visitor on a separate origin chats through the embedded widget, an agent answers from the inbox and the reply reaches the visitor; keyboard operation (Escape closes, focus returns) |
| `05-analytics-admin` | KPI cards, range tabs, the table fallback; the operator console with TOTP enrolment (the secret is read from the page), directory, workspace detail, audit |
| `06-a11y` | axe-core WCAG 2 A/AA rules (including colour contrast) on sign-in, inbox, conversation with the contact panel, command palette, dialogs, menus, nine settings pages, analytics and the operator sign-in, in light and dark; serious and critical findings fail |
| `07-responsive` | 390x844: list and chat are separate screens, bottom navigation, drawers, no horizontal scroll (also at 360x640 on five screens); 1024x768: sheets; reduced motion collapses animations |
| `08-perf` | 3,000 conversations in their own stack: only a window of rows is in the DOM, 5 seconds of scrolling from the bottom to the top and back runs at the display's frame rate (p95 frame time and long tasks are printed), keyboard navigation keeps the selected row visible |
| `09-team-chat` | two real browser contexts (owner and an agent) chatting over real sockets: create a channel and see it appear live, unread badge, thread reply and live reply counter, reaction, pin, @mention with notification, edit and delete, a direct message, search, share a customer conversation; ArrowUp edits, Alt+Arrow navigates; a 160-message history is virtualised and older pages load; axe in light and dark on the channel, the details panel, the new-message dialog and search; the 390x844 layout |
| `shots` | the screenshot matrix for [design/DESIGN.md](design/DESIGN.md) |

Notes: the widget is exercised from a second origin because a same-origin page sends no `Origin` header on GET requests, so the embed token's domain check cannot pass (see the known limitation in [APPROACH.md](APPROACH.md)). The a11y specs run with reduced motion so that axe measures settled colours, not a menu that is still fading in.

### Mobile and hosted chat

| Where | What |
| --- | --- |
| `server/tests/hosted-chat.test.ts` | `/chat` serving, CSP and frame-ancestors per token, generic refusal for unknown, revoked, flag-off tokens and suspended workspaces, parameter escaping, asset allow-list, the origin matrix (flag off or on; missing, null, other and own origin; other workspace; revoked; rotation keeps the flag), sessions follow the flag over REST and sockets |
| `server/tests/identity.test.ts` | secret management and audit, the full identity-hash matrix, reference vectors, tenant isolation of `external_id`, visitor uploads, attributes, log-out, upload rate limit |
| `server/tests/bridge.contract.test.ts` | about 100 command and event cases checked against both `docs/bridge/*.schema.json` (ajv) and the shipped `bridge.js`; endpoint behaviour (acks, nacks, rate limit, timeouts), every transport, the iframe origin rules, link and origin parity with the server, i18n completeness |
| `server/tests/mobile.docs.test.ts` | the identity snippets run in node, python and ruby (php skipped when absent), the curl flow replayed against a real HTTP server, the TypeScript example type-checked against `socket.io-client`, the Swift example with `swiftc` |
| `server/tests/migrations.upgrade.test.ts` | extended for migration 026 (defaults on old rows, the unique `external_id` index, the new table) on SQLite and PostgreSQL |
| `e2e/tests/10-hosted-chat.spec.ts` | 390x844 phone emulation (touch) and 1024x768, light and dark: chat, a photo upload, agent reply, emoji, 44 px targets, 16 px composer, axe, no console errors; offline banner and queue; paging with scroll anchoring; right-to-left and Spanish; the bridge conformance page passes every check in Chromium |
| `sdks/ios` (`swift test`) | 24 XCTest cases for the envelope, commands, events, state machine and URL builder; not run by `npm test` |
| `sdks/android` | JVM unit tests exist and were never run (no toolchain on the authoring machine) |

## Web tests

`web/src/**/*.test.ts(x)` (219 tests, Vitest + Testing Library + jsdom):

- socket-to-cache bridge (`message:new` dedupe by id and `client_msg_id`, updated/deleted/receipt, room reorder + unread bump, `room:*`, notifications)
- optimistic send state machine (ack before/after broadcast, failure, retry with the same `client_msg_id`, socket-to-REST fallback)
- composer channel rules (SMS 1599/1600, missing phone/email, opt-out, email sender/subject, notes always chat)
- unread badge logic, keyboard shortcuts (ignored while typing), grouping/day separators, mentions, relative times, filter params
- components: login, API error display incl. `AI_UNAVAILABLE`, message bubble variants (notes, system lines, ticks, failed + retry, quotes, attachments, voice-note player, image viewer), room list item (mentions shown as names), snooze menu, dropdown menu keyboard behaviour (Radix), widget preview and its contrast helper, settings and admin pages, charts
- `widget.test.ts`: the embeddable `server/public/widget.js` in jsdom with a fake fetch and fake Socket.IO client: shadow-DOM rendering, pre-chat form, optimistic send + ack merge, same-`client_msg_id` retry, REST fallback and resend on reconnect, typing/unread/receipts, safe text rendering, OTP flow, polling fallback, session restore
