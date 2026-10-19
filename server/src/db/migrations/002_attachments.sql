CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_attachments_ws ON attachments(workspace_id);
