import { describe, it, expect } from "vitest";
import { FenceStream } from "../src/core/fence-stream.js";

describe("FenceStream", () => {
  it("passes through plain prose unchanged", () => {
    const fs = new FenceStream();
    const r = fs.feed("hello world\nhow are you");
    expect(r.prose).toBe("hello world\nhow are you");
    expect(r.fences).toEqual([]);
    const tail = fs.flush();
    expect(tail.prose).toBe("");
    expect(tail.unclosed).toBeNull();
  });

  it("extracts a complete fenced block from a single chunk", () => {
    const fs = new FenceStream();
    const r = fs.feed("before\n```ts\nconst a = 1;\n```\nafter");
    expect(r.prose).toBe("before\n\nafter");
    expect(r.fences).toHaveLength(1);
    expect(r.fences[0]).toMatchObject({
      lang: "ts",
      ext: "ts",
      content: "const a = 1;",
    });
  });

  it("handles a fence split across chunk boundaries", () => {
    const fs = new FenceStream();
    const r1 = fs.feed("before\n``");
    expect(r1.prose).toBe("before\n");
    expect(r1.fences).toEqual([]);
    const r2 = fs.feed("`json\n{\"x\":1}\n``");
    expect(r2.prose).toBe("");
    expect(r2.fences).toEqual([]);
    const r3 = fs.feed("`\nafter");
    expect(r3.prose).toBe("\nafter");
    expect(r3.fences).toHaveLength(1);
    expect(r3.fences[0]).toMatchObject({
      lang: "json",
      ext: "json",
      content: '{"x":1}',
    });
  });

  it("treats stray 1–2 backticks as prose", () => {
    const fs = new FenceStream();
    const r = fs.feed("inline `code` here ``not a fence``");
    // Trailing `` is held pending a possible 3rd backtick; drained by flush.
    expect(r.prose).toBe("inline `code` here ``not a fence");
    expect(r.fences).toEqual([]);
    const tail = fs.flush();
    expect(tail.prose).toBe("``");
    expect(tail.unclosed).toBeNull();
  });

  it("handles unknown language tags as .txt", () => {
    const fs = new FenceStream();
    const r = fs.feed("```nonsense\nhello\n```");
    expect(r.fences).toHaveLength(1);
    expect(r.fences[0]).toMatchObject({
      lang: "nonsense",
      ext: "txt",
      mimeType: "text/plain",
      content: "hello",
    });
  });

  it("handles untagged fences as .txt", () => {
    const fs = new FenceStream();
    const r = fs.feed("```\njust raw\n```");
    expect(r.fences).toHaveLength(1);
    expect(r.fences[0]).toMatchObject({
      lang: "",
      ext: "txt",
      content: "just raw",
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
    expect(r.prose).toBe("a\n\nb\n\nc");
    expect(r.fences).toHaveLength(2);
    expect(r.fences[0]?.lang).toBe("js");
    expect(r.fences[1]?.lang).toBe("py");
  });

  it("survives the runaway-language-tag bug shape", () => {
    // Emulates Copilot wrapping a reply in ```markdown ... ``` and
    // streaming the content in many small chunks.
    const fs = new FenceStream();
    fs.feed("```markdown\n");
    expect(fs.inFence).toBe(true);
    for (let i = 0; i < 50; i++) fs.feed(`line ${i}\n`);
    const r = fs.feed("```");
    expect(r.fences).toHaveLength(1);
    expect(r.fences[0]?.lang).toBe("markdown");
    expect(r.fences[0]?.content.split("\n")).toHaveLength(50);
    expect(fs.inFence).toBe(false);
  });

  it("openSinceMs reports time in fence", () => {
    const fs = new FenceStream();
    fs.feed("```ts\n", 1000);
    expect(fs.openSinceMs(5000)).toBe(4000);
    fs.feed("```", 6000);
    expect(fs.openSinceMs(7000)).toBe(0);
  });
});
