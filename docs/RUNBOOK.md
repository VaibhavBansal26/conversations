# Runbook

Operational procedures for Conversations. Capacity incident playbooks come first; routine operations follow. Every playbook says what you will
see (metric or log), how to confirm, what to do, and how to know it worked. Metric names are the ones exported at `/metrics`
([PERFORMANCE.md](PERFORMANCE.md) lists them with their meaning).

Conventions: `conv_*` are Prometheus metrics from the app; "node" is one app process; commands assume `kubectl -n conversations` and a `psql` to the primary.

## Capacity incidents

### 1. Reconnect storm (a wave of sockets reconnecting at once)

*Causes:* a node or load balancer restart, a Cloudflare/provider blip, a bad deploy, Redis restart.
*You see:* `rate(conv_ws_connect_total[1m])` spikes; `conv_ws_shed_total{reason="loop_lag"|"handshakes"}` rising; `conv_event_loop_lag_p99_seconds` above 0.1; clients show "reconnecting".
*What the system does on its own:* admission control refuses handshakes with a jittered `retry_after_ms` (1.5 to 7.5 s), clients back off with 80% jitter (1 s to 30 s), per-IP handshake limits apply, `server:draining` spreads planned restarts.
*Confirm:* `sum(conv_ws_connections)` is dipping and recovering; shed counters are plateauing, not climbing without bound.
*Do:*
1. Do nothing for 2 to 3 minutes if the curve is recovering (the herd disperses by design).
2. If one node is hot, check `conv_ws_connections` per pod; a pod far above its peers means the balancer is not spreading: restart that pod last, not first.
3. If recovery stalls, scale out: `kubectl scale deploy/conversations --replicas=<current+25%>` (KEDA does this on connection count; manual scale is for when the trigger lags).
4. Raise `WS_MAX_HANDSHAKES` only if the loop lag is low (database-bound handshakes are the limit, not CPU). Never raise `SHED_LOOP_LAG_MS` to "make errors go away".
*Verify:* connections back to the pre-incident level, shed counters flat, p99 ack latency under 400 ms.
*Not an incident:* `OVERLOADED` handshake refusals during the first seconds of a mass reconnect.

### 2. Hot room (one conversation takes a large share of writes)

*You see:* p99 of `conv_ws_ack_duration_seconds{event="message:send"}` rising while the median is fine; Postgres `pg_stat_activity` shows many sessions waiting on `transactionid` for the same room row; per-room send limit (`msg.room`, 300/min) rejecting with 429.
*Why:* per-room `seq` is allocated by `UPDATE rooms SET next_seq = next_seq + 1`, so writers to one room serialise on that row lock. The measured ceiling for one room is in PERFORMANCE.md (hot-room table); other rooms are unaffected.
*Confirm:* count messages per room over the last minute (`created_at` is ISO text, so compare with an ISO string) and look for one room far above the rest.
*Do:* it is almost always a bot or a loop. Identify the sender (visitor session / API client), block it with the admin hook (`ratelimit/admin.ts`: deny `visitor:<id>` or `user:<id>` with a TTL). The per-room limit already caps the damage at 300 messages/min per room.
*If it is legitimate* (a very large live event): raise `msg.room` in `policies.ts`, accept the measured per-room ceiling, and tell the customer to use several rooms.

### 3. Replica lag (reads go stale)

*You see:* `DATABASE_REPLICA_URL` configured and users report missing recent messages in lists; `db.replicaStatus().lagMs` above `DATABASE_REPLICA_MAX_LAG_MS`.
*What the system does:* reads fall back to the primary automatically while lag exceeds the threshold, and for `DATABASE_READ_AFTER_WRITE_MS` after this node wrote (read-your-writes).
*Do:* check the primary's write load and the replica's replay (`SELECT now() - pg_last_xact_replay_timestamp()` on the replica). If the primary is now serving all reads, watch its CPU: that is the failure mode. Scale the primary or fix the replica; do not raise the lag threshold.
*Verify:* lag back under the threshold; reads return to the replica.

### 4. Queue backlog (sends or jobs pile up)

*You see:* `conv_queue_depth{state="waiting"}` growing; SMS/email sends stay `pending`; workspaces get 429 `send.backlog`; outbox lag (`SELECT count(*), min(created_at) FROM outbox_events WHERE published_at IS NULL`) growing.
*Do:*
1. Provider outage? Retries back off with jitter up to `SEND_RETRY_CAP_SECONDS`; nothing to do but wait, and tell customers. Failed messages can be retried by hand (`POST /api/messages/:id/retry`).
2. One tenant flooding? Due jobs are taken round-robin per workspace, so others keep flowing. Check `SELECT workspace_id, count(*) FROM jobs WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`; the offender gets 429s once above `SEND_QUEUE_WORKSPACE_MAX`.
3. Workers behind? Every node runs the scheduler; scale out. With Redis the relay and sweeps run under a lock on one node at a time (`outbox-relay`, `scheduler-sweep`).
4. Outbox lag only: the relay is not running or the bus is down. Check Redis health; the relay resumes and republishes (consumers dedupe by event id).

### 5. Partition exhaustion (inserts landing in DEFAULT partitions, or no partition for a month)

*You see:* `SELECT count(*) FROM messages_h0_default` greater than zero; the daily housekeeping log shows partition creation failures; planning time rising on message queries.
*Cause:* the scheduler is not running anywhere for longer than the pre-created horizon (`MESSAGE_PARTITION_MONTHS_AHEAD`, default 3 months), or the clock is far ahead.
*Do:* `SELECT conv_ensure_message_partitions(date_trunc('month', now())::date, (date_trunc('month', now()) + interval '3 months')::date);` It moves any rows sitting in a DEFAULT partition into the new month (a brief lock on the affected hash partition).
*Verify:* the default partitions are empty again.
*Prevent:* alert when any `messages_h*_default` has rows; keep at least one node with `SCHEDULER_ENABLED=true`.

### 6. Redis shard / instance loss

*You see:* `conv_ratelimit_breaker_open` = 1; `readyz` reports `redis: false`; cross-node events stop (agents on node A stop seeing visitors on node B); logs "redis error".
*What the system does:* fail-open limiters keep a per-node bound, fail-closed ones (login, OTP, webhooks) return 503 with Retry-After; sockets stay up on their node; when Redis returns, every node tells its clients `server:resync` and they refetch over REST; presence heals within `PRESENCE_TTL_MS / 3`.
*Do:* restore Redis (failover to the replica; with Redis Cluster a shard loss affects only keys on that shard). Presence, rate-limit and cache state is ephemeral and rebuilds itself. The database is the system of record: no messages are lost (measured: `loadtest` fault scenario `redis-restart`, see PERFORMANCE.md).
*Verify:* breaker closed, `server:resync` received by clients, no unpublished outbox backlog.
*Do not:* restart the app nodes to "fix" Redis; that creates a reconnect storm on top.

### 7. A node dies (SIGKILL, OOM, host loss)

*You see:* a pod disappears; its sockets reconnect to other nodes within seconds (behind a balancer the balancer does it).
*Guarantees (measured, small scale):* messages are written to Postgres before they are acknowledged, so an acknowledged message is never lost; unacknowledged sends are retried by clients with the same `client_msg_id`, which the database de-duplicates. See the node-kill result in PERFORMANCE.md.
*Do:* nothing urgent. Find why it died (OOM: look at `process_resident_memory_bytes` growth; raise the limit or lower `WS_MAX_CONNECTIONS`).

### 8. Database primary failover

*You see:* pool errors, `readyz` database false, request errors for the failover duration.
*What the system does:* requests fail fast (pool timeout 10 s) and sockets stay connected; clients retry sends with the same ids. Writes are idempotent (`message_qids`, unique indexes), so retries after the failover do not duplicate.
*Do:* promote the replica, point `DATABASE_URL` at the new primary (or let the managed endpoint switch), keep PgBouncer in transaction mode (`DATABASE_PGBOUNCER=true`). Migrations are safe to run concurrently (advisory lock).
*Verify:* writes succeed, outbox drains, unique violations on `message_qids` are not climbing.
*Measured:* freezing Postgres for 6 s under load lost and duplicated nothing (PERFORMANCE.md). A real promotion to a different server was not tested.

### 9. Disk filling (Postgres)

Messages are the bulk. Check partition sizes (`listMessagePartitions` in `db/partitions.ts`, or `pg_total_relation_size` per leaf). Remedies in order: set `retention_days` for large tenants (archives to object storage, restorable with `restoreArchive`), detach and dump old monthly partitions (`detachOldMessagePartitions`, an O(1) metadata change), add disk. Detached partitions can be re-attached with `restoreMessagePartition`.

### 10. Stripe webhooks failing or not arriving

*You see:* customers say a payment went through but credits or plan did not change; `stripe_events` rows with `status = 'failed'` or `processing` for a long time; the Stripe dashboard shows failing deliveries (5xx) for `/webhooks/stripe` or `/webhooks/stripe/connect`; a burst of `401 WEBHOOK_SIGNATURE` (wrong signing secret after a rotation, or an attacker).
*Confirm:* `SELECT id, type, status, error, received_at FROM stripe_events WHERE status <> 'processed' AND status <> 'ignored' ORDER BY received_at DESC LIMIT 50;`. Signature failures also feed the `webhook.badsig` strike limit, so one bad secret can block Stripe's own IP: check `GET /admin/api/ratelimit`.
*Do:* (1) signature errors: the endpoint's signing secret in the Stripe dashboard must equal `STRIPE_WEBHOOK_SECRET` (platform) or `STRIPE_CONNECT_WEBHOOK_SECRET` (Connect); fix and redeploy, then unblock the IP in the console. (2) `failed` rows: fix the cause (the `error` column) and use **Resend** in the Stripe dashboard for those events: `failed` events are claimed and re-run, processed ones are acknowledged as duplicates, so resending is always safe. (3) nothing arriving: check the endpoint URL (`PUBLIC_URL`), TLS and that the Cloudflare/WAF rules allow Stripe.
*Verify:* the rows turn `processed`; the workspace shows the plan or credits; the ledger has exactly one row per Stripe object (`idem_key`).
*Never:* edit `credit_balance` by hand to compensate; use a platform credit adjustment (audited) if a manual fix is unavoidable.

### 11. A workspace is locked, or says it was charged

*You see:* `402 ACCOUNT_LOCKED` on SMS/email, a "billing is overdue" banner for members.
*Meaning:* a subscription payment failed and `BILLING_GRACE_DAYS` passed (only when `PLAN_ENFORCEMENT=true`). Chat, reading and billing pages keep working. Paying (`invoice.paid`) unlocks it immediately.
*Do:* in the console open the workspace (billing status, grace date). If Stripe shows the invoice paid but the workspace is locked, the webhook was missed: see playbook 10. To give a customer time, there is no "extend grace" button on purpose; add credits or contact them and have them update the card in the portal.

### 12. Suspending a workspace, and looking at one

Suspend (abuse, fraud, non-payment you will not tolerate): console > workspace > reason > *Suspend*. Effect: all sessions end, API, login, refresh, widget and socket events answer `WORKSPACE_SUSPENDED`; inbound SMS/email is still stored. Unsuspend restores everything. To look at an account without its credentials use the read-only support view; the customer sees that in their own audit log. All of it is in [ADMIN.md](ADMIN.md).

### 12b. A workspace says SMS or email does not work

Open the workspace's Settings > Channels (or have them): the banner and `GET /api/channels/status` say which case it is. *Test mode* (no provider connected: messages are stored as `not_sent_test_mode`): connect Twilio / SendGrid ([CHANNELS.md](CHANNELS.md)); on a self-hosted single-tenant install set `SMS_PROVIDER=twilio` / `EMAIL_PROVIDER=sendgrid` instead. *Needs attention*: the provider rejected the saved credentials (rotated token, revoked key, suspended account): paste them again and verify. *Connected but nothing arrives*: use "Check webhook"; `rejected` means a signature or secret mismatch (wrong Auth Token, or `PUBLIC_URL` differs from the URL the provider calls). *Invitation, reset or digest emails missing for everyone*: the platform mailer (`EMAIL_PROVIDER`) is the console one. Provider outage: sends fail with a `timeout`/`provider_error` reason and retry with backoff; nothing is lost.

### 13. An operator lost their authenticator

Another superadmin cannot reset it from the console on purpose. On a host with database access: `npm run admin -- reset-mfa --email <address>` (audited as `admin.mfa_reset`); the operator enrols again at next sign-in. If the only superadmin is locked out, create a new one with `npm run admin -- create`.

### 14. Mobile hosted chat and identity verification

Background: [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md). Migration 026 is additive only (two columns, one unique index, one table; no table rebuild, nothing touches `sqlite_master`), safe on Render's SQLite.

- **Switch the hosted chat off at once** (abuse, a leaked token): Settings > Chat widget > Install > *Hosted chat for this token* off, or `PATCH /api/tokens/:id {"hosted_chat_enabled": false}`. The app's origin is refused immediately for the token's REST calls and socket handshakes; existing sessions stop working from the hosted page; the website widget on the token's own domain is unaffected. Revoke the token to stop everything.
- **Customers report "Chat is not available" (403) in the app:** the token is revoked, flag-off, or the workspace is suspended. `GET /api/tokens` shows `hosted_chat_enabled`.
- **`ORIGIN_NOT_ALLOWED` for every hosted call:** `PUBLIC_URL` is not the address the web view loads (scheme, host or port differ, often behind a proxy). Fix `PUBLIC_URL` ([CONFIGURATION.md](CONFIGURATION.md)).
- **Rotate the identity secret** (suspected leak): Settings > ... > Identity verification > *Replace secret*, then deploy the new secret to the customer's backend. Until it is deployed their signed users get `401 IDENTITY_HASH_INVALID` and the page offers "Continue as guest"; with enforcement on, plan the switch (turn enforcement off during the change if guests are acceptable). Sessions already created stay valid.
- **`DATA_ENCRYPTION_KEY` lost or changed without `DATA_ENCRYPTION_KEY_PREVIOUS`:** stored identity secrets become unreadable and the workspace behaves as if it had none (signed requests get `422 IDENTITY_NOT_CONFIGURED`, unsigned behave as before; never "accept anything"). A manager creates a new secret.
- **Uploads:** visitor pictures and PDFs go through `POST /public/attachments` (10 per minute per visitor, `UPLOAD_MAX_BYTES`), stored like agent attachments; remove abusive ones by deleting the message.

## Dashboards, alerts and SLOs

Dashboards (Prometheus/Grafana on `/metrics`): connections and handshakes (`conv_ws_connections`, `conv_ws_connect_total`, `conv_ws_shed_total`), latency (`conv_ws_ack_duration_seconds`, `conv_ws_fanout_duration_seconds`, `conv_http_request_duration_seconds`), saturation (`conv_event_loop_lag_p99_seconds`, `conv_ws_write_buffer_max`, process RSS), queues (`conv_queue_depth`, outbox lag), limiter health (`conv_ratelimit_decisions_total`, `conv_ratelimit_breaker_open`, `conv_ratelimit_redis_duration_seconds`, `conv_rate_limited_total`), database (`conv_db_statements_total`, pool wait, replica lag, partition sizes).

Suggested SLOs (targets from the scale design, **not yet demonstrated in production**): message acknowledgement p99 below 400 ms and server-side fan-out p99 below 150 ms at the stated load; zero lost or duplicated messages (page on any `message_qids` anomaly, gap or outbox backlog above 60 s); availability 99.9% of `/readyz` per node-minute.

Alerts to set: event-loop lag p99 above 0.1 s for 5 min; `conv_ws_shed_total` rate above baseline for 10 min; outbox oldest unpublished row above 60 s; `conv_queue_depth` growing for 15 min; `conv_ratelimit_breaker_open == 1` for 5 min; replica lag above `DATABASE_REPLICA_MAX_LAG_MS` for 5 min; free disk below 20%; `stripe_events` rows in `failed` for more than 10 minutes; any `5xx` rate above 1% for 5 min.

## Routine operations

### Deploy (zero lost messages)
Rolling update with `maxUnavailable: 0`. On SIGTERM a node flips `/readyz` to 503, tells its sockets `server:draining` with a random reconnect delay up to `WS_DRAIN_MS`, waits, closes. Keep `terminationGracePeriodSeconds` greater than `preStop sleep + WS_DRAIN_MS + in-flight request time` (60 s in `deploy/k8s`). Migrations run at boot under an advisory lock and are additive. Message-table conversions (partitioning) need the online procedure below.

### Upgrading an existing SQLite database
Migrations run at boot, in file-name order, and each is recorded in `_migrations` when it commits. On SQLite every migration runs in its own transaction, so a migration that throws leaves the database exactly at the previous version (earlier files stay applied) and the process exits at start-up. A migration that rebuilds a table (`-- @sqlite-foreign-keys-off` on its first line, for example 020, which rebuilds `messages`) copies every row once under the write lock: expect time proportional to the table, and take a copy of the database file first (`sqlite3 data.db ".backup copy.db"`, or copy the file together with its `-wal`/`-shm` files while the app is stopped). The runner switches foreign keys off for that file only, re-enables them afterwards, and rolls the migration back with the offending rows in the error if `PRAGMA foreign_key_check` finds a violation that did not exist before.

If a deploy fails with a migration error:
1. Read the first error line in the deploy log (`journalctl`/Render logs). On Render the previous version keeps serving traffic while the new one fails to start, so there is no outage; do not delete the database.
2. Roll back by redeploying the previous commit (Render: Deploys > the last live deploy > Rollback). The database is still at its previous version because the failed migration rolled back; the previous code runs on it unchanged. Check with `sqlite3 data.db "SELECT name FROM _migrations ORDER BY name DESC LIMIT 3"`.
3. Reproduce locally on a copy of the data: `DATABASE_PATH=copy.db node server/dist/index.js`. To test a release before shipping, build a database with the previous release's migrations and start the new build on it (`server/tests/migrations.upgrade.test.ts` does this for every change).
4. Fix forward with a new migration; never edit a migration that has already run in production. Rules for SQLite migrations: no `writable_schema` or `sqlite_master` edits (SQLite builds in defensive mode, such as the Node image on Render, refuse them), no `PRAGMA` (the runner owns them), `ALTER TABLE ... ADD COLUMN` where possible, otherwise rebuild the table with the 12-step procedure, recreate its indexes and triggers, and use the `-- @sqlite-foreign-keys-off` directive when other tables reference it. `npm test --prefix server` enforces these (`migrations.lint.test.ts`, `migrations.upgrade.test.ts`).

PostgreSQL runs all pending migrations in one transaction under an advisory lock, so a failure leaves the schema unchanged too. Roll back the same way (redeploy the previous version, which ignores columns and constraints it does not know). Migration 020 on PostgreSQL drops and re-adds a CHECK on the partitioned `messages` parent, which takes an `ACCESS EXCLUSIVE` lock and scans the table; schedule it for a quiet period on a very large table (not measured).

### Converting an existing large `messages` table to partitioned (PostgreSQL)
Migration 008 copies in one transaction: fine up to a few million rows. Beyond that: (1) deploy the code with migration 008 moved out of the migrations folder on a canary, (2) create the partitioned table as 008 does under another name, (3) backfill in batches by `created_at` range with `INSERT ... SELECT`, (4) in a short maintenance window copy the tail, swap names, drop the old table, (5) put the migration back (it is recorded as applied). Test the sequence on a restored copy first; it has not been rehearsed on a multi-million-row production table.

### Rotating secrets
`JWT_SECRET`: all sessions end, enrolled authenticators (TOTP secrets are encrypted with a key derived from it) stop verifying until re-enrolled, and platform-admin tokens end; plan a maintenance window and use the same value on every node. It no longer affects the analytics identity pepper. `DATA_ENCRYPTION_KEY` (encrypts the pepper and every workspace's Twilio / SendGrid credentials): do not change it casually; workspace credentials are re-sealed under the new key the first time they are used, so keep the previous key until the channels have been used, and a workspace whose credentials become unreadable only needs to paste them again. To rotate, set the new value as `DATA_ENCRYPTION_KEY` and the old one as `DATA_ENCRYPTION_KEY_PREVIOUS`, deploy, and let each workspace's pepper be read once (any analytics export or `GET /api/v1/analytics/identity-pepper` does it; the value is re-encrypted under the new key without changing it), then remove the previous key. If the key is lost, the pepper answers `409 PEPPER_UNREADABLE`; fix it by setting a new pepper (`PUT /api/v1/analytics/identity-pepper`, ideally the one the other apps already use, see [ANALYTICS.md](ANALYTICS.md)); exports change when the value changes. Upgrading from a version that encrypted the pepper under `JWT_SECRET`: set `DATA_ENCRYPTION_KEY` before deploying and keep `JWT_SECRET` unchanged until each workspace has been read once. Stripe: create a new signing secret in the dashboard, set it on the app and deploy (during the overlap Stripe retries failed deliveries). `STRIPE_SECRET_KEY`: roll the key in Stripe, set it, restart. `CF_SHARED_SECRET`: set the new value on the app first, then in the Cloudflare rule (the app accepts exactly one value). Provider keys: set and restart (rolling).

### Backup and restore
Postgres point-in-time recovery is the backup. Archived message batches live in object storage (`archive_manifest` lists them). Redis holds no durable state.

### Blocking abuse
The platform console (Rate limits page, or `POST /admin/api/ratelimit/deny`; see [ADMIN.md](ADMIN.md)) wraps `ratelimit/admin.ts`: add a deny entry (`ip:`, `ws:`, `user:`, `visitor:`) with a TTL; effective on the node that made it immediately and elsewhere within 5 s; audited in `audit_log`.
