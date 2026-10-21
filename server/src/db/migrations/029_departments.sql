-- Departments: an inbox with routing configuration. Additive only (ADR 0028): the existing inbox algorithm (manual, round_robin) and the
-- widget's visibility flag keep working; a department reads them as a routing mode when `routing_mode` is NULL.
ALTER TABLE inboxes ADD COLUMN description TEXT NOT NULL DEFAULT '';
-- NULL follows `algorithm` (round_robin stays round_robin, manual becomes manual_pick)
ALTER TABLE inboxes ADD COLUMN routing_mode TEXT CHECK (routing_mode IS NULL OR routing_mode IN ('round_robin','least_busy','skills_based','manual_pick'));
-- concurrent tickets per agent (0 = unlimited); a member can override it below
ALTER TABLE inboxes ADD COLUMN capacity INTEGER NOT NULL DEFAULT 0 CHECK (capacity >= 0);
-- {enabled, timezone, days:[{day,start,end}], holidays:['YYYY-MM-DD']}; disabled and no holidays = no restriction from the department
ALTER TABLE inboxes ADD COLUMN hours TEXT NOT NULL DEFAULT '{}';
ALTER TABLE inboxes ADD COLUMN sla_first_response_s INTEGER CHECK (sla_first_response_s IS NULL OR sla_first_response_s > 0);
ALTER TABLE inboxes ADD COLUMN sla_resolution_s INTEGER CHECK (sla_resolution_s IS NULL OR sla_resolution_s > 0);
-- where a ticket goes when this department is closed or has nobody who can take it (chains are walked with a visited set)
ALTER TABLE inboxes ADD COLUMN overflow_inbox_id TEXT REFERENCES inboxes(id) ON DELETE SET NULL;
ALTER TABLE inboxes ADD COLUMN auto_reply_closed TEXT NOT NULL DEFAULT '';
ALTER TABLE inboxes ADD COLUMN auto_reply_queued TEXT NOT NULL DEFAULT '';

ALTER TABLE inbox_members ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE inbox_members ADD COLUMN languages TEXT NOT NULL DEFAULT '[]';
ALTER TABLE inbox_members ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0);

-- First matching rule picks the department of a new conversation (page address, contact attributes, tags, language, channel).
CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- all conditions must hold: [{field, op, value}]
  conditions TEXT NOT NULL DEFAULT '[]',
  department_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_routing_rules_ws ON routing_rules(workspace_id, position);

-- Service levels and routing bookkeeping on tickets.
ALTER TABLE tickets ADD COLUMN sla_first_response_due_at TEXT;
ALTER TABLE tickets ADD COLUMN sla_resolution_due_at TEXT;
ALTER TABLE tickets ADD COLUMN sla_first_response_breached_at TEXT;
ALTER TABLE tickets ADD COLUMN sla_resolution_breached_at TEXT;
ALTER TABLE tickets ADD COLUMN reassigned_count INTEGER NOT NULL DEFAULT 0;
-- the SLA sweep reads waiting tickets whose first-response time is up
CREATE INDEX ix_tickets_sla_first ON tickets(status, sla_first_response_due_at);
CREATE INDEX ix_tickets_sla_resolution ON tickets(status, sla_resolution_due_at);
