# Performance: what was measured, how, and what it does not prove

Everything here was measured on **one laptop**: Apple M1 (8 cores), 8 GB RAM, macOS 24.3, Node 24.11, PostgreSQL 18.4 (the embedded binary the harness starts in a temp directory on a random port), Redis from `redis-server` on a random port. The generators, the app nodes, PostgreSQL and Redis all share those 8 cores, and the laptop was also running unrelated work, so **absolute latencies are pessimistic and noisy**. The point of these runs is correctness under load (no lost, duplicated or reordered message), per-node costs, absence of super-linear costs, and data-volume behaviour; the capacity model built on them is in [SCALING.md](SCALING.md) with every figure labelled measured or extrapolated.

Raw results: `loadtest/results/*.json` (each records the machine, the configuration and the load average at start and end). How to rerun: `loadtest/README.md`. Runs that were disturbed by machine load are kept under `loadtest/results/noisy/` and are not used below except where stated.

## Method notes that matter for reading the numbers

* The harness opens real Socket.IO connections from several generator processes, sends over them, and checks every `message:new` for `seq = previous + 1` (a jump is a *gap*, a repeat is a *dup*). Delivery latency is measured against the server-stamped `created_at`. A "quiet" run waited for the 1-minute load average to drop below 10 (the harness refuses to start otherwise; the start and end load are in the JSON).
* Loopback connections cost two file descriptors each in the kernel's global table (`kern.maxfiles` is 30,720 on this machine and shared with every other process), so this machine cannot hold much more than about 10,000 sockets. The harness aborts a run when `kern.num_files` approaches the limit rather than risk the machine: that guard fired in two runs of an earlier attempt (a 4-node 8,000-socket run and a 6,000-socket storm), which is why the sizes below are what they are.
* The rate limiter ran with `RATE_LIMIT_SCALE=100000` in load runs (one source IP would otherwise be throttled by the per-IP limits the product ships with).

## Connections

**10,000 sockets over 4 nodes (ramp, 2026-10-19, quiet)**: all 10,000 connected, 0 errors; connect latency p50 99 ms, p99 768 ms at 700 new connections/s (10 steps of 1,000); event-loop lag p99 11 to 34 ms per node at the end; per-node RSS peak 135 to 190 MB with 2,500 sockets each. Idle node baseline (an agent-only node) is 96 to 140 MB, so the marginal cost is **about 25 to 35 KB per idle socket** (derived, with `permessage-deflate` off; with it on a connection pays about 94 KB for its zlib contexts: `server/bench/deflate.mjs`, [ADR 0009](adr/0009-permessage-deflate-off.md)). The target was at most 40 KB.

Not measured: more than 2,500 sockets per node (the kernel file table, not the node, was the limit), CPU cost of heartbeats at 25,000 sockets per node, and any run at 100,000 or 1,000,000.

## Fan-out and scale-out

`multinode`: agents connect to node 0 only, visitors to the other nodes, so **every delivery crosses Redis**. Load per visitor node is held constant (750 sockets, 30 messages/s, 4 agent sockets receiving everything), and the number of visitor nodes grows (2026-10-20, quiet start: load 6 to 11):

| Nodes (1 agent + N visitor) | Sockets | Messages/s | Acked | Gaps | Dups | Delivery p50 / p99 | Ack p50 / p99 | Visitor-node CPU (avg) | Redis CPU (avg) |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 3 (2 visitor) | 1,500 | 60 | 2,700 | 0 | 0 | 5 / 14 ms | 9 / 24 ms | 11 to 12% | 5% |
| 4 (3 visitor) | 2,250 | 90 | 4,050 | 0 | 0 | 5 / 33 ms | 9 / 65 ms | 18 to 19% | 10% |
| 5 (4 visitor) | 3,000 | 120 | 5,399 | 0 | 0 | 22 / 435 ms | 56 / 670 ms | 30 to 35% | 23% |

Reading it: correctness held at every size (agent delivery ratio 1.0, zero gaps, zero duplicates). **Near-linear scaling was not demonstrated.** Going from 3 to 5 nodes doubles the load and per-node CPU roughly triples, and latency degrades from 14 ms to 435 ms p99; Redis CPU grows faster than the message rate (5, 10, 23% for 1x, 1.5x, 2x). On a box where generators, PostgreSQL, Redis and all nodes compete for 8 cores, with the machine already past 60% busy, that is what contention looks like, but it is also what a super-linear cost would look like, and this run cannot tell them apart. The first step in a cloud run ([CLOUD-LOADTEST.md](CLOUD-LOADTEST.md)) is to repeat this table on separate machines. An earlier attempt at the same scenarios at 2,000 to 4,000 sockets and 150 to 267 messages/s while the machine's load average was 20 to 40 degraded to multi-second latencies and incomplete deliveries (4-node: 1,814 acked of about 12,000 intended); those are in `loadtest/results/noisy/` and show saturation of the test machine, not of the product.

**Fan-out against subscribers of one stream** (`roomsize`, single node, PostgreSQL, 40 messages/s, 50 rooms, team sockets all receiving every message):

| Subscribers | Deliveries/s (measured) | Delivery p50 / p99 | Node CPU | Gaps / dups |
| ---: | ---: | --- | ---: | ---: |
| 1 | 34 | 4 / 7 ms | 18% | 0 / 0 |
| 10 | 342 | 4 / 10 ms | 15% | 0 / 0 |
| 100 | 685 | 7 / 720 ms | 22% | 0 / 0 |
| 1,000 | 684 | 4 / 49 ms | 15% | 0 / 0 |

Deliveries/s flatten at about 685 from 100 subscribers on although the node is only 15 to 22% busy and the expected figure is 40 x subscribers: the ceiling is the **generator processes** (three Node workers parsing every delivery on a shared machine), not the server, so the 100 and 1,000 rows say "no gaps, no duplicates, p99 under 1 s, server not saturated" and nothing about the server's maximum fan-out. Server-side fan-out cost per delivery has not been isolated; in the cloud run use many small generator pods.

## Write path and hot rooms

`hotroom.mjs` calls the real send service (`sendAgentMessage`: lock the room row for `seq`, insert the message, outbox row, summary and metrics update, all in one transaction) with N concurrent writers, on one room versus 20,000 rooms, 8 s per point, pool of 40 PostgreSQL connections (same machine as PostgreSQL):

| Writers | One room: msgs/s, p50, p99 | 20,000 rooms: msgs/s, p50, p99 |
| ---: | --- | --- |
| 1 | 454, 2.0 ms, 4.1 ms | 196, 4.9 ms, 7.8 ms |
| 10 | 700, 10.9 ms, 54 ms | 373, 26.6 ms, 55 ms (1 error) |
| 100 | 335, 266 ms, 800 ms | 377, 301 ms, 362 ms |
| 1,000 | 250, 4.8 s, 5.4 s | 435, 2.4 s, 3.7 s (38 errors) |

Conclusions that the data supports: a single process with PostgreSQL on the same cores sustains **about 350 to 700 messages/s of writes** whichever way they are spread; a hot room with 1,000 concurrent writers takes about 57% of what spread-out writers get and does not collapse; errors are rare (one at 10 writers, 38 of about 3,500 at 1,000 writers, consistent with pool exhaustion). Higher single-writer throughput on the hot room than on many rooms is the cost of cold rows (many-room writers touch cold pages and indexes). The per-room row lock therefore is not the first bottleneck at this scale and no group commit was added; if a single room must take far more, the escalation is batching writes per room (not implemented). The per-room send limit (`msg.room`, 300 per minute) stops a runaway client long before this matters.

## REST hot paths (single node, 500 connections open, 32 concurrent HTTP connections, 10 s each, quiet start)

| Endpoint | PostgreSQL: req/s, p50, p99 | SQLite (earlier, load 14): req/s, p50, p99 |
| --- | --- | --- |
| `GET /api/rooms?limit=30` (inbox list) | 64, 449 ms, 871 ms | 367, 162 ms, 355 ms |
| `GET /api/dashboard/counts` (cached) | 4,973, 5 ms, 15 ms | 1,760, 33 ms, 75 ms |
| `GET /api/rooms/:id/messages` | 2,788, 11 ms, 16 ms | 1,218, 42 ms, 178 ms |
| `GET /api/contacts?limit=30` | 2,042, 14 ms, 31 ms | 2,181, 28 ms, 51 ms |
| `POST` visitor message (insert, seq, fan-out) | 380, 81 ms, 139 ms | 738, 85 ms, 173 ms |

The inbox list is the heaviest read: 7 statements per request (seat, workspace state, rooms with a per-room unread count, assignees, contacts), roughly 9 to 15 ms of server time on PostgreSQL where each statement is a network round trip, 2.7 ms on SQLite. It is bounded (7 statements for 30 rooms; a test asserts it does not grow with the page) but it is the first thing to cache or move to a replica when read traffic grows (`Db.read()`).

## Reconnect storm, slow consumers, drain, idempotency

* **Storm** (3 nodes, 2,000 sockets, 100 messages/s; 950 sockets killed at the TCP level at once, 2026-10-20 quiet): **99% reconnected in 2.0 s**; zero gaps, zero duplicates, zero messages missing after the resync audit; 1,089 resync requests of which 492 failed and were retried by the client with backoff (rate-limited by design during a herd). A larger storm (6,000 sockets) could not run: the file-table guard aborted it.
* **Slow consumers** (2 nodes, 800 sockets, 6 agent sockets that stop reading, 1 KB messages): all 6 were disconnected by the slow-consumer guard (`slowDisconnects 6`), healthy sockets' delivery p99 79 ms, ack p99 207 ms.
* **Drain** (2 nodes, SIGTERM on one under load): the node exited in 5.3 s, all 800 of its clients received `server:draining` with a jittered reconnect delay; 0 gaps, 0 duplicates on the surviving traffic. (The harness has no balancer, so the drained clients keep retrying the same address: failing over is the balancer's job.)
* **Idempotency across nodes** (3 nodes, 10,000 sends of 1,000 distinct `client_msg_id`, 10 racing duplicates each, spread over the nodes): 1,000 stored, 9,000 answered as replays (HTTP 200) and 1,000 created (201); exactly once; `seq` contiguous in every room.

## Fault injection (zero loss and zero duplicates through failure)

All three: 3 nodes, 600 sockets, 100 messages/s for 30 s, 2026-10-20 (load average 11 to 19, moderately noisy). The check is **in the database**, not only on the clients: every acknowledged message must be stored exactly once (`stored_in_db = distinct_client_ids_in_db = acked`), per-room `seq` must be contiguous, and clients must see no gap, duplicate or missing message after the resync audit.

| Fault | What happened | Acked = stored | Lost / duplicated in DB | `seq` gaps in DB | Client gaps / dups / missing | Delivery p99 |
| --- | --- | ---: | --- | ---: | --- | ---: |
| `SIGKILL` of a visitor node mid-load | its 300 sockets failed over (300 reconnects), 3 sends were retried with the same id | 2,640 | 0 / 0 | 0 | 0 / 0 / 0 | 217 ms |
| Redis killed and restarted | no socket dropped; all 602 clients received `server:resync` and refetched over REST | 2,838 | 0 / 0 | 0 | 0 / 0 / 0 | 596 ms |
| PostgreSQL process frozen (`SIGSTOP`) for 6 s | writes stalled and resumed; no send failed, nothing stored twice | 3,439 | 0 / 0 | 0 | 0 / 0 / 0 | 269 ms |

Not tested: a real PostgreSQL promotion to another server, a Redis Cluster shard failover, a rolling Kubernetes deploy, loss of an availability zone.

## Soak

Two runs, 2 nodes, 1,500 sockets, 60 messages/s, PostgreSQL + Redis (`loadtest/results/soak-30min.first.json` and `soak-12min-quiet.json`). The target of 30+ minutes was run once, under disturbance; the quiet run is 12 minutes.

**12 minutes, quiet start (load 3.4 to 11.5), node logs on** (`soak-12min-quiet.json`): 42,585 messages sent and acknowledged, **0 send errors, 0 gaps, 0 duplicates**, agent delivery ratio 0.9966 (the remainder is messages still in flight when the run ended). The server's RSS stayed flat: the busy visitor node between 208 and 249 MB for the whole run (no growth), event-loop lag p99 12 to 49 ms. Delivery p99 was 17 to 60 ms for most 30-second windows with excursions to 0.8 s, 2.8 s and about 1 s for a minute in the middle of the run, and 6.4 s in the last window while the harness was tearing the stack down; these coincide with other activity on the laptop (load average rose from 3 to 12 during the run) and not with any server error or loss, but they were not attributed to a specific cause.

**30 minutes (`soak-30min.first.json`), started as the laptop's load average climbed from 4 to 20**: the first six minutes were an overload episode: delivery p99 rose to 30 s, 4,272 sends failed (4,242 `INTERNAL`, 30 validation errors) and **2,020 sequence gaps** were seen by agent sockets (2,128 messages not pushed live; the messages were stored and visible over REST). After minute six the system recovered **without intervention** and the remaining 24 minutes were clean: no further gaps or errors, delivery p99 48 to 380 ms with brief excursions to about 1.5 s, RSS flat (busy node 191 to 250 MB, no growth). Totals: 103,728 acked, 0 duplicates. What this does and does not show: the cause of the `INTERNAL` errors was not captured (node logs were off for this run; the second run above turned them on and did not reproduce the episode), and the likely mechanism is database and Redis timeouts on a saturated machine. Per the design, a send that fails is retried by the client with the same id (idempotent), and a message that commits but is not pushed is delivered on the next fetch: the sequence gaps are exactly that case. So this run shows **graceful degradation and recovery**, and it also shows that live push can be lost under overload; it does not show a leak, and it cannot be used to claim the SLO under overload.

A defect found while reading the 12-minute run's logs and fixed: the rate limiter's Redis circuit breaker logged "closed" on every successful call after any failure and "opened" on every failure while open (hundreds of identical lines per second during a stall); it now logs and sets its gauge only when the state changes. Garbage-collection pauses were not measured separately (event-loop lag is the proxy).

## Data volume: 50 million messages in real PostgreSQL

`loadtest/dataset.mjs`, PostgreSQL 18.4, the app's own migrations (16 hash partitions by `room_id`, each with monthly range leaves: 256 leaves), 2,500,000 rooms, 12 months, 50,000,000 message rows (2026-10-20):

| | |
| --- | --- |
| load rate | 36,276 rows/s for the load itself (1,378 s), 30,013 rows/s including the 288 s index build; the rate fell from about 45,000 to 24,000 rows/s as indexes and disk filled and recovered when disk pressure ended |
| size | 28.0 GB on disk, of which the messages table 19 GB; **602 bytes per row including indexes** (an average message of a few dozen characters plus the denormalised columns) |
| disk guard | the loader stops below 8 GB free; it did not trigger |

Hot queries at 50M rows (prepared = named prepared statement as the app uses it; plain = parsed each time; times in ms; the second to last columns are from `EXPLAIN`):

| Query | Prepared p50 / p99 | Plain p50 / p99 | Hash partitions touched | Leaves in the plan | Planning / execution |
| --- | --- | --- | ---: | ---: | --- |
| history page, newest 30 | 5.0 / 17.6 | 2.8 / 8.6 | 1 | 16 | 7.7 / 0.3 |
| history page, before a cursor | 3.0 / 4.6 | 2.9 / 3.6 | 1 | 16 | 3.0 / 0.1 |
| unread count in one room | 3.2 / 3.4 | 3.1 / 3.5 | 1 | 16 | 3.0 / 0.05 |
| last message of a room | 8.1 / 21.6 | 3.1 / 3.6 | 1 | 16 | 2.9 / 0.1 |
| room list, newest 30 open (rooms table only; summaries are denormalised) | 0.2 / 1.2 | 0.4 / 0.7 | 0 | 0 | 0.15 / 0.06 |
| message by (room, id) | 3.0 / 3.2 | 2.9 / 3.2 | 1 | 16 | 2.7 / 0.05 |
| message by id, room unknown | 5.3 / 9.8 | **54 / 161** | **16** | **256** | **96 / 2.9** |
| in-room search (ILIKE, one room) | 0.6 / 1.2 | 3.3 / 3.9 | 1 | 16 | 7.8 / 0.7 |
| analytics: messages per day, one workspace, 7 days | 367 / 560 | 323 / 488 | 16 | 16 | 27 / 357 |

What it shows: **partition pruning works**: every room-scoped query touches exactly one hash partition (EXPLAIN output for each query is in `loadtest/results/dataset-50m.plans.txt`), and execution is under 1 ms; the cost at this size is *planning* (3 to 8 ms plain), which named prepared statements remove after the first call. The one query that cannot prune, a message looked up by id alone, probes all 256 leaves and spends 96 ms planning: this is why hot paths always carry the room id and why `message_refs` exists ([ADR 0008](adr/0008-message-refs-locator.md)). Tenant-wide analytics scans are the slowest at about 0.4 s for a 7-day window on one workspace; that is why the dashboard and analytics API read `room_metrics`, not `messages`. The room list is independent of message volume (0.2 to 0.4 ms).

Not tested: 10 billion rows (a model, see SCALING.md), a long-running mixed workload at this size (vacuum, bloat, replication lag), and a restore from an archived partition at scale.

## Micro-benchmarks

| What | Result | Command |
| --- | --- | --- |
| Rate limiter decision, in-memory store | about 470,000 to 535,000 decisions/s, p50 1 microsecond, p99 5 to 8 microseconds, single caller | `server/bench/limiter.ts` |
| Rate limiter decision, Redis store, hot policy with the local lease tier (16 concurrent callers) | about 345,000 decisions/s, p50 31 microseconds, p99 150 microseconds | same |
| Rate limiter decision, Redis store, no lease (login policy, one Redis round trip each, 16 concurrent callers) | about 17,000 decisions/s, p50 0.76 ms, p99 3.4 ms | same |
| Rollup consumer (idempotent marker + counter upsert in one transaction), 1,000,000 events, SQLite in memory | 112,000 events/s (9 microseconds per event), total correct (1,000,000) | `server/bench/rollup.ts` |
| Large HTML sanitising on a worker thread versus inline | thresholds and event-loop stall measurements in `server/bench/pool.ts` and `bench/cpu.ts`; pool used above 32 KB | [ADR 0010](adr/0010-worker-threads-only-where-measured.md) |
| `permessage-deflate` | 40% of the size for about 32 microseconds per recipient and about 94 KB per connection | [ADR 0009](adr/0009-permessage-deflate-off.md) |

The rollup benchmark was not run on PostgreSQL. A guard against double counting is tested separately (`tests/eventbus.test.ts`: the same event id twice in one batch, even concurrently, counts once).

## Metrics reference (`GET /metrics`)

| Metric | Meaning |
| --- | --- |
| `conv_ws_connections` | open sockets on this node (by kind) |
| `conv_ws_connect_total` | handshake attempts by outcome |
| `conv_ws_shed_total{reason}` | handshakes refused by admission control (`loop_lag`, `handshakes`, caps) |
| `conv_ws_events_total`, `conv_ws_emits_total` | events received from and emitted to clients |
| `conv_ws_ack_duration_seconds{event}` | time to acknowledge a client event |
| `conv_ws_fanout_duration_seconds` | time to publish an event to its audience |
| `conv_ws_slow_consumer_disconnects_total`, `conv_ws_write_buffer_max` | slow-consumer evictions, largest outbound queue |
| `conv_ws_strikes_total` | rate-limited socket events counted towards a disconnect |
| `conv_event_loop_lag_p99_seconds` | event-loop delay, the best single saturation signal |
| `conv_http_request_duration_seconds` | REST latency by route and status |
| `conv_db_statements_total` | statements executed |
| `conv_queue_depth` | waiting, delayed, active, failed jobs |
| `conv_background_tasks` | in-flight fire-and-forget tasks |
| `conv_rate_limited_total`, `conv_ratelimit_decisions_total{policy,outcome}` | limiter outcomes per policy |
| `conv_ratelimit_redis_duration_seconds`, `conv_ratelimit_breaker_open`, `conv_ratelimit_lease_total`, `conv_ratelimit_penalty_box_size` | limiter store health |
