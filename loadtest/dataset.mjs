#!/usr/bin/env node
// Load N message rows into a REAL PostgreSQL (the embedded PostgreSQL 17 binary, or --url for your own) using the app's own migrations and
// partitioned schema, then time and EXPLAIN the hot queries at that size.
//   node dataset.mjs --rows 50000000 --rooms 2500000 --out results/dataset.json [--url postgres://...] [--keep true]
// Guards: stops loading when free disk falls below --min-free-gb (default 8). Needs `npm run build --prefix ../server`.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { SERVER_DIR, startPostgres } from "./lib/infra.mjs";

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, "")] = argv[i + 1];
const ROWS = Number(opt.rows ?? 5_000_000);
const ROOMS = Number(opt.rooms ?? Math.max(1000, Math.floor(ROWS / 20)));
const MONTHS = Number(opt.months ?? 12);
const CHUNK = Number(opt.chunk ?? 1_000_000);
const MIN_FREE_GB = Number(opt["min-free-gb"] ?? 8);
const req = createRequire(`${SERVER_DIR}/package.json`);
const pgmod = (await import(req.resolve("pg"))).default;

const freeGb = (dir) => {
  const out = execFileSync("df", ["-k", dir]).toString().trim().split("\n").pop().split(/\s+/);
  return Number(out[3]) / 1024 / 1024;
};
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const pgHandle = opt.url ? null : await startPostgres();
const url = opt.url ?? pgHandle.url;
const results = { date: new Date().toISOString(), machine: `${os.cpus()[0].model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, node ${process.version}`, rows_target: ROWS, rooms: ROOMS, months: MONTHS, postgres: null };

try {
  // 1. schema: the app's own boot (migrations incl. partitioning), 16 hash partitions as in production
  const { loadConfig } = await import(`${SERVER_DIR}/dist/config.js`);
  const { createContext, closeContext } = await import(`${SERVER_DIR}/dist/app-context.js`);
  const config = loadConfig({ NODE_ENV: "production", JWT_SECRET: "dataset-secret-dataset-secret", DATABASE_URL: url, DATA_DIR: os.tmpdir(), LOG_LEVEL: "error", MESSAGE_HASH_PARTITIONS: "16", MESSAGE_PARTITION_MONTHS_AHEAD: "1" }, () => {});
  const ctx = await createContext(config);
  const { register } = await import(`${SERVER_DIR}/dist/services/auth.js`);
  const reg = await register(ctx, { email: `ds${Date.now()}@load.test`, password: "dataset-password-1", name: "Owner", workspace_name: "Dataset Co" });
  const wsId = reg.workspace?.id ?? reg.member?.workspace_id;
  await closeContext(ctx);

  const c = new pgmod.Client({ connectionString: url });
  await c.connect();
  results.postgres = (await c.query("SHOW server_version")).rows[0].server_version;
  await c.query("SET synchronous_commit = off");
  const q = async (sql, ...p) => (await c.query(sql, p)).rows;
  const memberId = (await q("SELECT id FROM members WHERE workspace_id = $1 LIMIT 1", wsId))[0].id;

  // 2. monthly partitions for the span we are about to fill
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (MONTHS - 1), 1));
  await q("SELECT conv_ensure_message_partitions($1::date, $2::date)", start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  const t0span = start.getTime();
  const span = end.getTime() - t0span;

  // bulk-load order: indexes are dropped for the load and rebuilt afterwards (sorted builds, in parallel, are an order of magnitude faster than 7 random insert paths per row)
  const deferIdx = opt["defer-indexes"] !== "false";
  const INDEXES = [
    "CREATE INDEX ix_messages_room_seq ON messages(room_id, seq)",
    "CREATE INDEX ix_messages_id ON messages(id)",
    "CREATE INDEX ix_messages_ws_time ON messages(workspace_id, created_at)",
    "CREATE INDEX ix_messages_created_brin ON messages USING BRIN (created_at)",
    "CREATE INDEX ix_messages_provider ON messages(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL",
    "CREATE INDEX ix_messages_rfc ON messages(workspace_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL",
    "CREATE INDEX ix_messages_delivery ON messages(delivery, source) WHERE delivery IN ('pending','sent')",
  ];
  if (deferIdx) for (const n of ["ix_messages_room_seq", "ix_messages_id", "ix_messages_ws_time", "ix_messages_created_brin", "ix_messages_provider", "ix_messages_rfc", "ix_messages_delivery"]) await q(`DROP INDEX ${n}`);
  await q("SET maintenance_work_mem = '1GB'");
  await q("SET max_parallel_maintenance_workers = 4");

  // 3. contacts and rooms
  log(`creating ${ROOMS} contacts and rooms`);
  const tRooms = Date.now();
  for (let a = 0; a < ROOMS; a += 500_000) {
    const b = Math.min(ROOMS, a + 500_000);
    await q(
      `INSERT INTO contacts(id, workspace_id, name, email, phone, attrs, tags, created_at, updated_at)
       SELECT 'con_' || lpad(g::text, 9, '0'), $1, 'Person ' || g, 'p' || g || '@example.test', '+1415' || (5550000 + g)::text, '{}', '[]', $2, $2 FROM generate_series($3::int, $4::int) g`,
      wsId, start.toISOString(), a, b - 1,
    );
    await q(
      `INSERT INTO rooms(id, workspace_id, contact_id, status, last_message_at, last_contact_message_at, next_seq, last_message_seq, created_at, updated_at)
       SELECT 'room_' || lpad(g::text, 9, '0'), $1, 'con_' || lpad(g::text, 9, '0'), CASE WHEN g % 7 = 0 THEN 'closed' ELSE 'open' END, $2, $2, 0, 0, $2, $2 FROM generate_series($3::int, $4::int) g`,
      wsId, start.toISOString(), a, b - 1,
    );
  }
  results.rooms_secs = (Date.now() - tRooms) / 1000;

  // 4. messages, in chunks: rows are spread over the months, per-room seq is contiguous, ~35% contact / 65% agent
  const perRoom = Math.ceil(ROWS / ROOMS);
  log(`loading ${ROWS} messages (${perRoom} per room) into ${MONTHS} months x 16 hash partitions`);
  const series = [];
  let loaded = 0;
  const tLoad = Date.now();
  const freeBefore = freeGb(os.tmpdir());
  const PAR = Number(opt.parallel ?? 4);
  const roomsPerChunk = Math.max(1, Math.floor(CHUNK / perRoom));
  let nextFrom = 0;
  let stop = false;
  const workers = [];
  for (let w = 0; w < PAR; w++) {
    const wc = new pgmod.Client({ connectionString: url });
    await wc.connect();
    await wc.query("SET synchronous_commit = off");
    workers.push(
      (async () => {
        while (!stop) {
          const from = nextFrom;
          if (from >= ROOMS) break;
          nextFrom += roomsPerChunk;
          const to = Math.min(ROOMS, from + roomsPerChunk);
          await wc.query(
            `INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, sender_id, sender_name, kind, source, content, content_text, created_at)
             SELECT 'msg_' || lpad(r::text, 9, '0') || lpad(s::text, 3, '0'), $1, 'room_' || lpad(r::text, 9, '0'), s,
                    CASE WHEN (r + s) % 3 = 0 THEN 'agent' ELSE 'contact' END, CASE WHEN (r + s) % 3 = 0 THEN $2 ELSE NULL END, CASE WHEN (r + s) % 3 = 0 THEN 'Agent' ELSE 'Contact' END,
                    'text', 'dm', 'message ' || s || ' in conversation ' || r || ' about order ' || (r % 9973), 'message ' || s || ' in conversation ' || r || ' about order ' || (r % 9973),
                    to_char(to_timestamp(($3::bigint + (((r::bigint * 7919 + s::bigint * 104729) % 1000003) * $4::bigint / 1000003)) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             FROM generate_series($5::int, $6::int) r, generate_series(1, $7::int) s`,
            [wsId, memberId, t0span, span, from, to - 1, perRoom],
          );
          loaded += (to - from) * perRoom;
          const secs = (Date.now() - tLoad) / 1000;
          series.push({ rows: loaded, secs: Math.round(secs) });
          if (series.length % 5 === 0) log(`${loaded.toLocaleString()} rows, ${Math.round(loaded / secs).toLocaleString()} rows/s overall, free disk ${freeGb(os.tmpdir()).toFixed(1)} GB`);
          if (freeGb(os.tmpdir()) < MIN_FREE_GB) {
            log(`free disk below ${MIN_FREE_GB} GB: stopping the load here`);
            results.stopped_for_disk = true;
            stop = true;
          }
        }
        await wc.end();
      })(),
    );
  }
  await Promise.all(workers);
  results.load_secs = (Date.now() - tLoad) / 1000;
  if (deferIdx) {
    log("rebuilding indexes");
    const ti = Date.now();
    for (const ddl of INDEXES) await q(ddl);
    results.index_build_secs = (Date.now() - ti) / 1000;
  }
  results.rows_loaded = loaded;
  results.rows_per_s_load_only = Math.round(loaded / results.load_secs);
  results.rows_per_s_incl_indexes = Math.round(loaded / (results.load_secs + (results.index_build_secs ?? 0)));
  results.load_series = series;
  // rooms that did not get messages (disk stop) are fine; fix counters for the ones that did
  await q("UPDATE rooms r SET next_seq = m.mx, last_message_seq = m.mx, last_message_id = m.lid, last_message_at = m.lat FROM (SELECT room_id, MAX(seq) mx, (array_agg(id ORDER BY seq DESC))[1] lid, MAX(created_at) lat FROM messages GROUP BY room_id) m WHERE m.room_id = r.id");
  log("analyze");
  await q("ANALYZE");
  results.disk_gb_used = Number((freeBefore - freeGb(os.tmpdir())).toFixed(2));
  results.bytes_per_row_incl_indexes = Math.round((results.disk_gb_used * 2 ** 30) / loaded);
  results.table_size = (await q("SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) s FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class p ON p.oid = i.inhparent WHERE c.relkind = 'r' AND p.relname LIKE 'messages_h%'"))[0].s;
  results.partitions = Number((await q("SELECT count(*) n FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class p ON p.oid = i.inhparent WHERE c.relkind = 'r' AND p.relname LIKE 'messages_h%'"))[0].n);

  // 5. the hot queries, timed (median of 30 runs after warm-up) and explained
  const hotRoom = `room_${String(Math.floor(ROOMS / 3)).padStart(9, "0")}`;
  const mid = (await q("SELECT id, seq FROM messages WHERE room_id = $1 ORDER BY seq OFFSET 5 LIMIT 1", hotRoom))[0];
  const queries = {
    "history page, newest 30": ["SELECT * FROM messages WHERE room_id = $1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 30", [hotRoom]],
    "history page, before a cursor": ["SELECT * FROM messages WHERE room_id = $1 AND deleted_at IS NULL AND seq < $2 ORDER BY seq DESC LIMIT 30", [hotRoom, mid.seq]],
    "unread count in one room": ["SELECT COUNT(*) FROM messages WHERE room_id = $1 AND seq > $2 AND deleted_at IS NULL AND kind NOT IN ('note','system') AND sender_type != 'system'", [hotRoom, 3]],
    "last message of a room": ["SELECT * FROM messages WHERE room_id = $1 AND deleted_at IS NULL AND kind != 'system' ORDER BY seq DESC LIMIT 1", [hotRoom]],
    "room list, newest 30 open (rooms table only, summaries denormalised)": ["SELECT r.*, c.name FROM rooms r JOIN contacts c ON c.id = r.contact_id WHERE r.workspace_id = $1 AND r.archived = 0 AND r.status = 'open' ORDER BY r.last_message_at DESC, r.id DESC LIMIT 30", [wsId]],
    "message by id (no room known: probes every partition)": ["SELECT * FROM messages WHERE id = $1", [mid.id]],
    "message by (room, id)": ["SELECT * FROM messages WHERE room_id = $1 AND id = $2", [hotRoom, mid.id]],
    "analytics: messages per day, workspace, last 7 days (index ws+time)": ["SELECT substr(created_at, 1, 10) d, COUNT(*) FROM messages WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1", [wsId, new Date(end.getTime() - 14 * 86400000).toISOString(), new Date(end.getTime() - 7 * 86400000).toISOString()]],
    "in-room search (ILIKE, one room)": ["SELECT id FROM messages WHERE room_id = $1 AND content_text ILIKE $2 LIMIT 20", [hotRoom, "%order 12%"]],
  };
  results.queries = {};
  const plans = [];
  for (const [name, [sql, params]] of Object.entries(queries)) {
    for (let i = 0; i < 5; i++) await q(sql, ...params);
    const times = [];
    for (let i = 0; i < 30; i++) {
      const t = process.hrtime.bigint();
      await q(sql, ...params);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    // the app names statements after a few uses, so planning is paid once per connection: time that path too
    const ptimes = [];
    const stmt = { name: `ds_${name.replace(/\W+/g, "_").slice(0, 40)}`, text: sql };
    for (let i = 0; i < 8; i++) await c.query({ ...stmt, values: params });
    for (let i = 0; i < 30; i++) {
      const t = process.hrtime.bigint();
      await c.query({ ...stmt, values: params });
      ptimes.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    ptimes.sort((a, b) => a - b);
    const plan = (await q(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) ${sql}`, ...params)).map((r) => r["QUERY PLAN"]).join("\n");
    const leaves = new Set([...plan.matchAll(/(?:Scan|Bitmap Heap Scan|Index Only Scan)[^\n]* on (messages_h\d+(?:_\w+)?)/g)].map((m) => m[1]));
    const hashParts = new Set([...leaves].map((l) => l.split("_").slice(0, 2).join("_")));
    results.queries[name] = { prepared_p50_ms: Number(ptimes[15].toFixed(2)), prepared_p99_ms: Number(ptimes[29].toFixed(2)), p50_ms: Number(times[15].toFixed(2)), p99_ms: Number(times[29].toFixed(2)), hash_partitions_touched: hashParts.size, leaves_touched: leaves.size, planning_ms: Number((plan.match(/Planning Time: ([\d.]+)/)?.[1]) ?? 0), execution_ms: Number((plan.match(/Execution Time: ([\d.]+)/)?.[1]) ?? 0) };
    plans.push(`### ${name}\n${sql}\n\n${plan}\n`);
    log(name, JSON.stringify(results.queries[name]));
  }
  writeFileSync(opt.out?.replace(/\.json$/, ".plans.txt") ?? "results/dataset.plans.txt", plans.join("\n"));
  await c.end();
} catch (e) {
  results.error = String(e?.stack ?? e);
  process.exitCode = 1;
} finally {
  if (opt.out) writeFileSync(opt.out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (pgHandle && opt.keep !== "true") await pgHandle.stop();
  process.exit(process.exitCode ?? 0);
}
