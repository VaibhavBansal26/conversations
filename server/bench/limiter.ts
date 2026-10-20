// Rate limiter overhead. Run: npx tsx bench/limiter.ts [--redis redis://127.0.0.1:PORT] [--n 200000]
// Measures the cost of one `check()` (decision latency) for the memory store, and for the Redis store when a URL is given (one Redis round trip per decision
// for policies without the lease tier, a local decision for leased hot policies).
import { performance } from "node:perf_hooks";
import { MemoryStore } from "../src/ratelimit/memoryStore.js";
import { RateLimiter } from "../src/ratelimit/limiter.js";
import { RedisStore } from "../src/ratelimit/redisStore.js";
import { RedisHub } from "../src/infra/redis.js";
import { silentLogger } from "../src/logger.js";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const N = Number(arg("n") ?? 200_000);
const now = () => Date.now();
const out: Record<string, unknown> = { date: new Date().toISOString(), n: N };

async function bench(label: string, limiter: RateLimiter, policy: string, keys: number, conc: number) {
  for (let i = 0; i < 2000; i++) await limiter.check(policy, { key: `warm${i % 50}` });
  const lat: number[] = [];
  let done = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async (_, w) => {
    while (done < N) {
      const i = done++;
      const t = performance.now();
      await limiter.check(policy, { key: `k${(i * 7 + w) % keys}` });
      if (i % 50 === 0) lat.push(performance.now() - t);
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  out[label] = { decisions_per_s: Math.round(N / secs), mean_us: Math.round((secs / N) * 1e6), p50_us: Math.round(lat[Math.floor(lat.length * 0.5)]! * 1000), p99_us: Math.round(lat[Math.floor(lat.length * 0.99)]! * 1000), concurrency: conc, keys, policy };
}

const mem = new RateLimiter({ store: new MemoryStore(now), fallback: new MemoryStore(now), now, scale: 100_000, log: silentLogger });
await bench("memory_gcra_api.read_1_caller", mem, "api.read", 10_000, 1);
await bench("memory_window_msg.room_1_caller", mem, "msg.room", 10_000, 1);

const url = arg("redis");
if (url) {
  const hub = new RedisHub(url, silentLogger, `bench${Date.now()}`);
  const store = new RedisStore(hub, { timeoutMs: 200, breakerThreshold: 5, breakerOpenMs: 3000 });
  const rl = new RateLimiter({ store, fallback: new MemoryStore(now), now, scale: 100_000, log: silentLogger, leaseFraction: 0.1, leaseTtlMs: 1000 });
  await bench("redis_gcra_auth.login.ip_no_lease_conc_16", rl, "auth.login.ip", 10_000, 16);
  await bench("redis_gcra_api.read_leased_conc_16", rl, "api.read", 100, 16);
  rl.stop();
  await hub.close();
}
console.log(JSON.stringify(out, null, 2));
