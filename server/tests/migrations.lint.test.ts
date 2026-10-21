import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate, openDb, SQLITE_FK_OFF } from "../src/db/index.js";

/**
 * Static guard for the production failure "table sqlite_master may not be modified": SQLite builds with SQLITE_DBCONFIG_DEFENSIVE (the Node
 * image used on Render) refuse writable_schema and direct edits of the schema tables, and a fresh database never reaches such a statement, so
 * only a lint can catch it before a release (the upgrade tests in migrations.upgrade.test.ts cover the behaviour). See ADR 0023.
 */
const DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
const code = (f: string) =>
  readFileSync(join(DIR, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

describe("migration lint", () => {
  it("finds the migrations (guards against a wrong path making every check vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it.each(files)("%s never touches the schema tables or SQLite schema pragmas", (f) => {
    const sql = code(f);
    expect(sql, "writable_schema is forbidden in defensive mode").not.toMatch(/writable_schema/i);
    expect(sql, "sqlite_master / sqlite_schema must not be written").not.toMatch(/(update|insert\s+into|delete\s+from|replace\s+into)\s+(main\.)?"?sqlite_(temp_)?(master|schema)/i);
    expect(sql, "do not reference the schema tables at all in a migration").not.toMatch(/\bsqlite_(temp_)?(master|schema)\b/i);
    // PRAGMAs are the runner's job: foreign_keys cannot change inside the transaction the runner wraps a migration in (use the directive), and
    // schema_version / user_version / legacy_alter_table / trusted_schema / defensive edits are never needed by a portable migration.
    expect(sql, "no PRAGMA in a migration (use the -- @sqlite-foreign-keys-off directive)").not.toMatch(/\bpragma\b/i);
  });

  it("only .sqlite.sql files may carry the foreign-keys-off directive, and only on their first line", () => {
    for (const f of files) {
      const raw = readFileSync(join(DIR, f), "utf8");
      if (!raw.includes(SQLITE_FK_OFF)) continue;
      expect(f, `${f} uses the SQLite-only directive`).toMatch(/\.sqlite\.sql$/);
      expect(raw.startsWith(SQLITE_FK_OFF), `${f}: the directive must be the first line`).toBe(true);
    }
  });

  it("a SQLite migration that drops a table other tables reference must run with foreign keys off (else ON DELETE CASCADE deletes the children)", async () => {
    const db = await openDb(":memory:");
    await migrate(db);
    const parents = new Set(
      (await db.all<{ parent: string }>("SELECT DISTINCT f.\"table\" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'")).map((r) => r.parent),
    );
    await db.close();
    expect(parents.has("messages")).toBe(true);
    for (const f of files.filter((x) => !x.endsWith(".pg.sql"))) {
      const sql = code(f);
      for (const m of sql.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)) {
        if (!parents.has(m[1]!)) continue;
        expect(readFileSync(join(DIR, f), "utf8").startsWith(SQLITE_FK_OFF), `${f} drops ${m[1]}, which other tables reference: add ${SQLITE_FK_OFF} and verify with an upgrade test`).toBe(true);
      }
    }
  });

  it("every SQLite file that rebuilds a table (CREATE TABLE x_new ... RENAME TO x) uses the directive", () => {
    for (const f of files.filter((x) => !x.endsWith(".pg.sql"))) {
      if (/ALTER\s+TABLE\s+\w+\s+RENAME\s+TO\s+\w+/i.test(code(f)) && /DROP\s+TABLE/i.test(code(f))) expect(readFileSync(join(DIR, f), "utf8").startsWith(SQLITE_FK_OFF), f).toBe(true);
    }
  });
});
