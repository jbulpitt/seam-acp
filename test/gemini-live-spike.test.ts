import { describe, it, expect } from "vitest";
import {
  extractLiveAudioB64,
  extractLiveText,
  isLiveTurnComplete,
  liveReplyReady,
  parseLiveWsData,
} from "../packages/core/src/core/audio/gemini-live-spike.js";

describe("gemini live spike message parse", () => {
  it("skips unparseable first frames", () => {
    expect(parseLiveWsData("not-json")).toBeNull();
    expect(parseLiveWsData(Buffer.from([0xff, 0xfe]))).toBeNull();
    expect(parseLiveWsData("[]")).toBeNull();
  });

  it("parses setupComplete", () => {
    const msg = parseLiveWsData(JSON.stringify({ setupComplete: {} }));
    expect(msg && "setupComplete" in msg).toBe(true);
  });

  it("extracts pcm parts, transcripts, and turnComplete", () => {
    const msg = {
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from("abc").toString("base64") } },
            { text: "hello there" },
          ],
        },
        outputTranscription: { text: "hello " },
        inputTranscription: { text: "ping" },
        turnComplete: true,
      },
    };
    expect(extractLiveAudioB64(msg)).toEqual([Buffer.from("abc").toString("base64")]);
    expect(extractLiveText(msg, "input")).toBe("ping");
    expect(extractLiveText(msg, "output")).toContain("hello");
    expect(isLiveTurnComplete(msg)).toBe(true);
  });

  it("reads snake_case server_content too", () => {
    const msg = {
      server_content: {
        model_turn: {
          parts: [{ inline_data: { mime_type: "audio/pcm;rate=24000", data: "Zg==" } }],
        },
        turn_complete: true,
      },
    };
    expect(extractLiveAudioB64(msg)).toEqual(["Zg=="]);
    expect(isLiveTurnComplete(msg)).toBe(true);
  });

  it("does not treat the first audio chunk as a finished reply", () => {
    expect(liveReplyReady({ audioChunks: 1, turnComplete: false, closed: false })).toBe(false);
    expect(liveReplyReady({ audioChunks: 3, turnComplete: true, closed: false })).toBe(true);
    expect(liveReplyReady({ audioChunks: 2, turnComplete: false, closed: true })).toBe(true);
    expect(liveReplyReady({ audioChunks: 0, turnComplete: true, closed: false })).toBe(false);
  });
});
