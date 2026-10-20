# 0004. Partition messages by HASH(room_id), then monthly by created_at

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

Targets: billions of rows, retention by dropping old data, and every hot query scoped to one room.

## Decision

`messages` is `PARTITION BY HASH (room_id)` (16 ways) and each hash partition is `RANGE (created_at)` monthly plus a DEFAULT leaf. Room-scoped queries prune to one hash partition; a month is retired by detaching a leaf. Leaves are created ahead of time by `conv_ensure_message_partitions`. The brief suggested monthly-then-hash(workspace); hash(room) was chosen because every hot access names a room, not a workspace, and a single huge tenant still spreads evenly.

## Consequences

Measured on 50M rows (see PERFORMANCE.md). Costs: planning time grows with the number of leaves (mitigated by named prepared statements and by keeping the hot window to a few months), lookups by message id alone probe every partition (mitigated by `message_refs` and room-scoped queries, ADR 0008), tenant-wide scans use a `(workspace_id, created_at)` index per leaf.

## Alternatives

Rejected: no partitioning (retention by DELETE does not scale), hash(workspace_id) (room queries would not prune without adding workspace everywhere).
