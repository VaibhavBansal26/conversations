/** Shared types for the rate limiter. See docs/RATE-LIMITING.md. */

export type Tier = "free" | "pro" | "business";
export const TIERS: Tier[] = ["free", "pro", "business"];

export type KeyBy = "ip" | "user" | "workspace" | "apiKey" | "visitor" | "socket" | "composite";
export type Algo = "gcra" | "window" | "concurrency" | "strike";

export interface PenaltyConfig {
  /** violations inside `windowMs` that trigger a block */
  threshold: number;
  windowMs: number;
  /** block durations in seconds, escalating one step per block (1m -> 5m -> 30m -> 24h) */
  stepsSec: number[];
  /** one escalation level is forgiven after this long without a violation */
  decayMs: number;
}

export const DEFAULT_PENALTY: PenaltyConfig = { threshold: 10, windowMs: 10 * 60_000, stepsSec: [60, 300, 1800, 86400], decayMs: 6 * 3600_000 };

export interface Policy {
  id: string;
  description: string;
  keyBy: KeyBy;
  algo: Algo;
  /** requests (or cost units) allowed per `windowSec` */
  limit: number;
  windowSec: number;
  /** GCRA only: how many may arrive back to back. Defaults to `limit`. */
  burst?: number;
  /** default cost of one call */
  cost?: number;
  /** what to do when the shared store is unreachable */
  onFail: "open" | "closed";
  /** per-plan limit (same unit as `limit`); missing tier = `limit` */
  tiers?: Partial<Record<Tier, number>>;
  /** escalate repeated violations into a temporary block */
  penalty?: boolean | Partial<PenaltyConfig>;
  /** use the local token-lease tier (GCRA only; never for security policies) */
  lease?: boolean;
  /** concurrency policies: lease time-to-live */
  ttlMs?: number;
}

export interface Verdict {
  allowed: boolean;
  /** units left after this call (0 when denied) */
  remaining: number;
  retryAfterMs: number;
  /** ms until the bucket is completely full again */
  resetMs: number;
  /** denied because of an active penalty block (not because of the rate itself) */
  blocked?: boolean;
  /** served from the local lease tier, no store call */
  leased?: boolean;
}

export interface GcraParams {
  /** ms per unit */
  emissionMs: number;
  burst: number;
  cost: number;
}

export interface WindowParams {
  limit: number;
  windowMs: number;
  cost: number;
}

export interface Store {
  readonly kind: "memory" | "redis";
  gcra(key: string, p: GcraParams, penalty?: PenaltyConfig): Promise<Verdict>;
  /** take up to `want` units (at least p.cost) in one call; granted = 0 when denied */
  gcraLease(key: string, p: GcraParams, want: number): Promise<{ granted: number; verdict: Verdict }>;
  window(key: string, p: WindowParams, penalty?: PenaltyConfig): Promise<Verdict>;
  /** concurrency lease: ok=false when `max` leases are already live */
  acquire(key: string, id: string, max: number, ttlMs: number): Promise<{ ok: boolean; count: number }>;
  release(key: string, id: string): Promise<void>;
  renew(key: string, ids: string[], ttlMs: number): Promise<void>;
  count(key: string): Promise<number>;
  /** first caller within ttl wins (idempotency keys) */
  once(key: string, ttlMs: number): Promise<boolean>;
  /** admin allow/deny lists with TTL */
  listAdd(kind: "allow" | "deny", entry: string, ttlMs: number, note?: string): Promise<void>;
  listRemove(kind: "allow" | "deny", entry: string): Promise<boolean>;
  listAll(kind: "allow" | "deny"): Promise<{ entry: string; expiresAt: number; note?: string }[]>;
  listHas(kind: "allow" | "deny", entries: string[]): Promise<string | null>;
  /** recently limited keys (hashed), for the admin view */
  noteLimited(policy: string, keyHash: string): Promise<void>;
  recentlyLimited(limit: number): Promise<{ policy: string; key: string; count: number; last: number }[]>;
  penaltyBoxSize(): Promise<number>;
  clearPenalty(key: string): Promise<void>;
  /** record one failure against a penalty box (auth failures); returns the block that results, if any */
  strike(key: string, penalty: PenaltyConfig): Promise<number>;
  /** ms the key is blocked for (0 = not blocked) */
  blockedFor(key: string, penalty: PenaltyConfig): Promise<number>;
  close(): Promise<void>;
}
