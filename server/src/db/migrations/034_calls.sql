-- Voice and video calls between a team member and a visitor (docs/CALLS.md). One row per call, written by the signalling service; additive only.
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  ticket_id TEXT,
  contact_id TEXT NOT NULL,
  -- webrtc: in the browser between the inbox and the visitor's page; phone: Twilio Voice click-to-call to the visitor's phone number
  transport TEXT NOT NULL DEFAULT 'webrtc' CHECK (transport IN ('webrtc','phone')),
  kind TEXT NOT NULL CHECK (kind IN ('voice','video')),
  state TEXT NOT NULL CHECK (state IN ('ringing','connecting','active','declined','missed','ended','failed')),
  -- the team member who placed the call
  initiated_by TEXT NOT NULL,
  -- the sockets of both sides, bound when they answer and re-bound when they come back after a network change
  agent_socket TEXT,
  visitor_socket TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT,
  duration_s INTEGER,
  -- agent | visitor | system
  ended_by TEXT,
  -- cancelled, declined, timeout, completed, disconnected, ice_failed, ...
  end_reason TEXT,
  -- the thread card that shows the call
  message_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
-- at most one live call per conversation, even under races: the database is the arbiter (ADR 0002)
CREATE UNIQUE INDEX ux_calls_room_live ON calls(room_id) WHERE state IN ('ringing','connecting','active');
CREATE INDEX ix_calls_room ON calls(room_id, created_at);
CREATE INDEX ix_calls_ws ON calls(workspace_id, created_at);
CREATE INDEX ix_calls_live ON calls(state, created_at);
