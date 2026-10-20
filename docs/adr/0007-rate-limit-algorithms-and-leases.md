# 0007. GCRA, sliding windows, leases and a never-over-admit local tier

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

One limiter must be correct across nodes, cheap on the hot path and safe when Redis is down.

## Decision

GCRA for rates (exact Retry-After), sliding-window counters for quotas, ZSET leases for concurrency, a penalty box for repeat offenders; one Lua call per decision with server time; per-policy fail-open/closed with a timeout budget and circuit breaker. The local lease tier takes tokens from the shared bucket in batches, so the cluster never admits more than limit+burst (the spec's alternative, over-admission, was rejected); the price is bounded under-admission.

## Consequences

See docs/RATE-LIMITING.md. Measured overhead in PERFORMANCE.md.
