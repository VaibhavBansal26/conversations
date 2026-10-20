-- Database-enforced immutability: even a bug (or a hand-written script) cannot rewrite history or edit a system role.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER roles_system_no_update BEFORE UPDATE ON roles WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'system roles are immutable'); END;
CREATE TRIGGER roles_system_no_delete BEFORE DELETE ON roles WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'system roles are immutable'); END;
