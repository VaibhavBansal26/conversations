-- AI support agents (ADR 0029): configuration, one row per decision for review and analytics, and feedback on bot answers. Additive only.

-- Help-centre entries can be grouped (an agent's "knowledge scope") and can link to the page the answer comes from.
ALTER TABLE kb_entries ADD COLUMN collection TEXT NOT NULL DEFAULT '';
ALTER TABLE kb_entries ADD COLUMN url TEXT;

CREATE TABLE ai_agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  -- the role and rules the workspace gives the agent; always inserted below the product's own safety rules, never above them
  persona TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'friendly' CHECK (tone IN ('friendly','professional','concise','empathetic')),
  languages TEXT NOT NULL DEFAULT '[]',
  greeting TEXT NOT NULL DEFAULT '',
  -- departments the agent works for; [] = every department
  department_ids TEXT NOT NULL DEFAULT '[]',
  -- same shape as the widget's office hours; disabled = always on
  hours TEXT NOT NULL DEFAULT '{}',
  -- knowledge-base collections it may answer from; [] = the whole knowledge base
  kb_collections TEXT NOT NULL DEFAULT '[]',
  autonomy TEXT NOT NULL DEFAULT 'auto_answer' CHECK (autonomy IN ('suggest_only','auto_answer','auto_resolve')),
  confidence_threshold REAL NOT NULL DEFAULT 0.6 CHECK (confidence_threshold >= 0 AND confidence_threshold <= 1),
  coverage_threshold REAL NOT NULL DEFAULT 0.5 CHECK (coverage_threshold >= 0 AND coverage_threshold <= 1),
  max_turns INTEGER NOT NULL DEFAULT 6 CHECK (max_turns BETWEEN 1 AND 30),
  -- unanswered attempts (no knowledge-base answer, low confidence) before a person is asked for
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 10),
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  -- {human_request, low_confidence, repeated_rephrase, negative_sentiment, high_urgency, sensitive_topic, vip_contact, tool_failure: bool, sensitive_topics: [..]}
  handoff_triggers TEXT NOT NULL DEFAULT '{}',
  -- what the bot does while a ticket waits for a person: 'silent' or 'gather_info' (ask for contact details once)
  waiting_behavior TEXT NOT NULL DEFAULT 'gather_info' CHECK (waiting_behavior IN ('silent','gather_info')),
  disclosure_label TEXT NOT NULL DEFAULT 'AI assistant',
  channels TEXT NOT NULL DEFAULT '["widget"]',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_ai_agents_ws ON ai_agents(workspace_id, enabled);

-- One row per decision the agent took (answer, suggestion, clarifying question, refusal, handoff, resolution): the transcript review page, the
-- unanswered-questions report and the per-agent analytics read this; it is deleted with its ticket.
CREATE TABLE ai_turns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- the visitor message that triggered it and the bot message it produced (NULL when it only handed off)
  trigger_message_id TEXT,
  message_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('answered','suggested','clarified','refused','handoff','resolved','skipped')),
  intent TEXT,
  department_id TEXT,
  confidence REAL,
  reason TEXT,
  -- [{id, question, url, score, coverage}]
  sources TEXT NOT NULL DEFAULT '[]',
  -- [{tool, ok, args summary}]
  actions TEXT NOT NULL DEFAULT '[]',
  -- the visitor's words (shortened, redacted when the workspace redacts personal data): what the unanswered-questions report clusters
  query TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_ai_turns_agent ON ai_turns(workspace_id, agent_id, created_at);
CREATE INDEX ix_ai_turns_ticket ON ai_turns(ticket_id, created_at);
CREATE INDEX ix_ai_turns_outcome ON ai_turns(workspace_id, outcome, created_at);

-- Thumbs up or down on a bot answer, from the visitor or from a member of the team.
CREATE TABLE ai_feedback (
  message_id TEXT NOT NULL,
  rater_type TEXT NOT NULL CHECK (rater_type IN ('visitor','member')),
  rater_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id TEXT,
  agent_id TEXT,
  rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  comment TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, rater_type, rater_id)
);
CREATE INDEX ix_ai_feedback_agent ON ai_feedback(workspace_id, agent_id, created_at);
