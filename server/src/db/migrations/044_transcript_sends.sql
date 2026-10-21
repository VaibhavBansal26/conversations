-- Transcripts sent by email (docs/TRANSCRIPTS.md): one row per send, for the per-contact limit, "once per ticket" after a resolution and the team's view. Additive only.
CREATE TABLE transcript_sends (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  ticket_id TEXT,
  contact_id TEXT NOT NULL,
  -- visitor | member | ai | after_resolve
  requested_by TEXT NOT NULL CHECK (requested_by IN ('visitor','member','ai','after_resolve')),
  member_id TEXT,
  -- "a…@example.com": enough for the team to recognise it, never the full address
  to_hint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','not_sent_test_mode','failed')),
  messages INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_transcript_sends_room ON transcript_sends(room_id, created_at);
CREATE INDEX ix_transcript_sends_contact ON transcript_sends(workspace_id, contact_id, created_at);
-- at most one automatic copy per ticket, even under races
CREATE UNIQUE INDEX ux_transcript_sends_after ON transcript_sends(ticket_id) WHERE requested_by = 'after_resolve';
