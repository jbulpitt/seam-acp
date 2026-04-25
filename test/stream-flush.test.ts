import { describe, expect, it } from "vitest";
import { splitForFlush } from "../src/core/stream-flush.js";

const MAX = 100;

describe("splitForFlush — soft", () => {
  it("returns null on empty buffer", () => {
    expect(splitForFlush("", { maxLen: MAX, force: false })).toBeNull();
  });

  it("defers when no clean break exists", () => {
    expect(
      splitForFlush("just some prose with no breaks yet", {
        maxLen: MAX,
        force: false,
      })
    ).toBeNull();
  });

  it("splits at the last paragraph break", () => {
    const buf = "Para one.\n\nPara two so far";
    const out = splitForFlush(buf, { maxLen: MAX, force: false });
    expect(out).toEqual({ send: "Para one.", keep: "Para two so far" });
  });

  it("defers when only line breaks exist (paragraph-only soft mode)", () => {
    const buf = "line one\nline two\nstill writing";
    expect(splitForFlush(buf, { maxLen: MAX, force: false })).toBeNull();
  });

  it("defers when only sentence breaks exist (paragraph-only soft mode)", () => {
    const buf = "First sentence. Second one is in progress";
    expect(splitForFlush(buf, { maxLen: MAX, force: false })).toBeNull();
  });

  it("never splits inside an open code fence", () => {
    const buf = "```ts\nconst x = 1;\nconst y = 2;\n";
    expect(splitForFlush(buf, { maxLen: MAX, force: false })).toBeNull();
  });

  it("flushes at paragraph break after a closed code fence", () => {
    const buf = "Here is code:\n```ts\nconst x = 1;\n```\n\nMore prose now";
    const out = splitForFlush(buf, { maxLen: MAX, force: false });
    expect(out).not.toBeNull();
    expect(out!.send).toContain("```ts");
    expect(out!.send.endsWith("```")).toBe(true);
    expect(out!.keep).toBe("More prose now");
  });

  it("defers when a code fence has closed but no paragraph break follows", () => {
    const buf = "Here is code:\n```ts\nconst x = 1;\n```\nMore prose now";
    expect(splitForFlush(buf, { maxLen: MAX, force: false })).toBeNull();
  });
});

describe("splitForFlush — forced", () => {
  it("sends everything when under max and not in fence", () => {
    const buf = "short reply.";
    const out = splitForFlush(buf, { maxLen: MAX, force: true });
    expect(out).toEqual({ send: "short reply.", keep: "" });
  });

  it("closes and reopens an open fence with the same language", () => {
    const inner = "const a = 1;\n".repeat(20);
    const buf = "```ts\n" + inner;
    const out = splitForFlush(buf, { maxLen: 80, force: true });
    expect(out).not.toBeNull();
    expect(out!.send.endsWith("```")).toBe(true);
    expect(out!.keep.startsWith("```ts\n")).toBe(true);
    // Round-trip check: stripping the closing/reopening fences should give
    // back the original inner content.
    const sentInner = out!.send.replace(/^```ts\n/, "").replace(/\n```$/, "");
    const keptInner = out!.keep.replace(/^```ts\n/, "");
    expect(sentInner + "\n" + keptInner).toBe(buf.replace(/^```ts\n/, ""));
  });

  it("hard-cuts only when no clean break exists in window", () => {
    const buf = "x".repeat(150);
    const out = splitForFlush(buf, { maxLen: MAX, force: true });
    expect(out).not.toBeNull();
    expect(out!.send.length).toBe(MAX);
    expect(out!.keep.length).toBe(50);
  });

  it("does not loop forever on an orphan fence opener with no content", () => {
    const out = splitForFlush("```markdown\n", { maxLen: 80, force: true });
    expect(out).toEqual({ send: "", keep: "" });
  });

  it("does not loop forever when a re-opened fence has only whitespace", () => {
    const out = splitForFlush("```ts\n   \n", { maxLen: 80, force: true });
    expect(out).toEqual({ send: "", keep: "" });
  });

  it("force-drains an open fence in finite steps without empty pills", () => {
    // Simulates Copilot wrapping a long reply in ```markdown ... ```
    // and our drain loop iterating to completion.
    const inner =
      "Subject: hello\n\n" +
      Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the reply.`).join(
        "\n"
      ) +
      "\n";
    let buf = "```markdown\n" + inner + "```";
    const sends: string[] = [];
    let safety = 20;
    while (buf && safety-- > 0) {
      const out = splitForFlush(buf, { maxLen: 200, force: true });
      if (!out) break;
      buf = out.keep;
      if (out.send) sends.push(out.send);
    }
    expect(safety).toBeGreaterThan(0); // didn't infinite-loop
    expect(buf).toBe("");
    // Every emitted message should have non-trivial content (not an empty
    // ```lang ... ``` pill).
    for (const s of sends) {
      const stripped = s.replace(/```\w*\s*\n?/g, "").replace(/```/g, "");
      expect(stripped.trim().length).toBeGreaterThan(0);
    }
  });
});

import { findFirstUnsafeIndex } from "../src/core/stream-flush.js";

describe("findFirstUnsafeIndex", () => {
  it("returns -1 for plain prose", () => {
    expect(findFirstUnsafeIndex("just some prose")).toBe(-1);
  });
  it("returns -1 when all links are closed", () => {
    expect(
      findFirstUnsafeIndex("see [here](https://example.com) for more")
    ).toBe(-1);
  });
  it("flags an unclosed link text", () => {
    const buf = "prose [Some Link Text";
    expect(findFirstUnsafeIndex(buf)).toBe(buf.indexOf("["));
  });
  it("flags an unclosed url after ](", () => {
    const buf = "prose [Some Link](https://exam";
    expect(findFirstUnsafeIndex(buf)).toBe(buf.indexOf("["));
  });
  it("allows balanced parens inside url", () => {
    const buf =
      "see [x](https://en.wikipedia.org/wiki/Function_(mathematics)) ok";
    expect(findFirstUnsafeIndex(buf)).toBe(-1);
  });
  it("allows link title inside same outer parens", () => {
    expect(
      findFirstUnsafeIndex('see [x](https://example.com "a title") ok')
    ).toBe(-1);
  });
  it("flags an unclosed link with title still open", () => {
    const buf = 'see [x](https://example.com "open title';
    expect(findFirstUnsafeIndex(buf)).toBe(buf.indexOf("["));
  });
  it("ignores escaped brackets", () => {
    expect(findFirstUnsafeIndex("prose \\[ not a link")).toBe(-1);
  });
  it("does NOT escape when backslash itself is escaped", () => {
    const buf = "prose \\\\[Real Link";
    expect(findFirstUnsafeIndex(buf)).toBe(buf.indexOf("[Real"));
  });
  it("treats `[text]` not followed by `(` as plain text", () => {
    expect(findFirstUnsafeIndex("see [bracketed] later")).toBe(-1);
  });
  it("uses the `!` as unsafe start for an open image", () => {
    const buf = "alt ![image desc";
    expect(findFirstUnsafeIndex(buf)).toBe(buf.indexOf("!"));
  });
  it("reports the OUTERMOST open link when multiple are open", () => {
    const buf = "first [unclosed and then [also unclosed";
    expect(findFirstUnsafeIndex(buf)).toBe(buf.indexOf("[unclosed"));
  });
});

describe("splitForFlush — link-aware (forced)", () => {
  it("under-cap with open link sends safe prefix and keeps tail", () => {
    const buf = "Hello world. See [Some Link](https://exam";
    const out = splitForFlush(buf, { maxLen: 200, force: true });
    expect(out).toEqual({
      send: "Hello world. See",
      keep: "[Some Link](https://exam",
    });
  });
  it("under-cap with link starting at index 0 returns null (waits)", () => {
    const buf = "[Some Link](https://exam";
    expect(splitForFlush(buf, { maxLen: 200, force: true })).toBeNull();
  });
  it("under-cap with closed links sends whole buffer", () => {
    const buf = "See [a](https://x) and [b](https://y) ok";
    const out = splitForFlush(buf, { maxLen: 200, force: true });
    expect(out).toEqual({ send: buf, keep: "" });
  });
  it("allowUnsafeCut bypasses the safety check", () => {
    const buf = "[Some Link](https://exam";
    const out = splitForFlush(buf, {
      maxLen: 200,
      force: true,
      allowUnsafeCut: true,
    });
    expect(out).toEqual({ send: buf, keep: "" });
  });
  it("over-cap caps clean-split window at unsafeIdx", () => {
    const head = "A".repeat(50) + "\n";
    const buf = head + "[Open Link](https://stillopen";
    const out = splitForFlush(buf, { maxLen: 80, force: true });
    expect(out).not.toBeNull();
    expect(out!.send).toBe(head.replace(/\s+$/, ""));
    expect(out!.keep).toBe("[Open Link](https://stillopen");
  });
  it("end-of-turn allowUnsafeCut drains everything including open link", () => {
    const buf = "prose [Open Link](https://never-closed";
    const out = splitForFlush(buf, {
      maxLen: 200,
      force: true,
      allowUnsafeCut: true,
    });
    expect(out).toEqual({ send: buf, keep: "" });
  });
});

describe("splitForFlush — link-aware (soft)", () => {
  it("refuses a soft cut that would split inside an open link", () => {
    const buf = "Para [open\n\nlink keeps going...";
    expect(splitForFlush(buf, { maxLen: 200, force: false })).toBeNull();
  });
  it("allows a soft cut when the open link is AFTER the paragraph break", () => {
    const buf = "Para one done.\n\nNew para [open link...";
    const out = splitForFlush(buf, { maxLen: 200, force: false });
    expect(out).toEqual({
      send: "Para one done.",
      keep: "New para [open link...",
    });
  });
});

describe("splitForFlush — inline code span protection", () => {
  it("force: does not split at \\n inside a backtick span (over-cap path)", () => {
    // Simulates `docusign_agent\n` where the newline is inside the span.
    // The safe \n is before the opening backtick; the \n inside the span is skipped.
    const buf = "prefix text\n`name\nmore` suffix";
    const out = splitForFlush(buf, { maxLen: 18, force: true });
    expect(out).not.toBeNull();
    expect(out!.send).toBe("prefix text");
    expect(out!.keep).toBe("`name\nmore` suffix");
  });

  it("force: sends whole buffer when span is closed and buffer fits", () => {
    // A closed span with a newline inside — fits in maxLen, so sent whole.
    const buf = "before\n`code\nspan` after";
    const out = splitForFlush(buf, { maxLen: 200, force: true });
    expect(out).toEqual({ send: buf, keep: "" });
  });

  it("soft: skips \\n\\n inside a backtick span", () => {
    // Double newline inside a span — very unusual, but must not be chosen.
    const buf = "intro `code\n\nspan` done.\n\nParagraph two";
    const out = splitForFlush(buf, { maxLen: 200, force: false });
    expect(out).not.toBeNull();
    // The \n\n after "done." is outside the span and should be chosen.
    expect(out!.send).toBe("intro `code\n\nspan` done.");
    expect(out!.keep).toBe("Paragraph two");
  });

  it("allowUnsafeCut still splits even inside a backtick span", () => {
    // End-of-turn drain must always produce output.
    const buf = "line one\n`code\nspan` line three";
    const out = splitForFlush(buf, {
      maxLen: 200,
      force: true,
      allowUnsafeCut: true,
    });
    expect(out).toEqual({ send: buf, keep: "" });
  });

  it("multi-backtick run does not count as inline code opener", () => {
    // ``double`` inline uses 2-backtick delimiters; single-backtick tracking
    // ignores those runs, so the \n inside is a valid split point.
    const buf = "``double\nnot code`` rest";
    const out = splitForFlush(buf, { maxLen: 12, force: true });
    expect(out).not.toBeNull();
    expect(out!.send).toBe("``double");
    expect(out!.keep).toBe("not code`` rest");
  });
});
