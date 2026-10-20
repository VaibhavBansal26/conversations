-- Locator for lookups that do not know the room: provider callbacks (SMS status, SendGrid events), email threading by RFC Message-ID, and
-- external-message jobs by message id. `messages` is hash-partitioned by room_id, so a lookup without a room would probe every partition
-- (measured: 130 ms with 256 partitions); one primary-key read here turns it into a single-partition query.
CREATE TABLE message_refs (
  kind TEXT NOT NULL,            -- 'provider' | 'rfc' | 'id'
  ref TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  PRIMARY KEY (kind, ref, workspace_id)
);
INSERT INTO message_refs(kind, ref, workspace_id, message_id, room_id) SELECT 'provider', provider_message_id, workspace_id, id, room_id FROM messages WHERE provider_message_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO message_refs(kind, ref, workspace_id, message_id, room_id) SELECT 'rfc', rfc_message_id, workspace_id, id, room_id FROM messages WHERE rfc_message_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO message_refs(kind, ref, workspace_id, message_id, room_id) SELECT 'id', id, workspace_id, id, room_id FROM messages WHERE source != 'dm' ON CONFLICT DO NOTHING;
