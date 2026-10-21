# 0023. SQLite migrations must work in defensive mode; table rebuilds run with foreign keys off

Status: accepted (2026-10-21). Amends [ADR 0018](0018-test-mode-delivery.md).

## Context

Deploying commit 9f33409 to Render crashed at start-up on the existing SQLite database with `Error: table sqlite_master may not be modified` (`ERR_SQLITE_ERROR`, thrown from `SqliteDb.exec` in `createContext`). Migration `020_delivery_test_mode.sqlite.sql` widened the `messages.delivery` CHECK by running `PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = replace(...)`. The SQLite build in the `node:24-slim` image runs with `SQLITE_DBCONFIG_DEFENSIVE`, which forbids that. The local Node (24.11.1) ignores the `defensive` option, so tests passed; and nothing exercised the migration against a database created by the previous release. Render kept the previous version running, and the failed migration had rolled back (the runner wrapped all migrations in one transaction), so the database was left at version 19.

## Decision

1. **No migration edits the schema tables or uses `writable_schema`.** A lint test (`tests/migrations.lint.test.ts`) fails on `writable_schema`, any mention of `sqlite_master` / `sqlite_schema` in executable SQL, and any `PRAGMA` in a migration.
2. **Changing a CHECK (or anything else `ALTER TABLE` cannot do) on SQLite is a table rebuild**, as in <https://www.sqlite.org/lang_altertable.html>: create `x_new`, copy, drop `x`, rename, recreate every index, trigger and view of `x`. Migration 020 does this for `messages`.
3. **The runner supports `-- @sqlite-foreign-keys-off`** as the first line of a `.sqlite.sql` file. `PRAGMA foreign_keys` is a no-op inside a transaction, so the runner sets it to OFF before `BEGIN`, runs the file in its transaction, and turns it back ON in a `finally`. Without it, `DROP TABLE messages` performs the implicit `DELETE` and `ON DELETE CASCADE` removes every `message_mentions` row. Inside the transaction the runner compares `PRAGMA foreign_key_check` with its result before the file ran, and any new violation aborts and rolls back the migration with the offending rows in the error message (violations that already existed are ignored so a legacy orphan row cannot block boot). A lint test requires the directive for any SQLite migration that drops a table other tables reference.
4. **SQLite migrations run in one transaction each**, not one for the whole run (PostgreSQL keeps one transaction under its advisory lock). A failure rolls back that migration alone and leaves the database at the previous version, with earlier ones recorded. The old special case `-- @sqlite-bump-schema-version` is gone.
5. **`SqliteDb` asks for defensive mode** (`new DatabaseSync(path, { defensive: true })`), so any Node that honours the option behaves like production.
6. **Regression tests build the previous release's schema from this repo's migration files up to 019, fill every table, and run the rest through the real runner** (`tests/migrations.upgrade.test.ts`, SQLite and, with `TEST_DB=postgres`, PostgreSQL): row counts and `messages` / `message_mentions` contents unchanged, `foreign_key_check` clean, the new value storable, indexes and triggers present, idempotent re-run, and a schema-drift comparison with a database migrated from scratch. Where the `sqlite3` shell is installed they also apply migration 020 under `.dbconfig defensive on`, with the old `writable_schema` statement as a control that must fail.

## Alternatives considered

- **Keep the `delivery` CHECK and store the test-mode flag in a new column (`ALTER TABLE ADD COLUMN`).** Needs no rebuild, but every consumer of `delivery` would have to read two columns, and a message would be `sent` in the column that the reconcile scan, analytics and the retry path already switch on, which is the lie ADR 0018 removed.
- **Rebuild `messages` without the CHECK and validate in code.** Loses the database as arbiter ([ADR 0002](0002-database-is-the-arbiter.md)).
- **Add a new migration 026 and make 020 a no-op.** Editing 020 is safe: it has never succeeded on a defensive build, and on a database where the old version already applied (local and dev only) the recorded name is skipped and the schema is already correct (same CHECK text). The tests assert the schemas converge.

## Consequences

- A migration that fails halfway in SQLite no longer leaves later boots blocked by a half-applied batch; it is retried from that file on the next boot.
- Rebuilding `messages` copies every row once under a write lock; on a large database it takes time proportional to the table (measure on a copy first, see the runbook).
- Not verified: Render's exact SQLite build cannot be reproduced locally. The guards are the lint, the sqlite3 shell run (3.51.0) with defensive on, and the `defensive: true` option on Node versions that honour it.
