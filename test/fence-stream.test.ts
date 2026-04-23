import { describe, it, expect } from "vitest";
import { FenceStream, type Segment } from "../src/core/fence-stream.js";

const proseSegments = (segments: Segment[]): string =>
  segments
    .filter((s): s is Extract<Segment, { kind: "prose" }> => s.kind === "prose")
    .map((s) => s.text)
    .join("");

describe("FenceStream", () => {
  it("passes through plain prose unchanged", () => {
    const fs = new FenceStream();
    const r = fs.feed("hello world\nhow are you");
    expect(r.segments).toEqual([
      { kind: "prose", text: "hello world\nhow are you" },
    ]);
    const tail = fs.flush();
    expect(tail.segments).toEqual([]);
    expect(tail.unclosed).toBeNull();
  });

  it("extracts a complete fenced block from a single chunk in order", () => {
    const fs = new FenceStream();
    const r = fs.feed("before\n```ts\nconst a = 1;\n```\nafter");
    expect(r.segments.length).toBe(4);
    expect(r.segments[0]).toEqual({ kind: "prose", text: "before\n" });
    expect(r.segments[1]).toEqual({ kind: "fence-open" });
    expect(r.segments[2]).toMatchObject({
      kind: "fence-close",
      fence: { lang: "ts", ext: "ts", content: "const a = 1;" },
    });
    expect(r.segments[3]).toEqual({ kind: "prose", text: "\nafter" });
  });

  it("preserves prose-fence-prose ordering within a single chunk", () => {
    const fs = new FenceStream();
    const r = fs.feed("a\n```js\nx\n```\nb\n```py\ny\n```\nc");
    const kinds = r.segments.map((s) => s.kind);
    expect(kinds).toEqual([
      "prose",
      "fence-open",
      "fence-close",
      "prose",
      "fence-open",
      "fence-close",
      "prose",
    ]);
    expect(proseSegments(r.segments)).toBe("a\n\nb\n\nc");
  });

  it("handles a fence split across chunk boundaries", () => {
    const fs = new FenceStream();
    const r1 = fs.feed("before\n``");
    expect(r1.segments).toEqual([{ kind: "prose", text: "before\n" }]);
    const r2 = fs.feed("`json\n{\"x\":1}\n``");
    // Opening triple-tick consumed inside r2; only fence-open emitted
    // (no prose, no close yet).
    expect(r2.segments).toEqual([{ kind: "fence-open" }]);
    const r3 = fs.feed("`\nafter");
    expect(r3.segments.length).toBe(2);
    expect(r3.segments[0]).toMatchObject({
      kind: "fence-close",
      fence: { lang: "json", ext: "json", content: '{"x":1}' },
    });
    expect(r3.segments[1]).toEqual({ kind: "prose", text: "\nafter" });
  });

  it("treats stray 1–2 backticks as prose", () => {
    const fs = new FenceStream();
    const r = fs.feed("inline `code` here ``not a fence``");
    // Trailing `` is held pending a possible 3rd backtick; drained by flush.
    expect(proseSegments(r.segments)).toBe("inline `code` here ``not a fence");
    const tail = fs.flush();
    expect(proseSegments(tail.segments)).toBe("``");
    expect(tail.unclosed).toBeNull();
  });

  it("handles unknown language tags as .txt", () => {
    const fs = new FenceStream();
    const r = fs.feed("```nonsense\nhello\n```");
    const close = r.segments.find((s) => s.kind === "fence-close");
    expect(close).toBeDefined();
    expect(close).toMatchObject({
      fence: {
        lang: "nonsense",
        ext: "txt",
        mimeType: "text/plain",
        content: "hello",
      },
    });
  });

  it("handles untagged fences as .txt", () => {
    const fs = new FenceStream();
    const r = fs.feed("```\njust raw\n```");
    const close = r.segments.find((s) => s.kind === "fence-close");
    expect(close).toMatchObject({
      fence: { lang: "", ext: "txt", content: "just raw" },
    });
  });

  it("returns an unclosed fence on flush()", () => {
    const fs = new FenceStream();
    fs.feed("intro\n```python\nx = 1\n");
    const tail = fs.flush();
    expect(tail.unclosed).not.toBeNull();
    expect(tail.unclosed!).toMatchObject({
      lang: "python",
      ext: "py",
      content: "x = 1\n",
    });
  });

  it("supports multiple fences in one stream", () => {
    const fs = new FenceStream();
    const r = fs.feed("a\n```js\nlet a;\n```\nb\n```py\nb=1\n```\nc");
    const closed = r.segments.filter((s) => s.kind === "fence-close");
    expect(closed).toHaveLength(2);
    expect(closed[0]).toMatchObject({ fence: { lang: "js" } });
    expect(closed[1]).toMatchObject({ fence: { lang: "py" } });
  });

  it("survives the runaway-language-tag bug shape", () => {
    // Emulates Copilot wrapping a reply in ```markdown ... ``` and
    // streaming the content in many small chunks.
    const fs = new FenceStream();
    fs.feed("```markdown\n");
    expect(fs.inFence).toBe(true);
    for (let i = 0; i < 50; i++) fs.feed(`line ${i}\n`);
    const r = fs.feed("```");
    const close = r.segments.find((s) => s.kind === "fence-close");
    expect(close).toBeDefined();
    expect(close).toMatchObject({ fence: { lang: "markdown" } });
    if (close && close.kind === "fence-close") {
      expect(close.fence.content.split("\n")).toHaveLength(50);
    }
    expect(fs.inFence).toBe(false);
  });

  it("openSinceMs reports time in fence", () => {
    const fs = new FenceStream();
    fs.feed("```ts\n", 1000);
    expect(fs.openSinceMs(5000)).toBe(4000);
    fs.feed("```", 6000);
    expect(fs.openSinceMs(7000)).toBe(0);
  });

  it("currentFenceContentLength tracks growth of open fence", () => {
    const fs = new FenceStream();
    expect(fs.currentFenceContentLength()).toBe(0);
    fs.feed("```ts\n");
    expect(fs.currentFenceContentLength()).toBe(0);
    fs.feed("hello");
    expect(fs.currentFenceContentLength()).toBe(5);
    fs.feed(" world");
    expect(fs.currentFenceContentLength()).toBe(11);
    fs.feed("\n```");
    expect(fs.currentFenceContentLength()).toBe(0);
  });

  it("currentFenceLang reports lang once captured", () => {
    const fs = new FenceStream();
    expect(fs.currentFenceLang()).toBe("");
    fs.feed("```typ");
    // Lang line not yet terminated; reported as empty.
    expect(fs.currentFenceLang()).toBe("");
    fs.feed("escript\n");
    expect(fs.currentFenceLang()).toBe("typescript");
    fs.feed("hi\n```");
    expect(fs.currentFenceLang()).toBe("");
  });

  it("forceClose snapshots and resets to outside-fence", () => {
    const fs = new FenceStream();
    fs.feed("```ts\nhello world\n");
    expect(fs.inFence).toBe(true);
    const snap = fs.forceClose();
    expect(snap).not.toBeNull();
    expect(snap!).toMatchObject({
      lang: "ts",
      ext: "ts",
      content: "hello world\n",
    });
    expect(fs.inFence).toBe(false);
    // Subsequent bytes flow as prose.
    const r = fs.feed("after");
    expect(r.segments).toEqual([{ kind: "prose", text: "after" }]);
  });

  it("forceClose returns null when no fence is open", () => {
    const fs = new FenceStream();
    fs.feed("just prose");
    expect(fs.forceClose()).toBeNull();
  });
});
