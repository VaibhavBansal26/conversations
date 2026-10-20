-- Sessions with refresh-token rotation, TOTP two-factor, password resets and invitations.

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  user_agent TEXT,
  ip_hash TEXT
);
CREATE INDEX ix_auth_sessions_user ON auth_sessions(user_id, created_at);

-- Only a SHA-256 of the refresh token is stored. Each token is single use: presenting one that was already used revokes the whole session (theft signal).
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  replaced_by TEXT
);
CREATE INDEX ix_refresh_session ON refresh_tokens(session_id);

ALTER TABLE users ADD COLUMN totp_secret TEXT;            -- AES-256-GCM encrypted with a key derived from JWT_SECRET
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;   -- replay protection: a code is accepted once
ALTER TABLE users ADD COLUMN totp_pending TEXT;           -- secret awaiting confirmation (encrypted)

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX ix_invitations_ws ON invitations(workspace_id, created_at);
CREATE UNIQUE INDEX ux_invitations_pending ON invitations(workspace_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
