import type { RedisHub } from "./redis.js";

/**
 * Short-TTL cache for hot reads (seat lookups, widget config). Each node keeps its own copy; with Redis, an invalidation is
 * published so every node drops the key immediately instead of waiting out the TTL.
 */
export interface Cache {
  wrap<T>(key: string, loader: () => Promise<T>): Promise<T>;
  /** Drop one key (or every key starting with `prefix` when called with a trailing `*`) on this and every other node. */
  invalidate(keyOrPrefix: string): Promise<void>;
  readonly hits: number;
  readonly misses: number;
}

const CHANNEL = "cache:invalidate";

export class LocalCache implements Cache {
  private readonly m = new Map<string, { v: unknown; exp: number }>();
  hits = 0;
  misses = 0;
  private hub: RedisHub | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly max = 5000,
  ) {}

  /** Join the cluster-wide invalidation channel. */
  async attach(hub: RedisHub) {
    this.hub = hub;
    await hub.subscribe(CHANNEL, (msg) => this.drop(msg));
  }

  private drop(k: string) {
    if (k.endsWith("*")) {
      const p = k.slice(0, -1);
      for (const key of this.m.keys()) if (key.startsWith(p)) this.m.delete(key);
    } else this.m.delete(k);
  }

  async wrap<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return loader();
    const hit = this.m.get(key);
    if (hit && hit.exp > this.now()) {
      this.hits++;
      return hit.v as T;
    }
    this.misses++;
    const v = await loader();
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(key, { v, exp: this.now() + this.ttlMs });
    return v;
  }

  async invalidate(keyOrPrefix: string) {
    this.drop(keyOrPrefix);
    if (this.hub) await this.hub.publish(CHANNEL, keyOrPrefix).catch(() => 0);
  }
}
