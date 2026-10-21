# 0028. Departments are inboxes, and routing decisions hold one workspace lock

Status: accepted (2026-10-21).

## Context

Teams already use inboxes ("Support", "Billing") with members and an assignment algorithm (manual or round robin). The new work needs hours with holidays, capacity, skills, service levels, overflow and a queue, and it must not break inboxes that exist, the rooms assigned through them, notifications or the widget's inbox picker. Handoffs happen at the same moment from bots, agents, the scheduler and seat changes, and one person can be a member of several departments.

## Decision

- A department **is** an inbox. Configuration is added to the inbox tables with additive columns (`description`, `routing_mode`, `capacity`, `hours`, service levels, `overflow_inbox_id`, auto-replies; per member `skills`, `languages`, `capacity`). `routing_mode` is nullable: `NULL` reads the old `algorithm` (round robin stays round robin, manual becomes manual pick), so nothing changes until someone configures it. No table is rebuilt, which keeps the SQLite migration free of the defensive-mode hazards of [ADR 0023](0023-sqlite-migrations-defensive-mode.md).
- Routing is one function, `routeTicket`, called by every path (handoff, transfer, queue drain, seat change, SLA escalation). It runs in a transaction that first locks the workspace's `ticket_counters` row (`FOR UPDATE` on PostgreSQL; SQLite's single writer is the lock there). A workspace-wide lock instead of per-department or per-person locks because a person can belong to several departments and overflow chains cross departments: with several locks the order in which they are taken has to be proven deadlock free, with one lock it cannot deadlock. A routing transaction is a handful of indexed statements; the lock is held for milliseconds and no other write path takes it.
- Availability and load are read inside the lock, never cached: a seat's load is a count over live tickets by handler, so it cannot drift from reality, and capacity is checked across departments.
- Everything is idempotent by comparing the new state with the old inside the lock: a repeated handoff, queue pass or SLA escalation writes, notifies and says nothing when nothing changes.
- The overflow chain is walked with a visited set and also validated when configured, so a loop written directly into the database cannot spin.
- Routing rules use plain text operators only, no regular expressions.

## Alternatives considered

- **A new `departments` table** referencing inboxes: cleaner naming, but two objects to keep in sync, a migration of every inbox, and rooms that point at inboxes for visibility would need a second pointer.
- **Advisory locks per department** (`pg_advisory_xact_lock`): finer, but SQLite has no equivalent, the people-in-two-departments case still needs a second lock, and the overflow chain needs a global order.
- **Optimistic assignment with a capacity check in an UPDATE** (`WHERE (SELECT COUNT(*) ...) < cap`): correct per statement under serializable isolation only; under READ COMMITTED two such statements can both pass.
- **Counters per person** instead of counting tickets: constant time, but drifts on every missed decrement.

## Consequences

- Handoffs inside one workspace are serialised. At the measured scale (a routing transaction is a few statements) this is not a limit; a workspace handing off thousands of tickets per second would need a different design (documented in [DEPARTMENTS.md](../DEPARTMENTS.md), not measured).
- A seat with `inbox_visibility = assigned` cannot see queued tickets of a manual-pick department (nothing is assigned to them); such departments want `assigned_inbox` members.
