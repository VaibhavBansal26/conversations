-- `not_sent_test_mode`: the message was stored while the active SMS/email provider was the console/fake one, so nothing left the server.
-- messages is partitioned; the constraint lives on the parent and is inherited by every partition. Its generated name differs between
-- PostgreSQL versions (migration 008 recreated the table while the old one still owned the name), so find it by definition.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'messages'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%delivery%' LOOP
    EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_check CHECK (delivery IN ('pending','sent','delivered','failed','not_sent_test_mode'));
