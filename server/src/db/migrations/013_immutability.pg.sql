-- Database-enforced immutability: even a bug (or a hand-written script) cannot rewrite history or edit a system role.
CREATE FUNCTION conv_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION conv_reject_change();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION conv_reject_change();
CREATE TRIGGER roles_system_no_update BEFORE UPDATE ON roles FOR EACH ROW WHEN (OLD.is_system = 1) EXECUTE FUNCTION conv_reject_change();
CREATE TRIGGER roles_system_no_delete BEFORE DELETE ON roles FOR EACH ROW WHEN (OLD.is_system = 1) EXECUTE FUNCTION conv_reject_change();
