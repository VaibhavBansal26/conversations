import { dayLabel, formatRelative } from "./time";
import { inboxSearch, parseInboxParams } from "./inboxParams";

const now = new Date("2026-01-05T12:00:00.000Z");

describe("time helpers", () => {
  it("formats compact relative times", () => {
    expect(formatRelative("2026-01-05T11:59:40.000Z", now)).toBe("now");
    expect(formatRelative("2026-01-05T11:55:00.000Z", now)).toBe("5m");
    expect(formatRelative("2026-01-05T09:00:00.000Z", now)).toBe("3h");
    expect(formatRelative("2026-01-03T12:00:00.000Z", now)).toBe("2d");
    expect(formatRelative(null, now)).toBe("");
  });

  it("labels days relative to today", () => {
    expect(dayLabel(now.toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(now.getTime() - 86_400_000).toISOString(), now)).toBe("Yesterday");
  });
});

describe("inbox URL params", () => {
  it("round-trips filters and omits defaults", () => {
    const f = parseInboxParams(new URLSearchParams("status=closed&filter=unassigned&inbox=inb_1&q=ada&sort=oldest"));
    expect(f).toEqual({ status: "closed", filter: "unassigned", inbox_id: "inb_1", search: "ada", sort: "oldest" });
    expect(parseInboxParams(new URLSearchParams(inboxSearch(f)))).toEqual(f);
    expect(inboxSearch({ status: "open", sort: "newest" })).toBe("");
  });

  it("ignores invalid values", () => {
    expect(parseInboxParams(new URLSearchParams("status=bogus&filter=nope&sort=x"))).toEqual({ status: "open", filter: undefined, inbox_id: undefined, search: undefined, sort: "newest" });
  });
});
