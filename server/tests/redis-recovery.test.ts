import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RedisHub } from "../src/infra/redis.js";
import { silentLogger } from "../src/logger.js";

const free = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
});
const start = (port: number) => {
  const p = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  procs.push(p);
  return p;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.TEST_REDIS)("Redis outage recovery (private redis-server, killed and restarted)", () => {
  it("notifies listeners once the connection returns, not at first connect", async () => {
    const port = await free();
    const a = start(port);
    await sleep(300);
    const hub = new RedisHub(`redis://127.0.0.1:${port}`, silentLogger, "rec");
    let n = 0;
    hub.onRecovered(() => n++);
    await hub.client.ping();
    expect(n).toBe(0);
    a.kill("SIGKILL");
    await sleep(300);
    start(port);
    for (let i = 0; i < 50 && n === 0; i++) await sleep(100);
    expect(n).toBe(1);
    expect(await hub.client.ping()).toBe("PONG");
    await hub.close();
  }, 20_000);
});
