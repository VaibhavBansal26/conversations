-- PostgreSQL got this index with the partitioned table (migration 008); SQLite needs it for tenant-wide time ranges.
CREATE INDEX IF NOT EXISTS ix_messages_ws_time ON messages(workspace_id, created_at);
