-- Rooms always carry an activity timestamp so the inbox list can be served straight from an index (and paged with a keyset cursor).
UPDATE rooms SET last_message_at = created_at WHERE last_message_at IS NULL;

DROP INDEX ix_rooms_ws_status;
CREATE INDEX ix_rooms_list ON rooms(workspace_id, status, archived, last_message_at, id);
CREATE INDEX ix_rooms_all ON rooms(workspace_id, archived, last_message_at, id);
CREATE INDEX ix_rooms_prio ON rooms(workspace_id, status, archived, priority, last_message_at, id);

-- notification feed: newest first per seat
CREATE INDEX ix_notifications_feed ON notifications(member_id, created_at, id);

-- contact keyset listing (partial: PostgreSQL cannot use `col IS NULL` as an ordering-preserving equality, a partial index sidesteps that)
CREATE INDEX ix_contacts_list ON contacts(workspace_id, created_at, id) WHERE deleted_at IS NULL;

-- digest outbox flag: set when a contact message arrives, cleared once the digest pass has consumed it
ALTER TABLE rooms ADD COLUMN digest_due INTEGER NOT NULL DEFAULT 0;
CREATE INDEX ix_rooms_digest ON rooms(last_contact_message_at) WHERE digest_due = 1;
UPDATE rooms SET digest_due = 1 WHERE EXISTS (SELECT 1 FROM messages m WHERE m.room_id = rooms.id AND m.seq > rooms.digest_seq AND m.sender_type = 'contact' AND m.deleted_at IS NULL);
