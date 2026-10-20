-- AI urgency is a score between 0 and 1 (the analytics schema says `number`); migration 015 declared the column INTEGER, which SQLite accepts but PostgreSQL rejects.
ALTER TABLE room_metrics ALTER COLUMN ai_urgency TYPE DOUBLE PRECISION;
