# 0018. Messages stored while a channel is not connected are `not_sent_test_mode`

Status: accepted (2026-10-20).

## Context

`SMS_PROVIDER` and `EMAIL_PROVIDER` default to `console`, which only logs. A workspace on such a deployment saw every SMS and email as "sent" (a check mark) although nothing left the server, and reported that "SMS and email do not work". The UI never said so.

## Decision

- A provider can declare itself `simulated` (the console providers do; the in-memory fake is switchable). When the provider that would send a message is simulated, the message is stored with `delivery = not_sent_test_mode` and a `failure_reason` that explains how to fix it. No credits are debited, no reconciliation job is scheduled, no pacing slot is used.
- The web app never renders a sent, delivered or read tick for such a message. It shows a "Test mode: not sent" badge, an explanation with a link to Settings > Channels, and "send it now" (the normal retry route, which also accepts this state) for after the channel is connected. A banner above the composer and at the top of Settings > Channels says the channel is not connected.
- `GET /api/channels/status` reports per channel: mode (`live` or `test`), `connected`, provider, where credentials come from, details (counts only) and the last provider error. It never contains credentials.
- The state is a new value of the existing `delivery` column, not a separate flag, so every consumer that already switches on `delivery` (analytics export, archive, reconcile scan, UI) sees it explicitly instead of mistaking it for `sent`.

## Alternatives considered

- **Keep `sent` and add a boolean `test_mode`.** Every reader that ignores the flag keeps lying (the reconcile scan would poll the provider for fake ids; analytics would count the message as delivered).
- **Reject the send (4xx) while not connected.** Honest, but agents lose the draft and the conversation history of what they intended to say; a trial workspace should be able to try the product.
- **Use `failed`.** It triggers retry-with-backoff and error styling for something that is not an error.

## Consequences

- The `messages.delivery` CHECK constraint changed on both backends. PostgreSQL: drop and re-add on the partitioned parent. SQLite cannot alter a CHECK, and rebuilding `messages` would cascade-delete `message_mentions`, so migration 020 edits the stored table definition (the `writable_schema` procedure from the SQLite documentation, which is valid because no existing row can violate a looser constraint) and the migration runner bumps `schema_version` afterwards. This is the only place the runner treats a migration specially (`-- @sqlite-bump-schema-version`).
- Consumers of the analytics message export see a new `delivery_status` value (schema updated).
- `FakeSmsProvider`/`FakeEmailProvider` default to *not* simulated so the existing suite keeps exercising the live path.
