import { describe, it, expect } from "vitest";
import {
  EXCERPT_ELLIPSIS,
  PROMPT_EXCERPT_WORDS,
  clampGraphemes,
  graphemeLength,
  promptExcerpt,
  toGraphemes,
  truncateGraphemes,
} from "../packages/core/src/core/prompt-excerpt.js";

// The ONE excerpt convention every observability card shares (#153/#154/#155).
// These are the guarantees the cards depend on, not incidental formatting.

describe("promptExcerpt: word boundaries", () => {
  it("returns a short prompt untouched, with no ellipsis", () => {
    expect(promptExcerpt("fix the login bug")).toBe("fix the login bug");
  });

  it("collapses newlines and runs of whitespace to single spaces", () => {
    expect(promptExcerpt("  fix   the\n\nlogin\tbug  ")).toBe("fix the login bug");
  });

  it("keeps exactly the first N words and marks the cut", () => {
    const words = Array.from({ length: 150 }, (_, i) => `w${i}`);
    const out = promptExcerpt(words.join(" "), { words: 100, chars: 10_000 });
    expect(out.endsWith(EXCERPT_ELLIPSIS)).toBe(true);
    const kept = out.slice(0, -1).split(" ");
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe("w0");
    expect(kept[99]).toBe("w99");
  });

  it("defaults to ~100 words, per #153", () => {
    const words = Array.from({ length: 200 }, () => "word");
    const out = promptExcerpt(words.join(" "), { chars: 10_000 });
    expect(out.slice(0, -1).split(" ")).toHaveLength(PROMPT_EXCERPT_WORDS);
  });

  it("never cuts mid-word when the char budget bites", () => {
    // 20 chars of budget lands inside "elephant"; we back off to the space.
    expect(promptExcerpt("alpha bravo charlie elephant delta", { chars: 20 })).toBe(
      `alpha bravo charlie${EXCERPT_ELLIPSIS}`
    );
  });

  it("falls back to an exact cut when the budget contains no word boundary", () => {
    const url = "https://example.com/a/very/long/path/that/never/breaks";
    const out = promptExcerpt(url, { chars: 20 });
    expect(out).toBe(`${url.slice(0, 20)}${EXCERPT_ELLIPSIS}`);
  });

  it("returns empty (not a lone ellipsis) for an empty or blank prompt", () => {
    expect(promptExcerpt("")).toBe("");
    expect(promptExcerpt("   \n\t ")).toBe("");
    expect(promptExcerpt(null)).toBe("");
    expect(promptExcerpt(undefined)).toBe("");
  });
});

describe("promptExcerpt: Unicode safety", () => {
  // Each of these is one user-perceived character that a naive
  // `slice(0, n)` on UTF-16 code units can split into rendering debris.
  const FAMILY = "👨‍👩‍👧"; // ZWJ sequence
  const FLAG = "🇯🇵"; // regional-indicator pair
  const WAVE = "👋🏽"; // emoji + skin-tone modifier
  const ACCENT = "é"; // e + combining acute

  it("never emits a lone surrogate or a split cluster", () => {
    for (const cluster of [FAMILY, FLAG, WAVE, ACCENT]) {
      const text = Array.from({ length: 40 }, () => cluster).join("");
      for (let budget = 1; budget <= 12; budget++) {
        const out = promptExcerpt(text, { words: 0, chars: budget });
        // No unpaired surrogates survived the cut.
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(
          false
        );
        // Every retained cluster is whole: strip the ellipsis, and what's left
        // is an exact repetition of the cluster.
        const body = out.endsWith(EXCERPT_ELLIPSIS) ? out.slice(0, -1) : out;
        expect(body).toBe(cluster.repeat(body.length / cluster.length));
      }
    }
  });

  it("counts a grapheme cluster as one character, not two-to-eleven", () => {
    expect(graphemeLength(FAMILY)).toBe(1);
    expect(graphemeLength(FLAG)).toBe(1);
    expect(graphemeLength(WAVE)).toBe(1);
    expect(graphemeLength(ACCENT)).toBe(1);
    expect(toGraphemes(`${FAMILY}${FLAG}`)).toEqual([FAMILY, FLAG]);
  });

  it("budgets emoji by cluster, so an emoji-only prompt keeps whole emoji", () => {
    const out = promptExcerpt(`${FAMILY}${FLAG}${WAVE}`, { words: 0, chars: 2 });
    expect(out).toBe(`${FAMILY}${FLAG}${EXCERPT_ELLIPSIS}`);
  });
});

describe("grapheme truncation primitives", () => {
  it("clampGraphemes hard-cuts without an ellipsis", () => {
    expect(clampGraphemes("abcdef", 3)).toBe("abc");
    expect(clampGraphemes("abc", 10)).toBe("abc");
    expect(clampGraphemes("abc", 0)).toBe("");
  });

  it("truncateGraphemes fits the ellipsis INSIDE the cap", () => {
    const out = truncateGraphemes("abcdefghij", 5);
    expect(graphemeLength(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith(EXCERPT_ELLIPSIS)).toBe(true);
  });

  it("truncateGraphemes leaves a string already inside the cap alone", () => {
    expect(truncateGraphemes("abc", 3)).toBe("abc");
  });
});
