import { makeMessage, makeRoom } from "../test/factories";
import { countsAsUnread, documentTitle, formatBadge, totalUnreadRooms } from "./unread";

describe("unread logic", () => {
  it("caps the badge at 99+", () => {
    expect(formatBadge(1)).toBe("1");
    expect(formatBadge(99)).toBe("99");
    expect(formatBadge(100)).toBe("99+");
  });

  it("counts rooms with unread messages, not messages", () => {
    const rooms = [makeRoom({ unread_count: 7 }), makeRoom({ unread_count: 0 }), makeRoom({ unread_count: 120 })];
    expect(totalUnreadRooms(rooms)).toBe(2);
  });

  it("counts customer and bot messages as unread", () => {
    expect(countsAsUnread(makeMessage(), "mem_me")).toBe(true);
    expect(countsAsUnread(makeMessage({ sender: { type: "bot", id: null, name: "Bot" } }), "mem_me")).toBe(true);
  });

  it("never counts notes, system lines or the viewer's own messages", () => {
    expect(countsAsUnread(makeMessage({ kind: "note", sender: { type: "agent", id: "mem_other", name: "Sam" } }), "mem_me")).toBe(false);
    expect(countsAsUnread(makeMessage({ kind: "system", sender: { type: "system", id: null, name: "" } }), "mem_me")).toBe(false);
    expect(countsAsUnread(makeMessage({ sender: { type: "agent", id: "mem_me", name: "Me" } }), "mem_me")).toBe(false);
  });

  it("counts a teammate's reply as unread", () => {
    expect(countsAsUnread(makeMessage({ sender: { type: "agent", id: "mem_other", name: "Sam" } }), "mem_me")).toBe(true);
  });

  it("puts the unread count in the tab title", () => {
    expect(documentTitle(0)).toBe("Conversations");
    expect(documentTitle(3)).toBe("(3) Conversations");
    expect(documentTitle(250)).toBe("(99+) Conversations");
  });
});
