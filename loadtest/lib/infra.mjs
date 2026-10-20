import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = join(here, "../../server");
const serverRequire = createRequire(join(SERVER_DIR, "package.json"));

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${url}`);
}

export async function startRedis() {
  const port = await freePort();
  const proc = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--maxclients", "20000"], { stdio: "ignore" });
  const url = `redis://127.0.0.1:${port}`;
  const { default: Redis } = await import(serverRequire.resolve("ioredis")).catch(() => ({ default: serverRequire("ioredis") }));
  for (let i = 0; i < 100; i++) {
    const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    r.on("error", () => {});
    try {
      await r.connect();
      await r.ping();
      r.disconnect();
      break;
    } catch {
      r.disconnect();
      await sleep(50);
    }
  }
  const handle = {
    url,
    port,
    pid: proc.pid,
    proc,
    stop: async () => void handle.proc.kill("SIGTERM"),
    /** kill and start again on the same port with empty state, like a cache failover */
    async restart() {
      handle.proc.kill("SIGKILL");
      await sleep(300);
      handle.proc = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--maxclients", "20000"], { stdio: "ignore" });
      handle.pid = handle.proc.pid;
    },
  };
  return handle;
}

export async function startPostgres() {
  const { default: EmbeddedPostgres } = await import(serverRequire.resolve("embedded-postgres"));
  const dir = mkdtempSync(join(tmpdir(), "conv-load-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    postgresFlags: ["-c", "max_connections=300", "-c", "max_files_per_process=128", "-c", "shared_buffers=256MB", "-c", "synchronous_commit=off", "-c", "fsync=off"],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    dir,
    port,
    /** freeze every postgres process for `ms` (SIGSTOP/SIGCONT): a primary that stops answering, then comes back */
    async freeze(ms) {
      const { execFileSync } = await import("node:child_process");
      const pids = execFileSync("pgrep", ["-f", dir]).toString().trim().split("\n").filter(Boolean);
      for (const p of pids) process.kill(Number(p), "SIGSTOP");
      await sleep(ms);
      for (const p of pids) process.kill(Number(p), "SIGCONT");
    },
    stop: async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Spawn N app nodes from the BUILT server (`npm run build --prefix server`). */
export async function startNodes({ count, databaseUrl, redisUrl, env = {}, nodeFlags = [] }) {
  const dataRoot = mkdtempSync(join(tmpdir(), "conv-load-data-"));
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const port = await freePort();
    const e = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ID: `node${i}`,
      JWT_SECRET: "loadtest-secret-loadtest-secret",
      DATA_DIR: join(dataRoot, `n${i}`),
      DATABASE_PATH: join(dataRoot, `n${i}.db`),
      LOG_LEVEL: "warn",
      RATE_LIMIT_SCALE: "100000",
      WS_CONNECT_RATE_PER_IP: "1000000",
      WS_TRANSPORTS: "websocket",
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      CORS_ORIGINS: "http://shop.example.com",
      // fewer partitions keep the shared file table (kern.maxfiles on this Mac) from being the limit: see PERFORMANCE.md
      SHED_LOOP_LAG_MS: "3000", // the box is shared and noisy; shedding itself is tested separately
      MESSAGE_HASH_PARTITIONS: "4",
      MESSAGE_PARTITION_MONTHS_AHEAD: "1",
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
      ...env,
    };
    const proc = spawn(process.execPath, [...nodeFlags, ...(process.env.LOADTEST_NODE_FLAGS ? process.env.LOADTEST_NODE_FLAGS.split(" ") : []), join(SERVER_DIR, "dist/index.js")], { env: e, stdio: ["ignore", process.env.LOADTEST_NODE_LOGS ? "inherit" : "ignore", "inherit"] });
    nodes.push({ name: `node${i}`, port, url: `http://127.0.0.1:${port}`, pid: proc.pid, proc });
  }
  await Promise.all(nodes.map((n) => waitHttp(`${n.url}/readyz`)));
  return {
    nodes,
    stop: async () => {
      const exited = nodes.map((n) => new Promise((r) => (n.proc.exitCode != null ? r() : n.proc.once("exit", r))));
      for (const n of nodes) n.proc.kill("SIGTERM");
      await Promise.race([Promise.all(exited), sleep(12000)]);
      for (const n of nodes) n.proc.kill("SIGKILL");
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Whole stack for a scenario: redis + postgres (when nodes > 1 or forced) + nodes. */
export async function startStack({ nodes = 1, db = nodes > 1 ? "postgres" : "sqlite", redis = nodes > 1, env = {}, nodeFlags = [] }) {
  const r = redis ? await startRedis() : null;
  const p = db === "postgres" ? await startPostgres() : null;
  const n = await startNodes({ count: nodes, databaseUrl: p?.url, redisUrl: r?.url, env, nodeFlags });
  return {
    nodes: n.nodes,
    redis: r,
    postgres: p,
    urls: n.nodes.map((x) => x.url),
    stop: async () => {
      await n.stop();
      await r?.stop();
      await p?.stop();
    },
  };
}
