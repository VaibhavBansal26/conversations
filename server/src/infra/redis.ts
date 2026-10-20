import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "../logger.js";

/**
 * Redis is optional. `RedisHub` owns the connections the app needs (commands, a dedicated subscriber, extra duplicates for the
 * Socket.IO adapter and BullMQ) so they are closed together on shutdown.
 */
export class RedisHub {
  readonly client: Redis;
  private readonly subscriber: Redis;
  private readonly extras: Redis[] = [];
  private readonly recovered = new Set<() => void>();
  /** called each time the connection comes back after having been lost */
  onRecovered(cb: () => void) {
    this.recovered.add(cb);
  }
  private readonly handlers = new Map<string, Set<(msg: string) => void>>();

  constructor(
    readonly url: string,
    private readonly log: Logger,
    readonly prefix = "conv",
  ) {
    this.client = this.make();
    // after an outage (restart, failover) in-flight pub/sub messages and ephemeral state are gone: tell the app so it can repair itself
    let lost = false;
    this.client.on("close", () => (lost = true));
    this.client.on("ready", () => {
      if (!lost) return;
      lost = false;
      for (const cb of this.recovered) {
        try {
          cb();
        } catch {
          /* a listener must not break the others */
        }
      }
    });
    this.subscriber = this.make();
    this.subscriber.on("message", (channel: string, msg: string) => this.handlers.get(channel)?.forEach((h) => h(msg)));
  }

  /** every key and channel this app touches goes through here */
  k(name: string): string {
    return `${this.prefix}:${name}`;
  }

  private make(opts: RedisOptions = {}): Redis {
    const r = new Redis(this.url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false, ...opts });
    r.on("error", (e: Error) => this.log.warn("redis error", { error: e.message }));
    return r;
  }

  /** A fresh connection (the Socket.IO adapter and BullMQ each need their own). */
  duplicate(opts: RedisOptions = {}): Redis {
    const r = this.make(opts);
    this.extras.push(r);
    return r;
  }

  async subscribe(channel: string, handler: (msg: string) => void): Promise<void> {
    channel = this.k(channel);
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(handler);
  }

  publish(channel: string, msg: string): Promise<number> {
    return this.client.publish(this.k(channel), msg);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // QUIT waits for the server; with Redis down it would hang shutdown, so give it a moment and then cut the connections
    await Promise.race([Promise.allSettled([this.client.quit(), this.subscriber.quit(), ...this.extras.map((r) => r.quit())]), new Promise((r) => setTimeout(r, 1500).unref())]);
    for (const r of [this.client, this.subscriber, ...this.extras]) r.disconnect();
  }
}
