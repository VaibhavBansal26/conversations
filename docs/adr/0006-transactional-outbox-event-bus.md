# 0006. Transactional outbox and an EventBus interface

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

Downstream consumers (rollups, analytics, notifications) need every message event, in order per room, and must survive crashes.

## Decision

`message.created` is written to `outbox_events` in the message's transaction. A leader-elected relay publishes to the `EventBus` (Redis Streams by default, in-memory otherwise) and marks rows published; consumers dedupe by event id (`consumed_events`). Streams are partitioned by room; one active reader per (group, partition) held by a Redis lease gives per-key order with scaled-out consumers. Kafka and NATS adapters are documented stubs sharing the contract test suite.

## Consequences

Nothing is published before commit and nothing is lost between commit and publish; delivery is at least once. Cost: one extra insert per message. The Kafka/NATS adapters are not implemented.
