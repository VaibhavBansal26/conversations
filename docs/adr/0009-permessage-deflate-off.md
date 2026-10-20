# 0009. WebSocket compression off by default

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

Chat messages are small; CPU and per-connection memory are the scarce resources.

## Decision

`WS_PERMESSAGE_DEFLATE=false`. Benchmark (`server/bench/deflate.mjs`, 2026-10-19, M1): a 1.3 KB event compresses to 40% in about 32 microseconds per recipient, and each connection pays about 94 KB for its deflate and inflate contexts, against roughly 20 to 30 KB per idle connection without it.

## Consequences

Bandwidth is higher; memory per connection stays small. Revisit if egress cost dominates.
