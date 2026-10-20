import { contrastRatio, isHex, passesAA, readableOn } from "./contrast";

describe("contrast helpers", () => {
  it("computes the WCAG ratio", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#4f46e5", "#ffffff")).toBeGreaterThan(6);
  });
  it("flags low-contrast pairs", () => {
    expect(passesAA("#ffffff", "#ffe066")).toBe(false);
    expect(passesAA("#ffffff", "#4f46e5")).toBe(true);
  });
  it("picks a readable text colour", () => {
    expect(readableOn("#ffe066")).toBe("#14141a");
    expect(readableOn("#1e1b4b")).toBe("#ffffff");
  });
  it("validates 6-digit hex", () => {
    expect(isHex("#abcdef")).toBe(true);
    expect(isHex("#abc")).toBe(false);
  });
});
