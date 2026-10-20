import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Runs a script the way `npm run` does, in a child process, and reports how it ended: unit tests cannot see an event loop that never drains. */
function run(args: string[], env: NodeJS.ProcessEnv, limitMs: number): Promise<{ code: number | null; out: string; timedOut: boolean; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("npx", ["tsx", ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut, ms: Date.now() - t0 });
    });
  });
}

describe("script entry points", () => {
  it("npm run seed seeds a fresh database and exits (it used to stay alive until killed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conversations-seed-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: join(dir, "seed.db"), DATA_DIR: dir, NODE_ENV: "development", LOG_LEVEL: "silent" };
      delete env.DATABASE_URL;
      delete env.REDIS_URL;
      const first = await run(["src/seed.ts"], env, 60_000);
      expect(first.timedOut, `seed did not exit within the limit:\n${first.out}`).toBe(false);
      expect(first.code, first.out).toBe(0);
      expect(first.out).toMatch(/Seeded demo workspace/);
      // running it again takes the "already seeded" branch, which must also let go of everything
      const second = await run(["src/seed.ts"], env, 60_000);
      expect(second.timedOut, `second seed run did not exit:\n${second.out}`).toBe(false);
      expect(second.code, second.out).toBe(0);
      expect(second.out).toMatch(/Already seeded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
