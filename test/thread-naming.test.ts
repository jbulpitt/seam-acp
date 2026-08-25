import { describe, it, expect } from "vitest";
import {
  THREAD_LIMIT_MESSAGE,
  buildThreadName,
  formatKeycap,
  isEmptyOrDefaultThreadName,
  isSlugNumberedName,
  nameContainsSlug,
  nextThreadNumber,
  parseKeycapNumber,
  parseSlugThreadNumber,
  normalizeThreadSlug,
  resolveEffectiveSlug,
} from "../packages/core/src/platforms/discord/thread-naming.js";

const k = (n: number) => formatKeycap(n);

describe("formatKeycap / parseKeycapNumber", () => {
  it("formats 1–9 as digit + VS16 + enclosing keycap", () => {
    expect(k(1)).toBe("1\uFE0F\u20E3");
    expect(k(9)).toBe("9\uFE0F\u20E3");
    expect(k(5)).toHaveLength(3);
  });

  it("rejects 0, 10, and non-integers", () => {
    expect(() => formatKeycap(0)).toThrow(/1–9/);
    expect(() => formatKeycap(10)).toThrow(/1–9/);
    expect(() => formatKeycap(1.5)).toThrow(/1–9/);
  });

  it("parses the first 1–9 keycap and ignores 🔟 / bare digits", () => {
    expect(parseKeycapNumber(`hist ${k(3)}`)).toBe(3);
    expect(parseKeycapNumber("hist 3")).toBeNull();
    expect(parseKeycapNumber("hist 🔟")).toBeNull();
    expect(parseKeycapNumber(`a ${k(1)} b ${k(8)}`)).toBe(1);
  });
});

describe("nameContainsSlug", () => {
  it("matches a whitespace token case-insensitively", () => {
    expect(nameContainsSlug(`👾 Hist ${k(1)}`, "hist")).toBe(true);
    expect(nameContainsSlug(`👾 HIST ${k(1)}`, "hist")).toBe(true);
    expect(nameContainsSlug("history lesson", "hist")).toBe(false);
    expect(nameContainsSlug("review-pr", "hist")).toBe(false);
    expect(nameContainsSlug("  ", "hist")).toBe(false);
    expect(nameContainsSlug("hist 1", "")).toBe(false);
  });
});

describe("nextThreadNumber", () => {
  it("returns 1 on empty", () => {
    expect(nextThreadNumber([], "hist")).toBe(1);
  });

  it("fills the lowest gap among slug-matching names", () => {
    const names = [1, 2, 3, 4, 6].map((n) => `👾 hist ${k(n)}`);
    expect(nextThreadNumber(names, "hist")).toBe(5);
  });

  it("returns null when 1–9 are all taken", () => {
    const names = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `hist ${k(n)}`);
    expect(nextThreadNumber(names, "hist")).toBeNull();
  });

  it("ignores non-matching names and unnumbered slug mentions", () => {
    const names = [
      `👾 other ${k(1)}`,
      "custom title",
      `👾 hist ${k(2)}`,
      "just hist without a keycap",
    ];
    expect(nextThreadNumber(names, "hist")).toBe(1);
  });

  it("is case-insensitive on the slug token", () => {
    expect(nextThreadNumber([`👾 HIST ${k(1)}`], "hist")).toBe(2);
  });
});

describe("buildThreadName", () => {
  it("is [abbr] [slug] [n-emoji]", () => {
    expect(buildThreadName("👾", "hist", 3)).toBe(`👾 hist ${k(3)}`);
  });

  it("omits an empty abbr", () => {
    expect(buildThreadName("", "hist", 1)).toBe(`hist ${k(1)}`);
    expect(buildThreadName(null, "hist", 1)).toBe(`hist ${k(1)}`);
  });
});

describe("isSlugNumberedName / isEmptyOrDefaultThreadName", () => {
  it("detects a valid numbered slug name", () => {
    expect(isSlugNumberedName(`👾 hist ${k(4)}`, "hist")).toBe(true);
    expect(isSlugNumberedName("my custom name", "hist")).toBe(false);
  });

  it("treats empty, seam, and New Thread as default", () => {
    expect(isEmptyOrDefaultThreadName(undefined)).toBe(true);
    expect(isEmptyOrDefaultThreadName("")).toBe(true);
    expect(isEmptyOrDefaultThreadName("seam")).toBe(true);
    expect(isEmptyOrDefaultThreadName("New Thread")).toBe(true);
    expect(isEmptyOrDefaultThreadName("👾", "👾")).toBe(true);
    expect(isEmptyOrDefaultThreadName("my lab notes", "👾")).toBe(false);
  });
});

describe("normalizeThreadSlug", () => {
  it("trims and rejects empty or illegal tokens", () => {
    expect(normalizeThreadSlug(" hist ")).toBe("hist");
    expect(normalizeThreadSlug("")).toBeNull();
    expect(normalizeThreadSlug("has space")).toBeNull();
    expect(normalizeThreadSlug("ok_name-2")).toBe("ok_name-2");
  });
});

describe("resolveEffectiveSlug", () => {
  it("prefers DB preset, then thread, then channel", () => {
    expect(
      resolveEffectiveSlug({ presetSlug: "db", threadSlug: "th", channelSlug: "ch" })
    ).toBe("db");
    expect(resolveEffectiveSlug({ threadSlug: "th", channelSlug: "ch" })).toBe("th");
    expect(resolveEffectiveSlug({ channelSlug: "ch" })).toBe("ch");
    expect(resolveEffectiveSlug({})).toBeUndefined();
    expect(resolveEffectiveSlug({ presetSlug: "  " })).toBeUndefined();
  });
});

describe("THREAD_LIMIT_MESSAGE", () => {
  it("is the friendly 9-cap copy", () => {
    expect(THREAD_LIMIT_MESSAGE).toMatch(/limit \(9\)/);
  });
});
