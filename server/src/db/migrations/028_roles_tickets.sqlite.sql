-- Adds the ticket permissions to the built-in roles. System roles are immutable, so the guard trigger is dropped for this migration and recreated.
DROP TRIGGER roles_system_no_update;
UPDATE roles SET permissions = replace(permissions, '"team_chat:moderate"]', '"team_chat:moderate","tickets:read","tickets:write","tickets:close","tickets:merge"]') WHERE id IN ('role_owner', 'role_manager') AND permissions NOT LIKE '%tickets:read%';
UPDATE roles SET permissions = replace(permissions, '"team_chat:use"]', '"team_chat:use","tickets:read","tickets:write","tickets:close"]') WHERE id = 'role_agent' AND permissions NOT LIKE '%tickets:read%';
UPDATE roles SET permissions = replace(permissions, '"team_chat:use"]', '"team_chat:use","tickets:read"]') WHERE id = 'role_viewer' AND permissions NOT LIKE '%tickets:read%';
CREATE TRIGGER roles_system_no_update BEFORE UPDATE ON roles WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'system roles are immutable'); END;
-- custom roles keep what they could already do: whoever reads conversations may read tickets, whoever replies may work and close them
UPDATE roles SET permissions = replace(permissions, '"conversations:read"', '"conversations:read","tickets:read"') WHERE is_system = 0 AND permissions LIKE '%"conversations:read"%' AND permissions NOT LIKE '%tickets:read%';
UPDATE roles SET permissions = replace(permissions, '"conversations:reply"', '"conversations:reply","tickets:write","tickets:close"') WHERE is_system = 0 AND permissions LIKE '%"conversations:reply"%' AND permissions NOT LIKE '%tickets:write%';
