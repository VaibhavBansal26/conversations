# 0027. Tickets are episodes inside a room, opened by the message path

Status: accepted (2026-10-21).

## Context

A room is one thread per contact for ever ([ADR 0002](0002-database-is-the-arbiter.md): `ux_rooms_contact`). Support teams think in issues: "ticket 214 about the invoice PDF", resolved on Tuesday, a new one on Friday. AI agents need a unit that starts, is handled by a bot or a person, ends and is rated. Splitting the room per issue would break the one-room-per-contact rule that SMS number locks, email threading, unread math and the widget all rely on.

## Decision

- A `tickets` table of episodes **inside** a room. Rooms are unchanged. `messages.ticket_id` links each message to its episode (a plain column, no foreign key: `messages` is hash-partitioned on PostgreSQL and archived and restored as rows).
- The state machine runs **inside `insertMessage`'s transaction** (`ticketOnMessage`), so every way a message can arrive (widget, socket, SMS, email, agent, bot, seed) opens, reopens or answers tickets identically and no message is stored against a stale ticket.
- At most one live ticket per room: the partial unique index `ux_tickets_room_live (room_id) WHERE status <> 'closed'`. A lost race raises a unique violation inside a savepoint and the loser joins the winner's ticket (PostgreSQL would otherwise abort the whole transaction).
- Numbers come from `ticket_counters` with one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so they are contiguous per workspace and roll back with the transaction.
- Time-based rules (idle resolve, close after resolution) are a scheduler sweep, bounded per pass, judged against each workspace's own settings; reopening is also evaluated lazily when the customer writes, so the sweep is tidying, not correctness.
- No backfill of old messages: a populated database upgrades by adding tables, and a room gets its first ticket with its next message.

## Alternatives considered

- **A room per ticket**: simplest model for helpdesk people, but it breaks per-contact SMS number pinning, email threading and the widget's "your conversation", and creates many rooms per contact.
- **Tickets as room status values** (`open`, `pending`, ...): cannot represent several issues over time, handler, department or rating per issue.
- **Opening tickets in a background consumer of the outbox**: removes work from the write path, but a message would exist without a ticket for a while and the reply latency of a bot would depend on the consumer; the extra statements per message are one indexed lookup.
- **Backfilling a ticket per existing room and the `ticket_id` of every message**: an unbounded rewrite of the largest table for a field nothing needs yet.

## Consequences

- One more indexed read per stored message (`ux_tickets_room_live`); an insert only when an issue starts.
- A conversation's history before the upgrade is "outside any ticket" and the ticket history of old contacts starts at the upgrade.
- `ticket:updated` is emitted by `emitInserted` after commit; code that inserts a message and emits it by other means must publish the touched tickets (the result carries them).
