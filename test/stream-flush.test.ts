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

  it("falls back to last newline if no paragraph break", () => {
    const buf = "line one\nline two\nstill writing";
    const out = splitForFlush(buf, { maxLen: MAX, force: false });
    expect(out).toEqual({ send: "line one\nline two", keep: "still writing" });
  });

  it("falls back to sentence break if no newline", () => {
    const buf = "First sentence. Second one is in progress";
    const out = splitForFlush(buf, { maxLen: MAX, force: false });
    expect(out).toEqual({
      send: "First sentence.",
      keep: "Second one is in progress",
    });
  });

  it("never splits inside an open code fence", () => {
    const buf = "```ts\nconst x = 1;\nconst y = 2;\n";
    expect(splitForFlush(buf, { maxLen: MAX, force: false })).toBeNull();
  });

  it("flushes once a code fence has closed", () => {
    const buf = "Here is code:\n```ts\nconst x = 1;\n```\nMore prose now";
    const out = splitForFlush(buf, { maxLen: MAX, force: false });
    expect(out).not.toBeNull();
    expect(out!.send).toContain("```ts");
    expect(out!.send).toContain("```");
    expect(out!.keep).toBe("More prose now");
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
});
