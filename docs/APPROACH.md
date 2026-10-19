# Approach

How the product was built, why, and the judgment calls made where the brief or the legacy behaviour was ambiguous. Read `ARCHITECTURE.md` for the system itself and `MIGRATION-NOTES.md` for the legacy mapping.

## 1. Goals

Rebuild the live "Support" generation of the legacy conversations product (unified inbox for live chat, SMS and email) as a clean, standalone application: its own auth and tenancy, its own minimal CRM, no dependency on any platform service. Fix the documented legacy defects rather than port them. Everything advertised is implemented and tested; nothing is a stub.

## 2. Stack choices and why

| Choice | Reason |
| --- | --- |
| Hono + `@hono/node-server` | tiny, typed, testable with `app.request()` (no sockets needed for most tests) |
| Socket.IO 4 on the same HTTP server | required; one process, one port, reuses the dynamic-namespace feature for per-workspace isolation |
| `node:sqlite` (`DatabaseSync`) | zero native deps, WAL, synchronous API makes transactional invariants simple to reason about |
| Hand-written repository functions, SQL migrations | no ORM; every query visibly carries `workspace_id` |
| `zod` 4, `jose`, `node:crypto` scrypt | contract |
| `libphonenumber-js` | E.164 normalisation with a workspace default region (legacy hard-coded US) |
| `sanitize-html` | a vetted allow-list HTML sanitiser instead of a home-grown one |
| `fetch` adapters for Twilio / SendGrid | no heavy SDKs; trivially unit-testable with a mocked `fetch` |
| `@anthropic-ai/sdk` | contract (model from `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`) |
| Vitest, `socket.io-client` in tests | real Socket.IO round trips against an ephemeral port |

Services are plain functions taking an explicit `AppContext` (db, clock, bus, providers, storage, AI). The clock is injectable (`ctx.clock()`), so every time-dependent rule (snooze, OTP expiry, 30-day sessions, edit window, retry backoff, digests) is tested deterministically.

## 3. Design principles

1. **The database is the arbiter of invariants.** One live room per contact, message idempotency, per-room ordering, number locks, token-per-domain and webhook idempotency are unique indexes; code handles the constraint violation by returning the winner. Multi-step changes are single `BEGIN IMMEDIATE` transactions. Because the SQLite driver is synchronous, the "check then insert" windows that caused legacy races do not exist inside a transaction.
2. **One definition of scope.** `roomVisibility()` builds the SQL predicate used by list, get, messages, search, counts, socket joins and AI; `canSeeRoom()` reuses it. Out of scope means 404.
3. **Computed, not stored, counters.** Unread is `COUNT(messages after my read cursor)`; marking read is one `UPSERT` of the cursor that only moves forward.
4. **Interfaces at every external edge** (`SmsProvider`, `EmailProvider`, `Storage`, `AiProvider`, `RealtimeBus`) with deterministic fakes so tests never touch a network.
5. **Degrade, don't break.** AI outages, provider outages and background-job failures never prevent receiving or sending ordinary messages.

## 4. Decisions where the brief was open

| Topic | Decision |
| --- | --- |
| IDs | prefixed random ids (`ws_` + 24 hex, `room_...`, `msg_...`); workspace id format is validated for Socket.IO namespaces |
| Timestamps | ISO-8601 UTC strings; ordering inside a room uses `seq`, never the timestamp |
| JWT | access token only (12 h by default), no refresh tokens; the seat (role, flags) is re-read from the DB on every request/event so revocation is immediate. A user in several workspaces logs in with `workspace_id` to pick one |
| Seat vs role | `members.id` is the seat id used everywhere; removal is soft (`removed_at`) so history keeps names. Agents default to `inbox_visibility = assigned_inbox` |
| Unassigned rooms without an inbox | visible to owners/managers only (agents would otherwise never see them); the widget can route new chats with `widget.default_inbox_id` |
| Auto-assign | replying to an unassigned room (non-note) assigns the replying agent server-side (legacy did it in the UI) |
| Agent permissions | agents can assign a room to themselves or unassign themselves; reassigning others and changing the inbox needs owner/manager (legacy `conversation.reassign`) |
| Reopen rules | a contact message, an agent message or an agent note reopens a closed room and writes a `Conversation reopened` system line (reason recorded); bot and system messages never reopen. Any non-system message (bot included) clears a snooze |
| Closing | closing frees the SMS number locks of that room and clears any snooze; closing an already closed room is a no-op |
| Snooze | must be in the future and within a year, validated before any write; closed rooms cannot be snoozed; the wake job is conditional so it is idempotent |
| `waiting_longest` | customers waiting longest first, measured from the **first** unanswered contact message after the last agent reply (notes do not count as replies); rooms nobody is waiting on sort last |
| Room list paging | page/limit (max 100) with `has_more`; the web app uses infinite scroll over pages and patches the cache from socket events |
| Message content | `format: "text"` (default, escaped) or `"html"` (allow-list sanitised) for dm/email; SMS is always plain text. `content_text` is the plain rendering used for search, snippets and AI |
| Mentions | `@[Name](mem_id)` tokens and bare `@email-localpart`; parsed for **notes only** (so a customer never receives mention markup), only for seats that can see the room |
| Search | literal substring match over `content_text` (`LIKE ... ESCAPE`), scope-aware, excludes deleted and system lines |
| Edit/delete | edit own dm/note within `edit_window_seconds` (default 900, 0 disables); sent SMS/email cannot be recalled; agents delete own messages, managers any; deletion is soft and re-points the room's last message |
| SMS body limit | the brief says "< 1600 chars": 1599 is accepted, 1600 and 1601 are rejected (Twilio's own limit is 1600; being one short is the conservative reading of the brief) |
| SMS number choice | default number first; a room keeps its number; numbers locked to the same recipient by another room are skipped; all locked -> `SMS_NUMBERS_EXHAUSTED` |
| Email subject | explicit subject, else `Re: <room subject>`, else `Re: <first 70 chars of the first contact message>` with an ellipsis only when truncated, else `Re: Your conversation`. The chosen subject is stored on the room |
| Email threading | we generate `Message-ID`, set `In-Reply-To` to the latest id in the room and `References` to the chain (last 20). Inbound mail matches by `In-Reply-To`/`References` first, then by (contact email) lock, else creates contact + room. SendGrid may rewrite `Message-ID`; delivery events also match on `smtp-id` and the provider message id |
| Send flow | store first (`delivery = pending`), then provider send; on failure the message is **kept** as `failed` with the reason and (for transient errors) an exponential-backoff retry job; permanent errors wait for a manual retry. A contact who opts out between attempts is never texted |
| Credits | `usage_ledger` + `workspaces.credit_balance`; unlimited unless the workspace turns `credits_enforced` on; checked before a send, debited only after a successful provider send |
| Webhook auth when unconfigured | in production an unconfigured Twilio token / shared secret returns 503; in development/test it is accepted with a warning so the app runs with zero env |
| Embed tokens | tokens are publishable identifiers (they live in page source), so they are stored in clear and protected by the Origin allow-list; the settings UI can show the snippet again at any time. Wildcard `*.example.com` matches subdomains at any depth but not the apex |
| Unverified visitors | see only rooms created in their own session. A session for a contact that already has a conversation from another device is flagged `requires_verification`; creating/using that room returns `VERIFICATION_REQUIRED` until the OTP succeeds. Same-device continuity (same contact + `x-device-id`) carries the conversation and verification to the new session |
| OTP | 5 digits, HMAC-stored, 120 s expiry (valid at 119.999 s, expired at 120.000 s), max 5 wrong attempts then the code is dead, 30 s resend cooldown, single use, bound to the session; email if the contact has one, otherwise SMS from the default workspace number |
| Presence | refcounted per seat with a 5 s grace period; visitor presence is per contact |
| Notifications | in-app feed + `notification:new`; offline email only to the **assigned_to_you** tier (and mentions); the digest covers unanswered messages 2-60 minutes old and skips seats already emailed. Per-seat tier preferences, DND, availability `inactive`, and snoozed rooms are honoured |
| Digest unread rule | digest recipients must have unread messages by the cursor rule, which excludes rooms assigned to someone else; so team members are digested for *unassigned* rooms (and managers always for unassigned), not for rooms a colleague owns |
| AI | on-demand features (suggestions, summary, rephrase) are always available; triage and the widget auto-responder are workspace opt-in and default off. See `AI.md` |
| Web push | out of scope (brief); in-app + email only |
| Reactions, team chat, prospect channels | out of scope |

## 5. What changed versus the legacy product, and why

See `MIGRATION-NOTES.md` for the full table. In short: server-side message idempotency, unique-index-backed single room per contact, cursor-based unread, bounded mark-read, refcounted presence, namespace-verified visitor sessions, per-event authorisation, snooze validated before write, working message search, correct `waiting_longest`, failed sends kept and retried, a digest that actually sends, a deterministic round-robin that advances correctly, signed webhooks that are idempotent, and one clear sender vocabulary (`agent|contact|bot|system`) instead of `conversation|support`.

## 6. Security notes

- Secrets only via environment; nothing is committed. The legacy repository contains a connection string with credentials in a `.env.sample` file; **it was deliberately not copied and should be rotated** (see the migration notes).
- Production boot fails without `JWT_SECRET`; webhook endpoints fail closed (503) in production if their verification secret is not configured.
- All inputs are validated with zod; unknown keys are stripped; JSON bodies are size-limited (1 MB default, uploads 10 MB).
- Cross-tenant access returns 404 and is covered by tests for REST, sockets (team JWT and visitor session) and public endpoints.
- Visitor-supplied content is only ever rendered as text by the widget; agent HTML goes through the allow-list sanitiser; AI prompts treat conversation text as untrusted data and AI output is schema-validated and guarded against ungrounded money commitments.
- Uploads: magic-byte sniffing, extension must match content, SVG is never treated as an image, server-generated storage keys (no user input in paths), signed expiring URLs, `nosniff` and sandbox CSP.

## 7. Known limitations (honest list)

- SQLite is single-writer: run one replica. Presence and socket rate limits are per node even with the Redis adapter.
- Inbound email attachments are not ingested (text/HTML only); outbound email supports attachments.
- No MMS (SMS is text/quote only, per the brief).
- The widget collects text messages only (no file upload from visitors).
- Contact-facing email digests (the legacy "you have an unread reply" email to the visitor) are not implemented; only team digests are.
- The Redis adapter path is implemented but not exercised in CI (no Redis in the test environment).
- Real Twilio/SendGrid behaviour is covered by mocked-`fetch` tests; no live provider calls are made by the test suite.
