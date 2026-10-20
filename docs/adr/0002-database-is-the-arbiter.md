# 0002. The database arbitrates invariants, not process memory

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

Legacy bugs came from check-then-insert races. Multiple nodes make in-process locks meaningless.

## Decision

Invariants are enforced by the database: unique indexes (one live room per contact, token per domain, webhook events), `INSERT ... ON CONFLICT`, `UPDATE ... RETURNING` for per-room `seq`, row locks (`FOR NO KEY UPDATE`) for round robin. Services handle the constraint violation by returning the winner. `tests/concurrency.test.ts` proves it on both databases and across nodes.

## Consequences

Correctness does not depend on being single threaded or single node. The price is that hot rows serialise (see ADR 0006 and the hot-room measurement).
