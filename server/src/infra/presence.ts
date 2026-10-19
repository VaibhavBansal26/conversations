import { Presence } from "../realtime/presence.js";
import type { RedisHub } from "./redis.js";

export type PresenceChange = (scope: string, id: string, online: boolean) => void;

/** Async presence facade: in-memory for one node, Redis-backed (refcounted across nodes) when REDIS_URL is set. */
export interface PresenceService {
  connect(scope: string, id: string, socketId: string): Promise<void>;
  disconnect(scope: string, id: string, socketId: string): Promise<void>;
  isOnline(scope: string, id: string): Promise<boolean>;
  onlineIds(scope: string): Promise<string[]>;
  /** Drop a seat from presence immediately, skipping the grace period (tests, admin tooling). */
  forceOffline(scope: string, id: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryPresenceService implements PresenceService {
  constructor(readonly engine: Presence) {}
  async connect(scope: string, id: string, socketId: string) {
    this.engine.connect(scope, id, socketId);
  }
  async disconnect(scope: string, id: string, socketId: string) {
    this.engine.disconnect(scope, id, socketId);
  }
  async isOnline(scope: string, id: string) {
    return this.engine.isOnline(scope, id);
  }
  async onlineIds(scope: string) {
    return this.engine.onlineIds(scope);
  }
  async forceOffline(scope: string, id: string) {
    this.engine.reset(scope, id);
  }
  async close() {}
}

const SEP = "\u0000";

// Atomic: drop expired sockets, add ours, and claim the "announced online" flag if the seat just came online.
const CONNECT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 3)
redis.call('DEL', KEYS[3])
return redis.call('HSETNX', KEYS[2], ARGV[3], '1')
`;
// Atomic: returns 1 (and clears the flag) only for the single caller that observes "no live sockets, grace over".
const SWEEP = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) > 0 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
return redis.call('HDEL', KEYS[2], ARGV[1])
`;

/**
 * Presence refcounted across nodes. Each live socket is a member of a ZSET scored by its expiry time; nodes heartbeat their own
 * sockets, so connections of a crashed node simply expire. A seat is online while its ZSET is non-empty or its short "grace" key
 * exists. The node that wins the flag transition (HSETNX on connect, HDEL on sweep) is the one that announces the change, which
 * keeps announcements exactly-once without a coordinator.
 */
export class RedisPresenceService implements PresenceService {
  private readonly local = new Map<string, { scope: string; id: string; sockets: Set<string> }>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly beat: ReturnType<typeof setInterval>;

  constructor(
    private readonly hub: RedisHub,
    private readonly onChange: PresenceChange,
    private readonly opts: { nodeId: string; graceMs: number; ttlMs?: number },
  ) {
    hub.client.defineCommand("presConnect", { numberOfKeys: 3, lua: CONNECT });
    hub.client.defineCommand("presSweep", { numberOfKeys: 3, lua: SWEEP });
    const ttl = opts.ttlMs ?? 30_000;
    this.beat = setInterval(() => void this.heartbeat(ttl).catch(() => {}), Math.max(500, ttl / 3));
    this.beat.unref();
  }

  private ttl = () => this.opts.ttlMs ?? 30_000;
  private k = (scope: string, id: string) => `${scope}${SEP}${id}`;
  private zk = (key: string) => this.hub.k(`pres:z:${key}`);
  private gk = (key: string) => this.hub.k(`pres:g:${key}`);
  private fk = () => this.hub.k("pres:flag");
  private cmd = () => this.hub.client as unknown as { presConnect(...a: unknown[]): Promise<number>; presSweep(...a: unknown[]): Promise<number> };

  async connect(scope: string, id: string, socketId: string) {
    const key = this.k(scope, id);
    const entry = this.local.get(key) ?? { scope, id, sockets: new Set<string>() };
    entry.sockets.add(socketId);
    this.local.set(key, entry);
    const first = await this.cmd().presConnect(this.zk(key), this.fk(), this.gk(key), `${this.opts.nodeId}:${socketId}`, this.ttl(), key);
    if (first === 1) this.onChange(scope, id, true);
  }

  async disconnect(scope: string, id: string, socketId: string) {
    const key = this.k(scope, id);
    const entry = this.local.get(key);
    entry?.sockets.delete(socketId);
    if (entry && entry.sockets.size === 0) this.local.delete(key);
    await this.hub.client.zrem(this.zk(key), `${this.opts.nodeId}:${socketId}`);
    // grace: the seat stays "online" briefly so reloads and flaky networks do not flap
    await this.hub.client.set(this.gk(key), "1", "PX", Math.max(1, this.opts.graceMs));
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.sweepKey(key).catch(() => {});
    }, this.opts.graceMs + 20);
    t.unref();
    this.timers.add(t);
  }

  private async sweepKey(key: string) {
    const [scope, id] = key.split(SEP) as [string, string];
    const gone = await this.cmd().presSweep(this.zk(key), this.fk(), this.gk(key), key);
    if (gone === 1) this.onChange(scope, id, false);
  }

  private async heartbeat(ttl: number) {
    const pipe = this.hub.client.pipeline();
    const expiry = Date.now() + ttl;
    for (const [key, e] of this.local) for (const s of e.sockets) pipe.zadd(this.zk(key), "XX", expiry, `${this.opts.nodeId}:${s}`);
    await pipe.exec();
    // also converge seats whose node crashed (their sockets expired): any node may announce, exactly one wins
    const flagged = await this.hub.client.hkeys(this.fk());
    for (const key of flagged) if (!this.local.has(key)) await this.sweepKey(key);
  }

  async isOnline(scope: string, id: string) {
    const key = this.k(scope, id);
    const now = Date.now();
    await this.hub.client.zremrangebyscore(this.zk(key), "-inf", now);
    if ((await this.hub.client.zcard(this.zk(key))) > 0) return true;
    return (await this.hub.client.exists(this.gk(key))) === 1;
  }

  async onlineIds(scope: string) {
    const flagged = await this.hub.client.hkeys(this.fk());
    return flagged.filter((k) => k.startsWith(`${scope}${SEP}`)).map((k) => k.slice(scope.length + 1));
  }

  async forceOffline(scope: string, id: string) {
    const key = this.k(scope, id);
    this.local.delete(key);
    await this.hub.client.del(this.zk(key), this.gk(key));
    await this.hub.client.hdel(this.fk(), key);
  }

  async close() {
    clearInterval(this.beat);
    for (const t of this.timers) clearTimeout(t);
    const pipe = this.hub.client.pipeline();
    for (const [key, e] of this.local) for (const s of e.sockets) pipe.zrem(this.zk(key), `${this.opts.nodeId}:${s}`);
    await pipe.exec().catch(() => {});
  }
}
