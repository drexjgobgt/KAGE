import { describe, expect, it } from "vitest";
import { formatTimecode, parseTimecode } from "./format";

describe("formatTimecode", () => {
  it("formats sub-hour durations as MM:SS.cc", () => {
    expect(formatTimecode(0)).toBe("00:00.00");
    expect(formatTimecode(12.34)).toBe("00:12.34");
    expect(formatTimecode(125.5)).toBe("02:05.50");
  });

  it("formats hour-plus durations as H:MM:SS.cc", () => {
    expect(formatTimecode(3661.25)).toBe("1:01:01.25");
  });

  it("clamps negative and non-finite inputs to zero", () => {
    expect(formatTimecode(-5)).toBe("00:00.00");
    expect(formatTimecode(Number.NaN)).toBe("00:00.00");
  });
});

describe("parseTimecode", () => {
  it("parses raw seconds and decimals", () => {
    expect(parseTimecode("12")).toBe(12);
    expect(parseTimecode("12.35")).toBeCloseTo(12.35);
    expect(parseTimecode(" 0.5 ")).toBeCloseTo(0.5);
  });

  it("parses MM:SS.cc and HH:MM:SS.cc", () => {
    expect(parseTimecode("01:30")).toBe(90);
    expect(parseTimecode("02:05.50")).toBeCloseTo(125.5);
    expect(parseTimecode("1:02:03.25")).toBeCloseTo(3723.25);
  });

  it("rejects negative, malformed, or out-of-range segments", () => {
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode("-2.5")).toBeNull();
    expect(parseTimecode("01:60")).toBeNull();
    expect(parseTimecode("1:65:10")).toBeNull();
    expect(parseTimecode("abc")).toBeNull();
    expect(parseTimecode("1:2:3:4")).toBeNull();
  });
});
