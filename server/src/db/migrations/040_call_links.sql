-- Links that let a visitor join a voice or video call without logging in or giving contact details (docs/CALLS.md, ADR 0037). One row per link, bound to ONE
-- conversation. Only the SHA-256 of the token is stored: the token itself is derived from the link id and a server secret when the visitor's own chat needs to show it.
CREATE TABLE call_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  -- ai: the visitor talks to the AI assistant; team: the visitor waits for a team member to ring them
  mode TEXT NOT NULL CHECK (mode IN ('ai','team')),
  kind TEXT NOT NULL CHECK (kind IN ('voice','video')),
  token_hash TEXT NOT NULL UNIQUE,
  -- member:<id> or bot:<agent id>
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  -- the first device that opened it (a hash): another device is refused while the link is in use
  redeemed_at TEXT,
  device_hash TEXT,
  display_name TEXT,
  -- set when the call that was started through the link ended: the link is used up
  consumed_at TEXT,
  -- the card in the thread that shows the link to the visitor
  message_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_call_links_room ON call_links(room_id, created_at);
CREATE INDEX ix_call_links_ws ON call_links(workspace_id, created_at);
-- a session minted by a call link can only take part in that link's call
ALTER TABLE visitor_sessions ADD COLUMN call_link_id TEXT;
