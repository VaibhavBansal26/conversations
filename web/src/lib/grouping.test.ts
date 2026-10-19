import { makeMessage } from "../test/factories";
import { buildItems, sameGroup } from "./grouping";

const at = (min: number, over: Parameters<typeof makeMessage>[0] = {}) => makeMessage({ created_at: new Date(Date.UTC(2026, 0, 5, 10, min)).toISOString(), ...over });
const agent = { type: "agent" as const, id: "mem_1", name: "Sam" };

describe("message grouping", () => {
  it("groups same-sender messages within five minutes", () => {
    expect(sameGroup(at(0, { sender: agent }), at(5, { sender: agent }))).toBe(true);
    expect(sameGroup(at(0, { sender: agent }), at(6, { sender: agent }))).toBe(false);
  });

  it("splits groups by sender, by note-ness and around system lines", () => {
    expect(sameGroup(at(0, { sender: agent }), at(1))).toBe(false);
    expect(sameGroup(at(0, { sender: agent }), at(1, { sender: agent, kind: "note" }))).toBe(false);
    expect(sameGroup(at(0, { sender: agent }), at(1, { kind: "system", sender: { type: "system", id: null, name: "" } }))).toBe(false);
  });

  it("flags first/last of each group and inserts a day separator per day", () => {
    const now = new Date(Date.UTC(2026, 0, 6, 12));
    const items = buildItems([at(0, { sender: agent }), at(2, { sender: agent }), at(3), makeMessage({ created_at: "2026-01-06T09:00:00.000Z" })], now);
    expect(items.map((i) => i.type)).toEqual(["day", "message", "message", "message", "day", "message"]);
    const flags = items.filter((i) => i.type === "message").map((i) => (i.type === "message" ? [i.first, i.last] : []));
    expect(flags).toEqual([[true, false], [false, true], [true, true], [true, true]]);
    expect(items.find((i) => i.type === "day" && i.label === "Today")).toBeTruthy();
  });
});
