import { activeMention, insertMention, mentionedIds, mentionsToPlain, splitMentions } from "./mentions";

describe("mentions", () => {
  it("inserts a token for the member being typed", () => {
    const out = insertMention("Hey @sa", 7, { id: "mem_1", name: "Sam Lee" });
    expect(out.text).toBe("Hey @[Sam Lee](mem_1) ");
    expect(out.caret).toBe(out.text.length);
  });

  it("finds the active @query only right before the caret", () => {
    expect(activeMention("hello @ad", 9)).toEqual({ query: "ad", start: 6 });
    expect(activeMention("hello @ad there", 15)).toBeNull();
    expect(activeMention("mail me at a@b.co", 17)).toBeNull();
  });

  it("splits text into plain and mention segments", () => {
    expect(splitMentions("Hi @[Sam](mem_1), please look")).toEqual([
      { type: "text", text: "Hi " },
      { type: "mention", name: "Sam", id: "mem_1" },
      { type: "text", text: ", please look" },
    ]);
  });

  it("renders plain text and extracts ids", () => {
    expect(mentionsToPlain("cc @[Sam](mem_1) and @[Ana](mem_2)")).toBe("cc @Sam and @Ana");
    expect(mentionedIds("cc @[Sam](mem_1) and @[Ana](mem_2)")).toEqual(["mem_1", "mem_2"]);
  });
});
