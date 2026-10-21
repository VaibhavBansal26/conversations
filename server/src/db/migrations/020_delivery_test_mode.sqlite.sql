-- @sqlite-bump-schema-version
-- `not_sent_test_mode`: the message was stored while the active SMS/email provider was the console/fake one, so nothing left the server.
-- SQLite cannot alter a CHECK constraint, and rebuilding `messages` would cascade-delete message_mentions (ON DELETE CASCADE fires on DROP TABLE
-- while foreign keys are on). The documented alternative for a change that cannot invalidate existing rows is to edit the stored CREATE TABLE text
-- (https://www.sqlite.org/lang_altertable.html, "Making Other Kinds Of Table Schema Changes", the writable_schema procedure); the runner bumps
-- schema_version afterwards because it cannot be computed in plain SQL.
PRAGMA writable_schema = ON;
UPDATE sqlite_master
   SET sql = replace(sql, 'CHECK (delivery IN (''pending'',''sent'',''delivered'',''failed''))', 'CHECK (delivery IN (''pending'',''sent'',''delivered'',''failed'',''not_sent_test_mode''))')
 WHERE type = 'table' AND name = 'messages';
PRAGMA writable_schema = OFF;
