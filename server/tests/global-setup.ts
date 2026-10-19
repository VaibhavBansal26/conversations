import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import { Redis } from "ioredis";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function startRedis(): Promise<(() => Promise<void>) | undefined> {
  if (!process.env.TEST_REDIS || process.env.TEST_REDIS_URL) return;
  const port = await freePort();
  const proc = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  const url = `redis://127.0.0.1:${port}`;
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
      await new Promise((res) => setTimeout(res, 50));
    }
  }
  process.env.TEST_REDIS_URL = url;
  return async () => void proc.kill("SIGTERM");
}

/**
 * Optional real backends for the suite (all in-process/local, no Docker needed):
 *   TEST_DB=postgres  -> PostgreSQL (TEST_DATABASE_URL, e.g. a CI service container; otherwise a throwaway embedded PostgreSQL)
 *   TEST_REDIS=1      -> redis-server on a random port (TEST_REDIS_URL, e.g. a CI service container, otherwise a spawned local redis-server)
 */
export default async function setup() {
  const stops = [await startPostgres(), await startRedis()].filter(Boolean) as (() => Promise<void>)[];
  return async () => {
    for (const s of stops) await s();
  };
}

async function startPostgres(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.TEST_DB !== "postgres" || process.env.TEST_DATABASE_URL) return;
  const dir = mkdtempSync(join(tmpdir(), "conv-pg-"));
  const port = await freePort();
  const pgdb = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pgdb.initialise();
  await pgdb.start();
  process.env.TEST_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  return async () => {
    await pgdb.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
