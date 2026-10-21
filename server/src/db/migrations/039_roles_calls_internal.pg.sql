-- Adds calls:internal (calls between teammates) to the built-in roles owner, manager and agent. System roles are immutable, so the guard trigger is dropped for this migration and recreated. Custom roles are not changed: it is a new capability a role must be given.
DROP TRIGGER roles_system_no_update ON roles;
UPDATE roles SET permissions = replace(permissions, '"calls:settings"]', '"calls:settings","calls:internal"]') WHERE id IN ('role_owner', 'role_manager') AND permissions NOT LIKE '%calls:internal%';
UPDATE roles SET permissions = replace(permissions, '"calls:make"]', '"calls:make","calls:internal"]') WHERE id = 'role_agent' AND permissions NOT LIKE '%calls:internal%';
CREATE TRIGGER roles_system_no_update BEFORE UPDATE ON roles FOR EACH ROW WHEN (OLD.is_system = 1) EXECUTE FUNCTION conv_reject_change();
