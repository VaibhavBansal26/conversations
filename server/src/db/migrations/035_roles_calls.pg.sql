-- Adds the call permissions to the built-in roles: calls:make (owner, manager, agent) and calls:settings (owner, manager). System roles are immutable, so the guard trigger is dropped for this migration and recreated. Custom roles are not changed: placing calls is a new capability a role must be given.
DROP TRIGGER roles_system_no_update ON roles;
UPDATE roles SET permissions = replace(permissions, '"agents:manage"]', '"agents:manage","calls:make","calls:settings"]') WHERE id IN ('role_owner', 'role_manager') AND permissions NOT LIKE '%calls:make%';
UPDATE roles SET permissions = replace(permissions, '"tickets:close"]', '"tickets:close","calls:make"]') WHERE id = 'role_agent' AND permissions NOT LIKE '%calls:make%';
CREATE TRIGGER roles_system_no_update BEFORE UPDATE ON roles FOR EACH ROW WHEN (OLD.is_system = 1) EXECUTE FUNCTION conv_reject_change();
