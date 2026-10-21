-- AI voice and video calls (docs/CALLS.md, ADR 0033): transport 'ai', kinds 'ai_voice' and 'ai_video', and three columns that say which agent answered, the speech engine and the hand-over reason. Additive on PostgreSQL: the two CHECKs are replaced, no row changes.
ALTER TABLE calls DROP CONSTRAINT calls_transport_check;
ALTER TABLE calls DROP CONSTRAINT calls_kind_check;
ALTER TABLE calls ADD CONSTRAINT calls_transport_check CHECK (transport IN ('webrtc','phone','ai'));
ALTER TABLE calls ADD CONSTRAINT calls_kind_check CHECK (kind IN ('voice','video','ai_voice','ai_video'));
ALTER TABLE calls ADD COLUMN ai_agent_id TEXT;
ALTER TABLE calls ADD COLUMN engine TEXT;
ALTER TABLE calls ADD COLUMN handoff_reason TEXT;
