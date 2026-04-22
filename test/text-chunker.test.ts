import { describe, it, expect } from "vitest";
import { chunkForDiscord, collapseMarkdownLinkWraps } from "../src/core/text-chunker.js";

describe("collapseMarkdownLinkWraps", () => {
  it("no-ops on text without markdown links", () => {
    const text = "Hello\nworld\n\nParagraph two";
    expect(collapseMarkdownLinkWraps(text)).toBe(text);
  });

  it("collapses \\n inside link text with a space", () => {
    expect(collapseMarkdownLinkWraps("[Bug #\n202748 — desc](url)")).toBe(
      "[Bug # 202748 — desc](url)"
    );
  });

  it("collapses \\n inside link URL with no space", () => {
    expect(
      collapseMarkdownLinkWraps("](https://example.com/path\n/more)")
    ).toBe("](https://example.com/path/more)");
  });

  it("handles multiple \\n inside a single link construct", () => {
    expect(collapseMarkdownLinkWraps("[a\nb\nc](url)")).toBe("[a b c](url)");
  });

  it("handles multiple \\n inside a URL", () => {
    expect(collapseMarkdownLinkWraps("](https://x.com/a\n/b\n/c)")).toBe(
      "](https://x.com/a/b/c)"
    );
  });

  it("preserves intentional paragraph breaks between links", () => {
    const text = "[link1](url1)\n\n[link2](url2)";
    expect(collapseMarkdownLinkWraps(text)).toBe(text);
  });

  it("preserves \\n between items outside of link constructs", () => {
    const text = "Task #1 — Done\nTask #2 — In Progress";
    expect(collapseMarkdownLinkWraps(text)).toBe(text);
  });

  it("handles a full Gemini-style wrapped link", () => {
    const input =
      "[Bug #208569 — Non\n-Prod: Word clears](https://dev.azure.com/edit/20\n8569)";
    const expected =
      "[Bug #208569 — Non -Prod: Word clears](https://dev.azure.com/edit/208569)";
    expect(collapseMarkdownLinkWraps(input)).toBe(expected);
  });

  it("fixes Gemini's /. hostname-wrapping artifact in URLs", () => {
    expect(
      collapseMarkdownLinkWraps("[Task](https://dev/.\nazure.com/edit/123)")
    ).toBe("[Task](https://dev.azure.com/edit/123)");
  });

  it("fixes /. artifact combined with other \\n wraps", () => {
    const input =
      "[#203504 — Prevent TA Planning](https://dev/.\nazure.com/FlintHills/FHR/_workitems/edit/203504)";
    const expected =
      "[#203504 — Prevent TA Planning](https://dev.azure.com/FlintHills/FHR/_workitems/edit/203504)";
    expect(collapseMarkdownLinkWraps(input)).toBe(expected);
  });
});

describe("chunkForDiscord", () => {
  it("returns empty for empty input", () => {
    expect(chunkForDiscord("")).toEqual([]);
  });

  it("returns single chunk for short text", () => {
    expect(chunkForDiscord("hello")).toEqual(["hello"]);
  });

  it("normalizes CRLF to LF", () => {
    expect(chunkForDiscord("a\r\nb")).toEqual(["a\nb"]);
  });

  it("splits on a newline boundary near the end of a window", () => {
    // 200 chars of 'a', a newline, 200 chars of 'b'; cap at 250 should split at the newline
    const text = "a".repeat(200) + "\n" + "b".repeat(200);
    const chunks = chunkForDiscord(text, 250);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(200));
    expect(chunks[1]).toBe("b".repeat(200));
  });

  it("hard-cuts when no good newline boundary exists", () => {
    const text = "x".repeat(2500);
    const chunks = chunkForDiscord(text, 1000);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(1000);
    expect(chunks[1]?.length).toBe(1000);
    expect(chunks[2]?.length).toBe(500);
  });

  it("avoids tiny tail chunks by ignoring near-start newlines", () => {
    // Newline at offset 50, then 1500 chars; cap=1900 should NOT split at offset 50.
    const text = "a".repeat(50) + "\n" + "b".repeat(1500);
    const chunks = chunkForDiscord(text);
    // Whole thing fits in 1900.
    expect(chunks.length).toBe(1);
  });

  it("skips runs of empty newlines between chunks", () => {
    const text = "a".repeat(300) + "\n\n\n" + "b".repeat(300);
    const chunks = chunkForDiscord(text, 350);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(300));
    expect(chunks[1]).toBe("b".repeat(300));
  });

  it("trims trailing whitespace from the end of each chunk", () => {
    // Internal whitespace must be preserved (matches C# TrimEnd semantics).
    expect(chunkForDiscord("hello   \nworld   ", 1000)).toEqual([
      "hello   \nworld",
    ]);
    // Force a split: tail of first chunk should have its trailing spaces stripped.
    const text = "a".repeat(40) + "   \n" + "b".repeat(40);
    const chunks = chunkForDiscord(text, 50);
    expect(chunks[0]?.endsWith(" ")).toBe(false);
  });
});
