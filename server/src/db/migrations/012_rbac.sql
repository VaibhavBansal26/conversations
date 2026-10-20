-- Role-based access control. System roles (workspace_id NULL) are immutable; custom roles belong to one workspace.
-- `base_role` says which legacy role a custom role behaves as for ROOM VISIBILITY (owner/manager see every room, agent sees assigned rooms);
-- what a seat may DO is decided by `permissions`.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_role TEXT NOT NULL CHECK (base_role IN ('owner','manager','agent')),
  permissions TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_roles_ws_key ON roles(workspace_id, key) WHERE workspace_id IS NOT NULL;

-- NULL role_id means the system role named by members.role
ALTER TABLE members ADD COLUMN role_id TEXT;

INSERT INTO roles(id, workspace_id, key, name, description, base_role, permissions, is_system, created_at) VALUES
('role_owner', NULL, 'owner', 'Owner', 'Full control, including billing and roles', 'owner', '["conversations:read","conversations:reply","conversations:assign","conversations:delete","contacts:read","contacts:write","contacts:import","contacts:delete","inboxes:manage","members:read","members:manage","roles:manage","settings:read","settings:write","channels:manage","tokens:manage","templates:manage","kb:manage","ai:use","billing:manage","analytics:read","analytics:export","analytics_identity:manage","api_keys:manage","audit:read"]', 1, '2026-01-01T00:00:00.000Z'),
('role_manager', NULL, 'manager', 'Manager', 'Runs the team and the workspace, without billing or role administration', 'manager', '["conversations:read","conversations:reply","conversations:assign","conversations:delete","contacts:read","contacts:write","contacts:import","contacts:delete","inboxes:manage","members:read","members:manage","settings:read","settings:write","channels:manage","tokens:manage","templates:manage","kb:manage","ai:use","analytics:read","analytics:export","api_keys:manage","audit:read"]', 1, '2026-01-01T00:00:00.000Z'),
('role_agent', NULL, 'agent', 'Agent', 'Works conversations assigned to them (and their inboxes)', 'agent', '["conversations:read","conversations:reply","contacts:read","contacts:write","members:read","settings:read","ai:use"]', 1, '2026-01-01T00:00:00.000Z'),
('role_viewer', NULL, 'viewer', 'Viewer', 'Read-only access to conversations, contacts and analytics', 'manager', '["conversations:read","contacts:read","members:read","settings:read","analytics:read"]', 1, '2026-01-01T00:00:00.000Z');
