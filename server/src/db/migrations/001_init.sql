-- Conversations schema. Every business row carries workspace_id; timestamps are ISO-8601 UTC strings.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  credit_balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A member is a "seat": a user inside one workspace. members.id is the seat id used everywhere.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','manager','agent')),
  live_seat INTEGER NOT NULL DEFAULT 1,
  availability TEXT NOT NULL DEFAULT 'active' CHECK (availability IN ('active','away','inactive')),
  dnd_until TEXT,
  notification_prefs TEXT NOT NULL DEFAULT '{}',
  inbox_visibility TEXT NOT NULL DEFAULT 'assigned_inbox' CHECK (inbox_visibility IN ('assigned','assigned_inbox')),
  removed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX ix_members_ws ON members(workspace_id);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT,
  phone TEXT,
  attrs TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  sms_opt_out INTEGER NOT NULL DEFAULT 0,
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX ux_contacts_email ON contacts(workspace_id, lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ux_contacts_phone ON contacts(workspace_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_contacts_ws ON contacts(workspace_id, deleted_at);

CREATE TABLE contact_followers (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, member_id)
);

CREATE TABLE contact_notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_contact_notes ON contact_notes(contact_id, created_at);

CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'inbox',
  algorithm TEXT NOT NULL DEFAULT 'manual' CHECK (algorithm IN ('manual','round_robin')),
  last_assigned_member_id TEXT,
  live_routing_visibility INTEGER NOT NULL DEFAULT 0,
  default_email_inbound INTEGER NOT NULL DEFAULT 0,
  default_sms_inbound INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_inboxes_ws ON inboxes(workspace_id);

CREATE TABLE inbox_members (
  inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (inbox_id, member_id)
);
CREATE INDEX ix_inbox_members_member ON inbox_members(member_id);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  inbox_id TEXT REFERENCES inboxes(id) ON DELETE SET NULL,
  session_id TEXT,
  room_type TEXT NOT NULL DEFAULT 'inbound' CHECK (room_type IN ('inbound','outbound')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  archived INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0,1)),
  snooze_until TEXT,
  snoozed_by TEXT,
  subject TEXT,
  next_seq INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_message_at TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  last_contact_message_at TEXT,
  visitor_read_seq INTEGER NOT NULL DEFAULT 0,
  bot_paused INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  digest_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One live room per contact; archiving frees the slot.
CREATE UNIQUE INDEX ux_rooms_contact ON rooms(workspace_id, contact_id) WHERE archived = 0;
CREATE INDEX ix_rooms_ws_status ON rooms(workspace_id, archived, status, last_message_at);
CREATE INDEX ix_rooms_snooze ON rooms(snooze_until) WHERE snooze_until IS NOT NULL;
CREATE INDEX ix_rooms_inbox ON rooms(inbox_id);

CREATE TABLE room_assignees (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (room_id, member_id)
);
CREATE INDEX ix_room_assignees_member ON room_assignees(member_id);

CREATE TABLE room_favorites (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, member_id)
);

-- Per-seat read cursor. Unread counts are always computed from this, never stored.
CREATE TABLE room_reads (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  last_read_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, member_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  client_msg_id TEXT,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('agent','contact','bot','system')),
  sender_id TEXT,
  sender_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('text','image','voice','gif','attachment','ref','note','system')),
  source TEXT NOT NULL CHECK (source IN ('dm','sms','email')),
  content TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  subject TEXT,
  ref_message_id TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  delivery TEXT NOT NULL DEFAULT 'sent' CHECK (delivery IN ('pending','sent','delivered','failed')),
  failure_reason TEXT,
  provider_message_id TEXT,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_hdr TEXT,
  from_addr TEXT,
  to_addr TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  opened_at TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_messages_room_seq ON messages(room_id, seq);
CREATE UNIQUE INDEX ux_messages_qid ON messages(room_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX ix_messages_provider ON messages(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX ix_messages_rfc ON messages(workspace_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX ix_messages_delivery ON messages(delivery, source) WHERE delivery IN ('pending','sent');

CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (message_id, member_id)
);
CREATE INDEX ix_mentions_member ON message_mentions(workspace_id, member_id, room_id);

-- Pins which sender number/address a room uses for a contact; also the key for routing inbound replies.
CREATE TABLE message_locks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sms','email')),
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_locks_pair ON message_locks(workspace_id, type, from_addr, to_addr);
CREATE UNIQUE INDEX ux_locks_room ON message_locks(room_id, type);

CREATE TABLE sms_numbers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  e164 TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE email_senders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, address)
);

CREATE TABLE inbound_addresses (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_tokens_domain ON tokens(workspace_id, domain) WHERE status = 'active';

CREATE TABLE visitor_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  token_id TEXT,
  secret_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  ip TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  otp_hash TEXT,
  otp_sent_at TEXT,
  otp_expires_at TEXT,
  otp_attempts INTEGER NOT NULL DEFAULT 0,
  otp_channel TEXT,
  user_info TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  expired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_sessions_contact ON visitor_sessions(workspace_id, contact_id, device_id);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'any' CHECK (channel IN ('any','email','sms','dm')),
  subject TEXT,
  body TEXT NOT NULL,
  shortcut TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_templates_ws ON templates(workspace_id);

CREATE TABLE kb_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_kb_ws ON kb_entries(workspace_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  room_id TEXT,
  message_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_notifications_dedupe ON notifications(member_id, message_id, type) WHERE message_id IS NOT NULL;
CREATE INDEX ix_notifications_member ON notifications(member_id, read_at, created_at);

CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_ledger_ws ON usage_ledger(workspace_id, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_jobs_due ON jobs(status, run_at);

-- Idempotency + replay protection for provider webhooks.
CREATE TABLE webhook_events (
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_key)
);
