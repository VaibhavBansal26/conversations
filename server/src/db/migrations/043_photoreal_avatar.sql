-- Optional photoreal avatars for AI video calls through a hosted provider (D-ID), off until a workspace connects a key AND switches it on
-- (docs/CALLS.md "Photoreal avatar", ADR 0039). The built-in face stays the default. Additive only.
CREATE TABLE avatar_connections (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('did')),
  -- the provider API key, encrypted with DATA_ENCRYPTION_KEY (AAD avatar:<workspace>:<provider>); never returned by the API
  credentials_enc TEXT NOT NULL,
  -- the last four characters, for "connected, ends ...1234"
  key_hint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','connected','failing')),
  last_error TEXT,
  last_checked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE photoreal_avatars (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('did')),
  -- a stock presenter of the provider, or a photo at an https address (the workspace confirmed it has the right to use it)
  source TEXT NOT NULL CHECK (source IN ('presenter','image')),
  presenter_id TEXT,
  image_url TEXT,
  voice_provider TEXT,
  voice_id TEXT,
  -- the provider's own id for the agent built from this avatar (made on first use)
  external_id TEXT,
  consent_by TEXT,
  consent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_photoreal_avatars_ws ON photoreal_avatars(workspace_id);
CREATE TABLE avatar_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  avatar_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_agent_id TEXT,
  stream_id TEXT,
  provider_session TEXT,
  state TEXT NOT NULL CHECK (state IN ('starting','live','ended','failed')),
  greeted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  connected_at TEXT,
  ended_at TEXT,
  seconds INTEGER,
  end_reason TEXT
);
-- one photoreal session per call, also under races
CREATE UNIQUE INDEX ux_avatar_sessions_call_live ON avatar_sessions(call_id) WHERE state IN ('starting','live');
CREATE INDEX ix_avatar_sessions_ws ON avatar_sessions(workspace_id, started_at);
ALTER TABLE ai_agents ADD COLUMN photoreal_avatar_id TEXT;
