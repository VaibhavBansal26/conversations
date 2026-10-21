import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { migrate, openDb, type Db } from "../src/db/index.js";

/**
 * Upgrade tests: the failure that reached production (migration 020 edited sqlite_master, which a defensive SQLite build forbids) only
 * happens on a database that already holds data from the PREVIOUS release, and fresh-database runs cannot see it. These tests build a
 * database with the schema of the previous release (migrations up to and including 019, taken from this repo's own files), fill every
 * table with representative rows, then run the remaining migrations through the real runner.
 */

const MIGRATIONS = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const PREVIOUS_RELEASE = 19;
const postgres = Boolean(process.env.TEST_DATABASE_URL);

const num = (f: string) => Number(f.slice(0, 3));
/** A directory holding a copy of the migration files up to and including `max` (the schema of an older release). */
function releaseDir(max: number): string {
  const dir = mkdtempSync(join(tmpdir(), "conv-rel-"));
  for (const f of readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && num(f) <= max) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  return dir;
}

// ---- schema introspection (what the drift guard compares) ------------------------------------------------------------------------

const squash = (s: string | null | undefined) => (s ?? "").replace(/["`]/g, "").replace(/\s+/g, " ").trim();

async function sqliteSchema(db: Db) {
  const tables = (await db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' ORDER BY name")).map((t) => t.name);
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    out[`table ${t}`] = {
      sql: squash((await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", t))!.sql),
      columns: await db.all(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t}') ORDER BY cid`),
      foreign_keys: await db.all(`SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list('${t}') ORDER BY id, seq`),
      indexes: await db.all(`SELECT name, "unique", origin, partial FROM pragma_index_list('${t}') ORDER BY name`),
    };
  }
  for (const r of await db.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY type, name")) out[`${r.type} ${r.name}`] = squash(r.sql);
  return out;
}

async function pgSchema(db: Db) {
  const out: Record<string, unknown> = {};
  const schema = (await db.get<{ s: string }>("SELECT current_schema() AS s"))!.s;
  out.columns = await db.all("SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> '_migrations' ORDER BY table_name, ordinal_position");
  out.indexes = (await db.all<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename <> '_migrations' ORDER BY indexname")).map((r) => r.indexdef.split(`${schema}.`).join(""));
  out.triggers = await db.all("SELECT trigger_name, event_object_table, action_timing, event_manipulation FROM information_schema.triggers WHERE trigger_schema = current_schema() ORDER BY 1, 2, 4");
  out.constraints = await db.all("SELECT conrelid::regclass::text AS tbl, conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY 1, 2");
  return JSON.parse(JSON.stringify(out).split(`${schema}.`).join(""));
}

const schemaOf = (db: Db) => (db.dialect === "sqlite" ? sqliteSchema(db) : pgSchema(db));

async function userTables(db: Db): Promise<string[]> {
  if (db.dialect === "sqlite") return (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' ORDER BY name")).map((r) => r.name);
  // partition leaves are counted through their parent
  return (await db.all<{ table_name: string }>("SELECT c.relname AS table_name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname <> '_migrations' ORDER BY 1")).map((r) => r.table_name);
}
async function counts(db: Db, tables: string[]) {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n);
  return out;
}

// ---- representative data for the schema of the previous release ----------------------------------------------------------------------

const T = (n: number) => `2026-03-02T10:${String(n).padStart(2, "0")}:00.000Z`;

async function seedPreviousRelease(db: Db) {
  const run = (sql: string, ...p: (string | number | null)[]) => db.run(sql, ...p);
  for (const w of ["w1", "w2"]) await run("INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)", w, `Workspace ${w}`, T(0));
  for (const u of ["u1", "u2"]) await run("INSERT INTO users(id, email, password_hash, name, created_at) VALUES (?, ?, 'x', ?, ?)", u, `${u}@example.test`, u, T(0));
  // system roles (role_owner ... role_viewer) come from migration 012; a custom role that can read conversations and one that cannot
  await run("INSERT INTO roles(id, workspace_id, key, name, base_role, permissions, is_system, created_at) VALUES ('role_custom_reader', 'w1', 'reader', 'Reader', 'agent', '[\"conversations:read\",\"contacts:read\"]', 0, ?)", T(0));
  await run("INSERT INTO roles(id, workspace_id, key, name, base_role, permissions, is_system, created_at) VALUES ('role_custom_none', 'w1', 'none', 'Billing only', 'agent', '[\"billing:manage\"]', 0, ?)", T(0));
  await run("INSERT INTO members(id, workspace_id, user_id, role, role_id, created_at) VALUES ('m1', 'w1', 'u1', 'owner', NULL, ?)", T(0));
  await run("INSERT INTO members(id, workspace_id, user_id, role, role_id, created_at) VALUES ('m2', 'w1', 'u2', 'agent', 'role_custom_reader', ?)", T(0));
  await run("INSERT INTO members(id, workspace_id, user_id, role, created_at) VALUES ('m3', 'w2', 'u2', 'manager', ?)", T(0));
  for (const c of ["c1", "c2"]) await run("INSERT INTO contacts(id, workspace_id, name, email, phone, created_at, updated_at) VALUES (?, 'w1', ?, ?, ?, ?, ?)", c, c, `${c}@example.test`, `+1415555267${c.slice(1)}`, T(0), T(0));
  await run("INSERT INTO contact_notes(id, workspace_id, contact_id, member_id, body, created_at) VALUES ('cn1', 'w1', 'c1', 'm1', 'note', ?)", T(1));
  await run("INSERT INTO inboxes(id, workspace_id, name, created_at) VALUES ('i1', 'w1', 'Support', ?)", T(0));
  await run("INSERT INTO inbox_members(inbox_id, member_id, position) VALUES ('i1', 'm2', 0)");
  for (const [r, c] of [["r1", "c1"], ["r2", "c2"]] as const) await run("INSERT INTO rooms(id, workspace_id, contact_id, inbox_id, created_at, updated_at) VALUES (?, 'w1', ?, 'i1', ?, ?)", r, c, T(0), T(0));
  await run("INSERT INTO room_assignees(room_id, member_id, added_at) VALUES ('r1', 'm2', ?)", T(1));
  await run("INSERT INTO room_reads(room_id, member_id, updated_at) VALUES ('r1', 'm1', ?)", T(1));
  await run("INSERT INTO room_favorites(room_id, member_id, created_at) VALUES ('r1', 'm1', ?)", T(1));
  await run("INSERT INTO room_metrics(room_id, workspace_id, contact_id, created_at, opened_at) VALUES ('r1', 'w1', 'c1', ?, ?)", T(0), T(0));

  // one message for every delivery value that exists at 019, across all sources and kinds, in two rooms
  const deliveries = ["pending", "sent", "delivered", "failed"];
  let seq = 0;
  for (const room of ["r1", "r2"]) {
    seq = 0;
    for (const [i, source] of (["dm", "sms", "email"] as const).entries()) {
      for (const [j, delivery] of deliveries.entries()) {
        seq++;
        const id = `msg_${room}_${source}_${delivery}`;
        await run(
          `INSERT INTO messages(id, workspace_id, room_id, seq, client_msg_id, sender_type, sender_id, sender_name, kind, source, content, content_text, subject, attachments, meta, delivery,
             failure_reason, provider_message_id, rfc_message_id, in_reply_to, from_addr, to_addr, retry_count, delivered_at, deleted_at, created_at)
           VALUES (?, 'w1', ?, ?, ?, ?, 'm1', 'Olivia', 'text', ?, ?, ?, ?, ?, '{"k":"v"}', ?, ?, ?, ?, ?, 'a@example.test', 'b@example.test', ?, ?, ?, ?)`,
          id,
          room,
          seq,
          `cm-${id}`,
          j % 2 ? "agent" : "contact",
          source,
          `<p>hello ${id}</p>`,
          `hello ${id}`,
          source === "email" ? `Subject ${i}` : null,
          j === 1 ? '[{"id":"att1"}]' : "[]",
          delivery,
          delivery === "failed" ? "provider said no" : null,
          source === "dm" ? null : `SM${id}`,
          source === "email" ? `<${id}@example.test>` : null,
          source === "email" ? `<parent@example.test>` : null,
          delivery === "failed" ? 3 : 0,
          delivery === "delivered" ? T(5) : null,
          id.endsWith("_pending") && source === "dm" ? T(9) : null, // a soft-deleted message
          T(10 + seq),
        );
        await run("INSERT INTO message_qids(room_id, client_msg_id, message_id, created_at) VALUES (?, ?, ?, ?)", room, `cm-${id}`, id, T(10 + seq));
        if (source !== "dm") await run("INSERT INTO message_refs(kind, ref, workspace_id, message_id, room_id) VALUES ('provider', ?, 'w1', ?, ?)", `SM${id}`, id, room);
      }
    }
  }
  // rows that reference messages with ON DELETE CASCADE (SQLite): losing these is exactly what a careless table rebuild does
  for (const id of ["msg_r1_dm_sent", "msg_r1_sms_failed", "msg_r2_email_delivered", "msg_r2_sms_pending"]) {
    await run("INSERT INTO message_mentions(message_id, room_id, workspace_id, member_id) VALUES (?, ?, 'w1', 'm1')", id, id.slice(4, 6));
    await run("INSERT INTO message_mentions(message_id, room_id, workspace_id, member_id) VALUES (?, ?, 'w1', 'm2')", id, id.slice(4, 6));
  }
  await run("INSERT INTO notifications(id, workspace_id, member_id, type, room_id, message_id, title, created_at) VALUES ('n1', 'w1', 'm1', 'mention', 'r1', 'msg_r1_dm_sent', 'You were mentioned', ?)", T(11));
  await run("INSERT INTO attachments(id, workspace_id, key, file_name, content_type, size, created_at) VALUES ('att1', 'w1', 'k/att1', 'a.png', 'image/png', 10, ?)", T(2));
  await run("INSERT INTO tokens(id, workspace_id, domain, token, created_at) VALUES ('tok1', 'w1', 'example.test', 'tok_secret_1', ?)", T(0));
  await run("INSERT INTO tokens(id, workspace_id, domain, token, status, created_at) VALUES ('tok2', 'w1', 'old.example.test', 'tok_secret_2', 'revoked', ?)", T(0));
  await run("INSERT INTO visitor_sessions(id, workspace_id, contact_id, token_id, secret_hash, device_id, expires_at, created_at) VALUES ('vs1', 'w1', 'c1', 'tok1', 'hash1', 'dev1', ?, ?)", T(50), T(0));
  await run("INSERT INTO sms_numbers(id, workspace_id, e164, created_at) VALUES ('sn1', 'w1', '+15550000001', ?)", T(0));
  await run("INSERT INTO email_senders(id, workspace_id, address, verified, created_at) VALUES ('es1', 'w1', 'support@example.test', 1, ?)", T(0));
  await run("INSERT INTO usage_ledger(id, workspace_id, kind, delta, balance_after, idem_key, created_at) VALUES ('ul1', 'w1', 'grant', 100, 100, 'idem-1', ?)", T(0));
  await run("INSERT INTO jobs(id, type, dedupe_key, run_at, workspace_id, created_at, updated_at) VALUES ('j1', 'reconcile_sms', 'dk1', ?, 'w1', ?, ?)", T(20), T(0), T(0));
  await run("INSERT INTO templates(id, workspace_id, name, body, created_at, updated_at) VALUES ('t1', 'w1', 'Hi', 'Hello', ?, ?)", T(0), T(0));
  await run("INSERT INTO audit_log(id, workspace_id, actor_type, action, created_at) VALUES ('a1', 'w1', 'member', 'workspace.created', ?)", T(0));
  await run("INSERT INTO billing_accounts(workspace_id, created_at, updated_at) VALUES ('w1', ?, ?)", T(0), T(0));
  await run("INSERT INTO api_keys(id, workspace_id, name, prefix, key_hash, scopes, created_by, created_at) VALUES ('ak1', 'w1', 'k', 'cv_', 'kh1', '[]', 'm1', ?)", T(0));
  await run("INSERT INTO payment_requests(id, workspace_id, room_id, message_id, amount, currency, description, connect_account_id, created_at) VALUES ('pr1', 'w1', 'r1', 'msg_r1_dm_sent', 500, 'usd', 'Invoice', 'acct_1', ?)", T(3));
  await run("INSERT INTO invitations(id, workspace_id, email, role_id, token_hash, invited_by, created_at, expires_at) VALUES ('inv1', 'w1', 'new@example.test', 'role_custom_reader', 'ith1', 'm1', ?, ?)", T(0), T(50));
}

/** Tables the seed must have filled, so a seed that silently stops working cannot make the upgrade test vacuous. */
const MUST_BE_SEEDED = ["workspaces", "users", "members", "roles", "contacts", "rooms", "messages", "message_mentions", "notifications", "attachments", "tokens", "visitor_sessions", "usage_ledger", "jobs", "payment_requests", "message_qids", "message_refs"];

async function messageRows(db: Db) {
  return db.all("SELECT * FROM messages ORDER BY id");
}

// ---- the tests ---------------------------------------------------------------------------------------------------------------------

async function openSqliteFile() {
  const dir = mkdtempSync(join(tmpdir(), "conv-upg-"));
  return { dir, path: join(dir, "data", "conversations.db") };
}

describe("SQLite: upgrading a database created by the previous release", () => {
  it("applies every later migration to a populated 019 database without losing or changing a row", async () => {
    const { dir, path } = await openSqliteFile();
    try {
      // "previous release": its schema, built from the repo's own files, filled with data
      const old = await openDb(path);
      const prev = releaseDir(PREVIOUS_RELEASE);
      try {
        const oldApplied = await migrate(old, prev);
        expect(oldApplied.some((f) => num(f) > PREVIOUS_RELEASE)).toBe(false);
        await seedPreviousRelease(old);
        const tables = await userTables(old);
        const before = await counts(old, tables);
        for (const t of MUST_BE_SEEDED) expect(before[t], `seed filled ${t}`).toBeGreaterThan(0);
        expect(before.messages).toBe(24);
        const msgsBefore = await messageRows(old);
        const mentionsBefore = await old.all("SELECT * FROM message_mentions ORDER BY message_id, member_id");
        // the old CHECK really rejects the new value (so the test proves the migration changed something)
        await expect(old.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('x', 'w1', 'r1', 99, 'agent', 'text', 'sms', 'not_sent_test_mode', ?)", T(30))).rejects.toThrow(/CHECK/);
        await old.close();

        // "new release" boots on the same file with the real runner
        const db = await openDb(path);
        const applied = await migrate(db);
        expect(applied.length).toBeGreaterThan(0);
        expect(applied).toContain("020_delivery_test_mode.sqlite.sql");
        expect(applied.every((f) => !oldApplied.includes(f))).toBe(true);

        // nothing lost or altered in any table that existed before
        const after = await counts(db, tables);
        expect(after).toEqual(before);
        expect(await messageRows(db)).toEqual(msgsBefore);
        expect(await db.all("SELECT * FROM message_mentions ORDER BY message_id, member_id")).toEqual(mentionsBefore);
        expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
        expect((await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))!.foreign_keys).toBe(1);

        // the new value can be stored, a bad one still cannot, and ON DELETE CASCADE still works on the rebuilt table
        await db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('x', 'w1', 'r1', 99, 'agent', 'text', 'sms', 'not_sent_test_mode', ?)", T(30));
        await expect(db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('y', 'w1', 'r1', 100, 'agent', 'text', 'sms', 'bogus', ?)", T(30))).rejects.toThrow(/CHECK/);
        await db.run("INSERT INTO message_mentions(message_id, room_id, workspace_id, member_id) VALUES ('x', 'r1', 'w1', 'm1')");
        await db.run("DELETE FROM messages WHERE id = 'x'");
        expect(await db.all("SELECT 1 FROM message_mentions WHERE message_id = 'x'")).toEqual([]);
        expect(await db.all("SELECT 1 FROM message_mentions")).toHaveLength(mentionsBefore.length);
        // unique indexes still enforce what they enforced
        await expect(db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, created_at) VALUES ('z', 'w1', 'r1', 1, 'agent', 'text', 'dm', ?)", T(31))).rejects.toThrow(/UNIQUE/);

        // system and custom roles: the immutability trigger is back, system roles got the new permissions, custom ones were backfilled
        const perms = async (id: string) => JSON.parse((await db.get<{ permissions: string }>("SELECT permissions FROM roles WHERE id = ?", id))!.permissions) as string[];
        expect(await perms("role_agent")).toContain("team_chat:use");
        expect(await perms("role_owner")).toContain("team_chat:moderate");
        expect(await perms("role_custom_reader")).toContain("team_chat:use");
        expect(await perms("role_custom_none")).toEqual(["billing:manage"]);
        await expect(db.run("UPDATE roles SET name = 'hacked' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/);
        await expect(db.run("DELETE FROM roles WHERE id = 'role_agent'")).rejects.toThrow(/immutable/);
        await expect(db.run("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
        // later migrations' columns exist and carry their defaults on old rows
        expect((await db.get<{ preview: number }>("SELECT preview FROM visitor_sessions WHERE id = 'vs1'"))!.preview).toBe(0);
        expect((await db.get<{ last_seen_at: string | null }>("SELECT last_seen_at FROM tokens WHERE id = 'tok1'"))!.last_seen_at).toBeNull();

        // idempotent: a second boot applies nothing and changes nothing
        const schema1 = await schemaOf(db);
        expect(await migrate(db)).toEqual([]);
        expect(await schemaOf(db)).toEqual(schema1);
        await db.close();
        const again = await openDb(path);
        expect(await migrate(again)).toEqual([]);
        await again.close();
      } finally {
        rmSync(prev, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 019 has exactly the tables, columns, indexes, triggers and constraints of a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PREVIOUS_RELEASE);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      const a = await schemaOf(fresh);
      const b = await schemaOf(upgraded);
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      expect(b).toEqual(a);
      // pin what the rebuild must preserve, so "both sides lost an index" cannot pass
      for (const ix of ["ux_messages_room_seq", "ux_messages_qid", "ix_messages_provider", "ix_messages_rfc", "ix_messages_delivery", "ix_messages_ws_time", "ux_roles_ws_key"]) expect(Object.keys(b), ix).toContain(`index ${ix}`);
      for (const tr of ["audit_log_no_update", "audit_log_no_delete", "roles_system_no_update", "roles_system_no_delete"]) expect(Object.keys(b), tr).toContain(`trigger ${tr}`);
      expect(JSON.stringify(b["table messages"])).toContain("not_sent_test_mode");
      expect(JSON.stringify((b["table message_mentions"] as { foreign_keys: unknown }).foreign_keys)).toContain('"table":"messages"');
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a migration that leaves a foreign key violation is rolled back, foreign keys come back on, and the database stays at the previous version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conv-mig-"));
    try {
      writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT REFERENCES p(id) ON DELETE CASCADE); INSERT INTO p VALUES ('p1'); INSERT INTO c VALUES ('c1', 'p1');");
      writeFileSync(join(dir, "002_rebuild.sqlite.sql"), "-- @sqlite-foreign-keys-off\nCREATE TABLE p_new (id TEXT PRIMARY KEY, extra TEXT);\nINSERT INTO p_new(id) VALUES ('other');\nDROP TABLE p;\nALTER TABLE p_new RENAME TO p;\n");
      const db = await openDb(":memory:");
      await expect(migrate(db, dir)).rejects.toThrow(/foreign key violation/);
      expect((await db.all<{ name: string }>("SELECT name FROM _migrations")).map((r) => r.name)).toEqual(["001_a.sql"]);
      expect(await db.all("SELECT id FROM c")).toEqual([{ id: "c1" }]); // the child row was not cascaded away
      expect(await db.all("SELECT name FROM pragma_table_info('p')")).toEqual([{ name: "id" }]); // old table restored by the rollback
      expect((await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))!.foreign_keys).toBe(1);
      // the same rebuild done correctly passes and keeps the child row
      writeFileSync(join(dir, "002_rebuild.sqlite.sql"), "-- @sqlite-foreign-keys-off\nCREATE TABLE p_new (id TEXT PRIMARY KEY, extra TEXT);\nINSERT INTO p_new(id) SELECT id FROM p;\nDROP TABLE p;\nALTER TABLE p_new RENAME TO p;\n");
      expect(await migrate(db, dir)).toEqual(["002_rebuild.sqlite.sql"]);
      expect(await db.all("SELECT id FROM c")).toEqual([{ id: "c1" }]);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without the directive the same rebuild would cascade-delete child rows (why the directive exists)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conv-mig-"));
    try {
      writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT REFERENCES p(id) ON DELETE CASCADE); INSERT INTO p VALUES ('p1'); INSERT INTO c VALUES ('c1', 'p1');");
      writeFileSync(join(dir, "002_rebuild.sqlite.sql"), "CREATE TABLE p_new (id TEXT PRIMARY KEY, extra TEXT);\nINSERT INTO p_new(id) SELECT id FROM p;\nDROP TABLE p;\nALTER TABLE p_new RENAME TO p;\n");
      const db = await openDb(":memory:");
      await migrate(db, dir);
      expect(await db.all("SELECT id FROM c")).toEqual([]);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing migration leaves the earlier ones applied and the failed one unrecorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conv-mig-"));
    try {
      writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id TEXT);");
      writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id TEXT); THIS IS NOT SQL;");
      const db = await openDb(":memory:");
      await expect(migrate(db, dir)).rejects.toThrow();
      expect((await db.all<{ name: string }>("SELECT name FROM _migrations")).map((r) => r.name)).toEqual(["001_a.sql"]);
      expect(await db.all("SELECT name FROM sqlite_master WHERE name = 'b'")).toEqual([]);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Defensive mode (SQLITE_DBCONFIG_DEFENSIVE) cannot be switched on through node:sqlite 24.11 (the `defensive` option is ignored there; newer
// Node honours it and the SqliteDb constructor already asks for it). The sqlite3 command line shell can: `.dbconfig defensive on` is the same
// switch that Render's node:24-slim build has on. When the shell is installed this runs the REAL 020 file on a populated 019 database under it.
const shell = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
describe.skipIf(shell.status !== 0)("SQLite defensive mode (sqlite3 shell with .dbconfig defensive on)", () => {
  const sh = (file: string, script: string) => spawnSync("sqlite3", [file], { input: script, encoding: "utf8" });

  async function populated019(): Promise<{ dir: string; file: string }> {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PREVIOUS_RELEASE);
    const db = await openDb(path);
    await migrate(db, prev);
    await seedPreviousRelease(db);
    await db.close();
    rmSync(prev, { recursive: true, force: true });
    return { dir, file: path };
  }

  it("the old writable_schema approach is rejected (control: proves the harness reproduces the production failure)", async () => {
    const { dir, file } = await populated019();
    try {
      const r = sh(file, ".dbconfig defensive on\nPRAGMA writable_schema = ON;\nUPDATE sqlite_master SET sql = replace(sql, 'x', 'y') WHERE name = 'messages';\n");
      expect(r.stderr).toMatch(/may not be modified/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migration 020 applies under defensive mode, keeps every row and passes foreign_key_check", async () => {
    const { dir, file } = await populated019();
    try {
      const sql = readFileSync(join(MIGRATIONS, "020_delivery_test_mode.sqlite.sql"), "utf8");
      const r = sh(file, `.dbconfig defensive on\n.bail on\nPRAGMA foreign_keys = OFF;\nBEGIN;\n${sql}\nPRAGMA foreign_key_check;\nCOMMIT;\nPRAGMA foreign_keys = ON;\nSELECT 'messages=' || count(*) FROM messages;\nSELECT 'mentions=' || count(*) FROM message_mentions;\nINSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('nt', 'w1', 'r1', 99, 'agent', 'text', 'sms', 'not_sent_test_mode', 'now');\nSELECT 'new=' || count(*) FROM messages WHERE delivery = 'not_sent_test_mode';\n`);
      expect(r.stderr).toBe("");
      expect(r.stdout.trim().split("\n").filter((l) => l !== "defensive on")).toEqual(["messages=24", "mentions=8", "new=1"]); // foreign_key_check printed nothing
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: upgrading a database created by the previous release", () => {
  async function schemaDb(): Promise<{ db: Db; schema: string; drop: () => Promise<void> }> {
    const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.searchParams.set("options", `-c search_path=${schema}`);
    const db = await openDb({ url: u.toString(), poolMax: 4 });
    return {
      db,
      schema,
      drop: async () => {
        await db.close();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      },
    };
  }

  it("applies every later migration to a populated 019 database without losing or changing a row", async () => {
    const { db, drop } = await schemaDb();
    const prev = releaseDir(PREVIOUS_RELEASE);
    try {
      await migrate(db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(db);
      const tables = await userTables(db);
      const before = await counts(db, tables);
      for (const t of MUST_BE_SEEDED.filter((t) => t !== "message_mentions" || before[t])) expect(before[t], `seed filled ${t}`).toBeGreaterThan(0);
      const msgsBefore = await messageRows(db);
      await expect(db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('x', 'w1', 'r1', 99, 'agent', 'text', 'sms', 'not_sent_test_mode', ?)", T(30))).rejects.toThrow(/check/i);

      const applied = await migrate(db, undefined, { hashPartitions: 2 });
      expect(applied).toContain("020_delivery_test_mode.pg.sql");
      expect(await counts(db, tables)).toEqual(before);
      expect(await messageRows(db)).toEqual(msgsBefore);

      await db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('x', 'w1', 'r1', 99, 'agent', 'text', 'sms', 'not_sent_test_mode', ?)", T(30));
      await expect(db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('y', 'w1', 'r1', 100, 'agent', 'text', 'sms', 'bogus', ?)", T(30))).rejects.toThrow(/check/i);
      const perms = async (id: string) => JSON.parse((await db.get<{ permissions: string }>("SELECT permissions FROM roles WHERE id = ?", id))!.permissions) as string[];
      expect(await perms("role_agent")).toContain("team_chat:use");
      expect(await perms("role_custom_reader")).toContain("team_chat:use");
      expect(await perms("role_custom_none")).toEqual(["billing:manage"]);
      await expect(db.run("UPDATE roles SET name = 'hacked' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/);

      const schema1 = await schemaOf(db);
      expect(await migrate(db, undefined, { hashPartitions: 2 })).toEqual([]);
      expect(await schemaOf(db)).toEqual(schema1);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await drop();
    }
  });

  it("schema drift guard: a database upgraded from 019 has the schema of a fresh one", async () => {
    const a = await schemaDb();
    const b = await schemaDb();
    const prev = releaseDir(PREVIOUS_RELEASE);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await migrate(b.db, undefined, { hashPartitions: 2 });
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});
