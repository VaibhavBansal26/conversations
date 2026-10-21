-- Adds agents:manage to the owner and manager roles. System roles are immutable, so the guard trigger is dropped for this migration and recreated.
DROP TRIGGER roles_system_no_update;
UPDATE roles SET permissions = replace(permissions, '"departments:manage"]', '"departments:manage","agents:manage"]') WHERE id IN ('role_owner', 'role_manager') AND permissions NOT LIKE '%agents:manage%';
CREATE TRIGGER roles_system_no_update BEFORE UPDATE ON roles WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'system roles are immutable'); END;
