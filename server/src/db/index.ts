import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Param = SQLInputValue | boolean | undefined;

export interface Db {
  readonly raw: DatabaseSync;
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[];
  run(sql: string, ...params: Param[]): { changes: number };
  /** Runs fn inside a transaction (savepoint when nested). fn must be synchronous. */
  tx<T>(fn: () => T): T;
  close(): void;
}

const norm = (p: Param): SQLInputValue => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p);

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  const clean = <T>(row: unknown) => (row ? ({ ...(row as object) } as T) : undefined);
  return {
    raw,
    get: (sql, ...p) => clean(stmt(sql).get(...p.map(norm))),
    all: (sql, ...p) => stmt(sql).all(...p.map(norm)).map((r) => ({ ...r })) as never,
    run: (sql, ...p) => ({ changes: Number(stmt(sql).run(...p.map(norm)).changes) }),
    tx<T>(fn: () => T): T {
      const name = `sp_${depth}`;
      raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        depth--;
        raw.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
        return out;
      } catch (e) {
        depth--;
        raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    },
    close: () => raw.close(),
  };
}

export function migrate(db: Db, dir = resolve(dirname(fileURLToPath(import.meta.url)), "migrations")): string[] {
  db.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.all<{ name: string }>("SELECT name FROM _migrations").map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    db.tx(() => {
      db.raw.exec(readFileSync(resolve(dir, file), "utf8"));
      db.run("INSERT INTO _migrations(name, applied_at) VALUES (?, ?)", file, new Date().toISOString());
    });
    applied.push(file);
  }
  return applied;
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}
