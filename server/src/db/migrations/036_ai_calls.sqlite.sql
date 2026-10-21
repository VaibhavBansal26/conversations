-- @sqlite-foreign-keys-off
-- AI voice and video calls (docs/CALLS.md, ADR 0033). A call with the AI agent has transport 'ai' and kind 'ai_voice' or 'ai_video'; it records which
-- agent answered, which speech engine the visitor's browser used and why a hand-over happened. SQLite cannot alter a CHECK, so `calls` is rebuilt with the
-- documented procedure (ADR 0023): no sqlite_master edits, foreign keys off through the directive above, every index recreated. Nothing references
-- `calls`, so no child rows are at risk; rows are copied unchanged and the three new columns start empty.
CREATE TABLE calls_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  ticket_id TEXT,
  contact_id TEXT NOT NULL,
  -- webrtc: in the browser between the inbox and the visitor's page; phone: Twilio Voice click-to-call; ai: the visitor talks to the AI agent (no media leaves the visitor's browser except the text of what was said)
  transport TEXT NOT NULL DEFAULT 'webrtc' CHECK (transport IN ('webrtc','phone','ai')),
  kind TEXT NOT NULL CHECK (kind IN ('voice','video','ai_voice','ai_video')),
  state TEXT NOT NULL CHECK (state IN ('ringing','connecting','active','declined','missed','ended','failed')),
  -- the team member who placed the call; for an AI call the visitor's contact id
  initiated_by TEXT NOT NULL,
  agent_socket TEXT,
  visitor_socket TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT,
  duration_s INTEGER,
  ended_by TEXT,
  end_reason TEXT,
  message_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  -- AI calls: the agent that answered, the speech engine ('browser'), and the reason the call went to a person
  ai_agent_id TEXT,
  engine TEXT,
  handoff_reason TEXT
);
INSERT INTO calls_new (id, workspace_id, room_id, ticket_id, contact_id, transport, kind, state, initiated_by, agent_socket, visitor_socket, created_at, answered_at, ended_at, duration_s, ended_by, end_reason, message_id, meta, updated_at)
SELECT id, workspace_id, room_id, ticket_id, contact_id, transport, kind, state, initiated_by, agent_socket, visitor_socket, created_at, answered_at, ended_at, duration_s, ended_by, end_reason, message_id, meta, updated_at
FROM calls;
DROP TABLE calls;
ALTER TABLE calls_new RENAME TO calls;
CREATE UNIQUE INDEX ux_calls_room_live ON calls(room_id) WHERE state IN ('ringing','connecting','active');
CREATE INDEX ix_calls_room ON calls(room_id, created_at);
CREATE INDEX ix_calls_ws ON calls(workspace_id, created_at);
CREATE INDEX ix_calls_live ON calls(state, created_at);
