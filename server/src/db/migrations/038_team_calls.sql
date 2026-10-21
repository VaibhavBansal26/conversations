-- Voice and video calls between two teammates, from team chat (docs/CALLS.md, ADR 0036). One row per call; additive only.
-- Group calls are not built: a call is between the two members of a direct message.
CREATE TABLE team_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('voice','video')),
  state TEXT NOT NULL CHECK (state IN ('ringing','connecting','active','declined','missed','ended','failed')),
  caller_id TEXT NOT NULL,
  callee_id TEXT NOT NULL,
  -- the sockets of both sides, bound when they place and answer and re-bound after a network change
  caller_socket TEXT,
  callee_socket TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT,
  duration_s INTEGER,
  -- caller | callee | system
  ended_by TEXT,
  end_reason TEXT,
  -- the card in the direct message
  message_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
-- one live call per conversation, one live call placed per member and one live call received per member, even under races (ADR 0002)
CREATE UNIQUE INDEX ux_team_calls_channel_live ON team_calls(channel_id) WHERE state IN ('ringing','connecting','active');
CREATE UNIQUE INDEX ux_team_calls_caller_live ON team_calls(caller_id) WHERE state IN ('ringing','connecting','active');
CREATE UNIQUE INDEX ux_team_calls_callee_live ON team_calls(callee_id) WHERE state IN ('ringing','connecting','active');
CREATE INDEX ix_team_calls_ws ON team_calls(workspace_id, created_at);
CREATE INDEX ix_team_calls_live ON team_calls(state, created_at);
