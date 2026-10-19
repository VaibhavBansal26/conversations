ALTER TABLE notifications ADD COLUMN emailed_at TEXT;
CREATE UNIQUE INDEX ux_templates_shortcut ON templates(workspace_id, lower(shortcut)) WHERE shortcut IS NOT NULL AND shortcut != '';
