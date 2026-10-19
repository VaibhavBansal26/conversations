import { AppError } from "../errors.js";
import type { Decision } from "./limiter.js";

/** 429 (rate) or 503 (overload / store unavailable on a fail-closed policy), rendered by the app's error handler. */
export class RateLimitedError extends AppError {
  constructor(readonly decision: Decision) {
    super(decision.shed ? 503 : 429, decision.shed ? "OVERLOADED" : "RATE_LIMITED", decision.shed ? "The service is busy, retry shortly" : "Too many requests", undefined);
    this.name = "RateLimitedError";
  }
}

/** Build a 503 decision for a full concurrency cap. */
export function overloaded(policy: string, max: number): Decision {
  return { allowed: false, outcome: "shed", policy, limit: max, windowSec: 0, remaining: 0, retryAfterMs: 1000 + Math.floor(Math.random() * 2000), resetMs: 0, shed: true };
}

