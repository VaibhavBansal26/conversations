-- Analytics: per-room facts maintained by the write path, workspace API keys, and the per-workspace identity pepper.

CREATE TABLE room_metrics (
  room_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  inbox_id TEXT,
  contact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- counts (real participants only: system lines and internal notes are not messages exchanged with the contact)
  messages_in INTEGER NOT NULL DEFAULT 0,
  messages_out INTEGER NOT NULL DEFAULT 0,
  dm_msgs INTEGER NOT NULL DEFAULT 0,
  sms_msgs INTEGER NOT NULL DEFAULT 0,
  email_msgs INTEGER NOT NULL DEFAULT 0,
  -- first response: from the first contact message to the first message by a human agent (bots, notes and system lines never count)
  first_contact_at TEXT,
  first_response_at TEXT,
  first_response_s INTEGER,
  -- resolution: from creation (or the last reopen) to the last close, minus time spent snoozed; business seconds when office hours are on
  closed_at TEXT,
  resolution_s INTEGER,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,            -- creation or the latest reopen: where the open interval starts
  snoozed_count INTEGER NOT NULL DEFAULT 0,
  snooze_started_at TEXT,
  snoozed_s INTEGER NOT NULL DEFAULT 0,      -- snoozed time inside the current open interval, in the same unit as the times above
  assignee_id TEXT,
  csat INTEGER,
  csat_at TEXT,
  csat_comment TEXT,
  ai_intent TEXT,
  ai_sentiment TEXT,
  ai_urgency INTEGER
);
CREATE INDEX ix_room_metrics_ws_created ON room_metrics(workspace_id, created_at, room_id);
CREATE INDEX ix_room_metrics_ws_closed ON room_metrics(workspace_id, closed_at) WHERE closed_at IS NOT NULL;

INSERT INTO room_metrics(room_id, workspace_id, inbox_id, contact_id, created_at, opened_at)
SELECT id, workspace_id, inbox_id, contact_id, created_at, created_at FROM rooms;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,                -- first characters of the key, shown in the UI to tell keys apart
  key_hash TEXT NOT NULL UNIQUE,       -- SHA-256; the plaintext is shown once at creation and never stored
  scopes TEXT NOT NULL,                -- JSON array: analytics:read, analytics:export, analytics_identity:manage
  ip_allowlist TEXT NOT NULL DEFAULT '[]',   -- JSON array of CIDR blocks; empty = any address
  expires_at TEXT,
  last_used_at TEXT,
  last_used_ip TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_api_keys_ws ON api_keys(workspace_id, created_at);

CREATE TABLE analytics_pepper (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  pepper_enc TEXT NOT NULL,            -- AES-256-GCM, key derived from JWT_SECRET
  version INTEGER NOT NULL DEFAULT 1,
  rotated_at TEXT NOT NULL
);
