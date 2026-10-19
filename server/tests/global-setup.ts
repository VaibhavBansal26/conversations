import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/**
 * `TEST_DB=postgres npm test` runs the whole suite against PostgreSQL. Point TEST_DATABASE_URL at a server (CI service container,
 * `docker run postgres:17`) or leave it unset to boot a throwaway embedded PostgreSQL for the duration of the run.
 */
export default async function setup() {
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
