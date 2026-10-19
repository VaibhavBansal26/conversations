import type { Redis } from "ioredis";
import type { RedisHub } from "../infra/redis.js";
import * as lua from "./lua.js";
import type { GcraParams, PenaltyConfig, Store, Verdict, WindowParams } from "./types.js";

type Cmds = Redis & {
  rlGcra(...a: (string | number)[]): Promise<number[]>;
  rlGcraLease(...a: (string | number)[]): Promise<number[]>;
  rlWindow(...a: (string | number)[]): Promise<number[]>;
  rlAcquire(...a: (string | number)[]): Promise<number[]>;
  rlRenew(...a: (string | number)[]): Promise<number>;
  rlStrike(...a: (string | number)[]): Promise<number>;
  rlBlocked(...a: (string | number)[]): Promise<number>;
};

export interface RedisStoreOptions {
  /** hard budget for one Redis call; past it the call counts as a failure */
  timeoutMs: number;
  /** consecutive failures that open the circuit breaker */
  breakerThreshold: number;
  /** how long the breaker stays open before one probe is allowed */
  breakerOpenMs: number;
  now?: () => number;
}

export class StoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailable";
  }
}

/**
 * Redis-backed store. One Lua call per decision. All keys are `<prefix>:rl:{<tag>}:<kind>` where the tag is the policy+principal, so the
 * decision's keys live in one Cluster slot. A call that exceeds the time budget, errors, or arrives while the breaker is open throws
 * StoreUnavailable; the limiter then applies the policy's failure mode.
 */
export class RedisStore implements Store {
  readonly kind = "redis" as const;
  private readonly r: Cmds;
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  private readonly now: () => number;
  /** observers for metrics */
  onCall?: (seconds: number, ok: boolean) => void;
  onBreaker?: (open: boolean) => void;

  constructor(
    private readonly hub: RedisHub,
    private readonly opts: RedisStoreOptions,
  ) {
    this.now = opts.now ?? Date.now;
    const c = hub.client;
    c.defineCommand("rlGcra", { numberOfKeys: 2, lua: lua.GCRA });
    c.defineCommand("rlGcraLease", { numberOfKeys: 1, lua: lua.GCRA_LEASE });
    c.defineCommand("rlWindow", { numberOfKeys: 2, lua: lua.WINDOW });
    c.defineCommand("rlAcquire", { numberOfKeys: 1, lua: lua.ACQUIRE });
    c.defineCommand("rlRenew", { numberOfKeys: 1, lua: lua.RENEW });
    c.defineCommand("rlStrike", { numberOfKeys: 1, lua: lua.STRIKE });
    c.defineCommand("rlBlocked", { numberOfKeys: 1, lua: lua.BLOCKED });
    this.r = c as Cmds;
  }

  /** the breaker state, for tests and the readiness view */
  get breakerOpen() {
    return this.now() < this.openUntil;
  }

  private k(tag: string, kind: string) {
    return this.hub.k(`rl:{${tag}}:${kind}`);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    const t = this.now();
    if (t < this.openUntil) throw new StoreUnavailable("circuit open");
    if (this.openUntil !== 0 && !this.probing) this.probing = true; // half-open: this call is the probe
    const start = process.hrtime.bigint();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new StoreUnavailable(`redis call exceeded ${this.opts.timeoutMs} ms`)), this.opts.timeoutMs);
        }),
      ]);
      if (this.failures || this.openUntil) this.onBreaker?.(false);
      this.failures = 0;
      this.openUntil = 0;
      this.probing = false;
      this.onCall?.(Number(process.hrtime.bigint() - start) / 1e9, true);
      return res;
    } catch (e) {
      this.onCall?.(Number(process.hrtime.bigint() - start) / 1e9, false);
      this.failures++;
      if (this.failures >= this.opts.breakerThreshold || this.probing) {
        this.openUntil = this.now() + this.opts.breakerOpenMs;
        this.probing = false;
        this.onBreaker?.(true);
      }
      if (e instanceof StoreUnavailable) throw e;
      throw new StoreUnavailable(e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private static pen(c?: PenaltyConfig): (string | number)[] {
    return c ? [c.threshold, c.windowMs, c.decayMs, ...c.stepsSec] : [0, 0, 0];
  }
  private static verdict(r: number[]): Verdict {
    return { allowed: r[0] === 1, remaining: r[1]!, retryAfterMs: r[2]!, resetMs: r[3]!, blocked: r[4] === 1 || undefined };
  }

  async gcra(key: string, p: GcraParams, penalty?: PenaltyConfig) {
    return RedisStore.verdict(await this.call(() => this.r.rlGcra(this.k(key, "g"), this.k(key, "p"), p.emissionMs, p.burst, p.cost, ...RedisStore.pen(penalty))));
  }
  async gcraLease(key: string, p: GcraParams, want: number) {
    const r = await this.call(() => this.r.rlGcraLease(this.k(key, "g"), p.emissionMs, p.burst, p.cost, want));
    return { granted: r[0]!, verdict: { allowed: r[0]! > 0, remaining: r[1]!, retryAfterMs: r[2]!, resetMs: r[3]! } };
  }
  async window(key: string, p: WindowParams, penalty?: PenaltyConfig) {
    return RedisStore.verdict(await this.call(() => this.r.rlWindow(this.k(key, "w"), this.k(key, "p"), p.limit, p.windowMs, p.cost, ...RedisStore.pen(penalty))));
  }
  async acquire(key: string, id: string, max: number, ttlMs: number) {
    const r = await this.call(() => this.r.rlAcquire(this.k(key, "c"), id, max, ttlMs));
    return { ok: r[0] === 1, count: r[1]! };
  }
  async release(key: string, id: string) {
    await this.call(() => this.r.zrem(this.k(key, "c"), id));
  }
  async renew(key: string, ids: string[], ttlMs: number) {
    if (ids.length) await this.call(() => this.r.rlRenew(this.k(key, "c"), ttlMs, ...ids));
  }
  async count(key: string) {
    return this.call(async () => {
      const t = await this.r.time();
      const now = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
      return this.r.zcount(this.k(key, "c"), `(${now}`, "+inf");
    });
  }
  async once(key: string, ttlMs: number) {
    return (await this.call(() => this.r.set(this.k(key, "o"), "1", "PX", ttlMs, "NX"))) === "OK";
  }

  private listKey(kind: string) {
    return this.hub.k(`rl:{lists}:${kind}`);
  }
  async listAdd(kind: "allow" | "deny", entry: string, ttlMs: number, note?: string) {
    await this.call(async () => {
      const t = await this.r.time();
      const now = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
      const p = this.r.pipeline().zadd(this.listKey(kind), now + ttlMs, entry);
      if (note) p.hset(this.listKey(`${kind}:notes`), entry, note);
      await p.exec();
    });
  }
  async listRemove(kind: "allow" | "deny", entry: string) {
    return this.call(async () => {
      const n = await this.r.zrem(this.listKey(kind), entry);
      await this.r.hdel(this.listKey(`${kind}:notes`), entry);
      return n > 0;
    });
  }
  async listAll(kind: "allow" | "deny") {
    return this.call(async () => {
      const t = await this.r.time();
      const now = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
      await this.r.zremrangebyscore(this.listKey(kind), "-inf", String(now));
      const rows = await this.r.zrange(this.listKey(kind), "0", "999", "WITHSCORES");
      const notes = await this.r.hgetall(this.listKey(`${kind}:notes`));
      const out: { entry: string; expiresAt: number; note?: string }[] = [];
      for (let i = 0; i < rows.length; i += 2) out.push({ entry: rows[i]!, expiresAt: Number(rows[i + 1]), note: notes[rows[i]!] });
      return out;
    });
  }
  async listHas(kind: "allow" | "deny", entries: string[]) {
    if (!entries.length) return null;
    return this.call(async () => {
      const t = await this.r.time();
      const now = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
      const p = this.r.pipeline();
      for (const e of entries) p.zscore(this.listKey(kind), e);
      const res = (await p.exec()) ?? [];
      for (let i = 0; i < entries.length; i++) {
        const score = res[i]?.[1];
        if (score != null && Number(score) > now) return entries[i]!;
      }
      return null;
    });
  }

  async noteLimited(policy: string, keyHash: string) {
    // best effort, never on the decision path's failure budget
    const k = this.hub.k("rl:{limited}");
    await this.r
      .pipeline()
      .zincrby(k, 1, `${policy}|${keyHash}`)
      .zremrangebyrank(k, 0, -501)
      .pexpire(k, 3600_000)
      .exec()
      .catch(() => {});
  }
  async recentlyLimited(limit: number) {
    const rows = await this.call(() => this.r.zrevrange(this.hub.k("rl:{limited}"), 0, limit - 1, "WITHSCORES"));
    const out: { policy: string; key: string; count: number; last: number }[] = [];
    for (let i = 0; i < rows.length; i += 2) {
      const [policy, key] = rows[i]!.split("|");
      out.push({ policy: policy!, key: key!, count: Number(rows[i + 1]), last: 0 });
    }
    return out;
  }
  async penaltyBoxSize() {
    // approximate: counts penalty hashes with an active block. SCAN is bounded and only used by the admin view / a slow gauge.
    return this.call(async () => {
      let cursor = "0";
      let n = 0;
      const t = await this.r.time();
      const now = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
      let rounds = 0;
      do {
        const [next, keys] = await this.r.scan(cursor, "MATCH", this.hub.k("rl:*:p"), "COUNT", 500);
        cursor = next;
        if (keys.length) {
          const p = this.r.pipeline();
          for (const k of keys) p.hget(k, "until");
          for (const [, u] of (await p.exec()) ?? []) if (Number(u) > now) n++;
        }
      } while (cursor !== "0" && ++rounds < 20);
      return n;
    });
  }
  async strike(key: string, c: PenaltyConfig) {
    return this.call(() => this.r.rlStrike(this.k(key, "p"), ...RedisStore.pen(c)));
  }
  async blockedFor(key: string, c: PenaltyConfig) {
    return this.call(() => this.r.rlBlocked(this.k(key, "p"), ...RedisStore.pen(c)));
  }
  async clearPenalty(key: string) {
    await this.call(() => this.r.del(this.k(key, "p")));
  }
  async close() {}
}
