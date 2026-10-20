# 0003. Message idempotency on (room_id, client_msg_id) in the server

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

Clients retry on reconnects, node deaths and timeouts; duplicates must not appear and acknowledged messages must not be lost.

## Decision

The idempotency claim is a row in `message_qids` written in the same transaction as the message. A repeat returns the stored message with `created: false`. A unique index on a partitioned `messages` table cannot span partitions, which is why the claim lives in its own small table (pruned after 30 days).

## Consequences

Exactly-once effect for client retries, verified under SIGKILL of a node (zero lost, zero duplicated). Retries older than 30 days would create a duplicate.
