import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { migrate, openDb, type Db } from "../src/db/index.js";
import { ALL_PERMISSIONS, SYSTEM_ROLES } from "../src/authz/permissions.js";
import { insertMessage } from "../src/services/messageStore.js";
import { liveTicketOf } from "../src/services/tickets.js";
import { trackCtx, testConfig } from "./helpers.js";
import { createContext } from "../src/app-context.js";
import { HeuristicProvider } from "../src/ai/heuristic.js";
import { silentLogger } from "../src/logger.js";
import { FakeEmailProvider, FakeSmsProvider } from "../src/providers/fake.js";
import { RecordingBus } from "../src/realtime/bus.js";

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
  // `ticket_id` (migration 027) is the only column a later migration added to messages; old rows carry NULL
  return (await db.all<Record<string, unknown>>("SELECT * FROM messages ORDER BY id")).map(({ ticket_id, ...row }) => {
    if (ticket_id !== undefined) expect(ticket_id).toBeNull();
    return row;
  });
}

/** Migration 026 (mobile): additive columns carry their defaults on old rows and the new unique index and table work. */
async function expectMobileMigration(db: Db) {
  expect((await db.get<{ hosted_chat_enabled: number }>("SELECT hosted_chat_enabled FROM tokens WHERE id = 'tok1'"))!.hosted_chat_enabled).toBe(0);
  expect(await db.all("SELECT 1 FROM contacts WHERE external_id IS NOT NULL")).toEqual([]);
  await db.run("UPDATE contacts SET external_id = 'ext-1' WHERE id = 'c1'");
  await expect(db.run("UPDATE contacts SET external_id = 'ext-1' WHERE id = 'c2'")).rejects.toThrow(/unique/i);
  await db.run("UPDATE contacts SET external_id = NULL WHERE id = 'c1'");
  await db.run("INSERT INTO workspace_identity(workspace_id, secret, enforce, rotated_at, created_at) VALUES ('w1', 'v1.x.y.z', 0, ?, ?)", T(1), T(1));
  await db.run("DELETE FROM workspace_identity");
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
        await expectMobileMigration(db);

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
      await expectMobileMigration(db);

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

// ---- tickets (migrations 027 and 028): the release before them is 026 ---------------------------------------------------------------------

const PRE_TICKETS = 26;
const roleList = async (db: Db, id: string) => JSON.parse((await db.get<{ permissions: string }>("SELECT permissions FROM roles WHERE id = ?", id))!.permissions) as string[];

/** What 027 and 028 must leave on a populated database, on either backend. */
async function expectTicketsMigration(db: Db, before: Record<string, number>, tables: string[], msgsBefore: unknown[]) {
  expect(await counts(db, tables)).toEqual(before); // nothing lost anywhere
  expect(await messageRows(db)).toEqual(msgsBefore);
  expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE ticket_id IS NOT NULL"))!.n).toBe(0); // no backfill: old messages belong to no ticket
  expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets"))!.n).toBe(0);
  // the live-ticket index arbitrates, closed tickets pile up, numbers are unique per workspace, FKs cascade from rooms
  const ins = (id: string, room: string, n: number, status: string) =>
    db.run("INSERT INTO tickets(id, workspace_id, room_id, contact_id, number, status, opened_at, last_activity_at, created_at, updated_at) VALUES (?, 'w1', ?, 'c1', ?, ?, ?, ?, ?, ?)", id, room, n, status, T(40), T(40), T(40), T(40));
  await ins("tk1", "r1", 1, "open");
  await expect(ins("tk2", "r1", 2, "new")).rejects.toThrow(/UNIQUE|duplicate key/i);
  await ins("tk3", "r1", 3, "closed");
  await expect(ins("tk4", "r2", 3, "new")).rejects.toThrow(/UNIQUE|duplicate key/i); // number 3 is taken in w1
  await expect(db.run("INSERT INTO tickets(id, workspace_id, room_id, contact_id, number, status, opened_at, last_activity_at, created_at, updated_at) VALUES ('bad', 'w1', 'r2', 'c2', 9, 'bogus', ?, ?, ?, ?)", T(40), T(40), T(40), T(40))).rejects.toThrow(/CHECK|check constraint/i);
  await db.run("UPDATE messages SET ticket_id = 'tk1' WHERE room_id = 'r1' AND seq = 1");
  expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE ticket_id = 'tk1'"))!.n).toBe(1);
  await db.run("INSERT INTO ticket_events(id, workspace_id, ticket_id, type, actor_type, created_at) VALUES ('ev1', 'w1', 'tk1', 'opened', 'contact', ?)", T(40));
  await db.run("DELETE FROM tickets WHERE id IN ('tk1','tk3')");
  await db.run("UPDATE messages SET ticket_id = NULL WHERE ticket_id = 'tk1'");
  expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ticket_events"))!.n).toBe(0); // events cascade with their ticket

  // permissions: system roles equal the catalogue, custom roles keep what they had
  for (const r of SYSTEM_ROLES) expect((await roleList(db, r.id)).sort(), r.id).toEqual([...r.permissions].sort());
  expect(await roleList(db, "role_agent")).toEqual(expect.arrayContaining(["tickets:read", "tickets:write", "tickets:close"]));
  expect(await roleList(db, "role_agent")).not.toContain("tickets:merge");
  expect(await roleList(db, "role_viewer")).toContain("tickets:read");
  expect(await roleList(db, "role_viewer")).not.toContain("tickets:close");
  expect(await roleList(db, "role_owner")).toEqual(expect.arrayContaining(["tickets:merge"]));
  expect(await roleList(db, "role_custom_reader")).toEqual(["conversations:read", "tickets:read", "contacts:read"]); // read, not write
  expect(await roleList(db, "role_custom_none")).toEqual(["billing:manage"]);
  expect(ALL_PERMISSIONS).toContain("tickets:merge");
  await expect(db.run("UPDATE roles SET name = 'hacked' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/); // the guard trigger is back
}

describe("SQLite: tickets migrations on a populated database of the release before them", () => {
  it("adds tickets without touching a row, grants the new permissions, leaves old rooms ticket-less until their next message", async () => {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_TICKETS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      const msgsBefore = await messageRows(old);
      expect(await old.all("SELECT name FROM sqlite_master WHERE name = 'tickets'")).toEqual([]);
      await old.close();

      const db = await openDb(path);
      const applied = await migrate(db);
      expect(applied.slice(0, 2)).toEqual(["027_tickets.sql", "028_roles_tickets.sqlite.sql"]);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      await expectTicketsMigration(db, before, tables, msgsBefore);
      expect(await migrate(db)).toEqual([]);
      await db.close();

      // the application on that file: an old room opens its first ticket with its next message
      const ctx = await createContext(testConfig({ DATABASE_PATH: path }), { log: silentLogger, bus: new RecordingBus(), sms: new FakeSmsProvider(), email: new FakeEmailProvider(), ai: new HeuristicProvider() });
      trackCtx(ctx);
      await ctx.db.run("UPDATE rooms SET next_seq = 12 WHERE id = 'r1'"); // the seed writes messages without advancing the room's counter
      const room = (await ctx.db.get<{ id: string; workspace_id: string; contact_id: string }>("SELECT id, workspace_id, contact_id FROM rooms WHERE id = 'r1'"))!;
      expect(await liveTicketOf(ctx, "r1")).toBeUndefined();
      const m = await insertMessage(ctx, { workspaceId: room.workspace_id, roomId: "r1", senderType: "contact", senderId: room.contact_id, kind: "text", source: "dm", content: "back again" });
      const t = (await liveTicketOf(ctx, "r1"))!;
      expect(t.number).toBe(1);
      expect(m.message.ticket_id).toBe(t.id);
      expect((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE room_id = 'r1' AND ticket_id IS NULL"))!.n).toBe(12); // the history stays outside any ticket
    } finally {
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 026 equals a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_TICKETS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh));
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: tickets migrations on a populated database of the release before them", () => {
  async function schemaDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
    const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.searchParams.set("options", `-c search_path=${schema}`);
    const db = await openDb({ url: u.toString(), poolMax: 4 });
    return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
  }

  it("adds tickets without touching a row (messages is partitioned), grants the permissions, matches a fresh schema", async () => {
    const a = await schemaDb();
    const b = await schemaDb();
    const prev = releaseDir(PRE_TICKETS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      const msgsBefore = await messageRows(b.db);
      const applied = await migrate(b.db, undefined, { hashPartitions: 2 });
      expect(applied.slice(0, 2)).toEqual(["027_tickets.sql", "028_roles_tickets.pg.sql"]);
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectTicketsMigration(b.db, before, tables, msgsBefore);
      expect(await migrate(b.db, undefined, { hashPartitions: 2 })).toEqual([]);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- departments (migrations 029 and 030): the release before them is 028 -------------------------------------------------------------------

const PRE_DEPARTMENTS = 28;

/** A populated 028 database also holds tickets; this adds two (a live one and a closed one) on top of the shared seed. */
async function seedTickets(db: Db) {
  const ins = (id: string, room: string, n: number, status: string) =>
    db.run("INSERT INTO tickets(id, workspace_id, room_id, contact_id, number, status, handler, opened_at, last_activity_at, created_at, updated_at) VALUES (?, 'w1', ?, 'c1', ?, ?, 'human:m2', ?, ?, ?, ?)", id, room, n, status, T(41), T(41), T(41), T(41));
  await ins("tkA", "r1", 1, "open");
  await ins("tkB", "r2", 2, "closed");
  await db.run("INSERT INTO ticket_counters(workspace_id, next_number) VALUES ('w1', 2)");
}

async function expectDepartmentsMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  // old inboxes and members read as unconfigured departments: they keep behaving as before
  expect(await db.get("SELECT description, routing_mode, capacity, hours, sla_first_response_s, sla_resolution_s, overflow_inbox_id, auto_reply_closed, auto_reply_queued FROM inboxes WHERE id = 'i1'")).toEqual({
    description: "", routing_mode: null, capacity: 0, hours: "{}", sla_first_response_s: null, sla_resolution_s: null, overflow_inbox_id: null, auto_reply_closed: "", auto_reply_queued: "",
  });
  expect(await db.get("SELECT skills, languages, capacity FROM inbox_members WHERE inbox_id = 'i1' AND member_id = 'm2'")).toEqual({ skills: "[]", languages: "[]", capacity: null });
  expect(await db.get("SELECT sla_first_response_due_at, sla_resolution_due_at, sla_first_response_breached_at, sla_resolution_breached_at, reassigned_count FROM tickets WHERE id = 'tkA'")).toEqual({
    sla_first_response_due_at: null, sla_resolution_due_at: null, sla_first_response_breached_at: null, sla_resolution_breached_at: null, reassigned_count: 0,
  });
  // the CHECK constraints of the new columns hold, the overflow reference clears when its target is deleted, rules cascade with their department
  await expect(db.run("UPDATE inboxes SET routing_mode = 'random' WHERE id = 'i1'")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(db.run("UPDATE inboxes SET capacity = -1 WHERE id = 'i1'")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(db.run("UPDATE inbox_members SET capacity = -2 WHERE inbox_id = 'i1'")).rejects.toThrow(/CHECK|check constraint/i);
  await db.run("INSERT INTO inboxes(id, workspace_id, name, created_at) VALUES ('i2', 'w1', 'Overflow', ?)", T(42));
  await db.run("UPDATE inboxes SET overflow_inbox_id = 'i2', routing_mode = 'least_busy' WHERE id = 'i1'");
  await db.run("INSERT INTO routing_rules(id, workspace_id, position, name, department_id, created_at, updated_at) VALUES ('rl1', 'w1', 0, 'r', 'i2', ?, ?)", T(42), T(42));
  await db.run("DELETE FROM inboxes WHERE id = 'i2'");
  expect((await db.get<{ overflow_inbox_id: string | null }>("SELECT overflow_inbox_id FROM inboxes WHERE id = 'i1'"))!.overflow_inbox_id).toBeNull();
  expect(await db.all("SELECT 1 FROM routing_rules")).toEqual([]);
  // roles: departments:manage for owner and manager only, everything else as the catalogue says
  for (const r of SYSTEM_ROLES) expect((await roleList(db, r.id)).sort(), r.id).toEqual([...r.permissions].sort());
  expect(await roleList(db, "role_owner")).toContain("departments:manage");
  expect(await roleList(db, "role_manager")).toContain("departments:manage");
  expect(await roleList(db, "role_agent")).not.toContain("departments:manage");
  expect(await roleList(db, "role_custom_reader")).toEqual(["conversations:read", "contacts:read"]); // untouched by this migration (the seed adds it after 028 ran)
  await expect(db.run("UPDATE roles SET name = 'hacked' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/);
}

describe("SQLite: departments migrations on a populated database of the release before them", () => {
  it("adds department configuration without touching a row", async () => {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_DEPARTMENTS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      const applied = await migrate(db);
      expect(applied.slice(0, 2)).toEqual(["029_departments.sql", "030_roles_departments.sqlite.sql"]);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      await expectDepartmentsMigration(db, before, tables);
      expect(await migrate(db)).toEqual([]);
      await db.close();
    } finally {
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 028 equals a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_DEPARTMENTS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh));
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: departments migrations on a populated database of the release before them", () => {
  it("adds department configuration without touching a row and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_DEPARTMENTS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      const applied = await migrate(b.db, undefined, { hashPartitions: 2 });
      expect(applied.slice(0, 2)).toEqual(["029_departments.sql", "030_roles_departments.pg.sql"]);
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectDepartmentsMigration(b.db, before, tables);
      expect(await migrate(b.db, undefined, { hashPartitions: 2 })).toEqual([]);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- AI agents (migrations 031 and 032): the release before them is 030 --------------------------------------------------------------------

const PRE_AGENTS = 30;

const seedKb = (db: Db) => db.run("INSERT INTO kb_entries(id, workspace_id, question, answer, created_at, updated_at) VALUES ('kb1', 'w1', 'Q', 'A', ?, ?)", T(40), T(40));

async function expectAgentsMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  // knowledge-base entries written before the migration read as ungrouped and link-less
  expect(await db.get("SELECT collection, url FROM kb_entries LIMIT 1")).toEqual({ collection: "", url: null });
  // the new tables start empty, defaults hold, constraints hold, rows go with their workspace/ticket
  expect(await db.all("SELECT 1 FROM ai_agents")).toEqual([]);
  await db.run("INSERT INTO ai_agents(id, workspace_id, name, created_at, updated_at) VALUES ('ag1', 'w1', 'Aria', ?, ?)", T(50), T(50));
  expect(await db.get("SELECT tone, autonomy, enabled, waiting_behavior, disclosure_label, channels, max_turns FROM ai_agents WHERE id = 'ag1'")).toMatchObject({ tone: "friendly", autonomy: "auto_answer", waiting_behavior: "gather_info", disclosure_label: "AI assistant", channels: '["widget"]', max_turns: 6 });
  await expect(db.run("UPDATE ai_agents SET autonomy = 'wild' WHERE id = 'ag1'")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(db.run("UPDATE ai_agents SET confidence_threshold = 2 WHERE id = 'ag1'")).rejects.toThrow(/CHECK|check constraint/i);
  await db.run("INSERT INTO ai_turns(id, workspace_id, ticket_id, room_id, agent_id, outcome, created_at) VALUES ('tn1', 'w1', 'tkA', 'r1', 'ag1', 'answered', ?)", T(51));
  await expect(db.run("UPDATE ai_turns SET outcome = 'bogus' WHERE id = 'tn1'")).rejects.toThrow(/CHECK|check constraint/i);
  await db.run("DELETE FROM tickets WHERE id = 'tkA'");
  expect(await db.all("SELECT 1 FROM ai_turns")).toEqual([]);
  // roles: agents:manage for owner and manager only
  for (const r of SYSTEM_ROLES) expect((await roleList(db, r.id)).sort(), r.id).toEqual([...r.permissions].sort());
  expect(await roleList(db, "role_owner")).toContain("agents:manage");
  expect(await roleList(db, "role_manager")).toContain("agents:manage");
  expect(await roleList(db, "role_agent")).not.toContain("agents:manage");
  await expect(db.run("UPDATE roles SET name = 'hacked' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/);
}

describe("SQLite: AI agent migrations on a populated database of the release before them", () => {
  it("adds AI agents without touching a row", async () => {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_AGENTS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      const applied = await migrate(db);
      expect(applied.slice(0, 2)).toEqual(["031_ai_agents.sql", "032_roles_agents.sqlite.sql"]);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      await expectAgentsMigration(db, before, tables);
      expect(await migrate(db)).toEqual([]);
      await db.close();
    } finally {
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 030 equals a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_AGENTS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh));
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: AI agent migrations on a populated database of the release before them", () => {
  it("adds AI agents without touching a row and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_AGENTS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      const applied = await migrate(b.db, undefined, { hashPartitions: 2 });
      expect(applied.slice(0, 2)).toEqual(["031_ai_agents.sql", "032_roles_agents.pg.sql"]);
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectAgentsMigration(b.db, before, tables);
      expect(await migrate(b.db, undefined, { hashPartitions: 2 })).toEqual([]);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- department visitor details (migration 033): the release before it is 032 -------------------------------------------------------------

const PRE_VISITOR_INFO = 32;

async function expectVisitorInfoMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  // every existing department follows the workspace until someone overrides it
  expect(await db.get("SELECT visitor_info FROM inboxes WHERE id = 'i1'")).toEqual({ visitor_info: "{}" });
  await db.run("UPDATE inboxes SET visitor_info = ? WHERE id = 'i1'", '{"fields":{"phone":"required"}}');
  expect(await db.get("SELECT visitor_info FROM inboxes WHERE id = 'i1'")).toEqual({ visitor_info: '{"fields":{"phone":"required"}}' });
}

describe("SQLite: visitor details migration on a populated database of the release before them", () => {
  it("adds the department override without touching a row", async () => {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_VISITOR_INFO);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      const applied = await migrate(db);
      expect(applied[0]).toBe("033_department_visitor_info.sql");
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      await expectVisitorInfoMigration(db, before, tables);
      expect(await migrate(db)).toEqual([]);
      await db.close();
    } finally {
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 032 equals a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_VISITOR_INFO);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh));
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: visitor details migration on a populated database of the release before them", () => {
  it("adds the department override without touching a row and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_VISITOR_INFO);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      const applied = await migrate(b.db, undefined, { hashPartitions: 2 });
      expect(applied[0]).toBe("033_department_visitor_info.sql");
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectVisitorInfoMigration(b.db, before, tables);
      expect(await migrate(b.db, undefined, { hashPartitions: 2 })).toEqual([]);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- calls (migrations 034 and 035): the release before them is 033 ------------------------------------------------------------------------

const PRE_CALLS = 33;

async function expectCallsMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  expect(await db.all("SELECT 1 FROM calls")).toEqual([]);
  const ins = (id: string, state: string) => db.run("INSERT INTO calls(id, workspace_id, room_id, contact_id, kind, state, initiated_by, created_at, updated_at) VALUES (?, 'w1', 'r1', 'c1', 'voice', ?, 'm1', ?, ?)", id, state, T(60), T(60));
  await ins("cl1", "ringing");
  // one live call per conversation, any number of finished ones
  await expect(ins("cl2", "active")).rejects.toThrow(/unique|UNIQUE/i);
  await db.run("UPDATE calls SET state = 'ended' WHERE id = 'cl1'");
  await ins("cl3", "active");
  await expect(ins("cl4", "paused")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(db.run("UPDATE calls SET kind = 'hologram' WHERE id = 'cl3'")).rejects.toThrow(/CHECK|check constraint/i);
  // calls go with their conversation
  await db.run("DELETE FROM rooms WHERE id = 'r1'");
  expect(await db.all("SELECT 1 FROM calls")).toEqual([]);
  // roles: calls:make for owner, manager and agent; calls:settings for owner and manager
  for (const r of SYSTEM_ROLES) expect((await roleList(db, r.id)).sort(), r.id).toEqual([...r.permissions].sort());
  expect(await roleList(db, "role_agent")).toContain("calls:make");
  expect(await roleList(db, "role_agent")).not.toContain("calls:settings");
  expect(await roleList(db, "role_viewer")).not.toContain("calls:make");
  expect(await roleList(db, "role_manager")).toEqual(expect.arrayContaining(["calls:make", "calls:settings"]));
  await expect(db.run("UPDATE roles SET name = 'hacked' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/);
}

describe("SQLite: calls migrations on a populated database of the release before them", () => {
  it("adds calls without touching a row", async () => {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_CALLS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      const applied = await migrate(db);
      expect(applied.slice(0, 2)).toEqual(["034_calls.sql", "035_roles_calls.sqlite.sql"]);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      await expectCallsMigration(db, before, tables);
      expect(await migrate(db)).toEqual([]);
      await db.close();
    } finally {
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 033 equals a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_CALLS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh));
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: calls migrations on a populated database of the release before them", () => {
  it("adds calls without touching a row and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_CALLS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      const applied = await migrate(b.db, undefined, { hashPartitions: 2 });
      expect(applied.slice(0, 2)).toEqual(["034_calls.sql", "035_roles_calls.pg.sql"]);
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectCallsMigration(b.db, before, tables);
      expect(await migrate(b.db, undefined, { hashPartitions: 2 })).toEqual([]);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- AI calls (migration 036): the release before it is 035 ---------------------------------------------------------------------------

const PRE_AI_CALLS = 35;

/** one finished call of each existing transport, written with the schema of release 035 */
async function seedCallsAt035(db: Db) {
  const ins = (id: string, transport: string, kind: string, state: string, room: string) =>
    db.run("INSERT INTO calls(id, workspace_id, room_id, contact_id, transport, kind, state, initiated_by, duration_s, ended_by, end_reason, created_at, updated_at, meta) VALUES (?, 'w1', ?, 'c1', ?, ?, ?, 'm1', 61, 'agent', 'completed', ?, ?, '{\"k\":1}')", id, room, transport, kind, state, T(50), T(50));
  await ins("cl_web", "webrtc", "video", "ended", "r1");
  await ins("cl_phone", "phone", "voice", "failed", "r1");
  await ins("cl_live", "webrtc", "voice", "active", "r2");
}

async function expectAiCallsMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  // rows are copied unchanged, the three new columns start empty
  const rows = await db.all<any>("SELECT * FROM calls ORDER BY id");
  expect(rows.map((r) => [r.id, r.transport, r.kind, r.state, r.duration_s, r.ended_by, r.meta])).toEqual([
    ["cl_live", "webrtc", "voice", "active", 61, "agent", '{"k":1}'],
    ["cl_phone", "phone", "voice", "failed", 61, "agent", '{"k":1}'],
    ["cl_web", "webrtc", "video", "ended", 61, "agent", '{"k":1}'],
  ]);
  expect(rows.every((r) => r.ai_agent_id === null && r.engine === null && r.handoff_reason === null)).toBe(true);
  const ins = (id: string, transport: string, kind: string, room: string) =>
    db.run("INSERT INTO calls(id, workspace_id, room_id, contact_id, transport, kind, state, initiated_by, created_at, updated_at, ai_agent_id, engine) VALUES (?, 'w1', ?, 'c1', ?, ?, 'ended', 'c1', ?, ?, 'agt1', 'browser')", id, room, transport, kind, T(55), T(55));
  await ins("cl_ai1", "ai", "ai_voice", "r1");
  await ins("cl_ai2", "ai", "ai_video", "r1");
  // still strict: unknown values are refused, and the one-live-call-per-conversation index survived the rebuild
  await expect(ins("cl_bad1", "ai", "hologram", "r1")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(ins("cl_bad2", "satellite", "voice", "r1")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(db.run("INSERT INTO calls(id, workspace_id, room_id, contact_id, transport, kind, state, initiated_by, created_at, updated_at) VALUES ('cl_dup', 'w1', 'r2', 'c1', 'ai', 'ai_voice', 'active', 'c1', ?, ?)", T(56), T(56))).rejects.toThrow(/unique|UNIQUE/i);
  // calls still go with their conversation
  await db.run("DELETE FROM rooms WHERE id = 'r1'");
  expect((await db.all<{ id: string }>("SELECT id FROM calls ORDER BY id")).map((r) => r.id)).toEqual(["cl_live"]);
}

describe("SQLite: AI calls migration on a populated database of the release before it", () => {
  it("rebuilds calls without losing a row, keeps its indexes, and accepts AI calls", async () => {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_AI_CALLS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      await seedCallsAt035(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      const applied = await migrate(db);
      expect(applied[0]).toBe("036_ai_calls.sqlite.sql");
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      await expectAiCallsMigration(db, before, tables);
      expect(await migrate(db)).toEqual([]);
      await db.close();
    } finally {
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 035 equals a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_AI_CALLS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedCallsAt035(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh));
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: AI calls migration on a populated database of the release before it", () => {
  it("widens the CHECKs and adds the columns without touching a row, and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_AI_CALLS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      await seedCallsAt035(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      const applied = await migrate(b.db, undefined, { hashPartitions: 2 });
      expect(applied[0]).toBe("036_ai_calls.pg.sql");
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectAiCallsMigration(b.db, before, tables);
      expect(await migrate(b.db, undefined, { hashPartitions: 2 })).toEqual([]);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- agent portraits (migration 037): the release before it is 036 ------------------------------------------------------------------------

const PRE_AVATAR = 36;
const seedAgentAt036 = (db: Db) => db.run("INSERT INTO ai_agents(id, workspace_id, name, avatar_url, created_at, updated_at) VALUES ('agp', 'w1', 'Aria', 'https://pictures.example.test/a.png', ?, ?)", T(50), T(50));

async function expectAvatarMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  const a = await db.get<any>("SELECT avatar_url, avatar_key, avatar_alt FROM ai_agents WHERE id = 'agp'");
  expect(a).toEqual({ avatar_url: "https://pictures.example.test/a.png", avatar_key: null, avatar_alt: "" });
  await db.run("UPDATE ai_agents SET avatar_key = 'k', avatar_alt = 'alt' WHERE id = 'agp'");
  expect((await db.get<any>("SELECT avatar_key FROM ai_agents WHERE id = 'agp'")).avatar_key).toBe("k");
}

describe("SQLite: agent portrait migration on a populated database of the release before it", () => {
  it("adds the columns without touching a row and matches a fresh schema", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_AVATAR);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      await seedAgentAt036(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      expect((await migrate(db))[0]).toBe("037_agent_avatar.sql");
      expect(await schemaOf(db)).toEqual(await schemaOf(fresh));
      await expectAvatarMigration(db, before, tables);
      await db.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: agent portrait migration on a populated database of the release before it", () => {
  it("adds the columns without touching a row and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_AVATAR);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      await seedAgentAt036(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      expect((await migrate(b.db, undefined, { hashPartitions: 2 }))[0]).toBe("037_agent_avatar.sql");
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectAvatarMigration(b.db, before, tables);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- calls between teammates (migrations 038 and 039): the release before them is 037 --------------------------------------------------------

const PRE_TEAM_CALLS = 37;
const seedTeamChat = async (db: Db) => {
  await db.run("INSERT INTO team_channels(id, workspace_id, kind, visibility, dm_key, created_at) VALUES ('tch1', 'w1', 'dm', 'private', 'm1,m2', ?)", T(50));
  await db.run("INSERT INTO team_channels(id, workspace_id, kind, visibility, dm_key, created_at) VALUES ('tch2', 'w1', 'dm', 'private', 'm1,m3', ?)", T(50));
};

async function expectTeamCallsMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  const ins = (id: string, ch: string, caller: string, callee: string, state: string, kind = "voice") =>
    db.run("INSERT INTO team_calls(id, workspace_id, channel_id, kind, state, caller_id, callee_id, created_at, updated_at) VALUES (?, 'w1', ?, ?, ?, ?, ?, ?, ?)", id, ch, kind, state, caller, callee, T(60), T(60));
  await ins("tc1", "tch1", "m1", "m2", "ringing");
  // one live call per conversation, per caller and per callee; any number of finished ones
  await expect(ins("tc2", "tch1", "m2", "m1", "active")).rejects.toThrow(/unique|UNIQUE/i);
  await expect(ins("tc3", "tch2", "m1", "m3", "active")).rejects.toThrow(/unique|UNIQUE/i); // m1 already calls
  await expect(ins("tc4", "tch2", "m3", "m2", "active")).rejects.toThrow(/unique|UNIQUE/i); // m2 is already rung
  await db.run("UPDATE team_calls SET state = 'ended' WHERE id = 'tc1'");
  await ins("tc5", "tch2", "m1", "m3", "active");
  await expect(ins("tc6", "tch2", "m1", "m3", "paused")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(ins("tc7", "tch2", "m1", "m3", "ended", "hologram")).rejects.toThrow(/CHECK|check constraint/i);
  // calls go with their conversation
  await db.run("DELETE FROM team_channels WHERE id = 'tch2'");
  expect((await db.all<{ id: string }>("SELECT id FROM team_calls")).map((r) => r.id)).toEqual(["tc1"]);
  // roles: calls:internal for owner, manager and agent (not the viewer); custom roles keep exactly what they had
  for (const r of SYSTEM_ROLES) expect((await roleList(db, r.id)).sort(), r.id).toEqual([...r.permissions].sort());
  for (const id of ["role_owner", "role_manager", "role_agent"]) expect(await roleList(db, id)).toContain("calls:internal");
  expect(await roleList(db, "role_viewer")).not.toContain("calls:internal");
  expect(await roleList(db, "role_custom_reader")).toEqual(["conversations:read", "contacts:read"]);
  await expect(db.run("UPDATE roles SET name = 'hacked' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/);
}

describe("SQLite: teammate calls migrations on a populated database of the release before them", () => {
  it("adds team_calls and the permission without touching a row", async () => {
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_TEAM_CALLS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      await seedTeamChat(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      const applied = await migrate(db);
      expect(applied.slice(0, 2)).toEqual(["038_team_calls.sql", "039_roles_calls_internal.sqlite.sql"]);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      await expectTeamCallsMigration(db, before, tables.filter((t) => t !== "team_calls"));
      expect(await migrate(db)).toEqual([]);
      await db.close();
    } finally {
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schema drift guard: a database upgraded from 037 equals a fresh one", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_TEAM_CALLS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await old.close();
      const upgraded = await openDb(path);
      await migrate(upgraded);
      expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh));
      await upgraded.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: teammate calls migrations on a populated database of the release before them", () => {
  it("adds team_calls and the permission without touching a row and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_TEAM_CALLS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      await seedTeamChat(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      expect((await migrate(b.db, undefined, { hashPartitions: 2 })).slice(0, 2)).toEqual(["038_team_calls.sql", "039_roles_calls_internal.pg.sql"]);
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectTeamCallsMigration(b.db, before, tables.filter((t) => t !== "team_calls"));
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- call links (migration 040): the release before it is 039 -------------------------------------------------------------------------------

const PRE_CALL_LINKS = 39;
async function expectCallLinksMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  const link = (id: string, mode: string, kind: string, hash: string) =>
    db.run("INSERT INTO call_links(id, workspace_id, room_id, mode, kind, token_hash, created_by, created_at, expires_at) VALUES (?, 'w1', 'r1', ?, ?, ?, 'member:m1', ?, ?)", id, mode, kind, hash, T(60), T(90));
  await link("l1", "team", "voice", "h1");
  await link("l2", "ai", "video", "h2");
  await expect(link("l3", "team", "voice", "h1")).rejects.toThrow(/unique|UNIQUE/i); // one hash, one link
  await expect(link("l4", "robot", "voice", "h4")).rejects.toThrow(/CHECK|check constraint/i);
  await expect(link("l5", "ai", "hologram", "h5")).rejects.toThrow(/CHECK|check constraint/i);
  // sessions keep working and may carry a link id
  expect((await db.get<any>("SELECT call_link_id FROM visitor_sessions LIMIT 1"))?.call_link_id ?? null).toBeNull();
  // links go with their conversation
  await db.run("DELETE FROM rooms WHERE id = 'r1'");
  expect(await db.all("SELECT id FROM call_links")).toEqual([]);
}

describe("SQLite: call links migration on a populated database of the release before it", () => {
  it("adds the table and the session column without touching a row, and matches a fresh schema", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_CALL_LINKS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      expect((await migrate(db)).slice(0, 1)).toEqual(["040_call_links.sql"]);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(await schemaOf(db)).toEqual(await schemaOf(fresh));
      await expectCallLinksMigration(db, before, tables);
      await db.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: call links migration on a populated database of the release before it", () => {
  it("adds the table and the session column without touching a row, and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_CALL_LINKS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      expect((await migrate(b.db, undefined, { hashPartitions: 2 })).slice(0, 1)).toEqual(["040_call_links.sql"]);
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectCallLinksMigration(b.db, before, tables);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- group calls (migration 041): the release before it is 040 ------------------------------------------------------------------------------

const PRE_GROUP_CALLS = 40;
async function expectGroupCallsMigration(db: Db, before: Record<string, number>, tables: string[]) {
  expect(await counts(db, tables)).toEqual(before);
  const call = (id: string, ch: string, state: string, max = 4) =>
    db.run("INSERT INTO group_calls(id, workspace_id, channel_id, kind, state, host_id, max_participants, created_at, updated_at) VALUES (?, 'w1', ?, 'voice', ?, 'm1', ?, ?, ?)", id, ch, state, max, T(1), T(1));
  const ch = (await db.get<{ id: string }>("SELECT id FROM team_channels LIMIT 1"))!.id;
  await call("g1", ch, "live");
  await expect(call("g2", ch, "live")).rejects.toThrow(/unique|UNIQUE/i); // one live call per conversation
  await call("g3", ch, "ended"); // finished calls do not count
  await expect(call("g4", ch, "ended", 5)).rejects.toThrow(/CHECK|check constraint/i); // the cap is at most four
  await expect(call("g5", ch, "ringing")).rejects.toThrow(/CHECK|check constraint/i);
  const person = (c: string, m: string, st: string) => db.run("INSERT INTO group_call_participants(call_id, member_id, workspace_id, status, invited_at) VALUES (?, ?, 'w1', ?, ?)", c, m, st, T(1));
  await person("g1", "m1", "joined");
  await expect(person("g3", "m1", "joined")).rejects.toThrow(/unique|UNIQUE/i); // one call at a time
  await person("g3", "m2", "joined");
  await db.run("DELETE FROM group_calls WHERE id = 'g1'");
  expect(await db.all("SELECT member_id FROM group_call_participants WHERE call_id = 'g1'")).toEqual([]); // participants go with their call
}

describe("SQLite: group calls migration on a populated database of the release before it", () => {
  it("adds the tables without touching a row, enforces the caps and matches a fresh schema", async () => {
    const fresh = await openDb(":memory:");
    await migrate(fresh);
    const { dir, path } = await openSqliteFile();
    const prev = releaseDir(PRE_GROUP_CALLS);
    try {
      const old = await openDb(path);
      await migrate(old, prev);
      await seedPreviousRelease(old);
      await seedTickets(old);
      await seedKb(old);
      await seedTeamChat(old);
      const tables = await userTables(old);
      const before = await counts(old, tables);
      await old.close();
      const db = await openDb(path);
      expect((await migrate(db)).slice(0, 1)).toEqual(["041_group_calls.sql"]);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(await schemaOf(db)).toEqual(await schemaOf(fresh));
      await expectGroupCallsMigration(db, before, tables);
      await db.close();
    } finally {
      await fresh.close();
      rmSync(prev, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!postgres)("PostgreSQL: group calls migration on a populated database of the release before it", () => {
  it("adds the tables without touching a row, enforces the caps and matches a fresh schema", async () => {
    const mk = async () => {
      const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb({ url: u.toString(), poolMax: 4 });
      return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
    };
    const a = await mk();
    const b = await mk();
    const prev = releaseDir(PRE_GROUP_CALLS);
    try {
      await migrate(a.db, undefined, { hashPartitions: 2 });
      await migrate(b.db, prev, { hashPartitions: 2 });
      await seedPreviousRelease(b.db);
      await seedTickets(b.db);
      await seedKb(b.db);
      await seedTeamChat(b.db);
      const tables = await userTables(b.db);
      const before = await counts(b.db, tables);
      expect((await migrate(b.db, undefined, { hashPartitions: 2 })).slice(0, 1)).toEqual(["041_group_calls.sql"]);
      expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
      await expectGroupCallsMigration(b.db, before, tables);
    } finally {
      rmSync(prev, { recursive: true, force: true });
      await a.drop();
      await b.drop();
    }
  });
});

// ---- later additive migrations: each on a populated database of the release before it, SQLite and PostgreSQL ------------------------------

async function upgradeSqlite(pre: number, expected: string, check: (db: Db) => Promise<void>) {
  const fresh = await openDb(":memory:");
  await migrate(fresh);
  const { dir, path } = await openSqliteFile();
  const prev = releaseDir(pre);
  try {
    const old = await openDb(path);
    await migrate(old, prev);
    await seedPreviousRelease(old);
    await seedTickets(old);
    await seedKb(old);
    await seedTeamChat(old);
    const tables = await userTables(old);
    const before = await counts(old, tables);
    await old.close();
    const db = await openDb(path);
    expect((await migrate(db)).slice(0, 1)).toEqual([expected]);
    expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(await schemaOf(db)).toEqual(await schemaOf(fresh));
    expect(await counts(db, tables)).toEqual(before);
    await check(db);
    await db.close();
  } finally {
    await fresh.close();
    rmSync(prev, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
async function upgradePostgres(pre: number, expected: string, check: (db: Db) => Promise<void>) {
  const mk = async () => {
    const schema = `u_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.searchParams.set("options", `-c search_path=${schema}`);
    const db = await openDb({ url: u.toString(), poolMax: 4 });
    return { db, drop: async () => (await db.close(), await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`), await admin.end()) };
  };
  const a = await mk();
  const b = await mk();
  const prev = releaseDir(pre);
  try {
    await migrate(a.db, undefined, { hashPartitions: 2 });
    await migrate(b.db, prev, { hashPartitions: 2 });
    await seedPreviousRelease(b.db);
    await seedTickets(b.db);
    await seedKb(b.db);
    await seedTeamChat(b.db);
    const tables = await userTables(b.db);
    const before = await counts(b.db, tables);
    expect((await migrate(b.db, undefined, { hashPartitions: 2 })).slice(0, 1)).toEqual([expected]);
    expect(await schemaOf(b.db)).toEqual(await schemaOf(a.db));
    expect(await counts(b.db, tables)).toEqual(before);
    await check(b.db);
  } finally {
    rmSync(prev, { recursive: true, force: true });
    await a.drop();
    await b.drop();
  }
}

/** migration 042: push subscriptions, one per member and endpoint, removed with the member */
async function expectPushMigration(db: Db) {
  const m = (await db.get<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM members LIMIT 1"))!;
  const add = (id: string, endpoint: string) => db.run("INSERT INTO push_subscriptions(id, workspace_id, member_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?, 'k', 'a', ?)", id, m.workspace_id, m.id, endpoint, T(1));
  await add("p1", "https://fcm.googleapis.com/x");
  await expect(add("p2", "https://fcm.googleapis.com/x")).rejects.toThrow(/unique|UNIQUE/i);
  await add("p3", "https://fcm.googleapis.com/y");
  expect((await db.get<{ events: string }>("SELECT events FROM push_subscriptions WHERE id = 'p1'"))!.events).toBe('["missed_call","assigned","message"]');
}
describe("upgrades of the later additive migrations", () => {
  it("042 push subscriptions on SQLite", () => upgradeSqlite(41, "042_push_subscriptions.sql", expectPushMigration));
  it.skipIf(!postgres)("042 push subscriptions on PostgreSQL", () => upgradePostgres(41, "042_push_subscriptions.sql", expectPushMigration));
});

/** migration 043: photoreal avatars; agents keep working with no avatar chosen */
async function expectPhotorealMigration(db: Db) {
  const ws = (await db.get<{ id: string }>("SELECT id FROM workspaces LIMIT 1"))!.id;
  await db.run("INSERT INTO avatar_connections(workspace_id, provider, credentials_enc, key_hint, status, created_at, updated_at) VALUES (?, 'did', 'enc2.x.y', '1234', 'pending', ?, ?)", ws, T(1), T(1));
  await expect(db.run("INSERT INTO avatar_connections(workspace_id, provider, credentials_enc, key_hint, status, created_at, updated_at) VALUES (?, 'heygen', 'e', '1', 'pending', ?, ?)", ws, T(1), T(1))).rejects.toThrow();
  await db.run("INSERT INTO photoreal_avatars(id, workspace_id, name, provider, source, presenter_id, created_at, updated_at) VALUES ('pa1', ?, 'Amy', 'did', 'presenter', 'p1', ?, ?)", ws, T(1), T(1));
  const sess = (id: string, state: string) => db.run("INSERT INTO avatar_sessions(id, workspace_id, call_id, avatar_id, provider, state, started_at) VALUES (?, ?, 'c1', 'pa1', 'did', ?, ?)", id, ws, state, T(1));
  await sess("s1", "live");
  await expect(sess("s2", "starting")).rejects.toThrow(/unique|UNIQUE/i);
  await sess("s3", "ended");
  const agents = await db.all<{ photoreal_avatar_id: string | null }>("SELECT photoreal_avatar_id FROM ai_agents");
  for (const a of agents) expect(a.photoreal_avatar_id).toBeNull();
}
describe("upgrade: photoreal avatars", () => {
  it("043 on SQLite", () => upgradeSqlite(42, "043_photoreal_avatar.sql", expectPhotorealMigration));
  it.skipIf(!postgres)("043 on PostgreSQL", () => upgradePostgres(42, "043_photoreal_avatar.sql", expectPhotorealMigration));
});

/** migration 044: transcript sends, one automatic copy per ticket */
async function expectTranscriptMigration(db: Db) {
  const ws = (await db.get<{ id: string }>("SELECT id FROM workspaces LIMIT 1"))!.id;
  const room = (await db.get<{ id: string; contact_id: string }>("SELECT id, contact_id FROM rooms LIMIT 1"))!;
  const add = (id: string, by: string, ticket: string | null) => db.run("INSERT INTO transcript_sends(id, workspace_id, room_id, ticket_id, contact_id, requested_by, to_hint, status, messages, created_at) VALUES (?,?,?,?,?,?,'a…@x.test','sent',3,?)", id, ws, room.id, ticket, room.contact_id, by, T(1));
  await add("t1", "after_resolve", "tk1");
  await expect(add("t2", "after_resolve", "tk1")).rejects.toThrow(/unique|UNIQUE/i);
  await add("t3", "visitor", "tk1");
  await add("t4", "visitor", "tk1");
  await expect(add("t5", "robot", null)).rejects.toThrow(/CHECK|check constraint/i);
  await db.run("DELETE FROM rooms WHERE id = ?", room.id);
  expect(await db.all("SELECT id FROM transcript_sends")).toEqual([]);
}
describe("upgrade: transcript sends", () => {
  it("044 on SQLite", () => upgradeSqlite(43, "044_transcript_sends.sql", expectTranscriptMigration));
  it.skipIf(!postgres)("044 on PostgreSQL", () => upgradePostgres(43, "044_transcript_sends.sql", expectTranscriptMigration));
});
