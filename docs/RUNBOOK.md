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

## Routine operations

### Deploy (zero lost messages)
Rolling update with `maxUnavailable: 0`. On SIGTERM a node flips `/readyz` to 503, tells its sockets `server:draining` with a random reconnect delay up to `WS_DRAIN_MS`, waits, closes. Keep `terminationGracePeriodSeconds` greater than `preStop sleep + WS_DRAIN_MS + in-flight request time` (60 s in `deploy/k8s`). Migrations run at boot under an advisory lock and are additive. Message-table conversions (partitioning) need the online procedure below.

### Converting an existing large `messages` table to partitioned (PostgreSQL)
Migration 008 copies in one transaction: fine up to a few million rows. Beyond that: (1) deploy the code with migration 008 moved out of the migrations folder on a canary, (2) create the partitioned table as 008 does under another name, (3) backfill in batches by `created_at` range with `INSERT ... SELECT`, (4) in a short maintenance window copy the tail, swap names, drop the old table, (5) put the migration back (it is recorded as applied). Test the sequence on a restored copy first; it has not been rehearsed on a multi-million-row production table.

### Rotating secrets
`JWT_SECRET`: all sessions end. `CF_SHARED_SECRET`: set the new value on the app first, then in the Cloudflare rule (the app accepts exactly one value). Provider keys: set and restart (rolling).

### Backup and restore
Postgres point-in-time recovery is the backup. Archived message batches live in object storage (`archive_manifest` lists them). Redis holds no durable state.

### Blocking abuse
`ratelimit/admin.ts` (via the platform console when it exists, or a one-off script): add a deny entry (`ip:`, `ws:`, `user:`, `visitor:`) with a TTL; effective on the node that made it immediately and elsewhere within 5 s; audited in `audit_log`.
