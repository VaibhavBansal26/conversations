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
  private readonly handlers = new Map<string, Set<(msg: string) => void>>();

  constructor(
    readonly url: string,
    private readonly log: Logger,
  ) {
    this.client = this.make();
    this.subscriber = this.make();
    this.subscriber.on("message", (channel: string, msg: string) => this.handlers.get(channel)?.forEach((h) => h(msg)));
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
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(handler);
  }

  publish(channel: string, msg: string): Promise<number> {
    return this.client.publish(channel, msg);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.client.quit(), this.subscriber.quit(), ...this.extras.map((r) => r.quit())]);
    for (const r of [this.client, this.subscriber, ...this.extras]) r.disconnect();
  }
}
