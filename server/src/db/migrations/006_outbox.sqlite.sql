-- Transactional outbox: a domain event is written in the SAME transaction as the change that caused it; a relay publishes it to the event
-- bus afterwards. Nothing is published before commit and nothing is lost if the process dies between commit and publish.
-- `ord` is the publish order. Events with the same key are inserted while holding that key's room row lock, so for one room `ord` follows
-- commit order even though ids/timestamps may not.
CREATE TABLE outbox_events (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX ix_outbox_unpublished ON outbox_events(ord) WHERE published_at IS NULL;
CREATE INDEX ix_outbox_published ON outbox_events(published_at) WHERE published_at IS NOT NULL;

-- Consumer-side idempotency: an effect and its marker commit together, so a redelivered event is a no-op.
CREATE TABLE consumed_events (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (consumer, event_id)
);

-- Rollup maintained by the `rollup` consumer from message.created events: per workspace, day, channel and direction.
CREATE TABLE rollup_messages_daily (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, channel, direction)
);
