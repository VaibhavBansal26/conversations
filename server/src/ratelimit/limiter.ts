import { createHash } from "node:crypto";
import type { Logger } from "../logger.js";
import { DEFAULT_PENALTY, type GcraParams, type PenaltyConfig, type Policy, type Store, type Tier, type Verdict } from "./types.js";
import { MemoryStore } from "./memoryStore.js";
import { StoreUnavailable } from "./redisStore.js";
import { policyOf } from "./policies.js";

export type Outcome = "allowed" | "limited" | "blocked" | "shed" | "fail_open" | "fail_closed" | "allowlisted" | "denylisted" | "idempotent";

export interface Decision {
  allowed: boolean;
  outcome: Outcome;
  policy: string;
  /** the effective limit (after tier and scale) in the policy's unit */
  limit: number;
  windowSec: number;
  remaining: number;
  retryAfterMs: number;
  resetMs: number;
  /** true when the caller should answer 503 (overload / store unavailable on a fail-closed policy) instead of 429 */
  shed: boolean;
}

export interface LimiterMetrics {
  decision(policy: string, outcome: Outcome): void;
  lease(result: "hit" | "grant" | "deny"): void;
  redis(seconds: number, ok: boolean): void;
  breaker(open: boolean): void;
}

export interface LimiterOptions {
  store: Store;
  /** per-node store used when the shared one is unreachable (fail-open policies keep a local bound) */
  fallback?: Store;
  now?: () => number;
  scale?: number;
  tierOf?: (workspaceId: string) => Promise<Tier>;
  metrics?: LimiterMetrics;
  log?: Logger;
  leaseFraction?: number;
  leaseTtlMs?: number;
  logSample?: number;
  overrides?: Record<string, Partial<Policy>>;
}

const hashKey = (s: string) => createHash("sha1").update(s).digest("base64url").slice(0, 16);

export interface Principal {
  /** raw principal value; hashed before it becomes part of a key (no PII or addresses in Redis keys) */
  key: string;
  workspaceId?: string;
}

interface Lease {
  tokens: number;
  until: number;
  last: Verdict;
}

/**
 * The one entry point for every limit decision. Responsibilities:
 *  - resolve the policy's effective numbers (plan tier, RATE_LIMIT_SCALE)
 *  - pick the algorithm, spend from the local lease tier when allowed (hot, non-security GCRA policies only)
 *  - apply admin allow/deny lists (cached locally, refreshed every few seconds)
 *  - apply the policy's failure mode when the shared store is unavailable
 *  - count outcomes (bounded labels: policy id x outcome)
 */
export class RateLimiter {
  private readonly store: Store;
  private readonly fallback: Store;
  private readonly now: () => number;
  private readonly scale: number;
  private readonly leases = new Map<string, Lease>();
  private lists: { allow: Map<string, number>; deny: Map<string, number> } = { allow: new Map(), deny: new Map() };
  private listTimer?: ReturnType<typeof setInterval>;
  private limitedCount = 0;

  constructor(private readonly o: LimiterOptions) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
    this.fallback = o.fallback ?? (o.store.kind === "memory" ? o.store : new MemoryStore(this.now));
    this.scale = o.scale ?? 1;
  }

  /** registry lookup with per-instance overrides (config can retune a policy, e.g. socket burst sizes) */
  policy(id: string): Policy {
    const base = policyOf(id);
    const o = this.o.overrides?.[id];
    return o ? { ...base, ...o } : base;
  }

  get storeKind() {
    return this.store.kind;
  }

  /** start refreshing the admin lists (every 5 s) */
  startLists(everyMs = 5000) {
    const load = async () => {
      try {
        const [a, d] = await Promise.all([this.store.listAll("allow"), this.store.listAll("deny")]);
        this.lists = { allow: new Map(a.map((x) => [x.entry, x.expiresAt])), deny: new Map(d.map((x) => [x.entry, x.expiresAt])) };
      } catch {
        /* keep the last good copy */
      }
    };
    void load();
    this.listTimer = setInterval(load, everyMs);
    this.listTimer.unref();
  }

  stop() {
    if (this.listTimer) clearInterval(this.listTimer);
  }

  /** Effective numbers for a policy and workspace. */
  async effective(p: Policy, workspaceId?: string): Promise<{ limit: number; burst: number }> {
    let limit = p.limit;
    if (p.tiers && workspaceId && this.o.tierOf) {
      const t = p.tiers[await this.o.tierOf(workspaceId)];
      if (t !== undefined) limit = t;
    }
    const ratio = limit / p.limit;
    const s = p.algo === "concurrency" ? 1 : this.scale;
    return { limit: Math.max(1, Math.round(limit * s)), burst: Math.max(1, Math.round((p.burst ?? p.limit) * ratio * s)) };
  }

  private penaltyOf(p: Policy): PenaltyConfig | undefined {
    if (!p.penalty) return undefined;
    return { ...DEFAULT_PENALTY, ...(typeof p.penalty === "object" ? p.penalty : {}) };
  }
  private strikeConfig(p: Policy, limit: number): PenaltyConfig {
    return { ...DEFAULT_PENALTY, threshold: limit, windowMs: p.windowSec * 1000 };
  }

  private tag(p: Policy, principal: string) {
    return `${p.id}:${hashKey(principal)}`;
  }

  private note(policy: string, outcome: Outcome, keyTag?: string) {
    this.o.metrics?.decision(policy, outcome);
    if (outcome === "limited" || outcome === "blocked") {
      if (keyTag) void this.store.noteLimited(policy, keyTag.split(":")[1] ?? "").catch(() => {});
      if (++this.limitedCount % (this.o.logSample ?? 100) === 1) this.o.log?.info("rate limited", { policy, outcome, sample_every: this.o.logSample ?? 100 });
    }
  }

  private listed(kind: "allow" | "deny", entries: string[]): string | null {
    const now = this.now();
    const m = this.lists[kind];
    for (const e of entries) {
      const exp = m.get(e);
      if (exp !== undefined && exp > now) return e;
    }
    return null;
  }

  /** admin hooks update the local copy immediately so the node that made the change enforces it without waiting for the refresh */
  async refreshLists() {
    const [a, d] = await Promise.all([this.store.listAll("allow"), this.store.listAll("deny")]);
    this.lists = { allow: new Map(a.map((x) => [x.entry, x.expiresAt])), deny: new Map(d.map((x) => [x.entry, x.expiresAt])) };
  }

  /**
   * One decision. `entities` are the admin-list identities of the caller (`ip:1.2.3.4`, `ws:ws_..`, `user:mem_..`), checked once per call
   * when given. `idempotencyKey`: a repeat of the same key inside the policy's window is waved through without spending again.
   */
  async check(policyId: string, principal: Principal, o: { cost?: number; entities?: string[]; idempotencyKey?: string } = {}): Promise<Decision> {
    const p = this.policy(policyId);
    const eff = await this.effective(p, principal.workspaceId);
    const base = { policy: p.id, limit: eff.limit, windowSec: p.windowSec };
    const cost = o.cost ?? p.cost ?? 1;

    if (o.entities?.length) {
      if (this.listed("allow", o.entities)) {
        this.note(p.id, "allowlisted");
        return { ...base, allowed: true, outcome: "allowlisted", remaining: eff.limit, retryAfterMs: 0, resetMs: 0, shed: false };
      }
      const denied = this.listed("deny", o.entities);
      if (denied) {
        this.note(p.id, "denylisted");
        return { ...base, allowed: false, outcome: "denylisted", remaining: 0, retryAfterMs: 60_000, resetMs: 60_000, shed: false };
      }
    }

    const tag = this.tag(p, principal.key);
    if (o.idempotencyKey) {
      try {
        const first = await this.store.once(`${tag}:idem:${hashKey(o.idempotencyKey)}`, p.windowSec * 1000);
        if (!first) {
          this.note(p.id, "idempotent");
          return { ...base, allowed: true, outcome: "idempotent", remaining: eff.limit, retryAfterMs: 0, resetMs: 0, shed: false };
        }
      } catch {
        /* if the store is down the normal path below decides */
      }
    }

    try {
      const v = await this.run(p, tag, eff, cost, this.store);
      return this.finish(p, base, v, tag, v.leased ? "allowed" : undefined);
    } catch (e) {
      if (!(e instanceof StoreUnavailable)) throw e;
      if (p.onFail === "closed") {
        this.note(p.id, "fail_closed");
        return { ...base, allowed: false, outcome: "fail_closed", remaining: 0, retryAfterMs: 1000 + Math.floor(Math.random() * 2000), resetMs: 0, shed: true };
      }
      const v = await this.run(p, tag, eff, cost, this.fallback);
      this.note(p.id, v.allowed ? "fail_open" : "limited", tag);
      return { ...base, allowed: v.allowed, outcome: v.allowed ? "fail_open" : "limited", remaining: v.remaining, retryAfterMs: v.retryAfterMs, resetMs: v.resetMs, shed: false };
    }
  }

  private finish(p: Policy, base: { policy: string; limit: number; windowSec: number }, v: Verdict, tag: string, _o?: string): Decision {
    const outcome: Outcome = v.allowed ? "allowed" : v.blocked ? "blocked" : "limited";
    this.note(p.id, outcome, tag);
    return { ...base, allowed: v.allowed, outcome, remaining: v.remaining, retryAfterMs: v.retryAfterMs, resetMs: v.resetMs, shed: false };
  }

  private async run(p: Policy, tag: string, eff: { limit: number; burst: number }, cost: number, store: Store): Promise<Verdict> {
    switch (p.algo) {
      case "gcra": {
        const params: GcraParams = { emissionMs: (p.windowSec * 1000) / eff.limit, burst: eff.burst, cost };
        if (p.lease && !p.penalty && store === this.store && store.kind === "redis" && (this.o.leaseFraction ?? 0.1) > 0) return this.leased(tag, params, store);
        return store.gcra(tag, params, this.penaltyOf(p));
      }
      case "window":
        return store.window(tag, { limit: eff.limit, windowMs: p.windowSec * 1000, cost }, this.penaltyOf(p));
      case "strike": {
        const left = await store.blockedFor(tag, this.strikeConfig(p, eff.limit));
        return left > 0 ? { allowed: false, remaining: 0, retryAfterMs: left, resetMs: left, blocked: true } : { allowed: true, remaining: eff.limit, retryAfterMs: 0, resetMs: 0 };
      }
      case "concurrency":
        throw new Error(`policy ${p.id} is a concurrency policy; use acquire()`);
    }
  }

  /**
   * Local lease tier. Instead of one Redis call per request, take a small batch of tokens (a fraction of the burst) from the shared
   * bucket in ONE call and spend them locally until they run out or expire. The tokens are deducted from the shared bucket when leased,
   * so the cluster can never admit more than limit + burst; the price is under-admission: tokens leased by a node and not spent before
   * the lease expires are lost, at most (nodes x batch) per lease TTL. Security policies (penalty, fail-closed) never use it.
   */
  private readonly leaseFlight = new Map<string, Promise<{ granted: boolean; verdict: Verdict }>>();

  private async leased(tag: string, params: GcraParams, store: Store): Promise<Verdict> {
    for (;;) {
      const now = this.now();
      const l = this.leases.get(tag);
      if (l && l.until > now && l.tokens >= params.cost) {
        l.tokens -= params.cost;
        this.o.metrics?.lease("hit");
        return { allowed: true, remaining: Math.floor(l.tokens), retryAfterMs: 0, resetMs: l.last.resetMs, leased: true };
      }
      // single flight: a burst of concurrent requests for one key shares ONE lease call instead of each leasing (and wasting) a batch
      let f = this.leaseFlight.get(tag);
      if (!f) {
        f = this.fetchLease(tag, params, store).finally(() => this.leaseFlight.delete(tag));
        this.leaseFlight.set(tag, f);
      }
      const r = await f;
      if (!r.granted) return r.verdict;
    }
  }

  private async fetchLease(tag: string, params: GcraParams, store: Store): Promise<{ granted: boolean; verdict: Verdict }> {
    const batch = Math.max(0, Math.floor(params.burst * (this.o.leaseFraction ?? 0.1)));
    const r = await store.gcraLease(tag, params, params.cost + batch);
    if (r.granted === 0) {
      this.leases.delete(tag);
      this.o.metrics?.lease("deny");
      return { granted: false, verdict: r.verdict };
    }
    this.o.metrics?.lease("grant");
    this.leases.delete(tag);
    this.leases.set(tag, { tokens: r.granted, until: this.now() + (this.o.leaseTtlMs ?? 1000), last: r.verdict });
    if (this.leases.size > 20_000) this.leases.delete(this.leases.keys().next().value as string);
    return { granted: true, verdict: r.verdict };
  }

  /* ---------- strikes (auth failures) ---------- */

  /** Is this key currently blocked by a strike policy? Returns the remaining block in ms (0 = fine). Fail-closed policies throw StoreUnavailable-as-block. */
  async blockedFor(policyId: string, key: string): Promise<{ blockedMs: number; unavailable: boolean }> {
    const p = this.policy(policyId);
    const eff = await this.effective(p);
    try {
      return { blockedMs: await this.store.blockedFor(this.tag(p, key), this.strikeConfig(p, eff.limit)), unavailable: false };
    } catch (e) {
      if (!(e instanceof StoreUnavailable)) throw e;
      if (p.onFail === "closed") return { blockedMs: 0, unavailable: true };
      return { blockedMs: await this.fallback.blockedFor(this.tag(p, key), this.strikeConfig(p, eff.limit)), unavailable: false };
    }
  }

  /** Record one failure (bad password, bad signature). Returns the block that now applies, in ms. */
  async strike(policyId: string, key: string): Promise<number> {
    const p = this.policy(policyId);
    const eff = await this.effective(p);
    const cfg = this.strikeConfig(p, eff.limit);
    try {
      const ms = await this.store.strike(this.tag(p, key), cfg);
      if (ms > 0) this.note(p.id, "blocked", this.tag(p, key));
      return ms;
    } catch (e) {
      if (!(e instanceof StoreUnavailable)) throw e;
      return this.fallback.strike(this.tag(p, key), cfg);
    }
  }

  async clearStrikes(policyId: string, key: string): Promise<void> {
    const p = this.policy(policyId);
    const tag = this.tag(p, key);
    await this.store.clearPenalty(tag).catch(() => {});
    if (this.fallback !== this.store) await this.fallback.clearPenalty(tag);
  }

  /* ---------- concurrency ---------- */

  /** Take a lease. ok=false: cap reached. `unavailable`: store down (caller applies the policy's failure mode via p.onFail). */
  async acquire(policyId: string, key: string, leaseId: string, workspaceId?: string, maxOverride?: number): Promise<{ ok: boolean; count: number; max: number; unavailable?: boolean }> {
    const p = this.policy(policyId);
    const eff = await this.effective(p, workspaceId);
    if (maxOverride) eff.limit = maxOverride;
    const tag = this.tag(p, key);
    try {
      const r = await this.store.acquire(tag, leaseId, eff.limit, p.ttlMs ?? 60_000);
      this.note(p.id, r.ok ? "allowed" : "shed", tag);
      return { ...r, max: eff.limit };
    } catch (e) {
      if (!(e instanceof StoreUnavailable)) throw e;
      if (p.onFail === "closed") {
        this.note(p.id, "fail_closed");
        return { ok: false, count: 0, max: eff.limit, unavailable: true };
      }
      const r = await this.fallback.acquire(tag, leaseId, eff.limit, p.ttlMs ?? 60_000);
      this.note(p.id, r.ok ? "fail_open" : "shed", tag);
      return { ...r, max: eff.limit, unavailable: true };
    }
  }

  async release(policyId: string, key: string, leaseId: string): Promise<void> {
    const p = this.policy(policyId);
    const tag = this.tag(p, key);
    await this.store.release(tag, leaseId).catch(() => {});
    if (this.fallback !== this.store) await this.fallback.release(tag, leaseId);
  }

  async renew(policyId: string, key: string, leaseIds: string[]): Promise<void> {
    const p = this.policy(policyId);
    const tag = this.tag(p, key);
    await this.store.renew(tag, leaseIds, p.ttlMs ?? 60_000).catch(() => {});
  }

  /** Run `fn` under a concurrency cap; the lease is always released. Throws {shed:true} style error through `onShed`. */
  async withLease<T>(policyId: string, key: string, workspaceId: string | undefined, fn: () => Promise<T>, onShed: (d: { count: number; max: number; unavailable?: boolean }) => never): Promise<T> {
    const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const r = await this.acquire(policyId, key, id, workspaceId);
    if (!r.ok) onShed(r);
    try {
      return await fn();
    } finally {
      await this.release(policyId, key, id);
    }
  }

  /* ---------- pacing (outbound sends) ---------- */

  /**
   * Reserve the next send slot for a paced policy. Instead of rejecting, returns how long the caller should wait. `queueMax` bounds the
   * backlog per key (units beyond the burst); past it `full` is true and the caller should apply backpressure (429 to that tenant).
   */
  async pace(policyId: string, key: string, o: { workspaceId?: string; queueMax?: number; cost?: number } = {}): Promise<{ waitMs: number; full: boolean }> {
    const p = this.policy(policyId);
    const eff = await this.effective(p, o.workspaceId);
    const Q = o.queueMax ?? 1000;
    const params: GcraParams = { emissionMs: (p.windowSec * 1000) / eff.limit, burst: eff.burst + Q, cost: o.cost ?? 1 };
    const tag = this.tag(p, key);
    try {
      const v = await this.store.gcra(tag, params);
      if (!v.allowed) return { waitMs: v.retryAfterMs, full: true };
      return { waitMs: Math.max(0, Math.ceil(v.resetMs - eff.burst * params.emissionMs)), full: false };
    } catch (e) {
      if (!(e instanceof StoreUnavailable)) throw e;
      const v = await this.fallback.gcra(tag, params);
      return { waitMs: v.allowed ? Math.max(0, Math.ceil(v.resetMs - eff.burst * params.emissionMs)) : v.retryAfterMs, full: !v.allowed };
    }
  }

  /* ---------- admin ---------- */

  get shared(): Store {
    return this.store;
  }
}
