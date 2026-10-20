-- Multi-region routing key: the region a workspace's data lives in. NULL = served by any region (single-region installs).
ALTER TABLE workspaces ADD COLUMN home_region TEXT;
