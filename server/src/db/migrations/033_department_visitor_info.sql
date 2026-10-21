-- A department may override which visitor details its conversations ask for and when (JSON: {fields?, moments?}); {} follows the workspace.
ALTER TABLE inboxes ADD COLUMN visitor_info TEXT NOT NULL DEFAULT '{}';
