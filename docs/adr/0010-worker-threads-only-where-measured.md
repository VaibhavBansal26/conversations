# 0010. Worker threads only for large HTML bodies

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

CPU-heavy work should not block the event loop, but threads cost memory and latency.

## Decision

A small `worker_threads` pool sanitises large HTML bodies; everything else stays inline. A cached BM25 index replaced per-request index building. Thresholds came from `server/bench/cpu.ts` and `bench/pool.ts`.

## Consequences

Small bodies pay no hand-off cost. The pool is off in tests and configurable (`WORKER_POOL_SIZE`).
