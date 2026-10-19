import { randomUUID } from "node:crypto";
import type { RedisHub } from "./redis.js";

export interface Locks {
  /** Run fn only if the named lock is free; returns undefined when another node holds it. */
  withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined>;
}

export class MemoryLocks implements Locks {
  private readonly held = new Set<string>();
  async withLock<T>(name: string, _ttlMs: number, fn: () => Promise<T>) {
    if (this.held.has(name)) return undefined;
    this.held.add(name);
    try {
      return await fn();
    } finally {
      this.held.delete(name);
    }
  }
}

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/** `SET NX PX` lease with a compare-and-delete release, so singleton schedulers run on exactly one node at a time. */
export class RedisLocks implements Locks {
  constructor(private readonly hub: RedisHub) {
    hub.client.defineCommand("lockRelease", { numberOfKeys: 1, lua: RELEASE });
  }
  async withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>) {
    const token = randomUUID();
    const key = `lock:${name}`;
    const ok = await this.hub.client.set(key, token, "PX", ttlMs, "NX");
    if (ok !== "OK") return undefined;
    try {
      return await fn();
    } finally {
      await (this.hub.client as unknown as { lockRelease(k: string, t: string): Promise<number> }).lockRelease(key, token).catch(() => 0);
    }
  }
}
