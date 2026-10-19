/** In-memory token bucket keyed by an arbitrary string. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, cost = 1): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(t);
    return ok;
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets) if (t - b.at > (this.capacity / this.refillPerSec) * 1000) this.buckets.delete(k);
  }
}
