# 0008. A locator table for lookups that do not know the room

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

Provider callbacks and email threading know only a provider id or RFC Message-ID; on a hash-partitioned table that probes every partition (130 ms measured at 256 leaves).

## Decision

`message_refs(kind, ref, workspace_id) -> (message_id, room_id)` for provider ids, RFC ids and external message ids; the lookup is one primary-key read plus a single-partition query. REST edit/delete/retry accept an optional `?room_id=` hint.

## Consequences

Webhook paths stay fast at any size. Dm messages edited without the hint still take the slow path (rare, user initiated).
