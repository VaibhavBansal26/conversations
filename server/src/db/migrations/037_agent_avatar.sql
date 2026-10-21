-- An AI agent's uploaded portrait (docs/AI-AGENTS.md, ADR 0034): the storage key of the cleaned image and the picture's alternative text. Additive; existing agents have neither.
ALTER TABLE ai_agents ADD COLUMN avatar_key TEXT;
ALTER TABLE ai_agents ADD COLUMN avatar_alt TEXT NOT NULL DEFAULT '';
