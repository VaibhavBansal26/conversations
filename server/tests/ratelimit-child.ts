// Child process for the multi-process atomicity test: node --import tsx tests/ratelimit-child.ts <redisUrl> <prefix> <calls> <concurrency> [lease]
import { RedisHub } from "../src/infra/redis.js";
import { silentLogger } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit/limiter.js";
import { RedisStore } from "../src/ratelimit/redisStore.js";

const [url, prefix, callsS, concS, lease] = process.argv.slice(2);
const hub = new RedisHub(url!, silentLogger, prefix);
const store = new RedisStore(hub, { timeoutMs: 2000, breakerThreshold: 50, breakerOpenMs: 1000 });
const lim = new RateLimiter({
  store,
  leaseFraction: lease === "lease" ? 0.2 : 0,
  leaseTtlMs: 60_000,
  // 1 token per hour, burst 50: during the test no token refills, so the cluster-wide total must be exactly the burst
  overrides: { "public.config": { limit: 1, windowSec: 3600, burst: 50, lease: lease === "lease" } },
});
let allowed = 0;
let limited = 0;
let next = 0;
const total = Number(callsS);
await Promise.all(
  Array.from({ length: Number(concS) }, async () => {
    while (next++ < total) {
      const d = await lim.check("public.config", { key: "shared" });
      d.allowed ? allowed++ : limited++;
    }
  }),
);
console.log(JSON.stringify({ allowed, limited, leaseGrants: lease === "lease" }));
await hub.close();
process.exit(0);
