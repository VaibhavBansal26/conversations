-- PostgreSQL only: `messages` becomes a partitioned table.
--
--   HASH (room_id), 16 ways by default         every access to a room's messages (history, unread, last message, search within a room) names the room, so the
--                                   planner prunes to ONE hash partition; load spreads evenly even when a single tenant is huge
--   -> RANGE (created_at), monthly  retention and archival detach whole months (O(1)), BRIN/btree stay small, old months can live on cheaper storage
--   -> DEFAULT                      catches anything outside the pre-created months, so an insert never fails for want of a partition
--
-- Uniqueness that cannot span partitions is not declared: (room_id, seq) is allocated under the room row lock (UPDATE rooms ... RETURNING)
-- and (room_id, client_msg_id) lives in message_qids (migration 007). Foreign keys that pointed AT messages are dropped (message_mentions);
-- the application deletes mentions together with the message in one transaction.
--
-- Converting a deployment with a large messages table: this migration copies in one transaction. For tables beyond a few million rows use
-- the online procedure in docs/RUNBOOK.md (create the partitioned table alongside, backfill in batches, swap).

ALTER TABLE message_mentions DROP CONSTRAINT IF EXISTS message_mentions_message_id_fkey;
ALTER TABLE messages RENAME TO messages_unpartitioned;
ALTER TABLE messages_unpartitioned RENAME CONSTRAINT messages_pkey TO messages_unpartitioned_pkey;
DROP INDEX IF EXISTS ux_messages_room_seq;
DROP INDEX IF EXISTS ux_messages_qid;
DROP INDEX IF EXISTS ix_messages_provider;
DROP INDEX IF EXISTS ix_messages_rfc;
DROP INDEX IF EXISTS ix_messages_delivery;

CREATE TABLE messages (
  id TEXT NOT NULL,
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
  delivery TEXT NOT NULL DEFAULT 'sent' CHECK (delivery IN ('pending','sent','delivered','failed')),
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
) PARTITION BY HASH (room_id);

-- the number of hash partitions is fixed at creation (16 unless the migration runner set conv.hash_partitions, as the test suite does to keep schemas small)
DO $$
DECLARE n int := COALESCE(NULLIF(current_setting('conv.hash_partitions', true), ''), '16')::int;
BEGIN
  FOR h IN 0..n - 1 LOOP
    EXECUTE format('CREATE TABLE messages_h%s PARTITION OF messages FOR VALUES WITH (MODULUS %s, REMAINDER %s) PARTITION BY RANGE (created_at)', h, n, h);
    EXECUTE format('CREATE TABLE messages_h%s_default PARTITION OF messages_h%s DEFAULT', h, h);
  END LOOP;
END $$;

-- Creates the monthly leaves for [from_month, to_month] under every hash partition. Idempotent. Rows that already sit in a DEFAULT
-- partition for a month being created are moved into the new leaf. Called by this migration, at boot, and by the scheduler.
CREATE OR REPLACE FUNCTION conv_ensure_message_partitions(from_month date, to_month date) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE
  h int; m date; lo text; hi text; leaf text; parent text; dflt text; made int := 0; stuck boolean; n int;
BEGIN
  -- several nodes call this at boot: serialise them (transaction-scoped, so it is released on commit and safe behind PgBouncer)
  PERFORM pg_advisory_xact_lock(727275);
  SELECT count(*) INTO n FROM pg_inherits WHERE inhparent = 'messages'::regclass;
  m := date_trunc('month', from_month)::date;
  WHILE m <= to_month LOOP
    lo := to_char(m, 'YYYY-MM-DD') || 'T00:00:00.000Z';
    hi := to_char((m + interval '1 month')::date, 'YYYY-MM-DD') || 'T00:00:00.000Z';
    FOR h IN 0..n - 1 LOOP
      parent := format('messages_h%s', h);
      dflt := parent || '_default';
      leaf := format('messages_h%s_%s', h, to_char(m, 'YYYYMM'));
      IF to_regclass(leaf) IS NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE created_at >= %L AND created_at < %L)', dflt, lo, hi) INTO stuck;
        IF stuck THEN
          EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', parent, dflt);
          EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', leaf, parent, lo, hi);
          EXECUTE format('INSERT INTO %I SELECT * FROM %I WHERE created_at >= %L AND created_at < %L', leaf, dflt, lo, hi);
          EXECUTE format('DELETE FROM %I WHERE created_at >= %L AND created_at < %L', dflt, lo, hi);
          EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I DEFAULT', parent, dflt);
        ELSE
          EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', leaf, parent, lo, hi);
        END IF;
        made := made + 1;
      END IF;
    END LOOP;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN made;
END
$fn$;

-- months covering the existing data, plus the current month and three ahead
DO $$
DECLARE lo date; hi date;
BEGIN
  SELECT COALESCE(LEAST(MIN(substr(created_at, 1, 10))::date, date_trunc('month', now())::date), date_trunc('month', now())::date) INTO lo FROM messages_unpartitioned;
  hi := (date_trunc('month', now()) + interval '3 months')::date;
  IF lo < hi - interval '120 months' THEN lo := (hi - interval '120 months')::date; END IF;
  PERFORM conv_ensure_message_partitions(lo, hi);
END $$;

INSERT INTO messages SELECT * FROM messages_unpartitioned;

-- local indexes (created on the partitioned table, so every current and future partition gets one)
CREATE INDEX ix_messages_room_seq ON messages(room_id, seq);
CREATE INDEX ix_messages_id ON messages(id);
CREATE INDEX ix_messages_ws_time ON messages(workspace_id, created_at);
CREATE INDEX ix_messages_created_brin ON messages USING BRIN (created_at);
CREATE INDEX ix_messages_provider ON messages(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX ix_messages_rfc ON messages(workspace_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX ix_messages_delivery ON messages(delivery, source) WHERE delivery IN ('pending','sent');

DROP TABLE messages_unpartitioned;
