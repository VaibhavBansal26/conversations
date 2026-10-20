# 0005. Fan out room events to computed audiences, not per-room channels

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

A socket that joins one channel per visible room costs O(rooms) memory and connect time, and every assignment change rewrites memberships on every node.

## Decision

Team events for a room go to `managers`, `inboxv:<inbox>` (agents who see their inbox) and `member:<id>` for each assignee, computed from the room's inbox and assignees (cached briefly, invalidated cluster-wide on change). Visitors still use `vroom:<id>` (one room each). A team socket therefore joins O(inboxes) channels.

## Consequences

Connect time and memory no longer depend on the number of rooms (asserted in `tests/scale.test.ts`). An audience lookup per event costs one cheap query on a cache miss; events for one room are emitted in order through a per-room promise chain.
