import { formatMoney, parseMajorToMinor } from "./money";

describe("money", () => {
  it("formats minor units with the currency's own digits", () => {
    expect(formatMoney(2500, "usd")).toMatch(/25\.00/);
    expect(formatMoney(2500, "jpy")).toMatch(/2,500/);
    expect(formatMoney(5, "usd")).toMatch(/0\.05/);
  });
  it("parses what people type into cents, and refuses anything else", () => {
    expect(parseMajorToMinor("25")).toBe(2500);
    expect(parseMajorToMinor("25.5")).toBe(2550);
    expect(parseMajorToMinor("25,05")).toBe(2505);
    expect(parseMajorToMinor(" 0.99 ")).toBe(99);
    for (const bad of ["", "0", "0.00", "-5", "abc", "1.234", "1e3", "12345678"]) expect(parseMajorToMinor(bad), bad).toBeNull();
  });
});
