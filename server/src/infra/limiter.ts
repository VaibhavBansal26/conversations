import { RateLimiter } from "../util/ratelimit.js";
import type { RedisHub } from "./redis.js";

export interface Limiter {
  /** true when the request is allowed (and consumed `cost` tokens) */
  take(key: string, cost?: number): Promise<boolean>;
}

export interface LimiterFactory {
  get(name: string, capacity: number, perSecond: number): Limiter;
}

export class MemoryLimiterFactory implements LimiterFactory {
  private readonly all = new Map<string, Limiter>();
  constructor(private readonly now: () => number) {}

  get(name: string, capacity: number, perSecond: number): Limiter {
    let l = this.all.get(name);
    if (!l) {
      const inner = new RateLimiter(capacity, perSecond, this.now);
      l = { take: async (key, cost = 1) => inner.take(key, cost) };
      this.all.set(name, l);
    }
    return l;
  }
}

// Atomic token bucket. Time comes from the Redis server so every app node agrees.
const TOKEN_BUCKET = `
local key = KEYS[1]
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local d = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)
local ok = 0
if tokens >= cost then tokens = tokens - cost; ok = 1 end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.ceil(cap / rate * 1000) + 1000)
return ok
`;

/** Distributed token bucket: the same limits hold no matter which node a client lands on. Fails open if Redis is down. */
export class RedisLimiterFactory implements LimiterFactory {
  private readonly all = new Map<string, Limiter>();
  constructor(
    private readonly hub: RedisHub,
    private readonly onError: (e: unknown) => void = () => {},
  ) {
    hub.client.defineCommand("tokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET });
  }

  get(name: string, capacity: number, perSecond: number): Limiter {
    let l = this.all.get(name);
    if (!l) {
      l = {
        take: async (key, cost = 1) => {
          try {
            const r = await (this.hub.client as unknown as { tokenBucket(k: string, a: number, b: number, c: number): Promise<number> }).tokenBucket(
              `rl:${name}:${key}`,
              capacity,
              perSecond,
              cost,
            );
            return r === 1;
          } catch (e) {
            this.onError(e);
            return true;
          }
        },
      };
      this.all.set(name, l);
    }
    return l;
  }
}
