import type { GcraParams, PenaltyConfig, Verdict, WindowParams } from "./types.js";

/**
 * Pure algorithm cores. The memory store calls these directly; the Redis Lua scripts are line-for-line ports (tests run both against the
 * same sequences). Everything is deterministic given `now`.
 */

export interface GcraState {
  /** theoretical arrival time, ms */
  tat: number;
}

/**
 * GCRA. A call of `cost` units is allowed when the bucket (capacity `burst` units, refilling one unit per `emissionMs`) holds enough.
 * `retryAfterMs` on denial is exact: the first instant at which the same call would succeed, assuming no other traffic.
 */
export function gcra(state: GcraState | undefined, now: number, p: GcraParams): { verdict: Verdict; next: GcraState | undefined } {
  const T = p.emissionMs;
  const tat = Math.max(state?.tat ?? 0, now);
  const newTat = tat + p.cost * T;
  const allowAt = newTat - p.burst * T;
  if (allowAt > now) {
    const remaining = Math.max(0, Math.floor((p.burst * T - (tat - now)) / T + 1e-9));
    return { verdict: { allowed: false, remaining, retryAfterMs: Math.ceil(allowAt - now), resetMs: Math.ceil(tat - now) }, next: state };
  }
  const remaining = Math.max(0, Math.floor((p.burst * T - (newTat - now)) / T + 1e-9));
  return { verdict: { allowed: true, remaining, retryAfterMs: 0, resetMs: Math.ceil(newTat - now) }, next: { tat: newTat } };
}

/** Take up to `want` units, at least `p.cost`. granted = 0 means denied. */
export function gcraLease(state: GcraState | undefined, now: number, p: GcraParams, want: number): { granted: number; verdict: Verdict; next: GcraState | undefined } {
  const T = p.emissionMs;
  const tat = Math.max(state?.tat ?? 0, now);
  const available = Math.max(0, Math.floor((p.burst * T - (tat - now)) / T + 1e-9));
  const granted = Math.min(want, available);
  if (granted < p.cost) {
    const r = gcra(state, now, p);
    return { granted: 0, verdict: r.verdict, next: state };
  }
  const newTat = tat + granted * T;
  return {
    granted,
    verdict: { allowed: true, remaining: Math.max(0, Math.floor((p.burst * T - (newTat - now)) / T + 1e-9)), retryAfterMs: 0, resetMs: Math.ceil(newTat - now) },
    next: { tat: newTat },
  };
}

export interface WindowState {
  idx: number;
  cur: number;
  prev: number;
}

/** Sliding-window counter: the previous fixed window counts in proportion to how much of it still overlaps the sliding window. */
export function slidingWindow(state: WindowState | undefined, now: number, p: WindowParams): { verdict: Verdict; next: WindowState } {
  const idx = Math.floor(now / p.windowMs);
  let cur = 0;
  let prev = 0;
  if (state) {
    if (state.idx === idx) {
      cur = state.cur;
      prev = state.prev;
    } else if (state.idx === idx - 1) {
      prev = state.cur;
    }
  }
  const elapsed = (now - idx * p.windowMs) / p.windowMs;
  const weighted = prev * (1 - elapsed) + cur;
  const toEnd = (idx + 1) * p.windowMs - now;
  if (weighted + p.cost > p.limit + 1e-9) {
    let retry = toEnd;
    if (prev > 0) {
      const room = p.limit - cur - p.cost;
      if (room >= 0) {
        const f = 1 - room / prev;
        retry = Math.min(toEnd, Math.max(1, Math.ceil(f * p.windowMs - (now - idx * p.windowMs))));
      }
    }
    return {
      verdict: { allowed: false, remaining: Math.max(0, Math.floor(p.limit - weighted + 1e-9)), retryAfterMs: Math.max(1, Math.ceil(retry)), resetMs: Math.ceil(toEnd) },
      next: { idx, cur, prev },
    };
  }
  cur += p.cost;
  const after = prev * (1 - elapsed) + cur;
  return { verdict: { allowed: true, remaining: Math.max(0, Math.floor(p.limit - after + 1e-9)), retryAfterMs: 0, resetMs: Math.ceil(toEnd) }, next: { idx, cur, prev } };
}

export interface PenaltyState {
  v: number;
  vs: number;
  lvl: number;
  last: number;
  until: number;
}

export const penaltyRemaining = (s: PenaltyState | undefined, now: number): number => (s && s.until > now ? s.until - now : 0);

/** Record one violation; escalates to a block when the threshold is reached inside the window. */
export function penaltyViolation(s: PenaltyState | undefined, now: number, c: PenaltyConfig): PenaltyState {
  let { v, vs, lvl, last, until } = s ?? { v: 0, vs: 0, lvl: 0, last: 0, until: 0 };
  // forgiveness is measured from the later of the last violation and the end of the last block, or a 24 h block would forgive itself while running
  const ref = Math.max(last, until);
  if (lvl > 0 && ref > 0) lvl = Math.max(0, lvl - Math.floor((now - ref) / c.decayMs));
  if (now - vs > c.windowMs) {
    v = 0;
    vs = now;
  }
  v += 1;
  if (v >= c.threshold) {
    lvl = Math.min(c.stepsSec.length, lvl + 1);
    until = now + c.stepsSec[lvl - 1]! * 1000;
    v = 0;
    vs = now;
  }
  return { v, vs, lvl, last: now, until };
}
