-- Platform administration: operators of the whole installation (not members of any workspace) and workspace suspension.

CREATE TABLE platform_admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- superadmin: everything; support: read-only views and read-only impersonation
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'support')),
  -- two-factor is mandatory: an admin without it can only enrol, never reach data
  totp_secret TEXT,
  totp_pending TEXT,
  totp_enabled_at TEXT,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE workspaces ADD COLUMN suspended_at TEXT;
ALTER TABLE workspaces ADD COLUMN suspended_reason TEXT;
