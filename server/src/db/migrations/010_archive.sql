-- Cold-data tiering: batches of old messages are exported to object storage (NDJSON, gzip) and deleted from the database; the manifest is
-- how they are found again and restored.
CREATE TABLE archive_manifest (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  rows INTEGER NOT NULL,
  from_created_at TEXT NOT NULL,
  to_created_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX ix_archive_ws ON archive_manifest(workspace_id, created_at);
