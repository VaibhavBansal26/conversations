-- Mobile support: the hosted full-page chat (/chat) for in-app web views, and signed visitor identity.
-- Only additive changes: no table is rebuilt and nothing touches the SQLite schema tables (ADR 0023).

-- Per embed token: may the hosted chat page (served from the app's own origin) use it? Off by default; the domain allow-list is unchanged.
ALTER TABLE tokens ADD COLUMN hosted_chat_enabled INTEGER NOT NULL DEFAULT 0;

-- The id the host app uses for a signed-in user (identity_hash = HMAC(secret, external_id|email)). Unique per workspace while the contact lives.
ALTER TABLE contacts ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX ux_contacts_external ON contacts(workspace_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;

-- Per-workspace identity verification secret. The host backend signs; the server verifies. `enforce` = unsigned identity params are ignored.
CREATE TABLE workspace_identity (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  enforce INTEGER NOT NULL DEFAULT 0,
  rotated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
