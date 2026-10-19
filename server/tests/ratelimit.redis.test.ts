import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RedisHub } from "../src/infra/redis.js";
import { silentLogger } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit/limiter.js";
import { MemoryStore } from "../src/ratelimit/memoryStore.js";
import { RedisStore } from "../src/ratelimit/redisStore.js";
import type { GcraParams } from "../src/ratelimit/types.js";

const url = process.env.TEST_REDIS_URL;
const redis = describe.skipIf(!url);
const hubs: RedisHub[] = [];
const prefix = () => `rl${randomBytes(4).toString("hex")}`;
const hub = (p: string, u = url!) => {
  const h = new RedisHub(u, silentLogger, p);
  hubs.push(h);
  return h;
};
const store = (h: RedisHub, o: Partial<ConstructorParameters<typeof RedisStore>[1]> = {}) => new RedisStore(h, { timeoutMs: 1000, breakerThreshold: 5, breakerOpenMs: 500, ...o });
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});
afterAll(async () => {
  for (const h of hubs.splice(0)) await h.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function child(p: string, calls: number, conc: number, lease = false): Promise<{ allowed: number; limited: number }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--import", "tsx", "tests/ratelimit-child.ts", url!, p, String(calls), String(conc), lease ? "lease" : "plain"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(`child exited ${code}: ${out}`))));
  });
}

const P: GcraParams = { emissionMs: 3_600_000, burst: 50, cost: 1 };

redis("Redis limiter: atomicity", () => {
  it("1,000 concurrent calls from 4 separate processes admit exactly burst (50), no more, no fewer", async () => {
    const p = prefix();
    const results = await Promise.all([child(p, 250, 50), child(p, 250, 50), child(p, 250, 50), child(p, 250, 50)]);
    expect(results.reduce((a, r) => a + r.allowed, 0)).toBe(50);
    expect(results.reduce((a, r) => a + r.limited, 0)).toBe(950);
  }, 60_000);

  it("same guarantee for sliding-window quotas under concurrency on many connections", async () => {
    const p = prefix();
    const stores = Array.from({ length: 6 }, () => store(hub(p)));
    const win = { limit: 100, windowMs: 3_600_000, cost: 1 };
    const res = await Promise.all(Array.from({ length: 1000 }, (_, i) => stores[i % 6]!.window("quota", win)));
    expect(res.filter((r) => r.allowed)).toHaveLength(100);
  });

  it("concurrency leases never exceed the cap under a race", async () => {
    const p = prefix();
    const stores = Array.from({ length: 4 }, () => store(hub(p)));
    const res = await Promise.all(Array.from({ length: 200 }, (_, i) => stores[i % 4]!.acquire("conc", `id${i}`, 7, 60_000)));
    expect(res.filter((r) => r.ok)).toHaveLength(7);
  });

  it("matches the in-memory implementation on the same sequences (GCRA, window, penalty)", async () => {
    const s = store(hub(prefix()));
    const m = new MemoryStore(Date.now, 1000, 0);
    const g: GcraParams = { emissionMs: 3_600_000, burst: 5, cost: 1 };
    for (let i = 0; i < 8; i++) {
      const a = await s.gcra("k", g);
      const b = await m.gcra("k", g);
      expect([a.allowed, a.remaining]).toEqual([b.allowed, b.remaining]);
    }
    const w = { limit: 4, windowMs: 3_600_000, cost: 1 };
    for (let i = 0; i < 7; i++) expect((await s.window("w", w)).allowed).toBe((await m.window("w", w)).allowed);
    const pen = { threshold: 3, windowMs: 60_000, stepsSec: [60, 300], decayMs: 3_600_000 };
    for (let i = 0; i < 3; i++) {
      await s.strike("s", pen);
      await m.strike("s", pen);
    }
    expect(Math.round((await s.blockedFor("s", pen)) / 1000)).toBe(Math.round((await m.blockedFor("s", pen)) / 1000));
  });

  it("cost: weighted calls and cost > remaining are decided atomically", async () => {
    const s = store(hub(prefix()));
    expect((await s.gcra("c", { ...P, cost: 30 })).allowed).toBe(true);
    expect((await s.gcra("c", { ...P, cost: 30 })).allowed).toBe(false); // 20 left
    expect((await s.gcra("c", { ...P, cost: 20 })).allowed).toBe(true);
  });
});

redis("Redis limiter: robustness", () => {
  it("scripts reload transparently after SCRIPT FLUSH", async () => {
    const h = hub(prefix());
    const s = store(h);
    expect((await s.gcra("f", P)).allowed).toBe(true);
    await h.client.script("FLUSH");
    expect((await s.gcra("f", P)).allowed).toBe(true);
    await h.client.script("FLUSH");
    expect((await s.window("fw", { limit: 3, windowMs: 60_000, cost: 1 })).allowed).toBe(true);
  });

  it("every key it writes has a TTL (nothing leaks)", async () => {
    const p = prefix();
    const h = hub(p);
    const s = store(h);
    await s.gcra("t1", { emissionMs: 1000, burst: 3, cost: 1 });
    await s.window("t2", { limit: 3, windowMs: 1000, cost: 1 });
    await s.acquire("t3", "a", 3, 1000);
    await s.strike("t4", { threshold: 1, windowMs: 1000, stepsSec: [1], decayMs: 1000 });
    await s.once("t5", 1000);
    const keys = await h.client.keys(`${p}:rl:*`);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const k of keys) expect(await h.client.pttl(k), k).toBeGreaterThan(0);
    // and they disappear on their own
    await sleep(3200);
    expect((await h.client.keys(`${p}:rl:*`)).filter((k) => !k.includes("{limited}"))).toEqual([]);
  }, 15_000);

  it("keys use hash tags so one decision stays in one Cluster slot", async () => {
    const p = prefix();
    const h = hub(p);
    const s = store(h);
    await s.gcra("tag-check", { emissionMs: 1000, burst: 3, cost: 1 }, { threshold: 5, windowMs: 1000, stepsSec: [1], decayMs: 1000 });
    for (const k of await h.client.keys(`${p}:rl:*`)) expect(k).toMatch(/:rl:\{[^}]+\}:/);
  });

  it("clock skew immunity: decisions come from Redis TIME, not the caller's clock", async () => {
    const p = prefix();
    const a = store(hub(p), { now: () => Date.now() + 3_600_000 });
    const b = store(hub(p), { now: () => Date.now() - 3_600_000 });
    const res = await Promise.all(Array.from({ length: 200 }, (_, i) => (i % 2 ? a : b).gcra("skew", P)));
    expect(res.filter((r) => r.allowed)).toHaveLength(50);
  });

  it("a Redis call over the time budget counts as a failure (CLIENT PAUSE stalls the server)", async () => {
    const h = hub(prefix());
    const s = store(h, { timeoutMs: 30, breakerThreshold: 100 });
    const other = hub(prefix());
    await other.client.call("CLIENT", "PAUSE", "400", "ALL");
    const t0 = Date.now();
    await expect(s.gcra("slow", P)).rejects.toThrow(/exceeded 30 ms/);
    expect(Date.now() - t0).toBeLessThan(200);
    await sleep(500);
    expect((await s.gcra("slow", P)).allowed).toBe(true);
  });

  it("Redis down: fail-open policies keep a per-node bound, fail-closed policies refuse; the breaker stops paying the timeout", async () => {
    const dead = hub(prefix(), "redis://127.0.0.1:1");
    const s = store(dead, { timeoutMs: 20, breakerThreshold: 3, breakerOpenMs: 400 });
    const lim = new RateLimiter({ store: s, fallback: new MemoryStore(Date.now, 1000, 0), leaseFraction: 0 });
    // fail-open policy (public.config, burst 60): allowed, but the local fallback still enforces the burst on this node
    const open: string[] = [];
    for (let i = 0; i < 70; i++) open.push((await lim.check("public.config", { key: "ip" })).outcome);
    expect(open.slice(0, 5).every((o) => o === "fail_open")).toBe(true);
    expect(open.filter((o) => o === "fail_open")).toHaveLength(60);
    expect(open.filter((o) => o === "limited")).toHaveLength(10);
    // fail-closed policy (public.session): 503-style refusal, never allowed
    const closed = await lim.check("public.session", { key: "x" });
    expect(closed).toMatchObject({ allowed: false, outcome: "fail_closed", shed: true });
    // breaker is open now: a call returns immediately instead of waiting the 20 ms budget
    expect(s.breakerOpen).toBe(true);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) await lim.check("public.session", { key: "x" });
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(100); // 200 calls, not 200 x 20 ms
  });

  it("breaker closes again after the cool-down when Redis answers", async () => {
    const h = hub(prefix());
    const s = store(h, { timeoutMs: 1000, breakerThreshold: 2, breakerOpenMs: 150 });
    // force failures by calling with a script error: wrong arity makes Redis reply with an error
    const bad = () => (s as unknown as { call<T>(f: () => Promise<T>): Promise<T> }).call(() => Promise.reject(new Error("boom")));
    await expect(bad()).rejects.toThrow();
    await expect(bad()).rejects.toThrow();
    expect(s.breakerOpen).toBe(true);
    await expect(s.gcra("probe", P)).rejects.toThrow(/circuit open/);
    await sleep(200);
    expect((await s.gcra("probe", P)).allowed).toBe(true);
    expect(s.breakerOpen).toBe(false);
  });
});

redis("Redis limiter: local lease tier", () => {
  it("never admits more than burst cluster-wide; under-admission is bounded by nodes x lease", async () => {
    const p = prefix();
    const results = await Promise.all([child(p, 250, 50, true), child(p, 250, 50, true), child(p, 250, 50, true), child(p, 250, 50, true)]);
    const allowed = results.reduce((a, r) => a + r.allowed, 0);
    const batch = Math.floor(50 * 0.2);
    expect(allowed).toBeLessThanOrEqual(50);
    expect(allowed).toBeGreaterThanOrEqual(50 - 4 * batch);
  }, 60_000);

  it("a hot key is served mostly from the local lease (few Redis calls)", async () => {
    const p = prefix();
    const h = hub(p);
    let calls = 0;
    const s = store(h);
    s.onCall = () => calls++;
    const lim = new RateLimiter({ store: s, leaseFraction: 0.1, leaseTtlMs: 5000, overrides: { "api.read": { limit: 100000, windowSec: 1, burst: 100000 } } });
    for (let i = 0; i < 5000; i++) expect((await lim.check("api.read", { key: "hot-user" })).allowed).toBe(true);
    expect(calls).toBeLessThan(5000 / 100); // batches of 10,000 tokens: well under 1 Redis call per 100 requests
  });
});
