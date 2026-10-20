# 0011. Clients repair gaps over REST, not with replayed streams

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

Socket.IO connection-state recovery does not work with the plain Redis adapter, and nodes can lose cross-node events during a Redis outage.

## Decision

Clients reconnect with exponential backoff and 80% jitter, then refetch what the screen shows over REST; after a Redis outage each node emits `server:resync` to its sockets. Message sends carry client ids so retries are safe.

## Consequences

Simple and robust; costs one REST refetch per reconnect. Verified by the redis-restart and node-kill scenarios.
