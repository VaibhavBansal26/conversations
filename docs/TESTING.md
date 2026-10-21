# Testing

## Strategy

- **Vitest everywhere.** `server/tests` (1,634 test cases in 85 files: on the default SQLite run 1,565 pass and 69 are skipped because they need PostgreSQL or Redis; with `TEST_DB=postgres` 1,591 pass and 43 are skipped), `web/src` (562 tests in 64 files) and `edge` (3), plus 240 browser tests in 30 files in `e2e/` (Playwright, real Chrome: 105 in the `app` project, the rest are the screenshot matrix). Counts as of 2026-10-21 (the full run is listed in [the counts section](#counts-of-the-last-full-run)).
- **Services are tested directly** with an in-memory SQLite database (`:memory:`), a fake clock, a `RecordingBus` (captures realtime events), `FakeSmsProvider` / `FakeEmailProvider` (deterministic ids, programmable failures) and an injected `AiProvider`.
- **HTTP integration** goes through `app.request()` (no port): auth, tenancy, validation, error envelope, webhooks, widget/public endpoints, uploads.
- **Realtime tests use real Socket.IO**: `tests/rt-helpers.ts` boots the real Hono server + `SocketBus` on an ephemeral port and connects real `socket.io-client` sockets (team JWT and visitor sessions), so namespace middleware, joins, acks, rate limits and presence run for real.
- **Time is injected.** `ctx.clock()` is the only clock services read, so OTP expiry boundaries, 30-day sessions, snooze, edit window, retry backoff and digests are asserted at exact instants (`TestClock.advance`).
- **No test touches the network.** Twilio/SendGrid adapters are tested with a mocked `fetch`; AI with fake providers.
- **End-to-end proof** against the *built* server: `npm run e2e` (see below).
- Each test builds its own world (`fullApp()`, `seedWorkspace()`), so tests are independent and order-free.

- **The same suite on every backend.** `TEST_DATABASE_URL=postgres://...` gives each test its own schema in a real PostgreSQL; `TEST_REDIS_URL=redis://...` runs the whole suite on the Redis paths (limiter, presence, locks, cache invalidation) with a per-context key prefix. The default run needs neither. `TEST_DB=postgres` starts an embedded PostgreSQL for the run. Counts of the last full run are at the end of this document.
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
| `departments.test.ts`, `routing.test.ts`, `routing.concurrency.test.ts`, `routing-rules.test.ts` | department hours (start inclusive, end exclusive, zones, daylight saving, holidays by local date, next opening), configuration and its refusals, routing by mode (rotation, least busy, skills and language, manual pick), capacity (department, member, across departments), availability, overflow chains and loops, idempotency, seats that go away, the queue, service levels, transfer, notifications, what visitors are told; parallel handoffs, claims and the same ticket many times at once; routing rules (operators, order, validation, sandbox, tenant isolation) and choosing the department of a new widget conversation |
| `migrations.lint.test.ts` | no migration uses `writable_schema`, touches `sqlite_master` / `sqlite_schema` or runs a `PRAGMA`; a SQLite migration that drops a referenced table must carry `-- @sqlite-foreign-keys-off` |
| `agents.test.ts`, `agents-flow.test.ts` | AI agents: configuration and refusals, agent selection by channel, department and hours, the rules agent end to end (answer with sources and quick replies, clarification then hand-over, suggest only, confirmation resolves), every hand-off trigger and its off switch (including the multilingual request-for-a-person table), injection attempts, banned claims, ungrounded links, a failing, garbage or inventing model, the daily AI budget, redaction, tools (department, resolve, disallowed, audited, hidden from the visitor), classification and text helpers; quick replies (single tap under a double tap), talk to a person with and without an agent, take over and hand back, sandbox stores nothing, ratings and the review list, unanswered clustering, knowledge-base collections, concurrent messages and requests. Scripted models only: nothing runs against a real LLM |
| `visitor-info.test.ts` | visitor details: settings validation and defaults, department override, required fields at session start, which fields a card asks for (known values skipped, custom fields, moments, once per ticket, queue and no-agent wording), the AI tools, validation (email, E.164 phone with country, name, choice, unknown keys, consent), honeypot, another contact's address kept unverified without revealing it, skip rules, other visitors' and non-form messages refused, double submit, no personal data to the model when redacting |
| `calls.machine.test.ts`, `calls.test.ts` | calls: every legal and illegal transition and random walks of the state machine; placing and answering over real sockets (signalling reaches the other side only, durations and thread cards, audit and ticket events), what is refused (switched off, kinds, permission, offline visitor, no conversation, one live call also under racing invitations), declined, cancelled, missed and connect-timeout calls with the sweep run twice, races (accept and cancel, two ends, timeout and accept), who may signal (other visitors, other seats, other workspaces, second tab, oversized or mistyped signals), resume and the 20 s grace, call requests, TURN credentials (none, coturn HMAC with expiry, mocked Twilio token and failure), the call settings permission and the public config |
| `migrations.upgrade.test.ts` (tickets part) | migrations 027 and 028 on a populated 026 database (SQLite, PostgreSQL): nothing lost, no backfill, live-ticket and number uniqueness, cascades, system roles equal the catalogue, custom roles keep what they had, the guard trigger is back, drift against a fresh schema; on SQLite the application then opens ticket 1 for an old room with its next message |
| `migrations.upgrade.test.ts` (departments part) | migrations 029 and 030 on a populated 028 database (SQLite, PostgreSQL): nothing lost, old inboxes read as unconfigured departments, CHECK constraints, overflow reference clears on delete, rules cascade, permissions, drift against a fresh schema |
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

`web/src/**/*.test.ts(x)` (562 tests, Vitest + Testing Library + jsdom):

- socket-to-cache bridge (`message:new` dedupe by id and `client_msg_id`, updated/deleted/receipt, room reorder + unread bump, `room:*`, notifications)
- optimistic send state machine (ack before/after broadcast, failure, retry with the same `client_msg_id`, socket-to-REST fallback)
- composer channel rules (SMS 1599/1600, missing phone/email, opt-out, email sender/subject, notes always chat)
- unread badge logic, keyboard shortcuts (ignored while typing), grouping/day separators, mentions, relative times, filter params
- components: login, API error display incl. `AI_UNAVAILABLE`, message bubble variants (notes, system lines, ticks, failed + retry, quotes, attachments, voice-note player, image viewer), room list item (mentions shown as names), snooze menu, dropdown menu keyboard behaviour (Radix), widget preview and its contrast helper, settings and admin pages, charts
- `widget.test.ts`: the embeddable `server/public/widget.js` in jsdom with a fake fetch and fake Socket.IO client: shadow-DOM rendering, pre-chat form, optimistic send + ack merge, same-`client_msg_id` retry, REST fallback and resend on reconnect, typing/unread/receipts, safe text rendering, OTP flow, polling fallback, session restore

### Support automation, calls and AI

| Where | What |
| --- | --- |
| `migrations.upgrade.test.ts` (AI agents part) | migrations 031 and 032 on a populated 030 database (SQLite, PostgreSQL): nothing lost, knowledge entries read as ungrouped, constraints, cascades, `agents:manage` for owner and manager only, drift against a fresh schema |
| `web/src/calls/*.test.ts`, `CallSettings.test.tsx`, widget tests | the team engine and the visitor module under jsdom with a fake `RTCPeerConnection` (ringing, accept, negotiation, candidates queued before the description, mute and camera, screen share, resume after reconnect, ICE restart, failure reports, translation fallback), the call panel and the settings page |
| `ai-calls.test.ts`, `ai-calls.realtime.test.ts` | calls with the AI (SQLite and PostgreSQL): start and refusals, the loop, idempotent retries, hand-over, redaction, budgets, limits, sweeps, resume; the realtime engine against a local fake of the provider (secret minting, tools, the transcript monitor, budgets, the kill switch, every fallback), migration 036 |
| `agent-avatar.test.ts`, `chat-assets.test.ts` | portraits: magic bytes, size and dimension limits, animation, metadata stripped from PNG, JPEG and WebP, workspace scope, safe headers, the bundled allow-list and presets; the generated chat CSS is in step with the call modules |
| `team-calls.test.ts` | calls between teammates (SQLite and PostgreSQL): the flow, signalling isolation, presence and do-not-disturb, busy, races, rate limits, tenant isolation, timeouts and resume, a randomized state-machine test; migrations 038 and 039 |
| `call-links.test.ts` | call links (SQLite and PostgreSQL): token properties, expiry, reuse, revocation, wrong room and cross-tenant, one device, the call-scoped session's limits, the whole call with the team and with the AI, brute force, scrubbing of logs, error reports and the audit log, consent for email and SMS, the AI tool, settings; migration 040 |
| `web/src/calls/aicall*.test.ts`, `callpage.test.ts`, `teamEngine.test.ts` | the AI call module with a fake Web Speech API (loop, barge-in, silence, push-to-talk, hand-over, text fallback, the face, the realtime session), the call-link page (token stripped, one generic message, disclosure first, POST bodies only), the team engine |
| `e2e/tests/11-calls.spec.ts` | two real Chrome contexts against the built server with a synthetic camera, microphone and screen: connect over loopback, frames and audio flow both ways, mute reaches the other side, end closes both peers; decline and callback form, missed call, call request, buttons hidden when calls are off |
| `e2e/tests/12-ai-calls.spec.ts`, `13-team-calls.spec.ts`, `14-call-links.spec.ts` | real Chrome against the built server: AI calls with a fake Web Speech API (the loop, barge-in, silence, hand-over to a human call, no-speech fallback), calls between two teammates with the synthetic media, call links opened by a visitor with no chat open (AI and team) and the card in the widget with revocation. Not exercised: real speech, other browsers, real devices |
| `phone-calls.test.ts` | phone calls with a mocked Twilio: the create-call request (To, From, URLs, events, idempotency token, the workspace's own credentials), TwiML for the answered agent leg, status callbacks of both legs to active and ended with duration and card, no full numbers in audit, events or the call row, hang-up by the right seat only, every outcome of both phones, repeated and out-of-order callbacks, every guard (off, no Twilio, no caller ID, no countries, no number, no consent or consent for another number, opt-out, country, premium-rate, quiet hours in the contact's zone and wrap past midnight, agent number, 10 an hour, daily limit under parallel requests and across days, one live call), Twilio refusals and the sweep time-outs, webhook authentication (wrong token, unknown connection, missing call id, another workspace's call, foreign legs), the consent card end to end, settings validation and readiness |
| `support-analytics.test.ts` | the support overview (tickets opened and resolved, containment, hand-off rate and reasons, median wait for a person, ratings by handler, departments, AI agents, calls) against its JSON Schema, an empty period, the tickets and calls exports (schema, order, resumable cursor, keyed people, no free text or numbers), `ticket_id` in messages-meta, scopes, workspace isolation, the dashboard route |
| `agents.eval.test.ts`, `agents.eval.report.test.ts` | 51 golden cases with thresholds (`npm run eval:agent` prints the table), injection and hand-off cases never reach the model, a hostile model cannot get banned claims, ungrounded promises or invented links through |
| `seed-ai.test.ts` | `SEED_AI=1` builds the departments, the AI agent, entries with links and calls; the plain seed has none of it |
| `web/src/pages/SupportAnalytics.test.tsx` | the dashboard's support section |
| `group-calls.test.ts`, `web/src/calls/groupEngine.test.ts` | group calls (SQLite and PostgreSQL): the participant state table, ringing on every tab, cards, signalling to the addressed person only, refusals (off, direct messages, too many people, permission, viewers), busy and do-not-disturb people skipped, two joins for the last place, leaves during an offer, one screen share, mute and camera flags, inviting up to the cap, missed invitees, resume and the grace period, tenant isolation, a randomized test of the invariants; migration 041; the browser mesh engine with a fake `RTCPeerConnection` (the newcomer offers, ICE restart only where it is the offerer, speaker highlight, screen share replacing the video on every link) |
| `push.test.ts`, `web/src/pages/settings/PushSettings.test.tsx` | Web Push: RFC 8291 encryption against the RFC's worked example, VAPID JWT verified with the public key, subscriptions (own devices only, endpoint never returned, allow-list of push services, limits), expired and failing devices, which events are pushed when (app open or closed, do not disturb, previews off), rate limits, retries through the queue, tenant isolation; migration 042; the settings section |
| `avatar.test.ts`, `web/src/calls/aicall.photoreal.test.ts`, `PhotorealAvatarSettings.test.tsx` | the photoreal avatar against a local fake of the D-ID endpoints: connect (encrypted, write-only, last four only, never in logs or audit), test connection, disconnect, the instance key and the kill switch, avatars and consent, per-agent choice, negotiation, SDP and ICE relay, speaking replies, budget and concurrency, every failure falls back to the built-in face, sweeps; migration 043; the visitor's video element and fallback; the settings page. Nothing runs against D-ID |
| `ai-channels.test.ts`, `AiChannelSettings.test.tsx` | AI agents on SMS and email with fake providers and a scripted model (see [AI-AGENTS.md](AI-AGENTS.md#ai-agents-on-sms-and-email)) |
| `transcripts.test.ts`, `TranscriptSettings.test.tsx`, widget tests | transcripts: who may receive a copy (verified session, consent outside the pre-chat form), contents (no notes or internal lines), masking, limits, the automatic copy once per ticket, unsubscribe, the AI tool, test mode, audit; migration 044 |
| `prechat.test.ts`, `DepartmentSettings.test.tsx`, widget tests | pre-chat custom fields: required fields enforced at session start, optional ones stored once and not asked again in the thread, checkbox values, consent required with an email or phone, department overrides of field modes and consent wording |
| `e2e/tests/15-group-calls.spec.ts` | three Chrome contexts: a group video call rings two people, a mesh of connections with media both ways, speaker highlight, mute, one screen share at a time, the host leaves and it goes on, the last leaves and it ends |
| `e2e/tests/16-push.spec.ts` | Settings lists a device and sends a test through a fake push service on loopback; the real service worker shows a pushed notification (delivered through DevTools); a missed teammate call is pushed. Not exercised: real push services |
| `e2e/tests/17-photoreal.spec.ts` | connect a key, test it, add an avatar, give it to an agent, switch it on; a video call whose stream cannot connect falls back to the built-in face (fake provider) |
| `e2e/tests/18-ai-sms-email.spec.ts` | a text and an email through the built server's webhooks are answered by the AI in plain text with the disclosure, shown as not sent in test mode; an out-of-office reply is not answered |
| `e2e/tests/19-transcripts.spec.ts` | a visitor asks for a copy, gives an address with consent in the chat and gets it (test mode says so); a team member sends one from the conversation menu |
| `e2e/tests/20-prechat-fields.spec.ts` | the pre-chat form with custom fields in the widget and the hosted chat, validation, consent, and an axe check |

## Counts of the last full run

Run on 2026-10-21 on one development machine (macOS, Node 24), with the e2e suite running at the same time as the unit suites:

| Suite | Command | Result |
| --- | --- | --- |
| Server, SQLite | `npm test --prefix server` | 1,565 passed, 69 skipped (85 files) |
| Server, PostgreSQL | `TEST_DB=postgres npm test --prefix server` | 1,591 passed, 43 skipped |
| Web | `npm test --prefix web` | 562 tests in 64 files |
| Edge | `npm test --prefix edge` | 3 passed |
| End-to-end script | `npm run e2e` | passed |
| Browser (Playwright, `app` project) | `npx playwright test --project=app` | 105 tests |
| Docs | `npm run docs:check --prefix server` | ok |

Known flaky under heavy load: the team-chat history paging test (`09-team-chat`, scrolls 160 messages) and the transcripts e2e have each failed once while other suites ran alongside and passed when re-run.
