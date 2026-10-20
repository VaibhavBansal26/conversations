import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Param = SQLInputValue | boolean | undefined;
export type Dialect = "sqlite" | "postgres";

/**
 * The repository layer's one dependency. Both backends speak the same SQL subset (see docs/ARCHITECTURE.md, "Portable SQL"):
 * positional `?` placeholders, 0/1 integers instead of booleans, `ON CONFLICT`, `RETURNING`. Dialect differences are
 * exposed as small helpers (`ilike`, `forUpdate`, `jsonArrayHas`) instead of being scattered through the services.
 */
export interface Db {
  readonly dialect: Dialect;
  /** case-insensitive LIKE operator for this backend */
  readonly ilike: string;
  /** appended to a SELECT that must lock the row it reads (no-op on SQLite, whose writer lock already serialises) */
  readonly forUpdate: string;
  /** SQL fragment: does JSON-array column `col` contain the (bound) text value? Bind one parameter. */
  jsonArrayHas(col: string): string;
  /** number of statements executed so far (used by tests asserting bounded work) */
  readonly statements: number;
  /** test/diagnostic hook called with every statement before it runs */
  trace: ((sql: string, params: Param[]) => void) | null;
  /** The query plan for a statement (SQLite: EXPLAIN QUERY PLAN; PostgreSQL: EXPLAIN with sequential scans disabled so index availability is what is checked). */
  explain(sql: string, ...params: Param[]): Promise<string>;
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  /**
   * Runs fn in a transaction (a savepoint when nested). Every `get/all/run` made from fn's async call tree is routed to the
   * transaction's connection, so services just use `ctx.db` inside it.
   */
  tx<T>(fn: () => Promise<T> | T): Promise<T>;
  /**
   * A handle for queries that may be served by a read replica (history pages, lists, search, counts). Returns the primary itself when no
   * replica is configured, when called inside a transaction, shortly after this node wrote (read-your-writes), or while the replica is
   * lagging or unhealthy. Never use it for a read that feeds a write decision.
   */
  read(): Db;
  /** Run fn outside any ambient transaction (fire-and-forget background work must not inherit one). */
  detached<T>(fn: () => T): T;
  close(): Promise<void>;
}

const norm = (p: Param): SQLInputValue => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p);
const clean = <T>(row: unknown) => (row ? ({ ...(row as object) } as T) : undefined);

interface TxStore {
  active: boolean;
  depth: number;
  client?: pg.PoolClient;
}

/* ------------------------------------------------------------------ SQLite */

class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  readonly ilike = "LIKE";
  readonly forUpdate = "";
  statements = 0;
  trace: ((sql: string, params: Param[]) => void) | null = null;
  private readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private readonly als = new AsyncLocalStorage<TxStore>();
  /** Single connection: transactions are serialised with a promise-chain mutex and other statements wait for an open one. */
  private open: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  }

  jsonArrayHas(col: string) {
    return `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`;
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private async gate() {
    const st = this.als.getStore();
    if (!(st && st.active)) while (this.open) await this.open;
  }

  async explain(sql: string, ...p: Param[]) {
    return (this.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p.map(norm)) as { detail: string }[]).map((r) => r.detail).join("\n");
  }

  async get<T>(sql: string, ...p: Param[]) {
    await this.gate();
    this.statements++;
    this.trace?.(sql, p);
    return clean<T>(this.stmt(sql).get(...p.map(norm)));
  }
  async all<T>(sql: string, ...p: Param[]) {
    await this.gate();
    this.statements++;
    this.trace?.(sql, p);
    return this.stmt(sql)
      .all(...p.map(norm))
      .map((r) => ({ ...r })) as T[];
  }
  async run(sql: string, ...p: Param[]) {
    await this.gate();
    this.statements++;
    this.trace?.(sql, p);
    return { changes: Number(this.stmt(sql).run(...p.map(norm)).changes) };
  }
  async exec(sql: string) {
    await this.gate();
    this.raw.exec(sql);
  }

  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    const cur = this.als.getStore();
    if (cur?.active) {
      const name = `sp_${++cur.depth}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      try {
        const out = await fn();
        this.raw.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      } finally {
        cur.depth--;
      }
    }
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    const store: TxStore = { active: true, depth: 0 };
    this.open = this.tail;
    try {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const out = await this.als.run(store, async () => fn());
        this.raw.exec("COMMIT");
        return out;
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
    } finally {
      store.active = false;
      this.open = null;
      release();
    }
  }

  read(): Db {
    return this;
  }

  detached<T>(fn: () => T): T {
    return this.als.exit(fn);
  }

  async close() {
    this.raw.close();
  }
}

/* --------------------------------------------------------------- PostgreSQL */

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const cvt = new Map<string, string>();
/** `?` -> `$n` (outside string literals) and `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING`. */
export function toPg(sql: string): string {
  const hit = cvt.get(sql);
  if (hit) return hit;
  let out = "";
  let n = 0;
  let quote = false;
  for (const ch of sql) {
    if (ch === "'") quote = !quote;
    out += ch === "?" && !quote ? `$${++n}` : ch;
  }
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO").replace(/;?\s*$/, " ON CONFLICT DO NOTHING");
  cvt.set(sql, out);
  return out;
}

class PgDb implements Db {
  readonly dialect = "postgres" as const;
  readonly ilike = "ILIKE";
  readonly forUpdate = " FOR NO KEY UPDATE"; // self-conflicting, but compatible with the FOR KEY SHARE locks foreign-key inserts take on the same row
  statements = 0;
  trace: ((sql: string, params: Param[]) => void) | null = null;
  private readonly pool: pg.Pool;
  private readonly seen = new Map<string, number>();
  private readonly als = new AsyncLocalStorage<TxStore>();
  private readonly pgbouncer: boolean;
  private replica: pg.Pool | null = null;
  private replicaView: ReplicaView | null = null;
  private lastWriteAt = 0;
  private replicaLagMs = 0;
  private replicaDownUntil = 0;
  private lagTimer?: ReturnType<typeof setInterval>;
  private readonly readAfterWriteMs: number;
  private readonly maxLagMs: number;
  /** counters for metrics and tests */
  readonly reads = { replica: 0, primary: 0 };

  constructor(url: string, max: number, o: PgOptions = {}) {
    this.pgbouncer = !!o.pgbouncer;
    this.readAfterWriteMs = o.readAfterWriteMs ?? 1500;
    this.maxLagMs = o.replicaMaxLagMs ?? 1000;
    // counts and sums come back as bigint/numeric strings; every number we store is far below 2^53
    pg.types.setTypeParser(20, (v) => Number(v));
    pg.types.setTypeParser(1700, (v) => Number(v));
    this.pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", () => {
      /* idle client errors must not crash the process; the next query reports the problem */
    });
    if (o.replicaUrl) {
      this.replica = new pg.Pool({ connectionString: o.replicaUrl, max: o.replicaPoolMax ?? max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3000 });
      this.replica.on("error", () => {});
      this.replicaView = new ReplicaView(this, this.replica, (sql, values) => this.prep(sql, values));
      const probe = o.lagProbe ?? (() => this.probeLag());
      const tick = async () => {
        try {
          this.replicaLagMs = await probe();
          this.replicaDownUntil = 0;
        } catch {
          this.replicaDownUntil = Date.now() + 5000;
        }
      };
      void tick();
      this.lagTimer = setInterval(() => void tick(), o.lagProbeMs ?? 2000);
      this.lagTimer.unref();
    }
  }

  /** replica lag in ms: 0 when it has replayed everything it received, otherwise the age of the last replayed transaction */
  private async probeLag(): Promise<number> {
    const r = await this.replica!.query("SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0 ELSE COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, 0) END AS lag");
    return Number(r.rows[0]?.lag ?? 0);
  }

  read(): Db {
    const inTx = !!this.als.getStore()?.active;
    if (!this.replicaView || inTx || Date.now() < this.replicaDownUntil || this.replicaLagMs > this.maxLagMs || Date.now() - this.lastWriteAt < this.readAfterWriteMs) {
      this.reads.primary++;
      return this;
    }
    this.reads.replica++;
    return this.replicaView;
  }

  /** replica health and lag, for /readyz and metrics */
  replicaStatus() {
    return this.replica ? { lagMs: this.replicaLagMs, healthy: Date.now() >= this.replicaDownUntil } : null;
  }

  /** the statement as it will be sent (named after a few uses), shared by primary and replica paths */
  prep(sql: string, values: unknown[]) {
    const n = (this.seen.get(sql) ?? 0) + 1;
    if (this.seen.size < 2000) this.seen.set(sql, n);
    const text = toPg(sql);
    // PgBouncer in transaction mode hands every statement to whichever server connection is free, so a connection-scoped named statement may not exist there
    if (!this.pgbouncer && n >= 5 && !/IN \(\$/.test(text)) return { name: `s${hash(sql)}`, text, values: values as never[] };
    return { text, values: values as never[] };
  }

  jsonArrayHas(col: string) {
    return `EXISTS (SELECT 1 FROM jsonb_array_elements_text((${col})::jsonb) AS je(value) WHERE je.value = ?)`;
  }

  private target() {
    const st = this.als.getStore();
    return st?.active && st.client ? st.client : this.pool;
  }

  /**
   * Statements that keep recurring become named prepared statements (parsed and planned once per connection). Dynamic SQL with
   * variable-length IN lists is never named, since every list length would otherwise create a new prepared statement.
   */
  private async query(sql: string, p: Param[]) {
    this.statements++;
    this.trace?.(sql, p);
    const values = p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as never)));
    if (!/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(sql)) this.lastWriteAt = Date.now();
    return this.target().query(this.prep(sql, values));
  }

  async explain(sql: string, ...p: Param[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const r = await client.query(`EXPLAIN ${toPg(sql)}`, p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as never))));
      await client.query("ROLLBACK");
      return (r.rows as { "QUERY PLAN": string }[]).map((x) => x["QUERY PLAN"]).join("\n");
    } finally {
      client.release();
    }
  }

  async get<T>(sql: string, ...p: Param[]) {
    const r = await this.query(sql, p);
    return clean<T>(r.rows[0]);
  }
  async all<T>(sql: string, ...p: Param[]) {
    return (await this.query(sql, p)).rows as T[];
  }
  async run(sql: string, ...p: Param[]) {
    return { changes: (await this.query(sql, p)).rowCount ?? 0 };
  }
  async exec(sql: string) {
    await this.target().query(sql);
  }

  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    const cur = this.als.getStore();
    if (cur?.active && cur.client) {
      const name = `sp_${++cur.depth}`;
      await cur.client.query(`SAVEPOINT ${name}`);
      try {
        const out = await fn();
        await cur.client.query(`RELEASE ${name}`);
        return out;
      } catch (e) {
        await cur.client.query(`ROLLBACK TO ${name}`);
        await cur.client.query(`RELEASE ${name}`);
        throw e;
      } finally {
        cur.depth--;
      }
    }
    const client = await this.pool.connect();
    const store: TxStore = { active: true, depth: 0, client };
    let broken = false;
    try {
      await client.query("BEGIN");
      try {
        const out = await this.als.run(store, async () => fn());
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => (broken = true));
        throw e;
      }
    } finally {
      store.active = false;
      client.release(broken);
    }
  }

  detached<T>(fn: () => T): T {
    return this.als.exit(fn);
  }

  async close() {
    if (this.lagTimer) clearInterval(this.lagTimer);
    await this.replica?.end();
    await this.pool.end();
  }
}

export interface PgOptions {
  /** transaction-mode PgBouncer in front: no named prepared statements, no session state */
  pgbouncer?: boolean;
  replicaUrl?: string;
  replicaPoolMax?: number;
  /** after this node writes, reads stay on the primary this long */
  readAfterWriteMs?: number;
  /** reads go to the primary while the replica lags more than this */
  replicaMaxLagMs?: number;
  lagProbeMs?: number;
  /** override the lag measurement (tests) */
  lagProbe?: () => Promise<number>;
}

/** Read-only view served by the replica pool. Anything that is not a plain read is refused. */
class ReplicaView implements Db {
  readonly dialect = "postgres" as const;
  readonly ilike = "ILIKE";
  readonly forUpdate = "";
  constructor(
    private readonly primary: PgDb,
    private readonly pool: pg.Pool,
    private readonly prep: (sql: string, values: unknown[]) => { name?: string; text: string; values: never[] },
  ) {}
  get statements() {
    return this.primary.statements;
  }
  trace: ((sql: string, params: Param[]) => void) | null = null;
  jsonArrayHas(col: string) {
    return this.primary.jsonArrayHas(col);
  }
  explain(sql: string, ...p: Param[]) {
    return this.primary.explain(sql, ...p);
  }
  private async q(sql: string, p: Param[]): Promise<{ rows: unknown[] }> {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("the read replica view only runs SELECT statements");
    const values = p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as never)));
    try {
      return await this.pool.query(this.prep(sql, values));
    } catch (e) {
      // a replica that errors (restart, failover, conflict with recovery) must not fail the request: serve it from the primary
      if (/connect|terminat|recovery|ECONN|timeout/i.test((e as Error).message)) return { rows: await this.primary.all(sql, ...p) };
      throw e;
    }
  }
  async get<T>(sql: string, ...p: Param[]) {
    const r = await this.q(sql, p);
    return clean<T>(r.rows[0]);
  }
  async all<T>(sql: string, ...p: Param[]) {
    return (await this.q(sql, p)).rows as T[];
  }
  async run(): Promise<{ changes: number }> {
    throw new Error("the read replica view is read-only");
  }
  async exec(): Promise<void> {
    throw new Error("the read replica view is read-only");
  }
  tx<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.primary.tx(fn);
  }
  detached<T>(fn: () => T): T {
    return this.primary.detached(fn);
  }
  read(): Db {
    return this;
  }
  async close() {}
}

export interface DbOptions {
  /** `postgres://...` selects PostgreSQL; otherwise a SQLite file path (or ":memory:") */
  url?: string;
  path?: string;
  poolMax?: number;
  pgbouncer?: boolean;
  replicaUrl?: string;
  replicaMaxLagMs?: number;
  readAfterWriteMs?: number;
}

export async function openDb(o: DbOptions | string): Promise<Db> {
  const opts: DbOptions = typeof o === "string" ? { path: o } : o;
  if (opts.url && /^postgres(ql)?:\/\//.test(opts.url)) return new PgDb(opts.url, opts.poolMax ?? 10, { pgbouncer: opts.pgbouncer, replicaUrl: opts.replicaUrl, replicaMaxLagMs: opts.replicaMaxLagMs, readAfterWriteMs: opts.readAfterWriteMs });
  return new SqliteDb(opts.path ?? ":memory:");
}

/** Applies `migrations/*.sql` once each. On PostgreSQL a transaction-scoped advisory lock makes concurrent boots of several nodes safe. */
export async function migrate(db: Db, dir = resolve(dirname(fileURLToPath(import.meta.url)), "migrations"), opts: { hashPartitions?: number } = {}): Promise<string[]> {
  return db.tx(async () => {
    if (db.dialect === "postgres") {
      await db.exec("SELECT pg_advisory_xact_lock(727274)");
      if (opts.hashPartitions) await db.exec(`SELECT set_config('conv.hash_partitions', '${Math.trunc(opts.hashPartitions)}', true)`);
    }
    await db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set((await db.all<{ name: string }>("SELECT name FROM _migrations")).map((r) => r.name));
    const applied: string[] = [];
    // `NNN_name.sql` applies everywhere; `NNN_name.pg.sql` / `NNN_name.sqlite.sql` only on that dialect (a name is recorded once either way)
    const other = db.dialect === "postgres" ? ".sqlite.sql" : ".pg.sql";
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && !f.endsWith(other))
      .sort()) {
      if (done.has(file)) continue;
      await db.exec(readFileSync(resolve(dir, file), "utf8"));
      await db.run("INSERT INTO _migrations(name, applied_at) VALUES (?, ?)", file, new Date().toISOString());
      applied.push(file);
    }
    return applied;
  });
}

export function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(e.message) || (e as { code?: string }).code === "23505";
}
