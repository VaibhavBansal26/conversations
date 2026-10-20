-- Fair scheduling across tenants: jobs carry the workspace they belong to, so a due-job pass can take a bounded share from each workspace
-- (round robin) instead of the oldest N overall, which one tenant's burst could monopolise.
ALTER TABLE jobs ADD COLUMN workspace_id TEXT;
CREATE INDEX ix_jobs_ws_due ON jobs(workspace_id, run_at) WHERE status = 'pending';
