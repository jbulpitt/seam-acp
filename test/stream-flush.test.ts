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
});
