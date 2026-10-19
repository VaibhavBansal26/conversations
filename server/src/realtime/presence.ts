type Timer = ReturnType<typeof setTimeout>;

export interface PresenceHooks {
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

/**
 * Refcounted presence. A key (a member seat or a visitor contact) is online while it has at least one
 * live socket; after its last socket drops it stays "online" for a grace period so page reloads and
 * flaky networks do not flap the status.
 */
export class Presence {
  private sockets = new Map<string, Set<string>>();
  private timers = new Map<string, Timer>();
  private online = new Set<string>();
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(
    private readonly graceMs: number,
    private readonly onChange: (scope: string, id: string, online: boolean) => void = () => {},
    hooks: PresenceHooks = {},
  ) {
    this.setTimer = hooks.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer = hooks.clearTimer ?? clearTimeout;
  }

  private k = (scope: string, id: string) => `${scope}\u0000${id}`;

  connect(scope: string, id: string, socketId: string): void {
    const key = this.k(scope, id);
    const t = this.timers.get(key);
    if (t) {
      this.clearTimer(t);
      this.timers.delete(key);
    }
    const set = this.sockets.get(key) ?? new Set();
    set.add(socketId);
    this.sockets.set(key, set);
    if (!this.online.has(key)) {
      this.online.add(key);
      this.onChange(scope, id, true);
    }
  }

  disconnect(scope: string, id: string, socketId: string): void {
    const key = this.k(scope, id);
    const set = this.sockets.get(key);
    if (!set || !set.delete(socketId)) return;
    if (set.size > 0) return;
    this.sockets.delete(key);
    const t = this.setTimer(() => {
      this.timers.delete(key);
      if (this.sockets.has(key)) return;
      this.online.delete(key);
      this.onChange(scope, id, false);
    }, this.graceMs);
    this.timers.set(key, t);
  }

  isOnline(scope: string, id: string): boolean {
    return this.online.has(this.k(scope, id));
  }

  /** Number of live sockets (excludes the grace period). */
  socketCount(scope: string, id: string): number {
    return this.sockets.get(this.k(scope, id))?.size ?? 0;
  }

  onlineIds(scope: string, prefix = ""): string[] {
    const head = `${scope}\u0000${prefix}`;
    return [...this.online].filter((k) => k.startsWith(head)).map((k) => k.slice(scope.length + 1));
  }
}
