import { describe, expect, it } from "vitest";
import { StreamingSpeechSegmenter } from "../packages/core/src/core/audio/streaming-speech-segmenter.js";

describe("StreamingSpeechSegmenter", () => {
  it("releases the first complete short sentence without waiting for turn EOF", () => {
    const segmenter = new StreamingSpeechSegmenter();
    expect(segmenter.feed("Ready now. The unfinished tail")).toEqual(["Ready now."]);
    expect(segmenter.flush()).toEqual(["The unfinished tail"]);
  });

  it("uses the sub-minimum sentence fast path only once", () => {
    const segmenter = new StreamingSpeechSegmenter();
    expect(segmenter.feed("One. Two. Three. unfinished tail")).toEqual(["One."]);
    expect(segmenter.flush()).toEqual(["Two. Three. unfinished tail"]);
  });

  it("emits arrival-ordered sentences near the target size", () => {
    const segmenter = new StreamingSpeechSegmenter();
    expect(segmenter.feed("This first thought is deliberately long enough to reach the minimum speech chunk size, ")).toEqual([]);
    expect(segmenter.feed("and now it ends. The next thought remains buffered until turn end.")).toEqual([
      "This first thought is deliberately long enough to reach the minimum speech chunk size, and now it ends.",
    ]);
    expect(segmenter.flush()).toEqual(["The next thought remains buffered until turn end."]);
  });

  it("flushes short paragraphs and the final tail", () => {
    const segmenter = new StreamingSpeechSegmenter();
    expect(segmenter.feed("Short paragraph.\n\nFinal tail")).toEqual(["Short paragraph."]);
    expect(segmenter.flush()).toEqual(["Final tail"]);
    expect(segmenter.flush()).toEqual([]);
  });

  it("excludes code fences even when markers cross stream chunks", () => {
    const segmenter = new StreamingSpeechSegmenter({ minChars: 20 });
    expect(segmenter.feed("Speak this introduction. ``")).toEqual([
      "Speak this introduction.",
    ]);
    expect(segmenter.feed("`ts\nconst secret = 42;\n``")).toEqual([]);
    expect(segmenter.feed("` Then speak this conclusion clearly. ")).toEqual([
      "Then speak this conclusion clearly.",
    ]);
    expect(segmenter.flush()).toEqual([]);
  });

  it("never speaks raw tool or directive events", () => {
    const segmenter = new StreamingSpeechSegmenter({ minChars: 20 });
    expect(segmenter.feed("shell output that must stay silent", "tool-output")).toEqual([]);
    expect(segmenter.feed("a seam control payload", "directive")).toEqual([]);
    expect(segmenter.feed("This is the only visible prose that should be spoken. ")).toEqual([
      "This is the only visible prose that should be spoken.",
    ]);
  });

  it("strips markdown-only syntax while retaining readable labels", () => {
    const segmenter = new StreamingSpeechSegmenter();
    expect(segmenter.feed("## Result\n- Read **the [guide](https://example.com/docs)** and use `seam config tts`.\n---\n")).toEqual([
      "Result Read the guide and use seam config tts.",
    ]);
    expect(segmenter.flush()).toEqual([]);
  });

  it("force-flushes around 400 characters at a safe whitespace boundary", () => {
    const segmenter = new StreamingSpeechSegmenter();
    const words = "carefully explained material ".repeat(25);
    const emitted = segmenter.feed(words);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]!.length).toBeGreaterThanOrEqual(320);
    expect(emitted[0]!.length).toBeLessThanOrEqual(400);
    expect(emitted[0]!.endsWith(" ")).toBe(false);
    expect(emitted[0]!.split(" ").every((word) => ["carefully", "explained", "material"].includes(word))).toBe(true);
    expect([...emitted, ...segmenter.flush()].join(" ")).toBe(words.trim());
  });

  it("drops an unfinished trailing fence instead of speaking its contents", () => {
    const segmenter = new StreamingSpeechSegmenter();
    segmenter.feed("Visible tail.\n\n```json\n{\"private\":true}");
    expect(segmenter.flush()).toEqual([]);
  });

  it("rejects feed after final flush", () => {
    const segmenter = new StreamingSpeechSegmenter();
    segmenter.flush();
    expect(() => segmenter.feed("late text")).toThrow(/already flushed/);
  });
});
