import { FIXED_NOW, makeRoom, roomPages } from "../test/factories";
import { insertRoomInList, roomMatchesStatus, updateRoomInList } from "./roomCache";

const opts = { status: "open" as const, sort: "newest" as const, now: FIXED_NOW };

describe("roomCache", () => {
  it("classifies open, snoozed and closed rooms", () => {
    const future = "2026-01-06T09:00:00.000Z";
    const past = "2026-01-05T09:00:00.000Z";
    expect(roomMatchesStatus({ status: "open", snooze_until: null }, "open", FIXED_NOW)).toBe(true);
    expect(roomMatchesStatus({ status: "open", snooze_until: future }, "open", FIXED_NOW)).toBe(false);
    expect(roomMatchesStatus({ status: "open", snooze_until: future }, "snoozed", FIXED_NOW)).toBe(true);
    expect(roomMatchesStatus({ status: "open", snooze_until: past }, "open", FIXED_NOW)).toBe(true);
    expect(roomMatchesStatus({ status: "closed", snooze_until: null }, "closed", FIXED_NOW)).toBe(true);
    expect(roomMatchesStatus({ status: "closed", snooze_until: null }, "open", FIXED_NOW)).toBe(false);
  });

  it("keeps position for non-newest sorts", () => {
    const a = makeRoom({ id: "a" });
    const b = makeRoom({ id: "b" });
    const data = updateRoomInList(roomPages([a, b]), "b", { id: "b", last_message_at: "2026-01-05T11:59:00.000Z" }, { ...opts, sort: "oldest" });
    expect(data.pages[0]?.data.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("moves an updated room to the front of the first page for newest sort", () => {
    const a = makeRoom({ id: "a" });
    const b = makeRoom({ id: "b" });
    const c = makeRoom({ id: "c" });
    const data = updateRoomInList(roomPages([a], [b, c]), "c", { id: "c", last_message_at: "2026-01-05T11:59:00.000Z" }, opts);
    expect(data.pages.map((p) => p.data.map((r) => r.id))).toEqual([["c", "a"], ["b"]]);
  });

  it("does not insert new rooms into search or non-newest lists", () => {
    const base = roomPages([makeRoom({ id: "a" })]);
    expect(insertRoomInList(base, makeRoom({ id: "n" }), { ...opts, sort: "priority_first" })).toBe(base);
  });
});
