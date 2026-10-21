-- Last provider outcome per workspace and channel, so the UI can say "last error: ..." without scanning messages.
-- Written only on a failure and cleared on the next success, so a healthy workspace costs one primary-key UPDATE that matches nothing.
CREATE TABLE channel_health (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  last_error TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  last_ok_at TEXT,
  PRIMARY KEY (workspace_id, channel)
);
