-- Plan tier per workspace (limits are evaluated per tier; billing will set this later) and an admin override for rate-limit tiers.
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';

CREATE TABLE rate_limit_overrides (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  tier TEXT NOT NULL,
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- Append-only record of administrative actions (rate-limit blocks, tier overrides, later RBAC/admin console). Rows are never updated or deleted by the app.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX ix_audit_ws ON audit_log(workspace_id, created_at, id);
