import { gcra, gcraLease, penaltyRemaining, penaltyViolation, slidingWindow, type GcraState, type PenaltyState, type WindowState } from "./algorithms.js";
import type { GcraParams, PenaltyConfig, Store, Verdict, WindowParams } from "./types.js";

interface Entry<T> {
  v: T;
  /** ms epoch after which the entry is garbage */
  exp: number;
}

/** Bounded LRU map with TTL. Deleting and re-inserting on access keeps recently used keys at the tail. */
class Lru<T> {
  private readonly m = new Map<string, Entry<T>>();
  constructor(private readonly max: number) {}
  get(k: string, now: number): T | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp <= now) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: T, exp: number) {
    this.m.delete(k);
    this.m.set(k, { v, exp });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  delete(k: string) {
    this.m.delete(k);
  }
  sweep(now: number) {
    for (const [k, e] of this.m) if (e.exp <= now) this.m.delete(k);
  }
  get size() {
    return this.m.size;
  }
  entries() {
    return this.m.entries();
  }
}

/**
 * In-memory store: same semantics as the Redis one (the algorithms are shared), bounded by an LRU and swept periodically.
 * Used in development and tests, when REDIS_URL is unset, and as the per-node fallback when Redis is unreachable.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private readonly g: Lru<GcraState>;
  private readonly w: Lru<WindowState>;
  private readonly p = new Lru<PenaltyState>(20_000);
  private readonly conc = new Map<string, Map<string, number>>();
  private readonly once_ = new Lru<true>(50_000);
  private readonly lists = { allow: new Map<string, { exp: number; note?: string }>(), deny: new Map<string, { exp: number; note?: string }>() };
  private readonly limited = new Map<string, { policy: string; key: string; count: number; last: number }>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly now: () => number = Date.now,
    maxKeys = 100_000,
    sweepMs = 30_000,
  ) {
    this.g = new Lru(maxKeys);
    this.w = new Lru(maxKeys);
    if (sweepMs > 0) {
      this.timer = setInterval(() => this.sweep(), sweepMs);
      this.timer.unref();
    }
  }

  sweep() {
    const now = this.now();
    this.g.sweep(now);
    this.w.sweep(now);
    this.p.sweep(now);
    this.once_.sweep(now);
    for (const [k, m] of this.conc) {
      for (const [id, exp] of m) if (exp <= now) m.delete(id);
      if (!m.size) this.conc.delete(k);
    }
    for (const kind of ["allow", "deny"] as const) for (const [e, v] of this.lists[kind]) if (v.exp <= now) this.lists[kind].delete(e);
  }

  /** number of live keys, for tests and metrics */
  get size() {
    return this.g.size + this.w.size + this.p.size;
  }

  private blocked(key: string, now: number, c?: PenaltyConfig): Verdict | undefined {
    if (!c) return undefined;
    const rem = penaltyRemaining(this.p.get(key, now), now);
    return rem > 0 ? { allowed: false, remaining: 0, retryAfterMs: rem, resetMs: rem, blocked: true } : undefined;
  }
  private violate(key: string, now: number, c?: PenaltyConfig) {
    if (!c) return;
    const next = penaltyViolation(this.p.get(key, now), now, c);
    this.p.set(key, next, now + c.decayMs * (c.stepsSec.length + 1));
  }

  async gcra(key: string, p: GcraParams, penalty?: PenaltyConfig): Promise<Verdict> {
    const now = this.now();
    const pk = `${key}|pen`;
    const b = this.blocked(pk, now, penalty);
    if (b) return b;
    const r = gcra(this.g.get(key, now), now, p);
    if (r.verdict.allowed) this.g.set(key, r.next!, now + r.verdict.resetMs + Math.ceil(p.emissionMs) + 1000);
    else this.violate(pk, now, penalty);
    return r.verdict;
  }

  async gcraLease(key: string, p: GcraParams, want: number) {
    const now = this.now();
    const r = gcraLease(this.g.get(key, now), now, p, want);
    if (r.granted > 0) this.g.set(key, r.next!, now + r.verdict.resetMs + Math.ceil(p.emissionMs) + 1000);
    return { granted: r.granted, verdict: r.verdict };
  }

  async window(key: string, p: WindowParams, penalty?: PenaltyConfig): Promise<Verdict> {
    const now = this.now();
    const pk = `${key}|pen`;
    const b = this.blocked(pk, now, penalty);
    if (b) return b;
    const r = slidingWindow(this.w.get(key, now), now, p);
    if (r.verdict.allowed) this.w.set(key, r.next, now + p.windowMs * 2 + 1000);
    else this.violate(pk, now, penalty);
    return r.verdict;
  }

  async acquire(key: string, id: string, max: number, ttlMs: number) {
    const now = this.now();
    let m = this.conc.get(key);
    if (!m) this.conc.set(key, (m = new Map()));
    for (const [i, exp] of m) if (exp <= now) m.delete(i);
    if (m.has(id)) {
      m.set(id, now + ttlMs);
      return { ok: true, count: m.size };
    }
    if (m.size >= max) return { ok: false, count: m.size };
    m.set(id, now + ttlMs);
    return { ok: true, count: m.size };
  }
  async release(key: string, id: string) {
    const m = this.conc.get(key);
    m?.delete(id);
    if (m && !m.size) this.conc.delete(key);
  }
  async renew(key: string, ids: string[], ttlMs: number) {
    const m = this.conc.get(key);
    if (!m) return;
    const now = this.now();
    for (const id of ids) if (m.has(id)) m.set(id, now + ttlMs);
  }
  async count(key: string) {
    const now = this.now();
    const m = this.conc.get(key);
    if (!m) return 0;
    let n = 0;
    for (const exp of m.values()) if (exp > now) n++;
    return n;
  }

  async once(key: string, ttlMs: number) {
    const now = this.now();
    if (this.once_.get(key, now)) return false;
    this.once_.set(key, true, now + ttlMs);
    return true;
  }

  async listAdd(kind: "allow" | "deny", entry: string, ttlMs: number, note?: string) {
    this.lists[kind].set(entry, { exp: this.now() + ttlMs, note });
  }
  async listRemove(kind: "allow" | "deny", entry: string) {
    return this.lists[kind].delete(entry);
  }
  async listAll(kind: "allow" | "deny") {
    const now = this.now();
    return [...this.lists[kind]].filter(([, v]) => v.exp > now).map(([entry, v]) => ({ entry, expiresAt: v.exp, note: v.note }));
  }
  async listHas(kind: "allow" | "deny", entries: string[]) {
    const now = this.now();
    for (const e of entries) {
      const v = this.lists[kind].get(e);
      if (v && v.exp > now) return e;
    }
    return null;
  }

  async noteLimited(policy: string, keyHash: string) {
    const k = `${policy}|${keyHash}`;
    const cur = this.limited.get(k);
    this.limited.set(k, { policy, key: keyHash, count: (cur?.count ?? 0) + 1, last: this.now() });
    if (this.limited.size > 500) this.limited.delete(this.limited.keys().next().value as string);
  }
  async recentlyLimited(limit: number) {
    return [...this.limited.values()].sort((a, b) => b.last - a.last).slice(0, limit);
  }
  async penaltyBoxSize() {
    const now = this.now();
    let n = 0;
    for (const [, e] of this.p.entries()) if (e.exp > now && e.v.until > now) n++;
    return n;
  }
  async strike(key: string, c: PenaltyConfig) {
    const now = this.now();
    const pk = `${key}|pen`;
    const next = penaltyViolation(this.p.get(pk, now), now, c);
    this.p.set(pk, next, now + c.decayMs * (c.stepsSec.length + 1));
    return penaltyRemaining(next, now);
  }
  async blockedFor(key: string, _c?: PenaltyConfig) {
    const now = this.now();
    return penaltyRemaining(this.p.get(`${key}|pen`, now), now);
  }
  async clearPenalty(key: string) {
    this.p.delete(`${key}|pen`);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
  }
}
