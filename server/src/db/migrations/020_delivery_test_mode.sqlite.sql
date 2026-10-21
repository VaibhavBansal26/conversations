-- @sqlite-foreign-keys-off
-- `not_sent_test_mode`: the message was stored while the active SMS/email provider was the console/fake one, so nothing left the server.
-- SQLite cannot alter a CHECK constraint, so `messages` is rebuilt with the documented 12-step procedure
-- (https://www.sqlite.org/lang_altertable.html, "Making Other Kinds Of Table Schema Changes"). It never edits sqlite_master or uses
-- writable_schema: that is forbidden when the SQLite build runs with SQLITE_DBCONFIG_DEFENSIVE (the node:24-slim image does), see ADR 0023.
--
-- The runner executes this file with `PRAGMA foreign_keys = OFF` (the directive on line 1; the pragma cannot change inside a transaction, so
-- the runner sets it before BEGIN), inside one transaction, and afterwards compares `PRAGMA foreign_key_check` with the state before the
-- migration and fails (rolling back) on any new violation. With foreign keys off, DROP TABLE does not fire message_mentions'
-- ON DELETE CASCADE, so no child rows are lost. Anything that references `messages` keeps working because the new table takes the same name.
-- Every index that belongs to `messages` is recreated below; tests/migrations.upgrade.test.ts compares them with a fresh schema.
CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  client_msg_id TEXT,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('agent','contact','bot','system')),
  sender_id TEXT,
  sender_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('text','image','voice','gif','attachment','ref','note','system')),
  source TEXT NOT NULL CHECK (source IN ('dm','sms','email')),
  content TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  subject TEXT,
  ref_message_id TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  delivery TEXT NOT NULL DEFAULT 'sent' CHECK (delivery IN ('pending','sent','delivered','failed','not_sent_test_mode')),
  failure_reason TEXT,
  provider_message_id TEXT,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_hdr TEXT,
  from_addr TEXT,
  to_addr TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  opened_at TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO messages_new (id, workspace_id, room_id, seq, client_msg_id, sender_type, sender_id, sender_name, kind, source, content, content_text, subject, ref_message_id, attachments, meta, delivery, failure_reason, provider_message_id, rfc_message_id, in_reply_to, references_hdr, from_addr, to_addr, retry_count, delivered_at, opened_at, edited_at, deleted_at, deleted_by, created_at)
SELECT id, workspace_id, room_id, seq, client_msg_id, sender_type, sender_id, sender_name, kind, source, content, content_text, subject, ref_message_id, attachments, meta, delivery, failure_reason, provider_message_id, rfc_message_id, in_reply_to, references_hdr, from_addr, to_addr, retry_count, delivered_at, opened_at, edited_at, deleted_at, deleted_by, created_at
FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE UNIQUE INDEX ux_messages_room_seq ON messages(room_id, seq);
CREATE UNIQUE INDEX ux_messages_qid ON messages(room_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX ix_messages_provider ON messages(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX ix_messages_rfc ON messages(workspace_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX ix_messages_delivery ON messages(delivery, source) WHERE delivery IN ('pending','sent');
CREATE INDEX ix_messages_ws_time ON messages(workspace_id, created_at);
