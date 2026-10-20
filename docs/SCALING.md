# Scaling

Targets, the capacity model with its constants, sizing tables, bottlenecks, tuning, limits, and a table that labels every figure as measured or extrapolated. **Nothing here has been run at the target scale.** One laptop cannot prove 1,000,000 connections; what it did prove is per-node behaviour, correctness under faults and no obvious super-linear cost at small scale ([PERFORMANCE.md](PERFORMANCE.md)). The path to the real figures is [CLOUD-LOADTEST.md](CLOUD-LOADTEST.md).

## Targets (design assumptions; change only with a reason)

| Target | Value |
| --- | --- |
| Concurrent WebSockets, cluster-wide (agents and widget visitors) | 1,000,000 on stateless nodes, at least 25,000 per node tuned, at most 40 KB RSS per idle connection |
| Ingest | 10,000 messages/s sustained, 25,000/s peak; 100M+ messages/day |
| Latency | fan-out p99 under 150 ms server-side; end-to-end p99 under 400 ms at the stated load |
| Retention | 10B+ rows retained through partitioning and tiering (online window plus archive) |
| Delivery guarantees | zero lost, zero duplicated, per-room order preserved, at-least-once with idempotent consumers, through node crashes, Redis failover and deploys |

## What makes it scale (the design, in one page)

| Concern | Mechanism | Where |
| --- | --- | --- |
| Stateless nodes | everything a second node must see goes through PostgreSQL or Redis; per-node state is only the sockets and caches invalidated over pub/sub | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Ordering and idempotency | per-room `seq` by `UPDATE ... RETURNING`, unique `(room_id, client_msg_id)`, the database arbitrates | [ADR 0002](adr/0002-database-is-the-arbiter.md), [0003](adr/0003-server-side-idempotency.md) |
| Table size | `messages` hash-partitioned by room, then monthly; retire a month by detaching a leaf; archive to NDJSON.gz; per-tenant retention; GDPR purge by partition key | [ADR 0004](adr/0004-hash-partition-messages-by-room.md), RUNBOOK |
| Hot-path reads | room summary denormalised on the room row (last message, counts), keyset pagination everywhere, no `COUNT(*)` on hot paths, `message_refs` for lookups that do not know the room, `room_metrics` for analytics | [ADR 0008](adr/0008-message-refs-locator.md) |
| Connections to PostgreSQL | transaction-mode PgBouncer compatible (`DATABASE_PGBOUNCER`), transaction-scoped advisory locks, read replica with lag guard and read-your-writes (`Db.read()`) | CONFIGURATION |
| Events | transactional outbox, relay under a lock, `EventBus` (Redis Streams with partition leases, consumer groups, retries, dead letters; Kafka and NATS adapters are documented stubs), idempotent consumers | [ADR 0006](adr/0006-transactional-outbox-event-bus.md) |
| Realtime fan-out | audiences computed from visibility, a handful of channels per workspace instead of one per room, per-socket bounded queues with slow-consumer eviction, admission control, jittered retry, graceful drain, `server:resync` after Redis loss | [ADR 0005](adr/0005-computed-room-audiences.md), [REALTIME.md](REALTIME.md) |
| Tenant fairness | per-workspace queues and round-robin job scheduling, per-tenant send backlog caps, plan-scaled rate limits, per-tenant socket caps | [RATE-LIMITING.md](RATE-LIMITING.md) |
| Autoscaling | connections per pod as the KEDA trigger (not CPU alone), PodDisruptionBudget, topology spread, preStop drain longer than the reconnect window | `deploy/k8s`, `deploy/k8s-keda` |

## Capacity model

Let `C` be concurrent connections, `M` messages/s ingested, `A` the average audience size per message (sockets that receive it), `N` nodes.

| Quantity | Formula | Constant used | Status |
| --- | --- | --- | --- |
| Memory per node | `base + C/N x s` | `base` about 100 to 140 MB; `s` about 25 to 35 KB per idle socket (deflate off) | measured at 2,500 sockets per node; larger counts extrapolated |
| Sockets per node (memory bound) | `(limit - base) / s` | 4 GB limit gives about 100,000; 2 GB gives about 50,000 | extrapolated from `s` |
| Sockets per node (design) | tuned target | 25,000 | **not measured**; the laptop's kernel file table (30,720 descriptors shared by everything) stopped runs at 10,000 total |
| Nodes for connections | `ceil(C / 25,000 x 1.3)` headroom | | model |
| Ingest per process | writes are one transaction of about 5 statements (message, outbox row, room summary, room metrics, locator) | **about 350 to 700 messages/s per process** with PostgreSQL on the same 8 cores; 1,000 concurrent writers on one hot room get about 57% of that | measured (hot-room table); on dedicated database hardware the per-process figure is expected to be higher (not measured) |
| Nodes for ingest | `ceil(M / 400)` at the conservative end | 10,000 msg/s needs about 25 processes of write capacity | extrapolated; the node count for connections (40) already exceeds it |
| PostgreSQL primary writes | `M x 5` statements/s, plus indexes; bulk insert into the partitioned table reached 36,000 rows/s with indexes | 10,000 msg/s is about 50,000 statements/s | extrapolated; the bulk rate is measured |
| Redis publishes | `M x channels per message` (typically 1 to 4: the room's audience channels) | | model |
| Redis egress | `publishes x subscribed nodes x payload` | 10,000 msg/s x 40 nodes x 1 KB is about 400 MB/s if every node subscribes to the busiest channels | extrapolated; **this is the first thing that will not fit one Redis**, see bottlenecks |
| Disk | `rows x 602 bytes` including indexes | 100M messages/day is about 60 GB/day online; 30 days is about 1.8 TB | measured constant (50M-row load), arithmetic extrapolated |

### Sizing tables (all rows are model output, not measurements)

| | 100,000 connections | 1,000,000 connections |
| --- | --- | --- |
| App nodes (4 vCPU / 16 GB, 25,000 sockets each, 30% headroom) | 6 | 52 (about 40 at full tuning) |
| RSS per node at the target (25,000 x 30 KB + base) | about 0.9 GB | about 0.9 GB |
| Ingest | 1,000 msg/s: 3 to 4 processes of write capacity | 10,000 msg/s: about 25 processes (already covered by the nodes above) |
| PostgreSQL primary | 8 vCPU / 32 GB, 1 replica | 16+ vCPU / 64+ GB, 2 replicas, provisioned IOPS, 64 hash partitions (`MESSAGE_HASH_PARTITIONS`, chosen before first start) |
| PgBouncer | 1 pair, `pool_size` 40 | 3 or more, total server connections about 4 x primary vCPUs |
| Redis | 1 primary + replica | Redis Cluster, 6 or more shards, sharded pub/sub |
| Online storage (30 days at 100M msgs/day) | 0.2 TB at 10M/day | 1.8 TB, then archive |

### PgBouncer and pool sizing

Server connections to PostgreSQL ≈ `4 x primary vCPUs` (more only adds contention). App side: `DATABASE_POOL_MAX` per node times nodes can be far larger than that because PgBouncer in transaction mode multiplexes: set PgBouncer `default_pool_size` to the server budget divided by databases/users, `max_client_conn` to `nodes x DATABASE_POOL_MAX x 1.2`, and `DATABASE_PGBOUNCER=true` (disables named prepared statements; the app uses no session state and takes only transaction-scoped advisory locks). Pool exhaustion on the app side shows as rising `conv_http_request_duration_seconds` with idle PostgreSQL; the hot-room run produced its only errors that way at 1,000 concurrent writers on a pool of 40.

## Bottleneck ranking (what breaks first as load grows)

1. **Redis pub/sub egress** (extrapolated). With a plain adapter every node that has any subscriber to a channel receives every publish. Computed audiences keep channel counts small but the per-workspace `managers` channel is subscribed by every node that has a manager online. Mitigation, in order: Redis Cluster with sharded pub/sub (`SPUBLISH`), routing a workspace's sockets to a subset of nodes (consistent hashing at the balancer), then splitting by region. The `EventBus` for events other than socket fan-out already uses Redis Streams with consumer groups.
2. **PostgreSQL write IOPS and WAL** at 10,000 msg/s x about 5 statements. Mitigation: partition count chosen up front, batch consumers for rollups, the outbox keeps analytics off the write path, then shard workspaces across clusters (`workspaces.home_region` is the routing key, see Known limits: refusal in the wrong region is implemented, cross-cluster operation is not).
3. **Event-loop CPU per node at 25,000 sockets** (heartbeats, serialisation): not measured. Mitigation: more, smaller nodes (the model already assumes 4 vCPU), `perMessageDeflate` off, one serialisation per broadcast, coalesced presence and typing.
4. **File descriptors and ephemeral ports** on nodes and load balancers: operational tuning below.
5. **Hot rooms**: bounded by the per-room send limit and measured (about 57% of spread-out throughput at 1,000 writers on one room); not the first limit.
6. **Planning time on partitioned tables** grows with leaf count (96 ms to plan a query that cannot prune on 256 leaves at 50M rows): hot queries are prepared and room-scoped so they plan once and touch one partition; keep the hot window to a few months of leaves.
7. **Single-process outbox relay and rollups**: the relay runs under a lock on one node at a time (one pass drains up to 20 batches every 200 ms); when the outbox lag alert fires, raise the batch size or shard the relay by partition key before anything else.

## Node tuning

| Setting | Value to start from | Why |
| --- | --- | --- |
| `ulimit -n` | 100,000 per process (1,000,000 on the host) | one descriptor per socket plus database and Redis connections |
| `net.core.somaxconn`, `net.ipv4.tcp_max_syn_backlog` (Linux) / `kern.ipc.somaxconn` (macOS) | 4,096 / 8,192 | accept backlog; at the default 128 a burst of a few hundred SYNs per node is reset |
| `net.ipv4.ip_local_port_range` | `10000 65535` | ephemeral ports (relevant on the proxy and generator side, per source and destination address) |
| `net.ipv4.tcp_keepalive_time` | 120 or less, with the balancer idle timeout above the Socket.IO ping interval (25 s) | dead connections are found by ping, not by the kernel |
| `NODE_OPTIONS=--max-old-space-size` | about 75% of the container memory limit (3072 for a 4 GB limit) | avoid OOM kill before V8 collects |
| `UV_THREADPOOL_SIZE` | 8 | DNS, crypto (scrypt on login) and file I/O |
| Processes per core | one process per vCPU group (4 vCPU nodes run one process; the app is single-threaded for I/O) | cluster mode is not used: sockets are not shared across processes |
| `WS_MAX_CONNECTIONS` | about 90% of what the node was sized for | shed with 503 and a jittered retry hint instead of falling over |
| `terminationGracePeriodSeconds` | above `preStop sleep + WS_DRAIN_MS + in-flight request time` (60 s in `deploy/k8s`) | zero-loss deploys |

The harness README (`loadtest/README.md`) lists the macOS and Linux commands for raising the limits further on a test machine; they need `sudo` and are never run by the harness.

## Known limits

* SQLite (the default) is single-node by design. The topology that scales is PostgreSQL plus Redis.
* `LocalDiskStorage` is per node; multi-node needs an object-store `Storage` or a shared volume.
* Socket delivery is at-most-once; gaps are repaired by clients over REST. A message that commits but whose fan-out fails (for example the node dies between commit and emit) is stored and delivered on the next fetch, not pushed again; sequence numbers make the gap visible.
* The Kafka and NATS event-bus adapters are stubs that fail loudly (contract tests exist for the interface; Redis Streams is the only production implementation).
* One PostgreSQL cluster per installation. Multi-region has its routing hook only: `workspaces.home_region` (set by an operator) and `REGION` make an installation refuse a workspace homed elsewhere with `421 WRONG_REGION` and the correct region in the error, so a global edge or balancer can route it home. Asynchronous cross-region replication, region-aware failover and global routing are design only (a workspace's home region is the failover unit; read-mostly data such as the widget config can be replicated asynchronously; the failover procedure would promote the home region's replica and flip the routing table).
* The first 50M-row figures are for the `messages` table only; `room_metrics`, `outbox_events` and the audit log were not loaded to that size.
* Partitioning an existing large `messages` table needs the online procedure in [RUNBOOK.md](RUNBOOK.md), which has not been rehearsed on a multi-million-row production table.

## Measured versus extrapolated

Every figure used above, with its status. "Measured" means a run of this repository's harness on the laptop described in PERFORMANCE.md, with the run named; anything else is a model.

| Figure | Value | Status | Source |
| --- | --- | --- | --- |
| Sockets held by a 4-node cluster | 10,000 (2,500 per node), 0 connect errors | measured | `ramp-10k-4node` |
| Connect latency during that ramp | p50 99 ms, p99 768 ms at 700 connections/s | measured | same |
| RSS per idle socket | about 25 to 35 KB (derived) | measured (derived) | same |
| Sockets per node at 25,000 | | **not measured** | CLOUD-LOADTEST |
| 100,000 and 1,000,000 sockets | | **not measured, never claimed** | CLOUD-LOADTEST |
| Zero lost / duplicated / reordered through node kill, Redis restart, PostgreSQL freeze | 0 / 0 / 0 in database and clients | measured | `fault-*` |
| Reconnect storm, 950 of 2,000 sockets killed | 99% back in 2.0 s, nothing missing after resync | measured | `storm-3node` |
| Exactly-once across 3 nodes with 10 racing duplicates | 1,000 of 1,000 | measured | `idem-3node` |
| Slow consumers evicted without harming others | 6 of 6, healthy p99 79 ms | measured | `slow-2node` |
| Multi-node correctness (every delivery crossing Redis) | 0 gaps / 0 dups at 3, 4, 5 nodes | measured | `scaleout-*` |
| Near-linear scale-out | not shown: per-node CPU and latency rose with node count on a saturated single machine | **inconclusive** | `scaleout-*`, PERFORMANCE |
| Write path per process | about 350 to 700 msg/s (PostgreSQL on the same cores) | measured | `hotroom` |
| Hot room at 1,000 writers | about 250 msg/s, about 57% of spread-out writes | measured | `hotroom` |
| Fan-out ceiling of the server | | **not measured** (generator-bound) | `roomsize` |
| Bulk insert into the partitioned table | 36,276 rows/s with indexes, 50,000,000 rows | measured | `dataset-50m` |
| Bytes per message row including indexes | 602 | measured | same |
| Room-scoped hot queries at 50M rows | 0.1 to 3 ms execution, one hash partition, 3 to 8 ms plain planning | measured | same |
| Lookup by id without the room at 50M rows | 54 ms p50 plain, 16 partitions | measured | same |
| 10B rows | | **extrapolated** (arithmetic on 602 bytes per row and the archive design) | this page |
| 10,000 msg/s ingest | | **extrapolated** from per-process write capacity | this page |
| Redis egress at 1M sockets | | **extrapolated**; expected to need sharded pub/sub | this page |
| Limiter overhead | 1 to 8 microseconds in memory, 31 to 150 microseconds on Redis with leases, 0.8 to 3.4 ms Redis round trip without | measured | `bench/limiter.ts` |
| Rollup consumer | 112,000 events/s on in-memory SQLite | measured (SQLite only) | `bench/rollup.ts` |
| Cost estimates | | **assumptions** | CLOUD-LOADTEST |
