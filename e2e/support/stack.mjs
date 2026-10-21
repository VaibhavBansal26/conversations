// Boots the BUILT server (server/dist + web/dist) on a free port with a throwaway SQLite database and the demo seed.
// Used by Playwright's global setup; `npm run stack` keeps one running for manual poking. Never touches ports 3000/5173/6379.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = join(root, "server");

import { DEMO, enrich } from "./api.mjs";

export { DEMO };
export const OPERATOR = { email: "ops@example.test", password: "operator-pass-12345", name: "Olive Operator" };

const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

export async function startStack({ port } = {}) {
  port ??= await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "conv-e2e-ui-"));
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    HOST: "127.0.0.1",
    JWT_SECRET: "e2e-ui-secret-e2e-ui-secret-e2e-ui-1234",
    DATABASE_PATH: join(dataDir, "e2e.db"),
    DATA_DIR: dataDir,
    PUBLIC_URL: base,
    WEB_DIST: join(root, "web/dist"),
    LOG_LEVEL: "warn",
    RATE_LIMIT_SCALE: "50",
    // calls connect over loopback in the tests: no STUN lookups to the internet
    STUN_URLS: "",
  };
  const seed = spawnSync(join(SERVER, "node_modules/.bin/tsx"), ["src/seed.ts"], { cwd: SERVER, env, encoding: "utf8" });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr || seed.stdout}`);
  const admin = spawnSync(join(SERVER, "node_modules/.bin/tsx"), ["scripts/platform-admin.ts", "create"], {
    cwd: SERVER,
    env: { ...env, ADMIN_EMAIL: OPERATOR.email, ADMIN_PASSWORD: OPERATOR.password, ADMIN_NAME: OPERATOR.name },
    encoding: "utf8",
  });
  if (admin.status !== 0) throw new Error(`operator creation failed: ${admin.stderr || admin.stdout}`);
  const proc = spawn(process.execPath, ["dist/index.js"], { cwd: SERVER, env, stdio: ["ignore", "ignore", "inherit"] });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not become healthy");
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = async () => {
    proc.kill("SIGTERM");
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    if (!process.env.E2E_NO_ENRICH) await enrich(base);
  } catch (e) {
    await stop();
    throw e;
  }
  return {
    base,
    port,
    dataDir,
    stop,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startStack({ port: process.env.E2E_PORT ? Number(process.env.E2E_PORT) : undefined });
  console.log(`stack up at ${s.base} (login ${DEMO.email} / ${DEMO.password}); Ctrl-C to stop`);
  const quit = () => s.stop().then(() => process.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
