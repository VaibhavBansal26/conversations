-- Denormalised room summary: the "last message" card shown in lists, kept current by the transaction that writes the message, so listing
-- rooms never has to touch the (large, partitioned) messages table. NULL = not yet computed (rows from before this migration; lazily filled).
ALTER TABLE rooms ADD COLUMN last_brief TEXT;

-- Idempotency keys live outside `messages`: a unique index on a partitioned messages table would have to include the partition keys and so
-- could not stop the same client_msg_id from landing in two partitions. One row per (room, client_msg_id), pruned after the retry window.
CREATE TABLE message_qids (
  room_id TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, client_msg_id)
);
INSERT INTO message_qids(room_id, client_msg_id, message_id, created_at) SELECT room_id, client_msg_id, id, created_at FROM messages WHERE client_msg_id IS NOT NULL;
CREATE INDEX ix_qids_created ON message_qids(created_at);
