-- Internal team chat: channels, direct and group messages between workspace members. Separate from customer conversations (rooms/messages).
-- Same rules as the rest: every row carries workspace_id; per-channel `seq` is the ordering and the basis of unread (no stored counters);
-- `client_msg_id` makes sends idempotent; deletes are soft; timestamps are ISO-8601 UTC text.
CREATE TABLE team_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('channel','dm','group')),
  -- direct and group messages are always private
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  name TEXT,            -- display name of a channel; NULL for dm/group (derived from the members)
  slug TEXT,            -- lower-case unique name of a channel inside the workspace while it is not archived
  topic TEXT NOT NULL DEFAULT '',
  -- sorted member ids joined with ',' : the same people always resolve to the same dm/group
  dm_key TEXT,
  is_general INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  next_seq INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_team_channels_slug ON team_channels(workspace_id, slug) WHERE slug IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX ux_team_channels_dm ON team_channels(workspace_id, dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX ux_team_channels_general ON team_channels(workspace_id) WHERE is_general = 1;
CREATE INDEX ix_team_channels_ws ON team_channels(workspace_id, kind, visibility);

CREATE TABLE team_channel_members (
  channel_id TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  -- read cursor: everything up to this seq is read; unread is computed from it
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_id)
);
CREATE INDEX ix_tcm_member ON team_channel_members(workspace_id, member_id);

CREATE TABLE team_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  -- a reply carries the id of the top-level message that started the thread; replies to replies are not a thing
  thread_root_id TEXT,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('text','share','system')),
  content TEXT NOT NULL DEFAULT '',        -- plain text; @[Name](mem_...) mention tokens
  content_text TEXT NOT NULL DEFAULT '',   -- what search looks at: tokens replaced by @Name
  attachments TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',         -- share card: {room_id}; mention_all
  client_msg_id TEXT,
  pinned_at TEXT,
  pinned_by TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_tmsg_seq ON team_messages(channel_id, seq);
CREATE UNIQUE INDEX ux_tmsg_qid ON team_messages(channel_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX ix_tmsg_thread ON team_messages(channel_id, thread_root_id, seq) WHERE thread_root_id IS NOT NULL;
CREATE INDEX ix_tmsg_pins ON team_messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX ix_tmsg_ws_time ON team_messages(workspace_id, created_at);

CREATE TABLE team_reactions (
  message_id TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, member_id, emoji)
);

CREATE TABLE team_mentions (
  message_id TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (message_id, member_id)
);
CREATE INDEX ix_tmention_member ON team_mentions(channel_id, member_id, seq);

-- team notifications use the same feed as conversation ones; channel_id says where to open them
ALTER TABLE notifications ADD COLUMN channel_id TEXT;
