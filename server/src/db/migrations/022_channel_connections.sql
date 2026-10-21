-- Per-workspace provider connections: a workspace pastes its own Twilio / SendGrid credentials instead of the deployment having one global set.
-- Credentials are AES-256-GCM encrypted with DATA_ENCRYPTION_KEY (util/dataCrypto.ts), bound to the row by additional authenticated data,
-- and never leave the server in any API response.
CREATE TABLE channel_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  provider TEXT NOT NULL CHECK (provider IN ('twilio','sendgrid')),
  -- pending: saved, not verified yet (sending is refused); verified: usable; error: the provider rejected the credentials (sending is refused)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','error')),
  credentials_enc TEXT NOT NULL,
  -- non-secret facts shown in the UI: masked hints, account name, trial/full, scopes, inbound domain, event-webhook public key
  meta TEXT NOT NULL DEFAULT '{}',
  -- opaque routing id in this connection's webhook URLs (/webhooks/c/<webhook_id>/...); not a secret by itself
  webhook_id TEXT NOT NULL UNIQUE,
  -- SendGrid cannot sign Inbound Parse requests, so its URL carries a per-connection secret (hash for checking, ciphertext to show the admin)
  webhook_secret_hash TEXT NOT NULL,
  webhook_secret_enc TEXT NOT NULL,
  verified_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, channel)
);

-- The newest inbound provider events per workspace and channel ("Check webhook" in Settings > Channels). Never stores message content.
CREATE TABLE channel_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_channel_events ON channel_events(workspace_id, channel, created_at, id);
