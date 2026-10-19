import { describe, expect, it } from "vitest";
import { Presence } from "../src/realtime/presence.js";

function harness(grace = 5000) {
  const changes: string[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  let id = 0;
  const p = new Presence(grace, (scope, who, online) => changes.push(`${scope}/${who}:${online ? "on" : "off"}`), {
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id as never;
    },
    clearTimer: (t) => void timers.delete(t as never),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [k, t] of [...timers]) if (t.at <= now) {
      timers.delete(k);
      t.fn();
    }
  };
  return { p, changes, advance };
}

describe("refcounted presence", () => {
  it("is online with two tabs; closing one keeps the seat online", () => {
    const { p, changes, advance } = harness();
    p.connect("ws:member", "m1", "tab1");
    p.connect("ws:member", "m1", "tab2");
    expect(changes).toEqual(["ws:member/m1:on"]);
    p.disconnect("ws:member", "m1", "tab1");
    advance(60_000);
    expect(p.isOnline("ws:member", "m1")).toBe(true);
    expect(p.socketCount("ws:member", "m1")).toBe(1);
    expect(changes).toEqual(["ws:member/m1:on"]);
  });
  it("goes offline only after the grace period once the last tab closes", () => {
    const { p, changes, advance } = harness(5000);
    p.connect("ws:member", "m1", "tab1");
    p.disconnect("ws:member", "m1", "tab1");
    advance(4999);
    expect(p.isOnline("ws:member", "m1")).toBe(true);
    expect(p.socketCount("ws:member", "m1")).toBe(0);
    advance(1);
    expect(p.isOnline("ws:member", "m1")).toBe(false);
    expect(changes).toEqual(["ws:member/m1:on", "ws:member/m1:off"]);
  });
  it("reconnecting inside the grace period cancels the offline transition and emits no flicker", () => {
    const { p, changes, advance } = harness(5000);
    p.connect("ws:member", "m1", "tab1");
    p.disconnect("ws:member", "m1", "tab1");
    advance(2000);
    p.connect("ws:member", "m1", "tab2");
    advance(60_000);
    expect(p.isOnline("ws:member", "m1")).toBe(true);
    expect(changes).toEqual(["ws:member/m1:on"]);
  });
  it("ignores duplicate or unknown disconnects and keeps scopes and seats independent", () => {
    const { p, changes, advance } = harness(100);
    p.connect("ws:member", "m1", "a");
    p.connect("ws:member", "m2", "b");
    p.connect("ws:visitor", "m1", "c");
    p.disconnect("ws:member", "m1", "a");
    p.disconnect("ws:member", "m1", "a");
    p.disconnect("ws:member", "ghost", "z");
    advance(100);
    expect(p.isOnline("ws:member", "m1")).toBe(false);
    expect(p.isOnline("ws:member", "m2")).toBe(true);
    expect(p.isOnline("ws:visitor", "m1")).toBe(true);
    expect(p.onlineIds("ws:member").sort()).toEqual(["m2"]);
    expect(changes.filter((c) => c.endsWith(":off"))).toEqual(["ws:member/m1:off"]);
  });
  it("supports many sockets per seat and re-announces after a full offline cycle", () => {
    const { p, changes, advance } = harness(10);
    for (const s of ["1", "2", "3"]) p.connect("ws:member", "m1", s);
    for (const s of ["1", "2", "3"]) p.disconnect("ws:member", "m1", s);
    advance(10);
    p.connect("ws:member", "m1", "4");
    expect(changes).toEqual(["ws:member/m1:on", "ws:member/m1:off", "ws:member/m1:on"]);
  });
});
