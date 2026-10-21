# Rate limiting

One layered limiter used by REST, the widget, provider webhooks, outbound sends and Socket.IO. Implementation: `server/src/ratelimit/`.
Spec it follows: `analysis/RATE-LIMIT-SPEC.md` (an internal brief). Everything below states what is implemented and tested, and what is not.

## Design in one page

* **Decisions are made by a central policy registry** (`policies.ts`). A policy is `{ id, keyBy, algo, limit, window, burst, cost, onFail, tiers, penalty, lease }`.
  Routes and socket events refer to policies by id in one declaration (`routePolicies.ts`). Two tests fail the build when a registered route or socket
  event has no declaration, when a declaration names a missing route, or when a policy is never applied (`tests/ratelimit.http.test.ts`).
* **Layers, cheapest first, short-circuiting:** (1) `ip.global` per client IP; (2) the route class (public, auth, API, upload, import, AI, webhook);
  (3) the principal (user, visitor session); (4) the workspace quota with **plan tiers** (free / pro / business, overridable per workspace);
  (5) a concurrency cap for heavy routes. Pre-authentication layers run in a global middleware; principal layers run when the auth middleware knows who the caller is.
* **Algorithms** (`algorithms.ts`, shared by the memory store and ported line for line to Lua):
  * **GCRA** for rates (per second/minute): one number per key (the theoretical arrival time), smooth with a configurable burst, and an *exact* `Retry-After`
    (the test retries one millisecond early and exactly on time).
  * **Sliding-window counter** (two adjacent fixed windows, weighted by overlap) for hour/day quotas: AI calls, SMS/email sends, OTP per contact.
    Its `Retry-After` is a close lower bound, not exact (stated in the test).
  * **Concurrency lease** (ZSET of lease ids with expiry scores) for in-flight caps and socket counts; released in `finally`, expires on crash, renewed by live sockets.
  * **Cost-weighted** calls: every check takes a `cost` (import = 5 of a 10-unit bucket, socket `typing` = 0.25, `message:send` = 2).
  * **Penalty box**: repeated violations inside a window raise a block that escalates 1 min -> 5 min -> 30 min -> 24 h; one level is forgiven per 6 h of good behaviour,
    counted from the end of the last block. **Strike policies** (failed logins, bad webhook signatures) use only the penalty box and lock out per key.
* **Storage:** Redis when `REDIS_URL` is set (one atomic Lua call per decision, `EVALSHA` with automatic reload after `SCRIPT FLUSH`, server time from `TIME`, a TTL on every
  key, `{hash tag}` per decision so Cluster keeps it in one slot), otherwise an in-memory store with a bounded LRU and a periodic sweep. Same interface, same semantics.
* **Local lease tier** (`lease: true`, hot non-security GCRA policies only): a node takes a batch (10% of the burst) from the shared bucket in one call and spends it
  locally. The tokens are deducted from the shared bucket when leased, so **the cluster can never admit more than limit + burst**; the cost is under-admission:
  unspent leased tokens expire after `RATELIMIT_LEASE_TTL_MS` (1 s), so a key can be refused slightly early, by at most `nodes x batch` tokens per lease TTL.
  (The spec describes the opposite trade, over-admission; this design chooses never to over-admit. Concurrent requests for one key share a single lease call.)
  Auth, webhook, OTP and all penalty policies never lease: always exact.
* **Failure policy per policy:** `fail-open` (default; the node falls back to a per-node in-memory bucket with the same numbers, logged and counted as `fail_open`) or
  `fail-closed` (auth, webhooks, widget session/OTP: refused with 503 + `Retry-After`). Redis calls have a time budget (`RATELIMIT_REDIS_TIMEOUT_MS`, default 30 ms) and a
  circuit breaker (`RATELIMIT_BREAKER_FAILURES` consecutive failures open it for `RATELIMIT_BREAKER_OPEN_MS`), so an outage costs one timeout, not one per request.
* **Client IP** (`util/clientIp.ts`): `CF-Connecting-IP` only with the shared-secret header (`CF_SHARED_SECRET`); `X-Forwarded-For` only behind trusted proxies and then the entry
  `TRUSTED_PROXY_HOPS` from the **right** (the left side is client-controlled); invalid values ignored; IPv4-mapped IPv6 collapses to IPv4; other IPv6 is limited per **/64**.
* **Key hygiene:** every key is `<prefix>:rl:{<policy>:<sha1(principal) 16 chars>}:<kind>`: namespaced by environment prefix and policy, hashed (no addresses or emails in Redis),
  length-bounded; the memory store is an LRU (bounded cardinality).
* **Idempotency:** a repeat of the same `Idempotency-Key` header (REST writes) or `client_msg_id` (message sends, REST and socket) inside the policy window is waved through without
  spending again.

## HTTP contract

Every response from a limited route carries, for the tightest policy that applied to the caller:

```
RateLimit-Policy: "api.read";q=20;w=1
RateLimit: "api.read";r=97;t=1
X-RateLimit-Limit: 20            X-RateLimit-Remaining: 97         X-RateLimit-Reset: 1
```

A refused request is `429` (or `503` for a full concurrency cap or a fail-closed policy whose store is down) with an integer `Retry-After` (seconds) and

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests", "retry_after_s": 7, "policy": "public.config" } }
```

`code` is `OVERLOADED` for 503s. Only the caller's own state is ever reported.

## Socket.IO

| Concern | Mechanism |
| --- | --- |
| Handshake flood | `ws.connect.ip` per IP; refusal carries `retry_after_ms` with jitter |
| Reconnect storm | admission control before any database work: refuses (`OVERLOADED`, jittered `retry_after_ms`) when the event loop's p99 lag over the last second exceeds `SHED_LOOP_LAG_MS` (250), when more than `WS_MAX_HANDSHAKES` (500) handshakes are in flight, or at `WS_MAX_CONNECTIONS` |
| Concurrent sockets | `ws.conn.user`, `ws.conn.visitor`, `ws.conn.workspace` (plan tier; enforced when `PLAN_ENFORCEMENT=true` or `WS_MAX_CONNECTIONS_PER_WORKSPACE` is set), `ws.conn.ip`: shared leases with a 5-minute TTL renewed by the owning node every 100 s |
| Event rate | per-socket bucket (exact, node-local) with per-event cost weights, plus `ws.actor` per user across all their sockets and nodes |
| Violations | the event is dropped with an ack `{ ok: false, error: { code: "RATE_LIMITED", retry_after_ms }, retry_after_ms }`; `WS_STRIKE_LIMIT` (25) drops within 60 s emit `rate:limited` and disconnect the socket |
| Message sends | `msg.room`, `msg.workspace` (plan tier), per user/visitor, deduplicated by `client_msg_id` |
| Slow consumers / payload size | outbound queue cap (`WS_MAX_WRITE_BUFFER`), inbound frame cap (`WS_MAX_BUFFER_BYTES`) |

## Outbound provider sends

SMS and email are **paced, not rejected**: `sms.number` (1/s per sending number) and `email.sender` (10/s) reserve the next slot; a message whose slot is not now stays `pending`
and a delayed `paced_send` job sends it (with a short in-process nudge for the database queue). Past `SEND_QUEUE_MAX` slots per number the send falls back to
retry-with-backoff. Quotas (`sms.workspace`, `email.workspace`, `sms.contact`) are rejected with 429. A workspace whose own send backlog exceeds
`SEND_QUEUE_WORKSPACE_MAX` gets 429 on new external sends; other workspaces are unaffected. Due jobs are taken round-robin per workspace (`runDueJobs`, 5 per workspace per pass).

## Policy table

Generated from `policies.ts` and `routePolicies.ts` (`npm run docs:ratelimit`; `docs:check` fails when it is stale).

<!-- policies:start -->
| Policy | Keyed by | Algorithm | Limit | Plan tiers | Failure mode | What it protects (where) |
| --- | --- | --- | --- | --- | --- | --- |
| `ip.global` | ip | gcra | 100 per 1 s, burst 400 | - | fail-open + lease | Every HTTP request, per client IP (/64 for IPv6). Cheapest check, runs first. (socket server / delivery) |
| `auth.login.ip` | ip | gcra | 10 per 1 min, burst 10 | - | fail-closed + penalty box | Login attempts per IP (POST /api/auth/login) |
| `auth.register.ip` | ip | gcra | 10 per 1 min, burst 10 | - | fail-closed + penalty box | Workspace registrations per IP (POST /api/auth/register) |
| `auth.fail.account` | composite | strike | 5 failures / 15 min | - | fail-closed | Failed logins per account (hashed email): 5 failures in 15 min lock the account, escalating 1 min -> 5 min -> 30 min -> 24 h (POST /api/auth/login) |
| `auth.fail.ip` | ip | strike | 20 failures / 15 min | - | fail-closed | Failed logins per IP: 20 failures in 15 min block the IP, escalating (POST /api/auth/login) |
| `auth.refresh.ip` | ip | gcra | 60 per 1 min, burst 60 | - | fail-open | Refresh-token exchanges per IP (POST /api/auth/refresh, POST /api/auth/logout) |
| `auth.mfa.ip` | ip | gcra | 10 per 1 min, burst 10 | - | fail-closed + penalty box | Second-factor submissions per IP (POST /api/auth/mfa/verify) |
| `auth.fail.mfa` | composite | strike | 5 failures / 15 min | - | fail-closed | Wrong second-factor codes per user: 5 in 15 min lock the second step, escalating (POST /api/auth/mfa/verify) |
| `auth.forgot.ip` | ip | window | 10 per 1 h | - | fail-closed | Password-reset requests per IP per hour (POST /api/auth/password/forgot) |
| `auth.forgot.email` | composite | window | 3 per 1 h | - | fail-closed | Password-reset requests per address per hour (stops mail bombing) (POST /api/auth/password/forgot) |
| `auth.reset.ip` | ip | gcra | 10 per 10 min, burst 10 | - | fail-closed + penalty box | Password-reset and invitation token submissions per IP (POST /api/auth/password/reset, GET /api/auth/invitations/:token, POST /api/auth/invitations/accept) |
| `admin.login.ip` | ip | gcra | 5 per 1 min, burst 5 | - | fail-closed + penalty box | Platform admin sign-in steps per IP (5 per minute) (4 entry points) |
| `admin.fail.account` | composite | strike | 5 failures / 15 min | - | fail-closed | Failed platform admin logins per account: 5 in 15 min lock it, escalating (4 entry points) |
| `admin.fail.ip` | ip | strike | 10 failures / 15 min | - | fail-closed | Failed platform admin logins per IP: 10 in 15 min block the IP, escalating (4 entry points) |
| `admin.fail.mfa` | composite | strike | 5 failures / 15 min | - | fail-closed | Wrong platform admin second-factor codes per admin: 5 in 15 min lock the second step, escalating (4 entry points) |
| `admin.api` | user | gcra | 10 per 1 s, burst 40 | - | fail-closed | Platform admin API calls, per admin (18 entry points) |
| `public.config` | ip | gcra | 60 per 1 min, burst 60 | - | fail-open | Widget config fetch, per IP (GET /public/widget/config, GET /chat, GET /chat/bridge-test) |
| `public.session` | composite | gcra | 20 per 1 min, burst 20 | - | fail-closed + penalty box | Visitor session creation, per IP + Origin + embed token (POST /public/sessions) |
| `public.room` | visitor | gcra | 10 per 50 s, burst 10 | - | fail-open | Visitor starts a conversation (POST /public/rooms) |
| `public.send` | visitor | gcra | 30 per 30 s, burst 30 | - | fail-open | Visitor sends a message (5 entry points) |
| `public.read` | visitor | gcra | 60 per 30 s, burst 60 | - | fail-open | Visitor read receipts (6 entry points) |
| `public.query` | visitor | gcra | 10 per 1 s, burst 40 | - | fail-open + lease | Visitor reads (session, rooms, messages) (GET /public/session, GET /public/rooms, GET /public/rooms/:id/messages) |
| `public.upload` | visitor | gcra | 10 per 1 min, burst 10 | - | fail-closed | Visitor file uploads (camera and photo attachments), 10 per minute per visitor (POST /public/attachments) |
| `public.otp.send` | visitor | gcra | 5 per 10 min, burst 5 | - | fail-closed + penalty box | OTP sends per visitor session (5 per 10 min) (POST /public/otp/send) |
| `public.otp.contact` | composite | window | 10 per 1 d | - | fail-closed | OTP sends per contact per day (caps cost of SMS pumping) (POST /public/otp/send) |
| `public.otp.ip` | ip | window | 30 per 1 h | - | fail-closed | OTP sends per IP per hour (POST /public/otp/send) |
| `public.otp.verify` | visitor | gcra | 10 per 5 min, burst 10 | - | fail-closed + penalty box | OTP verification attempts per visitor session (POST /public/otp/verify) |
| `msg.room` | composite | window | 300 per 1 min | - | fail-open | Messages per room (visitor + agents together): stops a runaway client or loop (7 entry points) |
| `msg.workspace` | workspace | window | 5000 per 1 h | free 5000, pro 50000, business 500000 | fail-open | Messages per workspace per hour, by plan (7 entry points) |
| `team.send` | user | gcra | 90 per 1 min, burst 40 | - | fail-open | Team chat messages, per member (REST and socket) (POST /api/team/channels/:id/messages, socket team:message:send) |
| `team.channel` | composite | window | 300 per 1 min | - | fail-open | Team chat messages per channel per minute: stops a runaway client or loop (POST /api/team/channels/:id/messages, socket team:message:send) |
| `team.workspace` | workspace | window | 20000 per 1 h | free 20000, pro 200000, business 2000000 | fail-open | Team chat messages per workspace per hour, by plan (POST /api/team/channels/:id/messages, socket team:message:send) |
| `team.search` | user | gcra | 20 per 1 min, burst 10 | - | fail-open | Team chat searches, per member (20 per minute) (GET /api/team/search) |
| `team.create` | workspace | window | 100 per 1 h | - | fail-open | Channel and group message creation per workspace per hour (POST /api/team/channels, POST /api/team/dms) |
| `api.read` | user | gcra | 20 per 1 s, burst 100 | - | fail-open + lease | Authenticated reads, per user (64 entry points) |
| `api.write` | user | gcra | 10 per 1 s, burst 50 | - | fail-open + lease | Authenticated writes, per user (118 entry points) |
| `api.workspace` | workspace | window | 1200 per 1 min | free 1200, pro 6000, business 30000 | fail-open | All API calls per workspace per minute, by plan (195 entry points) |
| `api.send` | user | gcra | 120 per 1 min, burst 60 | - | fail-open | Agent message sends, per user (POST /api/rooms/:id/messages) |
| `api.upload` | user | gcra | 30 per 1 min, burst 30 | - | fail-open | Uploads, per user (POST /api/attachments, POST /api/team/attachments) |
| `api.import` | workspace | gcra | 10 per 10 min, burst 10 | - | fail-open | CSV imports (cost 5 of a small bucket), per workspace (POST /api/contacts/import) |
| `heavy.concurrency` | workspace | concurrency | 2 concurrent | - | fail-open | Concurrent heavy requests (imports) per workspace (POST /api/contacts/import) |
| `ai.minute` | user | gcra | 30 per 1 min, burst 20 | - | fail-open | AI calls, per user (4 entry points) |
| `ai.workspace` | workspace | window | 200 per 1 d | free 200, pro 5000, business 50000 | fail-open | AI calls per workspace per day, by plan (4 entry points) |
| `ai.concurrency` | workspace | concurrency | 4 concurrent | - | fail-open | Concurrent AI calls per workspace (4 entry points) |
| `analytics.read` | apiKey | gcra | 60 per 1 min, burst 60 | - | fail-open | Analytics API reads, per API key (60 per minute) (4 entry points) |
| `analytics.export` | apiKey | gcra | 10 per 1 min, burst 10 | - | fail-open | Analytics exports, per API key (10 per minute) (GET /api/v1/analytics/export/rooms, GET /api/v1/analytics/export/messages-meta) |
| `analytics.workspace` | workspace | window | 120 per 1 min | free 120, pro 600, business 3000 | fail-open | Analytics API calls per workspace per minute, by plan (6 entry points) |
| `analytics.concurrency` | apiKey | concurrency | 2 concurrent | - | fail-open | Concurrent exports per API key (GET /api/v1/analytics/export/rooms, GET /api/v1/analytics/export/messages-meta) |
| `billing.checkout` | user | gcra | 10 per 1 min, burst 10 | - | fail-open | Creating Stripe checkout/portal/onboarding sessions, per user (each is a paid API call to Stripe) (5 entry points) |
| `payments.workspace` | workspace | window | 20 per 1 h | free 20, pro 300, business 3000 | fail-open | Customer payment requests per workspace per hour, by plan (POST /api/rooms/:id/payment-requests) |
| `channels.verify` | user | gcra | 6 per 1 min, burst 6 | - | fail-open | Credential checks and number/sender imports (read-only provider calls), per user (POST /api/channels/:channel/verify, POST /api/channels/sms/numbers/import, POST /api/channels/email/senders/import) |
| `channels.test` | workspace | window | 10 per 1 h | - | fail-closed | Test texts and test emails per workspace per hour (they cost the workspace money at its provider) (POST /api/channels/:channel/test) |
| `webhook.connection` | composite | gcra | 20 per 1 s, burst 100 | - | fail-open | Inbound provider events per workspace connection (its webhook id), 20/s with a burst of 100 (4 entry points) |
| `webhook.provider` | ip | gcra | 300 per 1 min, burst 300 | - | fail-closed | Provider webhooks (Twilio, SendGrid), per IP (8 entry points) |
| `webhook.stripe` | ip | gcra | 600 per 1 min, burst 600 | - | fail-open | Stripe webhooks (platform and Connect), per IP. Signature-verified; Stripe retries what is delayed (POST /webhooks/stripe, POST /webhooks/stripe/connect) |
| `webhook.badsig` | ip | strike | 10 failures / 10 min | - | fail-closed | Webhook signature failures per IP: 10 in 10 min block the IP, escalating (10 entry points) |
| `sms.number` | composite | gcra | 1 per 1 s, burst 1 | - | fail-open | SMS pacing per sending number (carrier-friendly: 1 message/s, queue instead of reject) (POST /api/rooms/:id/messages, socket message:send) |
| `email.sender` | composite | gcra | 10 per 1 s, burst 10 | - | fail-open | Email pacing per sender address (10/s, queue instead of reject) (POST /api/rooms/:id/messages, socket message:send) |
| `sms.workspace` | workspace | window | 100 per 1 d | free 100, pro 2000, business 20000 | fail-open | SMS sends per workspace per day, by plan (rejected with 429 once exceeded) (POST /api/rooms/:id/messages, socket message:send) |
| `email.workspace` | workspace | window | 500 per 1 d | free 500, pro 10000, business 100000 | fail-open | Email sends per workspace per day, by plan (POST /api/rooms/:id/messages, socket message:send) |
| `sms.contact` | composite | window | 20 per 1 h | - | fail-open | SMS to one contact per hour (anti-harassment cap) (POST /api/rooms/:id/messages, socket message:send) |
| `ws.connect.ip` | ip | gcra | 20 per 1 s, burst 40 | - | fail-open | Handshake attempts per IP (reconnect storms) (socket server / delivery) |
| `ws.conn.user` | user | concurrency | 20 concurrent | - | fail-open | Concurrent sockets per team seat (socket server / delivery) |
| `ws.conn.visitor` | visitor | concurrency | 5 concurrent | - | fail-open | Concurrent sockets per visitor session (socket server / delivery) |
| `ws.conn.workspace` | workspace | concurrency | 500 concurrent | free 500, pro 5000, business 100000 | fail-open | Concurrent sockets per workspace, by plan (enforced when PLAN_ENFORCEMENT=true) (socket server / delivery) |
| `ws.conn.ip` | ip | concurrency | 1000 concurrent | - | fail-open | Concurrent sockets per IP (WS_MAX_CONNECTIONS_PER_IP; 0 = off) (socket server / delivery) |
| `ws.event` | socket | gcra | 10 per 1 s, burst 30 | - | fail-open | Socket events per socket, cost-weighted per event (see EVENT_LIMITS) (socket server / delivery) |
| `ws.actor` | composite | gcra | 40 per 1 s, burst 120 | - | fail-open | Socket events per user/visitor across all their sockets and nodes (socket server / delivery) |

Socket event costs (per-socket bucket, `ws.event`):

| Event | Cost |
| --- | --- |
| `message:send` | 2 |
| `message:read` | 1 |
| `room:create` | 5 |
| `room:update` | 2 |
| `room:assign` | 2 |
| `typing` | 0.25 |
| `otp:verify` | 5 |
| `presence:list` | 1 |
| `call:invite` | 5 |
| `call:request` | 5 |
| `call:accept` | 2 |
| `call:decline` | 2 |
| `call:end` | 2 |
| `call:connected` | 1 |
| `call:failed` | 1 |
| `call:resume` | 2 |
| `call:offer` | 2 |
| `call:answer` | 2 |
| `call:ice` | 0.25 |
| `team:message:send` | 2 |
| `team:typing` | 0.25 |
| `team:read` | 1 |
| `team:reaction` | 1 |
<!-- policies:end -->

## Operations

* Metrics: `conv_ratelimit_decisions_total{policy,outcome}` (outcomes: allowed, limited, blocked, shed, fail_open, fail_closed, allowlisted, denylisted, idempotent),
  `conv_ratelimit_redis_duration_seconds`, `conv_ratelimit_lease_total{result}`, `conv_ratelimit_breaker_open`, `conv_ratelimit_penalty_box_size`, `conv_ws_shed_total{reason}`,
  `conv_ws_strikes_total{result}`. Labels are bounded (policy ids x a closed outcome set).
* Logs: 1 in `RATELIMIT_LOG_SAMPLE` (100) limited decisions, with the policy id and never a raw key.
* Admin hooks (`ratelimit/admin.ts`, for the platform console): block or allow an entity (`ip:`, `ws:`, `user:`, `key:`, `visitor:`) with a TTL (effective on the node that made the
  change immediately, on others within 5 s), list limited keys (hashed), override a workspace's tier. Every change is written to the append-only `audit_log`.
* Tuning: raise a number in `policies.ts` (or set `RATE_LIMIT_SCALE` for a load test: it multiplies every rate; never set it in production, startup logs a warning).
  Plan-tier numbers live in each policy's `tiers`.
* Failure modes: Redis down -> fail-open policies use a per-node bucket (a cluster of N nodes then admits up to N x the limit), fail-closed policies return 503.
  A node that cannot reach Redis for the admin lists keeps its last copy. Penalty boxes in memory are per node.

## Adding a policy

1. Add a row to `POLICIES` (choose `keyBy`, algorithm, `onFail`; security policies are fail-closed, no lease).
2. Reference it from the route or event in `routePolicies.ts` (`pre`, `post`, or `inHandler` with a call to `enforce()` / `ctx.ratelimit.check()`).
3. `npm run docs:ratelimit`, then `npm test`: the coverage tests tell you if you forgot a step.

## Not done / limits

* No Redis Cluster test (keys are hash-tagged for it, but only a single `redis-server` was available).
* No Cloudflare-side rate limiting beyond the documented rules and the optional Worker (`docs/CLOUDFLARE.md`).
* The analytics policies have no penalty box: a key that keeps hitting `429` is simply refused again as its bucket allows; escalating blocks exist for the auth, OTP and webhook-signature policies (see the table). A consumer that honours `Retry-After` never sees more than the plain `429`.

## Analytics API: reading the limits

Per API key: `analytics.read` (60 per minute, reads) and `analytics.export` (10 per minute, **all export routes together**: rooms and messages-meta draw on the same 10), at most 2 concurrent exports. Per workspace: `analytics.workspace` (120 per minute on the free plan) counts **every** analytics call of **every** key of the workspace, reads and exports. So a key can be refused before its own 10 exports are spent when other keys or other export routes used the workspace budget; the policy named in the `429` body and in the `RateLimit` header tells which limit applied. Reads never reduce a key's export budget (separate buckets; covered by `tests/ratelimit.analytics.test.ts`).

`Retry-After` and `retry_after_s` are the GCRA answer: seconds until the same request would be allowed (one token: window / quota, 6 s for exports). `RateLimit: ...;t=` and `X-RateLimit-Reset` are seconds until the bucket is full again (60 s after ten rapid requests). Both are correct and `Retry-After <= reset` always holds: wait `Retry-After` to send one more request, `t` to have the whole quota back.
* Overhead numbers are in [PERFORMANCE.md](PERFORMANCE.md).
