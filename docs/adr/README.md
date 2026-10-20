# Architecture decision records

Short records of decisions that shaped the system. Add one when you make a decision that is expensive to reverse.

* [0001](./0001-sqlite-default-postgres-for-scale.md) SQLite by default, PostgreSQL + Redis to scale out
* [0002](./0002-database-is-the-arbiter.md) The database arbitrates invariants, not process memory
* [0003](./0003-server-side-idempotency.md) Message idempotency on (room_id, client_msg_id) in the server
* [0004](./0004-hash-partition-messages-by-room.md) Partition messages by HASH(room_id), then monthly by created_at
* [0005](./0005-computed-room-audiences.md) Fan out room events to computed audiences, not per-room channels
* [0006](./0006-transactional-outbox-event-bus.md) Transactional outbox and an EventBus interface
* [0007](./0007-rate-limit-algorithms-and-leases.md) GCRA, sliding windows, leases and a never-over-admit local tier
* [0008](./0008-message-refs-locator.md) A locator table for lookups that do not know the room
* [0009](./0009-permessage-deflate-off.md) WebSocket compression off by default
* [0010](./0010-worker-threads-only-where-measured.md) Worker threads only for large HTML bodies
* [0011](./0011-resync-over-rest.md) Clients repair gaps over REST, not with replayed streams
