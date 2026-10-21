-- Group voice and video calls between teammates, up to 4 people, as a WebRTC mesh (docs/CALLS.md, ADR 0038). Additive only.
CREATE TABLE group_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('voice','video')),
  state TEXT NOT NULL CHECK (state IN ('live','ended','missed')),
  host_id TEXT NOT NULL,
  -- the cap in force when the call started (the workspace setting, at most 4)
  max_participants INTEGER NOT NULL CHECK (max_participants BETWEEN 2 AND 4),
  -- who shares their screen right now (at most one person)
  sharing_id TEXT,
  created_at TEXT NOT NULL,
  -- the moment a second person joined
  started_at TEXT,
  ended_at TEXT,
  duration_s INTEGER,
  end_reason TEXT,
  message_id TEXT,
  updated_at TEXT NOT NULL
);
-- one live group call per conversation, even under races (ADR 0002)
CREATE UNIQUE INDEX ux_group_calls_channel_live ON group_calls(channel_id) WHERE state = 'live';
CREATE INDEX ix_group_calls_ws ON group_calls(workspace_id, created_at);
CREATE INDEX ix_group_calls_live ON group_calls(state, created_at);
CREATE TABLE group_call_participants (
  call_id TEXT NOT NULL REFERENCES group_calls(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('invited','joined','left','declined','missed')),
  -- the socket that carries this person's signalling, bound on join and re-bound on resume
  socket_id TEXT,
  invited_by TEXT,
  invited_at TEXT NOT NULL,
  joined_at TEXT,
  left_at TEXT,
  gone_at TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  camera_off INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (call_id, member_id)
);
-- a member is in at most one group call at a time, even under races
CREATE UNIQUE INDEX ux_gcp_member_joined ON group_call_participants(member_id) WHERE status = 'joined';
CREATE INDEX ix_gcp_member ON group_call_participants(workspace_id, member_id, status);
