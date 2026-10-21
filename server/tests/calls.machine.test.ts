import { describe, expect, it } from "vitest";
import { CALL_EVENTS, CALL_STATES, IllegalTransition, canDo, isLive, next, type CallEvent, type CallState } from "../src/calls/machine.js";

const LEGAL: [CallState, CallEvent, CallState][] = [
  ["ringing", "accept", "connecting"],
  ["ringing", "decline", "declined"],
  ["ringing", "ring_timeout", "missed"],
  ["ringing", "cancel", "ended"],
  ["ringing", "fail", "failed"],
  ["connecting", "connected", "active"],
  ["connecting", "end", "ended"],
  ["connecting", "fail", "failed"],
  ["connecting", "connect_timeout", "failed"],
  ["active", "end", "ended"],
  ["active", "fail", "failed"],
  ["active", "connected", "active"],
];

describe("call state machine", () => {
  it("allows exactly the listed transitions and refuses every other combination", () => {
    for (const s of CALL_STATES) {
      for (const e of CALL_EVENTS) {
        const want = LEGAL.find(([f, ev]) => f === s && ev === e);
        if (want) expect(next(s, e), `${s} + ${e}`).toBe(want[2]);
        else {
          expect(() => next(s, e), `${s} + ${e}`).toThrow(IllegalTransition);
          expect(canDo(s, e)).toBe(false);
        }
      }
    }
  });

  it("final states have no way out", () => {
    for (const s of ["declined", "missed", "ended", "failed"] as CallState[]) {
      expect(isLive(s)).toBe(false);
      for (const e of CALL_EVENTS) expect(canDo(s, e), `${s} + ${e}`).toBe(false);
    }
    for (const s of ["ringing", "connecting", "active"] as CallState[]) expect(isLive(s)).toBe(true);
  });

  it("random walks never leave a final state, never skip connecting, and always terminate", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 3000; run++) {
      let s: CallState = "ringing";
      let sawConnecting = false;
      let steps = 0;
      while (steps++ < 40) {
        const e = CALL_EVENTS[Math.floor(rnd() * CALL_EVENTS.length)]!;
        if (!canDo(s, e)) {
          expect(() => next(s, e)).toThrow(IllegalTransition);
          continue;
        }
        const was = s;
        s = next(s, e);
        if (s === "connecting") sawConnecting = true;
        // a call becomes active only through connecting
        if (s === "active" && was !== "active") expect(was).toBe("connecting");
        if (!isLive(s)) break;
      }
      if (s === "active") expect(sawConnecting).toBe(true);
    }
  });

  it("an accept and a cancel racing: whichever is applied first decides, the other is illegal or maps to an end", () => {
    // accept first: the cancel arrives at 'connecting', where only `end` exists
    const afterAccept = next("ringing", "accept");
    expect(canDo(afterAccept, "cancel")).toBe(false);
    expect(next(afterAccept, "end")).toBe("ended");
    // cancel first: the accept is refused
    const afterCancel = next("ringing", "cancel");
    expect(() => next(afterCancel, "accept")).toThrow(IllegalTransition);
  });
});
