import { describe, expect, it } from "vitest";
import { threadVoiceTranscriptMessages } from "../packages/core/src/platforms/discord/thread-voice-panel.js";

describe("Thread Voice transcript echo", () => {
  it("splits a long final into visible Discord-safe continuation messages without loss", () => {
    const transcript = Array.from({ length: 700 }, (_, i) => `word${i}`).join(" ");
    const messages = threadVoiceTranscriptMessages("Jesse", transcript);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 2_000)).toBe(true);
    expect(messages[0]).toMatch(/^🎙️ Jesse: /);
    expect(messages[1]).toMatch(/^🎙️ Jesse \(continued\): /);
    const recovered = messages
      .map((message, index) => message.replace(index === 0 ? /^🎙️ Jesse: / : /^🎙️ Jesse \(continued\): /, ""))
      .join(" ");
    expect(recovered).toBe(transcript);
  });
});
