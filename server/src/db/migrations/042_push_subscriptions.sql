-- Web Push subscriptions of team members, one per browser (docs/NOTIFICATIONS.md). Additive only.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- the push service address the browser gave (it is a capability: never shown back in full)
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- what the member called this device ("Work laptop"), and the browser that made it
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  -- JSON array of the events this device wants: missed_call, assigned, message
  events TEXT NOT NULL DEFAULT '["missed_call","assigned","message"]',
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT
);
CREATE UNIQUE INDEX ux_push_subscriptions_endpoint ON push_subscriptions(member_id, endpoint);
CREATE INDEX ix_push_subscriptions_member ON push_subscriptions(workspace_id, member_id);
