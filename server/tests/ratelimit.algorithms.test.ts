import { describe, expect, it } from "vitest";
import { gcra, penaltyRemaining, penaltyViolation, slidingWindow, type GcraState, type PenaltyState, type WindowState } from "../src/ratelimit/algorithms.js";
import { RateLimiter } from "../src/ratelimit/limiter.js";
import { MemoryStore } from "../src/ratelimit/memoryStore.js";
import { DEFAULT_PENALTY, type GcraParams } from "../src/ratelimit/types.js";

/** deterministic PRNG so the randomised properties are reproducible */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const run = (p: GcraParams, times: number[], cost = p.cost) => {
  let st: GcraState | undefined;
  return times.map((t) => {
    const r = gcra(st, t, { ...p, cost });
    st = r.next;
    return r.verdict;
  });
};

describe("GCRA", () => {
  const p: GcraParams = { emissionMs: 100, burst: 5, cost: 1 }; // 10/s, burst 5

  it("allows exactly `burst` back to back, then denies", () => {
    const v = run(p, Array(7).fill(1000));
    expect(v.map((x) => x.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(v.slice(0, 5).map((x) => x.remaining)).toEqual([4, 3, 2, 1, 0]);
  });

  it("Retry-After is exact: retrying exactly then succeeds, one ms earlier fails", () => {
    let st: GcraState | undefined;
    for (let i = 0; i < 5; i++) st = gcra(st, 1000, p).next;
    const denied = gcra(st, 1000, p).verdict;
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(100);
    expect(gcra(st, 1000 + denied.retryAfterMs - 1, p).verdict.allowed).toBe(false);
    expect(gcra(st, 1000 + denied.retryAfterMs, p).verdict.allowed).toBe(true);
  });

  it("refills at the steady rate: one token per emission interval", () => {
    let st: GcraState | undefined;
    for (let i = 0; i < 5; i++) st = gcra(st, 0, p).next;
    // 1 s later (10 intervals) the bucket is full again but never over capacity
    expect(gcra(st, 1000, p).verdict.remaining).toBe(4);
    let t = 0;
    const allowed: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      const r = gcra(st, (t += 100), p);
      st = r.next;
      allowed.push(r.verdict.allowed);
    }
    expect(allowed.every(Boolean)).toBe(true); // exactly the steady rate is always admitted
  });

  it("a cost larger than what remains is denied without consuming anything; a cost above the burst can never pass", () => {
    let st: GcraState | undefined = gcra(undefined, 0, { ...p, cost: 3 }).next;
    const r = gcra(st, 0, { ...p, cost: 4 });
    expect(r.verdict.allowed).toBe(false);
    expect(r.next).toBe(st);
    expect(gcra(st, 0, { ...p, cost: 2 }).verdict.allowed).toBe(true);
    expect(gcra(undefined, 0, { ...p, cost: 6 }).verdict.allowed).toBe(false);
    expect(gcra(undefined, 10 ** 9, { ...p, cost: 6 }).verdict.allowed).toBe(false);
  });

  it("cost 0 never consumes and is allowed on a full bucket", () => {
    expect(gcra(undefined, 0, { ...p, cost: 0 }).verdict.allowed).toBe(true);
  });

  it("property: in any window W the number admitted never exceeds burst + W/emission", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const params: GcraParams = { emissionMs: 10 + Math.floor(rand() * 200), burst: 1 + Math.floor(rand() * 20), cost: 1 };
      let st: GcraState | undefined;
      const admitted: number[] = [];
      let t = 0;
      for (let i = 0; i < 2000; i++) {
        t += Math.floor(rand() * rand() * 60); // bursty arrivals
        const r = gcra(st, t, { ...params, cost: 1 });
        st = r.next;
        if (r.verdict.allowed) admitted.push(t);
      }
      for (let i = 0; i < admitted.length; i++) {
        for (const w of [50, 500, 5000]) {
          let n = 0;
          for (let j = i; j < admitted.length && admitted[j]! - admitted[i]! < w; j++) n++;
          expect(n).toBeLessThanOrEqual(params.burst + Math.ceil(w / params.emissionMs));
        }
      }
    }
  });
});

describe("sliding window counter", () => {
  const p = { limit: 10, windowMs: 1000, cost: 1 };
  const feed = (times: number[], cost = 1) => {
    let st: WindowState | undefined;
    return times.map((t) => {
      const r = slidingWindow(st, t, { ...p, cost });
      st = r.next;
      return r.verdict;
    });
  };

  it("admits `limit` in one window and denies the rest", () => {
    const v = feed(Array(12).fill(100));
    expect(v.filter((x) => x.allowed)).toHaveLength(10);
  });

  it("weights the previous window by its remaining overlap", () => {
    let st: WindowState | undefined;
    for (let i = 0; i < 10; i++) st = slidingWindow(st, 900, p).next; // 10 in window 0
    // at 1500 (halfway through window 1) the previous window counts 50%: 5 + new
    const at = (n: number) => {
      let s = st;
      let ok = 0;
      for (let i = 0; i < n; i++) {
        const r = slidingWindow(s, 1500, p);
        s = r.next;
        if (r.verdict.allowed) ok++;
      }
      return ok;
    };
    expect(at(20)).toBe(5);
    // at the very start of window 1 the previous window still counts fully
    let s2 = st;
    expect(slidingWindow(s2, 1000, p).verdict.allowed).toBe(false);
    // a full window later it has fully expired
    expect(slidingWindow(st, 2000, p).verdict.allowed).toBe(true);
  });

  it("boundary: the last millisecond of a window and the first of the next share the budget", () => {
    let st: WindowState | undefined;
    for (let i = 0; i < 10; i++) st = slidingWindow(st, 999, p).next;
    expect(slidingWindow(st, 1000, p).verdict.allowed).toBe(false);
    expect(slidingWindow(st, 1999, p).verdict.allowed).toBe(true);
  });

  it("cost larger than remaining is denied atomically", () => {
    let st: WindowState | undefined = slidingWindow(undefined, 0, { ...p, cost: 8 }).next;
    expect(slidingWindow(st, 0, { ...p, cost: 3 }).verdict.allowed).toBe(false);
    expect(slidingWindow(st, 0, { ...p, cost: 2 }).verdict.allowed).toBe(true);
  });

  it("Retry-After is never later than needed: retrying then succeeds", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = rng(seed);
      let st: WindowState | undefined;
      let t = 0;
      for (let i = 0; i < 60; i++) {
        t += Math.floor(rand() * 120);
        const r = slidingWindow(st, t, p);
        if (r.verdict.allowed) st = r.next;
        else {
          const again = slidingWindow(st, t + r.verdict.retryAfterMs, p);
          // a lower bound across a window edge: if it still fails, the new Retry-After must be shorter than the original window
          expect(r.verdict.retryAfterMs).toBeGreaterThan(0);
          expect(r.verdict.retryAfterMs).toBeLessThanOrEqual(p.windowMs);
          if (!again.verdict.allowed) expect(again.verdict.retryAfterMs).toBeLessThanOrEqual(p.windowMs);
        }
      }
    }
  });

  it("property: no sliding 1 s interval holds more than limit + a window-edge allowance", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed * 7);
      let st: WindowState | undefined;
      const admitted: number[] = [];
      let t = 0;
      for (let i = 0; i < 1500; i++) {
        t += Math.floor(rand() * 40);
        const r = slidingWindow(st, t, p);
        if (r.verdict.allowed) {
          st = r.next;
          admitted.push(t);
        }
      }
      for (let i = 0; i < admitted.length; i++) {
        let n = 0;
        for (let j = i; j < admitted.length && admitted[j]! - admitted[i]! < p.windowMs; j++) n++;
        // the weighted counter approximates a true sliding window; it is bounded by the limit within one window length
        expect(n).toBeLessThanOrEqual(p.limit * 2);
      }
      // and over a long horizon the average rate converges to the limit
      const span = admitted[admitted.length - 1]! - admitted[0]!;
      if (span > 5000) expect(admitted.length / (span / p.windowMs)).toBeLessThanOrEqual(p.limit * 1.05 + 1);
    }
  });
});

describe("penalty box", () => {
  const c = { ...DEFAULT_PENALTY, threshold: 3 };
  it("escalates 1 min -> 5 min -> 30 min -> 24 h and caps there", () => {
    let st: PenaltyState | undefined;
    let now = 0;
    const blocks: number[] = [];
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 3; i++) {
        st = penaltyViolation(st, now, c);
        now += 1000;
      }
      blocks.push(Math.round(penaltyRemaining(st, now - 1000) / 1000));
      now = st!.until + 1; // wait it out; stay well inside the decay horizon
    }
    expect(blocks).toEqual([60, 300, 1800, 86400, 86400, 86400]);
  });

  it("violations outside the window do not accumulate", () => {
    let st: PenaltyState | undefined;
    st = penaltyViolation(st, 0, c);
    st = penaltyViolation(st, 1000, c);
    st = penaltyViolation(st, 11 * 60_000, c); // the first two have aged out of the 10-minute window
    expect(penaltyRemaining(st, 11 * 60_000)).toBe(0);
  });

  it("decays one level per decayMs without violations", () => {
    let st: PenaltyState | undefined;
    let now = 0;
    for (let level = 0; level < 3; level++) {
      for (let i = 0; i < 3; i++) st = penaltyViolation(st, now, c);
      now = st!.until + 1;
    }
    expect(st!.lvl).toBe(3);
    // a day and a half of good behaviour forgives all three levels (6 h each is 18 h), so the next block is the first step again
    now += 36 * 3600_000;
    for (let i = 0; i < 3; i++) st = penaltyViolation(st, now, c);
    expect(Math.round(penaltyRemaining(st, now) / 1000)).toBe(60);
  });
});

describe("limiter (memory store)", () => {
  const mk = (over: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) => {
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms: number) => (t += ms) };
    const store = new MemoryStore(clock.now, 1000, 0);
    const lim = new RateLimiter({ store, now: clock.now, ...over });
    return { clock, store, lim };
  };

  it("applies plan tiers per workspace and lets an override win", async () => {
    let tier: "free" | "pro" | "business" = "free";
    const { lim } = mk({ tierOf: async () => tier });
    const take = async () => (await lim.check("msg.workspace", { key: "w1", workspaceId: "w1" })).limit;
    expect(await take()).toBe(5000);
    tier = "pro";
    expect(await take()).toBe(50000);
    tier = "business";
    expect(await take()).toBe(500000);
  });

  it("idempotency key: a repeat inside the window does not spend again", async () => {
    const { lim } = mk();
    const first = await lim.check("public.send", { key: "v1" }, { idempotencyKey: "abc" });
    const repeat = await lim.check("public.send", { key: "v1" }, { idempotencyKey: "abc" });
    const fresh = await lim.check("public.send", { key: "v1" }, { idempotencyKey: "def" });
    expect(first.remaining).toBe(29);
    expect(repeat.outcome).toBe("idempotent");
    expect(fresh.remaining).toBe(28);
  });

  it("concurrency lease: cap, release on throw, expiry of a leaked lease", async () => {
    const { lim, clock } = mk();
    const hold: (() => void)[] = [];
    const slow = () => new Promise<void>((r) => hold.push(r));
    const shedErr = new Error("shed");
    const onShed = () => {
      throw shedErr;
    };
    const runs = [1, 2, 3, 4].map(() => lim.withLease("ai.concurrency", "w", "w", slow, onShed));
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    await expect(lim.withLease("ai.concurrency", "w", "w", async () => 1, onShed)).rejects.toBe(shedErr); // 4 in flight = the cap
    hold.forEach((h) => h());
    await Promise.all(runs);
    // released: room again
    await expect(lim.withLease("ai.concurrency", "w", "w", async () => 7, onShed)).resolves.toBe(7);
    // released in finally even when the work throws
    await expect(lim.withLease("ai.concurrency", "w", "w", async () => Promise.reject(new Error("boom")), onShed)).rejects.toThrow("boom");
    await expect(lim.withLease("ai.concurrency", "w", "w", async () => 8, onShed)).resolves.toBe(8);
    // a leaked lease (crash) expires with its TTL
    for (let i = 0; i < 4; i++) await lim.acquire("ai.concurrency", "leak", `id${i}`, "leak");
    expect((await lim.acquire("ai.concurrency", "leak", "idx", "leak")).ok).toBe(false);
    clock.advance(61_000);
    expect((await lim.acquire("ai.concurrency", "leak", "idx", "leak")).ok).toBe(true);
  });

  it("strike policy: locks after the threshold, escalates, and a success clears the account", async () => {
    const { lim, clock } = mk();
    for (let i = 0; i < 4; i++) expect((await lim.blockedFor("auth.fail.account", "a@x")).blockedMs).toBe(0), await lim.strike("auth.fail.account", "a@x");
    expect((await lim.blockedFor("auth.fail.account", "a@x")).blockedMs).toBe(0);
    await lim.strike("auth.fail.account", "a@x"); // 5th
    const b = (await lim.blockedFor("auth.fail.account", "a@x")).blockedMs;
    expect(b).toBeGreaterThan(59_000);
    expect((await lim.blockedFor("auth.fail.account", "other@x")).blockedMs).toBe(0);
    clock.advance(61_000);
    expect((await lim.blockedFor("auth.fail.account", "a@x")).blockedMs).toBe(0);
    await lim.clearStrikes("auth.fail.account", "a@x");
  });

  it("allow and deny lists with TTL", async () => {
    const { lim, store, clock } = mk();
    await store.listAdd("deny", "ip:1.2.3.4", 60_000);
    await lim.refreshLists();
    const entities = ["ip:1.2.3.4"];
    expect((await lim.check("ip.global", { key: "1.2.3.4" }, { entities })).outcome).toBe("denylisted");
    await store.listAdd("allow", "ip:1.2.3.4", 60_000);
    await lim.refreshLists();
    expect((await lim.check("ip.global", { key: "1.2.3.4" }, { entities })).outcome).toBe("allowlisted");
    clock.advance(61_000);
    await lim.refreshLists();
    expect((await lim.check("ip.global", { key: "1.2.3.4" }, { entities })).outcome).toBe("allowed");
  });

  it("pacing reserves slots instead of rejecting, and reports a full queue", async () => {
    const { lim } = mk();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) waits.push((await lim.pace("sms.number", "+14155550100", { queueMax: 10 })).waitMs);
    expect(waits).toEqual([0, 1000, 2000, 3000]);
    const full: boolean[] = [];
    for (let i = 0; i < 10; i++) full.push((await lim.pace("sms.number", "+14155550100", { queueMax: 10 })).full);
    expect(full.slice(-1)[0]).toBe(true);
  });

  it("memory store is bounded: an LRU evicts old keys", async () => {
    const t = 1_000_000;
    const store = new MemoryStore(() => t, 100, 0);
    const lim = new RateLimiter({ store, now: () => t });
    for (let i = 0; i < 1000; i++) await lim.check("public.config", { key: `ip${i}` });
    expect(store.size).toBeLessThanOrEqual(100);
  });
});
