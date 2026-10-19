import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Logger } from "./logger.js";
import type { RealtimeBus } from "./realtime/bus.js";
import type { Presence } from "./realtime/presence.js";
import type { EmailProvider, SmsProvider, Storage } from "./providers/types.js";
import type { AiProvider } from "./ai/provider.js";
import type { RateLimiter } from "./util/ratelimit.js";

/** Everything a service needs, passed explicitly. Tests build one with fakes (see tests/helpers). */
export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  /** Mutable on purpose: tests swap it to advance time. Always call it, never capture the result. */
  clock: () => Date;
  bus: RealtimeBus;
  presence: Presence;
  sms: SmsProvider;
  email: EmailProvider;
  storage: Storage;
  ai: AiProvider;
  limiters: Map<string, RateLimiter>;
  /** Fire-and-forget side effects (triage, notifications). Tests await `settle()`. */
  background: BackgroundTracker;
}

export class BackgroundTracker {
  private pending = new Set<Promise<unknown>>();
  constructor(private readonly onError: (e: unknown) => void) {}

  run(fn: () => Promise<unknown> | unknown): void {
    const p = Promise.resolve()
      .then(fn)
      .catch(this.onError)
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export const nowIso = (ctx: AppContext): string => ctx.clock().toISOString();
