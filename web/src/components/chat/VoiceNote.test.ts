import { barHeights, formatDuration } from "./VoiceNote";

describe("voice note helpers", () => {
  it("draws the same bars for the same note and stays within 25-100%", () => {
    const a = barHeights("att_1");
    expect(a).toEqual(barHeights("att_1"));
    expect(a).not.toEqual(barHeights("att_2"));
    expect(a).toHaveLength(32);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0.25);
    expect(Math.max(...a)).toBeLessThanOrEqual(1);
  });

  it("formats durations as m:ss and tolerates NaN/Infinity", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(125.7)).toBe("2:05");
    expect(formatDuration(NaN)).toBe("0:00");
    expect(formatDuration(Infinity)).toBe("0:00");
  });
});
