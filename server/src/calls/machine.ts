/**
 * The call state machine, as a pure function so it can be tested exhaustively (docs/CALLS.md).
 *
 *   ringing --accept--> connecting --connected--> active --end--> ended
 *   ringing --decline--> declined          connecting --end--> ended      active --fail--> failed
 *   ringing --ring_timeout--> missed       connecting --fail | connect_timeout--> failed
 *   ringing --cancel--> ended              (a cancel before the visitor answered: ended, reason cancelled)
 *
 * declined, missed, ended and failed are final: nothing leaves them. Anything not listed is an illegal transition and throws.
 */
export const CALL_STATES = ["ringing", "connecting", "active", "declined", "missed", "ended", "failed"] as const;
export type CallState = (typeof CALL_STATES)[number];
export const CALL_EVENTS = ["accept", "decline", "ring_timeout", "cancel", "connected", "end", "fail", "connect_timeout"] as const;
export type CallEvent = (typeof CALL_EVENTS)[number];

export const LIVE_STATES: readonly CallState[] = ["ringing", "connecting", "active"];
export const isLive = (s: CallState): boolean => LIVE_STATES.includes(s);

const TABLE: Record<CallState, Partial<Record<CallEvent, CallState>>> = {
  ringing: { accept: "connecting", decline: "declined", ring_timeout: "missed", cancel: "ended", fail: "failed" },
  connecting: { connected: "active", end: "ended", fail: "failed", connect_timeout: "failed" },
  active: { end: "ended", fail: "failed", connected: "active" },
  declined: {},
  missed: {},
  ended: {},
  failed: {},
};

export class IllegalTransition extends Error {
  constructor(
    readonly from: CallState,
    readonly event: CallEvent,
  ) {
    super(`a ${from} call cannot ${event}`);
  }
}

/** The state after `event`, or an IllegalTransition. `connected` while active is a harmless repeat (both sides report it). */
export function next(from: CallState, event: CallEvent): CallState {
  const to = TABLE[from][event];
  if (!to) throw new IllegalTransition(from, event);
  return to;
}

export const canDo = (from: CallState, event: CallEvent): boolean => TABLE[from][event] !== undefined;
