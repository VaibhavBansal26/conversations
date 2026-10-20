#!/usr/bin/env node
// Scenario runner. `node run.mjs <scenario> [--key value ...]`; results print as JSON and optionally go to --out file.
// Needs the server built:  npm run build --prefix server   and  npm install  in this directory.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import autocannon from "autocannon";
import { createVisitors, createWorkspace, json, ORIGIN } from "./lib/bootstrap.mjs";
import { Fleet, scrape } from "./lib/fleet.mjs";
import { startStack } from "./lib/infra.mjs";
import { postLoad } from "./lib/post-load.mjs";
import { ResourceSampler, sleep } from "./lib/stats.mjs";

const [scenario, ...argv] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, "")] = argv[i + 1];
const num = (k, d) => (opt[k] != null ? Number(opt[k]) : d);

const cfg = {
  nodes: num("nodes", 1),
  conns: num("conns", 2000),
  agents: num("agents", 5),
  workers: num("workers", 4),
  rate: num("rate", 50), // messages per second, total, from visitors
  duration: num("duration", 30), // seconds of traffic
  connectRate: num("connect-rate", 400),
  bytes: num("bytes", 64),
  db: opt.db, // sqlite | postgres (default: sqlite for 1 node, postgres for more)
  redis: opt.redis != null ? opt.redis === "true" : undefined,
};

const machine = `${os.cpus()[0].model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.platform()} ${os.release()}, node ${process.version}`;
const numFiles = () => { try { return Number(execFileSync("sysctl", ["-n", "kern.num_files"], { encoding: "utf8" })); } catch { return null; } };
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function setup(extraEnv = {}) {
  const stack = await startStack({ nodes: cfg.nodes, db: cfg.db, redis: cfg.redis, env: extraEnv });
  log(`stack up: ${stack.urls.join(" ")} db=${stack.postgres ? "postgres" : "sqlite"} redis=${!!stack.redis}`);
  const ws = await createWorkspace(stack.urls[0]);
  return { stack, ws };
}

function makeItems({ stack, ws, visitors, agents, agentNode = 0 }) {
  const urls = stack.urls;
  const items = [];
  const rooms = visitors.map((v) => v.roomId);
  for (let i = 0; i < agents; i++) items.push({ kind: "team", urls: urls.length > 1 ? urls : undefined, url: urls[agentNode % urls.length], wsId: ws.wsId, token: ws.ownerToken, rooms });
  const visitorUrls = urls.length > 1 && agents > 0 ? urls.filter((_, i) => i !== agentNode % urls.length) : urls;
  visitors.forEach((v, i) => items.push({ kind: "visitor", urls: urls.length > 1 ? urls : undefined, url: visitorUrls[i % visitorUrls.length], wsId: ws.wsId, session: v.session, device: v.device, rooms: [v.roomId] }));
  return items;
}

async function sampleNodes(stack, fleet) {
  const sampler = new ResourceSampler([...stack.nodes.map((n) => ({ name: n.name, pid: n.pid })), ...(stack.redis ? [{ name: "redis", pid: stack.redis.pid }] : []), ...fleet.pids()]);
  sampler.start();
  return sampler;
}

const scrapeAll = async (stack) => Object.fromEntries(await Promise.all(stack.nodes.map(async (n) => [n.name, await scrape(n.url)])));

async function bootstrapVisitors(stack, ws, count, tag) {
  log(`creating ${count} visitor sessions + rooms over REST...`);
  const t0 = Date.now();
  const r = await createVisitors({ urls: stack.urls, embedToken: ws.embedToken, count, prefix: tag, onProgress: (i) => i && log(`  ${i}/${count}`) });
  log(`created ${r.visitors.length} (${r.failures} failed) in ${((Date.now() - t0) / 1000).toFixed(1)}s = ${Math.round(r.visitors.length / ((Date.now() - t0) / 1000))}/s`);
  return r;
}

/** This harness shares the box with the generators, the DB and Redis, so a busy machine ruins a measurement. Wait for a quiet moment and record the load average either way. */
async function waitQuiet() {
  const limit = num("quiet-load", 6);
  const until = Date.now() + num("quiet-wait", 300) * 1000;
  while (os.loadavg()[0] > limit && Date.now() < until) {
    log(`machine busy (load ${os.loadavg()[0].toFixed(1)} > ${limit}); waiting`);
    await sleep(10000);
  }
  results.load_avg_at_start = os.loadavg().map((x) => Number(x.toFixed(1)));
}

const results = { scenario, date: new Date().toISOString(), machine, config: cfg };
let cleanup = [];

async function main() {
  await waitQuiet();
  const fns = { ramp, fanout, storm, slow, multinode, soak, idempotency, rest, drain, fault, roomsize };
  if (!fns[scenario]) throw new Error(`unknown scenario "${scenario}". one of: ${Object.keys(fns).join(", ")}`);
  await fns[scenario]();
}

/* ---- scenarios ---- */

async function ramp() {
  const { stack, ws } = await setup();
  cleanup.push(() => stack.stop());
  const { visitors, failures } = await bootstrapVisitors(stack, ws, cfg.conns, "ramp");
  const fleet = new Fleet(cfg.workers);
  await fleet.start();
  cleanup.push(() => fleet.close());
  const sampler = await sampleNodes(stack, fleet);
  const steps = [];
  const items = makeItems({ stack, ws, visitors, agents: 0 });
  const stepSize = Math.max(500, Math.floor(items.length / 10));
  let connectedAt = Date.now();
  for (let i = 0; i < items.length; i += stepSize) {
    const t0 = Date.now();
    await fleet.connect(items.slice(i, i + stepSize), cfg.connectRate);
    await sleep(1500);
    const s = await fleet.stats();
    const srv = await scrapeAll(stack);
    steps.push({ target: Math.min(items.length, i + stepSize), open: s.open, errors: s.connectErrors, connect_p50_ms: s.connect.p50, connect_p99_ms: s.connect.p99, step_secs: Math.round((Date.now() - t0) / 1000), loop_lag_p99_ms: Math.max(...Object.values(srv).map((x) => Math.round(x?.loopLagP99Ms ?? 0))) });
    log(`step ${steps.at(-1).target}: open=${s.open} errors=${s.connectErrors} p99=${s.connect.p99}ms`);
  }
  // sockets that failed to connect keep retrying with jittered backoff; give them time and record how long the tail takes
  const settleStart = Date.now();
  let final = await fleet.stats();
  const atRamp = { open: final.open, errors: final.connectErrors };
  while (final.open < items.length && Date.now() - settleStart < 60000) {
    await sleep(2000);
    final = await fleet.stats();
  }
  results.settle = { open_at_end_of_ramp: atRamp.open, open_after_settle: final.open, settle_secs: Math.round((Date.now() - settleStart) / 1000), kern_num_files_with_all_open: numFiles(), kern_maxfiles: Number(execFileSync("sysctl", ["-n", "kern.maxfiles"], { encoding: "utf8" })) };
  results.bootstrap_failures = failures;
  results.steps = steps;
  results.final = { open: final.open, target: items.length, connect_errors: final.connectErrors, error_kinds: final.connectErrorSamples, connect: final.connect };
  results.server = await scrapeAll(stack);
  results.resources = sampler.report();
  sampler.stop();
  results.ramp_total_secs = Math.round((Date.now() - connectedAt) / 1000);
}

async function traffic({ stack, ws, fleet, seconds, rate }) {
  await fleet.all({ cmd: "send", ratePerSec: rate / cfg.workers, bytes: cfg.bytes, kindFilter: "visitor" });
  await sleep(seconds * 1000);
  await fleet.all({ cmd: "stopSend" });
  await sleep(2000);
}

async function steady(opts = {}) {
  const { stack, ws } = await setup(opts.env ?? {});
  cleanup.push(() => stack.stop());
  const { visitors } = await bootstrapVisitors(stack, ws, cfg.conns, opts.tag ?? "st");
  const fleet = new Fleet(cfg.workers);
  await fleet.start();
  cleanup.push(() => fleet.close());
  const items = makeItems({ stack, ws, visitors, agents: cfg.agents, agentNode: opts.agentNode ?? 0 });
  // agents first so they are subscribed before traffic
  await fleet.connect(items, cfg.connectRate);
  await sleep(2000);
  const s = await fleet.stats();
  log(`connected ${s.open}/${items.length}, errors ${s.connectErrors}`);
  const sampler = await sampleNodes(stack, fleet);
  return { stack, ws, fleet, visitors, items, sampler };
}

async function finish(ctx, extra = {}) {
  await sleep(2000);
  const fin = await ctx.fleet.stats();
  ctx.sampler.stop();
  results.final = { ...fin, ...extra };
  results.server = await scrapeAll(ctx.stack);
  results.resources = ctx.sampler.report();
  const expectedTeam = fin.sendOk * cfg.agents;
  results.delivery_check = {
    sent_acked: fin.sendOk,
    send_errors: fin.sendErr,
    agent_sockets: cfg.agents,
    expected_agent_deliveries: expectedTeam,
    actual_agent_deliveries: fin.recvTeam,
    agent_delivery_ratio: expectedTeam ? Number((fin.recvTeam / expectedTeam).toFixed(5)) : null,
    seq_gaps: fin.gap,
    seq_missing_msgs: fin.gapMsgs,
    duplicates: fin.dup,
  };
}

async function fanout() {
  const ctx = await steady();
  results.connected = (await ctx.fleet.stats()).open;
  await traffic({ ...ctx, seconds: cfg.duration, rate: cfg.rate });
  await finish(ctx);
}

async function multinode() {
  if (cfg.nodes < 2) cfg.nodes = 3;
  const ctx = await steady({ agentNode: 0, tag: "mn" });
  results.note = "agents are connected to node0 only; visitors only to the other nodes, so every delivery crosses the Redis adapter";
  await traffic({ ...ctx, seconds: cfg.duration, rate: cfg.rate });
  await finish(ctx);
}

async function storm() {
  const ctx = await steady({ tag: "storm" });
  const total = (await ctx.fleet.stats()).open;
  await ctx.fleet.all({ cmd: "send", ratePerSec: cfg.rate / cfg.workers, bytes: cfg.bytes, kindFilter: "visitor" });
  await sleep(5000);
  await ctx.fleet.stats(true);
  const t0 = Date.now();
  const dropped = (await ctx.fleet.all({ cmd: "drop", fraction: 0.5, kind: "visitor" })).reduce((a, r) => a + r.dropped, 0);
  log(`dropped ${dropped} visitor sockets abruptly`);
  let recoveredAt = null;
  const curve = [];
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const s = await ctx.fleet.stats();
    curve.push({ t: i + 1, open: s.open });
    if (recoveredAt == null && s.open >= total * 0.99) recoveredAt = (Date.now() - t0) / 1000;
    if (recoveredAt != null && i > recoveredAt + 3) break;
  }
  await ctx.fleet.all({ cmd: "stopSend" });
  await sleep(3000);
  await ctx.fleet.all({ cmd: "audit" });
  await finish(ctx, { dropped, secs_to_99pct_reconnected: recoveredAt });
  results.recovery_curve = curve.filter((_, i) => i % 3 === 0);
  results.storm = {
    dropped,
    secs_to_99pct_reconnected: recoveredAt,
    messages_missed_while_down_then_recovered_via_resync: results.final.recovered,
    still_missing_after_resync_audit: results.final.auditMissing,
    resync_requests: results.final.resyncRequests,
    resync_failed: results.final.resyncFailed,
  };
}

async function slow() {
  const ctx = await steady({ tag: "slow", env: { WS_MAX_WRITE_BUFFER: "200" } });
  const paused = (await ctx.fleet.all({ cmd: "pause", n: Math.ceil(cfg.agents / 2) / cfg.workers + 1 })).reduce((a, r) => a + r.paused, 0);
  log(`paused reading on ${paused} agent sockets (TCP receive stops; the server write queue fills)`);
  const before = await scrapeAll(ctx.stack);
  cfg.bytes = Math.max(cfg.bytes, 1024);
  await traffic({ ...ctx, seconds: cfg.duration, rate: cfg.rate });
  await finish(ctx);
  results.slow = { paused_sockets: paused, server_before: before, slow_consumer_disconnects: Object.values(results.server).reduce((a, s) => a + (s?.slowDisconnects ?? 0), 0) };
  results.note = "delivery ratio is expected to be < 1 here: the paused sockets are the ones that are dropped. delivery latency p99 of the healthy sockets is the signal that matters";
}

async function soak() {
  const ctx = await steady({ tag: "soak" });
  const secs = num("duration", 600);
  const series = [];
  await ctx.fleet.all({ cmd: "send", ratePerSec: cfg.rate / cfg.workers, bytes: cfg.bytes, kindFilter: "visitor" });
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < secs) {
    await sleep(Math.min(30000, secs * 1000 - (Date.now() - t0)));
    const srv = await scrapeAll(ctx.stack);
    const s = await ctx.fleet.stats(true);
    const rep = ctx.sampler.report();
    series.push({ t: Math.round((Date.now() - t0) / 1000), open: s.open, delivery_p99_ms: s.delivery.p99, loop_lag_p99_ms: Math.round(Math.max(...Object.values(srv).map((x) => x?.loopLagP99Ms ?? 0))), rss_mb: Object.fromEntries(Object.entries(rep).filter(([k]) => k.startsWith("node")).map(([k, v]) => [k, v.rss_peak_mb])), gaps: s.gap, dups: s.dup });
    ctx.sampler.reset();
    log(JSON.stringify(series.at(-1)));
  }
  await ctx.fleet.all({ cmd: "stopSend" });
  results.series = series;
  await finish(ctx);
}

async function idempotency() {
  const { stack, ws } = await setup();
  cleanup.push(() => stack.stop());
  const { visitors } = await createVisitors({ urls: stack.urls, embedToken: ws.embedToken, count: 20, prefix: "idem" });
  const unique = 50;
  const dupes = 10;
  const jobs = [];
  let k = 0;
  for (const v of visitors) for (let u = 0; u < unique; u++) for (let d = 0; d < dupes; d++) jobs.push({ v, u, base: stack.urls[k++ % stack.urls.length] });
  // duplicates of the same id are adjacent in `jobs`, so with 64 in flight they genuinely race (also across nodes)
  const statuses = [];
  let at = 0;
  await Promise.all(
    Array.from({ length: 64 }, async () => {
      while (at < jobs.length) {
        const { v, u, base } = jobs[at++];
        const r = await fetch(`${base}/public/rooms/${v.roomId}/messages`, {
          method: "POST",
          headers: { "x-support-session": v.session, "x-device-id": v.device, origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ content: `m${u}`, client_msg_id: `idem-msg-${u}` }),
        });
        statuses.push(r.status);
        await r.arrayBuffer();
      }
    }),
  );
  const sends = jobs;
  const byStatus = {};
  for (const s of statuses) byStatus[s] = (byStatus[s] ?? 0) + 1;
  let stored = 0;
  let seqOk = true;
  for (const v of visitors) {
    const rows = [];
    let before = null;
    for (;;) {
      const r = await json(`${stack.urls[0]}/public/rooms/${v.roomId}/messages?limit=50${before ? `&before=${before}` : ""}`, { headers: { "x-support-session": v.session, "x-device-id": v.device, origin: ORIGIN } });
      const page = r.data ?? r.messages ?? [];
      rows.push(...page);
      if (page.length < 50) break;
      before = page[0].id;
    }
    const mine = rows.filter((m) => m.sender?.type === "contact" || m.sender_type === "contact");
    stored += mine.length;
    const seqs = rows.map((m) => m.seq).sort((a, b) => a - b);
    if (seqs.some((s, i) => i && s !== seqs[i - 1] + 1)) seqOk = false;
  }
  results.idempotency = { rooms: visitors.length, unique_messages_per_room: unique, duplicate_sends_each: dupes, requests: sends.length, nodes: stack.urls.length, http_status: byStatus, stored_messages: stored, expected_messages: visitors.length * unique, exactly_once: stored === visitors.length * unique, per_room_seq_contiguous: seqOk };
}

async function rest() {
  const { stack, ws } = await setup();
  cleanup.push(() => stack.stop());
  const { visitors } = await bootstrapVisitors(stack, ws, cfg.conns, "rest");
  // give rooms some messages so list/detail queries are realistic
  {
    // modest concurrency: this Mac's listen backlog (kern.ipc.somaxconn=128) resets bursts of hundreds of simultaneous connects
    const seed = visitors.slice(0, 500);
    let at = 0;
    await Promise.all(
      Array.from({ length: 32 }, async () => {
        while (at < seed.length) {
          const v = seed[at++];
          const r = await fetch(`${stack.urls[0]}/public/rooms/${v.roomId}/messages`, { method: "POST", headers: { "x-support-session": v.session, "x-device-id": v.device, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ content: "hello", client_msg_id: "seed-msg-1" }) });
          await r.arrayBuffer();
        }
      }),
    );
  }
  const auth = { authorization: `Bearer ${ws.ownerToken}` };
  const base = stack.urls[0];
  const room = visitors[0].roomId;
  const only = (key) => !opt.only || opt.only === key;
  const run = (title, o) =>
    new Promise((resolve) => {
      const inst = autocannon({ url: base, connections: num("connections", 64), duration: num("duration", 10), ...o }, (err, r) => resolve({ title, req_per_sec: Math.round(r.requests.average), p50_ms: r.latency.p50, p99_ms: r.latency.p99, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts }));
      void inst;
    });
  const sampler = new ResourceSampler(stack.nodes.map((n) => ({ name: n.name, pid: n.pid })));
  sampler.start();
  const out = [];
  if (only("list")) out.push(await run("GET /api/rooms?limit=30 (inbox list, keyset)", { requests: [{ method: "GET", path: "/api/rooms?limit=30", headers: auth }] }));
  if (only("counts")) out.push(await run("GET /api/dashboard/counts (cached)", { requests: [{ method: "GET", path: "/api/dashboard/counts", headers: auth }] }));
  if (only("thread")) out.push(await run(`GET /api/rooms/:id/messages (thread)`, { requests: [{ method: "GET", path: `/api/rooms/${room}/messages?limit=30`, headers: auth }] }));
  if (only("contacts")) out.push(await run("GET /api/contacts?limit=30", { requests: [{ method: "GET", path: "/api/contacts?limit=30", headers: auth }] }));
  const hv = { "x-support-session": visitors[0].session, "x-device-id": visitors[0].device, origin: ORIGIN, "content-type": "application/json" };
  if (only("post")) out.push({ title: "POST visitor message (write path: insert + seq + fan-out)", ...(await postLoad({ url: `${base}/public/rooms/${room}/messages`, headers: hv, bodyFor: (i) => JSON.stringify({ content: "load", client_msg_id: `pl-${Date.now()}-${i}` }), connections: num("connections", 64), seconds: num("duration", 10) })) });
  sampler.stop();
  results.rest = out;
  results.resources = sampler.report();
  results.dataset = { rooms: visitors.length, db: stack.postgres ? "postgres" : "sqlite" };
}

async function drain() {
  // rolling restart under load: stop node0 with SIGTERM while sockets are connected and traffic flows; clients must come back via the other nodes
  if (cfg.nodes < 2) cfg.nodes = 2;
  const ctx = await steady({ tag: "drain", agentNode: 1 });
  await ctx.fleet.all({ cmd: "send", ratePerSec: cfg.rate / cfg.workers, bytes: cfg.bytes, kindFilter: "visitor" });
  await sleep(3000);
  const before = (await ctx.fleet.stats()).open;
  const node0 = ctx.stack.nodes[0];
  const t0 = Date.now();
  node0.proc.kill("SIGTERM");
  await new Promise((r) => node0.proc.once("exit", r));
  const exitMs = Date.now() - t0;
  await sleep(1000);
  // clients that were on node0 reconnect (their URL is node0, which is gone): point out that production uses a balancer. Here we measure the drain itself.
  const mid = await ctx.fleet.stats();
  await ctx.fleet.all({ cmd: "stopSend" });
  await finish(ctx);
  results.drain = { open_before: before, open_after_node0_exit: mid.open, node0_exit_ms: exitMs, drain_events_received_by_clients: mid.drained, note: "node0 clients were told server:draining with a jittered reconnect delay; in this harness they have no balancer to fail over to, so they keep retrying node0" };
}

/** Fault under load with end-to-end verification: nothing lost, nothing stored twice, nothing out of order. --fault node-kill|redis-restart|pg-freeze */
async function fault() {
  const kind = opt.fault ?? "node-kill";
  if (cfg.nodes < 3) cfg.nodes = 3;
  const ctx = await steady({ tag: "fault", agentNode: 0, env: {} });
  const total0 = (await ctx.fleet.stats()).open;
  await ctx.fleet.all({ cmd: "send", ratePerSec: cfg.rate / cfg.workers, bytes: cfg.bytes, kindFilter: "visitor", track: true });
  await sleep(8000);
  const t0 = Date.now();
  if (kind === "node-kill") {
    ctx.stack.nodes[1].proc.kill("SIGKILL");
    log("SIGKILLed node1 under load");
  } else if (kind === "redis-restart") {
    await ctx.stack.redis.restart();
    log("restarted redis (state lost)");
  } else if (kind === "pg-freeze") {
    log("freezing postgres for 6 s");
    await ctx.stack.postgres.freeze(6000);
  }
  await sleep(20000);
  await ctx.fleet.all({ cmd: "stopSend" });
  // everything unacknowledged is retried by the clients (same client ids); wait until the pending sets drain
  let s;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    s = await ctx.fleet.stats();
    if (s.sendOk >= s.sendUnique) break;
  }
  await ctx.fleet.all({ cmd: "audit" });
  const fin = await ctx.fleet.stats();
  // ground truth from the database
  const { createRequire } = await import("node:module");
  const { default: pgmod } = await import(createRequire(new URL("../server/package.json", import.meta.url)).resolve("pg"));
  const c = new pgmod.Client({ connectionString: ctx.stack.postgres.url });
  await c.connect();
  const stored = Number((await c.query("SELECT COUNT(*) n FROM messages WHERE sender_type = 'contact' AND client_msg_id LIKE 'c%-%'")).rows[0].n);
  const distinct = Number((await c.query("SELECT COUNT(*) n FROM message_qids WHERE client_msg_id LIKE 'c%-%'")).rows[0].n);
  const gaps = Number((await c.query("SELECT COUNT(*) n FROM (SELECT room_id FROM messages GROUP BY room_id HAVING MAX(seq) - MIN(seq) + 1 <> COUNT(*)) t")).rows[0].n);
  await c.end();
  await finish(ctx);
  results.fault = {
    kind,
    secs_run_after_fault: Math.round((Date.now() - t0) / 1000),
    sockets_before: total0,
    sockets_after: fin.open,
    failovers_by_clients: fin.failovers,
    unique_messages_sent: fin.sendUnique,
    acked: fin.sendOk,
    resent_after_reconnect: fin.resent,
    stored_in_db: stored,
    distinct_client_ids_in_db: distinct,
    LOST: fin.sendUnique - stored,
    DUPLICATED_IN_DB: stored - distinct,
    per_room_seq_gaps_in_db: gaps,
    client_seq_gaps: fin.gap,
    client_duplicates_received: fin.dup,
    client_missing_after_resync_audit: fin.auditMissing,
  };
}

/** Fan-out throughput against the number of subscribers of ONE event stream (team sockets all receive every message). */
async function roomsize() {
  const sizes = String(opt.sizes ?? "1,10,100,1000").split(",").map(Number);
  const { stack, ws } = await setup();
  cleanup.push(() => stack.stop());
  const { visitors } = await bootstrapVisitors(stack, ws, 50, "rs");
  const fleet = new Fleet(cfg.workers);
  await fleet.start();
  cleanup.push(() => fleet.close());
  const out = [];
  let connectedAgents = 0;
  let prevRecv = 0;
  let prevSent = 0;
  const sampler = await sampleNodes(stack, fleet);
  const vitems = makeItems({ stack, ws, visitors, agents: 0 });
  await fleet.connect(vitems, 500);
  for (const size of sizes) {
    const add = size - connectedAgents;
    if (add > 0) {
      const rooms = visitors.map((v) => v.roomId);
      await fleet.connect(Array.from({ length: add }, () => ({ kind: "team", url: stack.urls[0], wsId: ws.wsId, token: ws.ownerToken, rooms })), 400);
      connectedAgents = size;
      await sleep(2000);
    }
    await fleet.stats(true);
    sampler.reset();
    const t0 = Date.now();
    await fleet.all({ cmd: "send", ratePerSec: cfg.rate / cfg.workers, bytes: cfg.bytes, kindFilter: "visitor" });
    await sleep(cfg.duration * 1000);
    await fleet.all({ cmd: "stopSend" });
    await sleep(2500);
    const s = await fleet.stats();
    const secs = (Date.now() - t0) / 1000;
    const dRecv = s.recvTeam - prevRecv;
    const dSent = s.sendOk - prevSent;
    prevRecv = s.recvTeam;
    prevSent = s.sendOk;
    out.push({ subscribers: size, sent_per_s: Math.round(dSent / cfg.duration), deliveries_per_s: Math.round(dRecv / secs), delivery_p50_ms: s.delivery.p50, delivery_p99_ms: s.delivery.p99, gaps: s.gap, dups: s.dup, node_cpu_pct: sampler.report().node0?.cpu_avg_pct, node_rss_mb: sampler.report().node0?.rss_peak_mb });
    log(JSON.stringify(out.at(-1)));
  }
  sampler.stop();
  results.roomsize = out;
}

try {
  await main();
} catch (e) {
  results.error = String(e?.stack ?? e) + (e?.cause ? `\ncause: ${e.cause.code ?? ""} ${e.cause.message ?? e.cause}` : "");
  process.exitCode = 1;
} finally {
  results.load_avg_at_end = os.loadavg().map((x) => Number(x.toFixed(1)));
  for (const c of cleanup.reverse()) await c().catch(() => {});
  const out = JSON.stringify(results, null, 2);
  if (opt.out) writeFileSync(opt.out, out);
  console.log(out);
  process.exit(process.exitCode ?? 0);
}
