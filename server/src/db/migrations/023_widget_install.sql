-- "Verify installation": the newest config request a widget made with this token from a real site, and the Origin it came from.
ALTER TABLE tokens ADD COLUMN last_seen_origin TEXT;
ALTER TABLE tokens ADD COLUMN last_seen_at TEXT;
-- Sessions minted through the in-app "Try it now" preview: they are accepted from the app's own origin only and expire after hours, not 30 days.
ALTER TABLE visitor_sessions ADD COLUMN preview INTEGER NOT NULL DEFAULT 0;
