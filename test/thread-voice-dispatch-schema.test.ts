import { describe, expect, it } from "vitest";
import { parseDispatchSpec } from "../packages/core/src/core/dispatch/types.js";

const base = {
  target: "thread-1",
  prompt: "voice prompt",
  session: "live",
  createdUtc: "2026-08-27T12:00:00.000Z",
};

describe("thread_voice dispatch schema", () => {
  it("accepts the complete trusted tuple only for the internal kind", () => {
    expect(parseDispatchSpec("tvd-1", JSON.stringify({
      ...base,
      kind: "thread_voice",
      authorId: "user-1",
      authorName: "Jesse",
      threadVoiceSessionId: "tv-1",
    }))).toMatchObject({
      id: "tvd-1",
      kind: "thread_voice",
      authorId: "user-1",
      authorName: "Jesse",
      threadVoiceSessionId: "tv-1",
      session: "live",
    });
  });

  it("rejects missing trusted fields and isolated Thread Voice runs", () => {
    expect(() => parseDispatchSpec("bad-1", JSON.stringify({
      ...base, kind: "thread_voice", authorId: "user-1",
    }))).toThrow(/requires authorId, authorName, and threadVoiceSessionId/);
    expect(() => parseDispatchSpec("bad-2", JSON.stringify({
      ...base,
      session: "isolated",
      kind: "thread_voice",
      authorId: "user-1",
      authorName: "Jesse",
      threadVoiceSessionId: "tv-1",
    }))).toThrow(/must use the live session/);
  });

  it("rejects speaker metadata on arbitrary dispatch kinds", () => {
    expect(() => parseDispatchSpec("bad-3", JSON.stringify({
      ...base, kind: "handoff", authorId: "user-1",
    }))).toThrow(/accepted only for kind thread_voice/);
  });
});
