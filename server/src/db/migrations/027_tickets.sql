-- Tickets: an episode of support inside a room (a room stays one per contact). Additive only: no table is rebuilt, nothing touches the SQLite
-- schema tables (ADR 0023). Existing rooms and messages are NOT backfilled: messages written before this migration have ticket_id NULL, and a
-- room gets its first ticket when its next message arrives (ADR 0027).

-- Per-workspace human-friendly numbers (#1, #2, ...). One UPDATE ... RETURNING allocates the next number, so concurrent opens never repeat one.
CREATE TABLE ticket_counters (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  next_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  number INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  -- 'auto' subjects may be refined by the AI agent; once an agent edits it, it stays as written
  subject_set_by TEXT NOT NULL DEFAULT 'auto' CHECK (subject_set_by IN ('auto','agent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','bot_handling','waiting_for_human','open','pending_customer','resolved','closed')),
  -- 'bot:<agent id>' or 'human:<member id>'; NULL while nobody has taken it
  handler TEXT,
  -- a department is an inbox (migration 028 adds the routing configuration)
  department_id TEXT REFERENCES inboxes(id) ON DELETE SET NULL,
  -- 0 low, 1 normal, 2 high, 3 urgent
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('bot_resolved','human_resolved','abandoned','auto_closed','merged')),
  channel TEXT NOT NULL DEFAULT 'dm' CHECK (channel IN ('dm','sms','email')),
  opened_at TEXT NOT NULL,
  first_response_at TEXT,
  handoff_at TEXT,
  first_human_response_at TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  csat INTEGER CHECK (csat IS NULL OR csat BETWEEN 1 AND 5),
  csat_comment TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  handoff_reason TEXT,
  merged_into_id TEXT,
  last_activity_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_tickets_number ON tickets(workspace_id, number);
-- at most one live ticket per room, even under races: the database is the arbiter (ADR 0002)
CREATE UNIQUE INDEX ux_tickets_room_live ON tickets(room_id) WHERE status <> 'closed';
CREATE INDEX ix_tickets_room ON tickets(room_id, opened_at);
CREATE INDEX ix_tickets_contact ON tickets(workspace_id, contact_id, opened_at);
CREATE INDEX ix_tickets_ws_activity ON tickets(workspace_id, last_activity_at);
CREATE INDEX ix_tickets_status ON tickets(workspace_id, status, last_activity_at);
CREATE INDEX ix_tickets_handler ON tickets(workspace_id, handler, status);
CREATE INDEX ix_tickets_queue ON tickets(workspace_id, department_id, status, handoff_at);
-- the scheduler's idle sweep reads by status across workspaces (a partial index would not be chosen for an IN list of a subset)
CREATE INDEX ix_tickets_idle ON tickets(status, last_activity_at);

-- Timeline of what happened to a ticket (opened, handed off, taken over, resolved, merged, ...). Append-only by convention; feeds the handoff
-- reason and SLA reports.
CREATE TABLE ticket_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('contact','member','bot','system')),
  actor_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX ix_ticket_events ON ticket_events(ticket_id, created_at);
CREATE INDEX ix_ticket_events_type ON ticket_events(workspace_id, type, created_at);

-- Messages carry the ticket they belong to. Plain column, no foreign key: messages is hash-partitioned on PostgreSQL and archived/restored as rows.
ALTER TABLE messages ADD COLUMN ticket_id TEXT;
CREATE INDEX ix_messages_ticket ON messages(room_id, ticket_id) WHERE ticket_id IS NOT NULL;
