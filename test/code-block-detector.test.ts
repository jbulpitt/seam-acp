import { describe, it, expect } from "vitest";
import { detectFileBlocks } from "../src/agents/code-block-detector.js";

const big = (lines: number, prefix = "line") =>
  Array.from({ length: lines }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("detectFileBlocks", () => {
  it("returns nothing for plain prose", () => {
    expect(detectFileBlocks("just some text, no fences")).toEqual([]);
  });

  it("ignores untagged blocks", () => {
    const text = "```\n" + big(30) + "\n```";
    expect(detectFileBlocks(text)).toEqual([]);
  });

  it("ignores blocks below the line threshold", () => {
    const text = "```python\nprint('hi')\n```";
    expect(detectFileBlocks(text)).toEqual([]);
  });

  it("uploads a long python block", () => {
    const text = "```python\n" + big(30) + "\n```";
    const got = detectFileBlocks(text);
    expect(got).toHaveLength(1);
    expect(got[0]?.filename).toBe("snippet-1.py");
    expect(got[0]?.mimeType).toBe("text/x-python");
  });

  it("lowers the threshold for markdown", () => {
    const text = "```markdown\n" + big(6) + "\n```";
    const got = detectFileBlocks(text);
    expect(got).toHaveLength(1);
    expect(got[0]?.filename).toBe("snippet-1.md");
  });

  it("skips short markdown too", () => {
    const text = "```md\n# hi\n```";
    expect(detectFileBlocks(text)).toEqual([]);
  });

  it("numbers multiple blocks", () => {
    const text =
      "```json\n" + big(25) + "\n```\nfoo\n```yaml\n" + big(25) + "\n```";
    const got = detectFileBlocks(text);
    expect(got.map((b) => b.filename)).toEqual(["snippet-1.json", "snippet-2.yml"]);
  });

  it("recognizes Dockerfile and names it sanely", () => {
    const text = "```dockerfile\n" + big(25) + "\n```";
    const got = detectFileBlocks(text);
    expect(got[0]?.filename).toBe("Dockerfile");
  });

  it("aliases language tags (typescript → ts)", () => {
    const text = "```typescript\n" + big(25) + "\n```";
    expect(detectFileBlocks(text)[0]?.filename).toBe("snippet-1.ts");
  });

  it("ignores blocks with unknown language tags", () => {
    const text = "```martian\n" + big(40) + "\n```";
    expect(detectFileBlocks(text)).toEqual([]);
  });

  it("respects custom thresholds", () => {
    const text = "```json\n" + big(8) + "\n```";
    expect(detectFileBlocks(text)).toEqual([]);
    const got = detectFileBlocks(text, { minLines: 5 });
    expect(got).toHaveLength(1);
  });

  it("uses a custom filename prefix", () => {
    const text = "```json\n" + big(25) + "\n```";
    expect(
      detectFileBlocks(text, { filenamePrefix: "report" })[0]?.filename
    ).toBe("report-1.json");
  });

  it("preserves block content verbatim (no fences)", () => {
    const body = big(25);
    const text = "prose before\n```json\n" + body + "\n```\nprose after";
    expect(detectFileBlocks(text)[0]?.content).toBe(body);
  });
});
