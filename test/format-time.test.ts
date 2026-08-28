import { describe, expect, it } from "vitest";
import { formatLocalTime } from "../packages/core/src/core/format-time.js";

describe("formatLocalTime", () => {
  it("renders a UTC instant in the given zone with a zone label (CDT in summer)", () => {
    const out = formatLocalTime("2026-08-27T11:41:41.652Z", "America/Chicago");
    // 11:41 UTC − 5 (CDT) = 6:41 AM local
    expect(out).toContain("6:41 AM");
    expect(out).toContain("CDT");
    expect(out).toContain("Aug 27, 2026");
    expect(out).not.toContain("Z");
  });

  it("tracks DST (CST in winter)", () => {
    const out = formatLocalTime("2026-01-15T12:00:00Z", "America/Chicago");
    // 12:00 UTC − 6 (CST) = 6:00 AM local
    expect(out).toContain("6:00 AM");
    expect(out).toContain("CST");
  });

  it("accepts epoch millis and Date", () => {
    const ms = Date.parse("2026-08-27T11:41:41.652Z");
    expect(formatLocalTime(ms, "America/Chicago")).toContain("6:41 AM");
    expect(formatLocalTime(new Date(ms), "America/Chicago")).toContain("6:41 AM");
  });

  it("passes invalid input through unchanged", () => {
    expect(formatLocalTime("not-a-date")).toBe("not-a-date");
  });
});
