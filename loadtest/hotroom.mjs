#!/usr/bin/env node
// Hot-room contention: how many messages/s can ONE room take vs many rooms, as concurrent writers grow.
//   node hotroom.mjs --writers 1,10,100,1000 --seconds 8 --out results/hotroom.json [--url postgres://...]
// Writers call the real service (sendAgentMessage): room row lock for `seq`, message insert, outbox row, summary update, all in one transaction.
// Per-room seq allocation is `UPDATE rooms SET next_seq = next_seq + 1 ... RETURNING`, so writers to one room serialise on that row lock.
import { writeFileSync } from "node:fs";
import os from "node:os";
import { SERVER_DIR, startPostgres } from "./lib/infra.mjs";

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, "")] = argv[i + 1];
const WRITERS = String(opt.writers ?? "1,10,100,1000").split(",").map(Number);
const SECS = Number(opt.seconds ?? 8);
const ROOMS_MANY = Number(opt.rooms ?? 20000);
const POOL = Number(opt.pool ?? 40);

const pgh = opt.url ? null : await startPostgres();
const url = opt.url ?? pgh.url;
const results = { date: new Date().toISOString(), machine: `${os.cpus()[0].model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, node ${process.version}`, pool: POOL, seconds_per_point: SECS, points: [] };
try {
  const { loadConfig } = await import(`${SERVER_DIR}/dist/config.js`);
  const { createContext, closeContext } = await import(`${SERVER_DIR}/dist/app-context.js`);
  const { register } = await import(`${SERVER_DIR}/dist/services/auth.js`);
  const { sendAgentMessage } = await import(`${SERVER_DIR}/dist/services/messages.js`);
  const { actorFromRow, getMember } = await import(`${SERVER_DIR}/dist/services/members.js`);
  const config = loadConfig({ NODE_ENV: "production", JWT_SECRET: "hotroom-secret-hotroom-secret", DATABASE_URL: url, DATABASE_POOL_MAX: String(POOL), DATA_DIR: os.tmpdir(), LOG_LEVEL: "error", RATE_LIMIT_SCALE: "100000", MESSAGE_HASH_PARTITIONS: "16", MESSAGE_PARTITION_MONTHS_AHEAD: "1" }, () => {});
  const ctx = await createContext(config);
  const reg = await register(ctx, { email: `hr${Date.now()}@load.test`, password: "hotroom-password-1", name: "Owner", workspace_name: "Hot Co" });
  const wsId = reg.workspace?.id ?? reg.member?.workspace_id;
  const memberId = reg.member?.id;
  const owner = actorFromRow(await getMember(ctx, wsId, memberId));
  // rooms: one hot room and many cold ones, created with SQL for speed
  const { default: pgmod } = await import((await import("node:module")).createRequire(`${SERVER_DIR}/package.json`).resolve("pg"));
  const c = new pgmod.Client({ connectionString: url });
  await c.connect();
  const now = new Date().toISOString();
  await c.query(`INSERT INTO contacts(id, workspace_id, name, email, phone, attrs, tags, created_at, updated_at) SELECT 'con_h' || lpad(g::text, 7, '0'), $1, 'P' || g, 'h' || g || '@x.test', '+1415' || (6000000 + g)::text, '{}', '[]', $2, $2 FROM generate_series(0, $3::int) g`, [wsId, now, ROOMS_MANY]);
  await c.query(`INSERT INTO rooms(id, workspace_id, contact_id, status, last_message_at, next_seq, last_message_seq, created_at, updated_at) SELECT 'room_h' || lpad(g::text, 7, '0'), $1, 'con_h' || lpad(g::text, 7, '0'), 'open', $2, 0, 0, $2, $2 FROM generate_series(0, $3::int) g`, [wsId, now, ROOMS_MANY]);
  await c.end();
  const rooms = Array.from({ length: ROOMS_MANY + 1 }, (_, i) => `room_h${String(i).padStart(7, "0")}`);
  const hot = rooms[0];

  async function run(writers, pick) {
    const lat = [];
    let ok = 0;
    let err = 0;
    let n = 0;
    const end = Date.now() + SECS * 1000;
    await Promise.all(
      Array.from({ length: writers }, async (_, w) => {
        while (Date.now() < end) {
          const room = pick(w);
          const t = process.hrtime.bigint();
          try {
            await sendAgentMessage(ctx, owner, room, { kind: "text", source: "dm", content: "load", client_msg_id: `hr-${w}-${n++}-${Math.random().toString(36).slice(2, 8)}` });
            ok++;
            lat.push(Number(process.hrtime.bigint() - t) / 1e6);
          } catch (e) {
            err++;
          }
        }
      }),
    );
    lat.sort((a, b) => a - b);
    const p = (q) => (lat.length ? Number(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1)) : null);
    return { msgs_per_s: Math.round(ok / SECS), p50_ms: p(0.5), p99_ms: p(0.99), errors: err };
  }
  for (const w of WRITERS) {
    const oneRoom = await run(w, () => hot);
    const manyRooms = await run(w, (i) => rooms[(i * 7919 + Math.floor(Math.random() * 100000)) % rooms.length]);
    const point = { writers: w, one_room: oneRoom, many_rooms: manyRooms };
    results.points.push(point);
    console.error(JSON.stringify(point));
  }
  await closeContext(ctx);
} catch (e) {
  results.error = String(e?.stack ?? e);
  process.exitCode = 1;
} finally {
  if (opt.out) writeFileSync(opt.out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (pgh) await pgh.stop();
  process.exit(process.exitCode ?? 0);
}
