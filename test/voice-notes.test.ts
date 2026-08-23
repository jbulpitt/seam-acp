import { describe, it, expect } from "vitest";
import { transcribeAudioWithGemini } from "../packages/core/src/core/audio/gemini-stt.js";
import {
  applyVoiceNoteTranscriptions,
  formatVoiceNoteBlock,
  isVoiceNoteAttachment,
} from "../packages/core/src/core/audio/voice-notes.js";
import type { MessageAttachment } from "../packages/core/src/platforms/chat-adapter.js";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";

function geminiFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = new Request(url, init);
    return handler(req);
  }) as typeof fetch;
}

const voice = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({
  url: "https://cdn.example/voice-message.ogg",
  filename: "voice-message.ogg",
  contentType: "audio/ogg",
  size: 30769,
  ...over,
});

describe("isVoiceNoteAttachment", () => {
  it("matches Discord voice notes by mime and extension", () => {
    expect(isVoiceNoteAttachment(voice())).toBe(true);
    expect(isVoiceNoteAttachment({ contentType: null, filename: "voice-message.ogg" })).toBe(true);
    expect(isVoiceNoteAttachment({ contentType: "image/png", filename: "pic.png" })).toBe(false);
  });
});

describe("formatVoiceNoteBlock", () => {
  it("quotes a successful transcript", () => {
    const text = formatVoiceNoteBlock("Jesse", [
      { filename: "voice-message.ogg", transcript: "Hello there" },
    ]);
    expect(text).toContain("Voice note from Jesse");
    expect(text).toContain("`voice-message.ogg`");
    expect(text).toContain('"Hello there"');
  });

  it("is fail-visible when STT errors", () => {
    const text = formatVoiceNoteBlock("Jesse", [
      { filename: "voice-message.ogg", error: "STT HTTP 500" },
    ]);
    expect(text).toMatch(/transcription failed: STT HTTP 500/);
    expect(text).not.toContain("undefined");
  });
});

describe("transcribeAudioWithGemini", () => {
  it("extracts spoken words from generateContent", async () => {
    const fetchFn = geminiFetch(async (req) => {
      expect(req.url).toBe(GEMINI_URL);
      expect(req.headers.get("x-goog-api-key")).toBe("test-key");
      const body = (await req.json()) as { contents: Array<{ parts: unknown[] }> };
      expect(body.contents[0]!.parts).toHaveLength(2);
      return Response.json({
        candidates: [{ content: { parts: [{ text: "  hello from the phone  " }] } }],
      });
    });
    const result = await transcribeAudioWithGemini({
      apiKey: "test-key",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
      fetchFn,
    });
    expect(result).toEqual({ ok: true, text: "hello from the phone" });
  });

  it("returns a visible error on HTTP failure", async () => {
    const fetchFn = geminiFetch(async () =>
      Response.json({ error: { message: "quota exceeded" } }, { status: 429 })
    );
    const result = await transcribeAudioWithGemini({
      apiKey: "test-key",
      bytes: new Uint8Array([1]),
      mimeType: "audio/ogg",
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/quota exceeded/);
  });
});

describe("applyVoiceNoteTranscriptions", () => {
  it("leaves the prompt unchanged when the API key is missing", async () => {
    let called = 0;
    const fetchFn = geminiFetch(async () => {
      called += 1;
      return Response.json({});
    });
    const prompt = "please help";
    const out = await applyVoiceNoteTranscriptions({
      prompt,
      attachments: [voice()],
      apiKey: "",
      speakerLabel: "Jesse",
      fetchFn,
    });
    expect(out).toBe(prompt);
    expect(called).toBe(0);
  });

  it("injects the transcript before the model sees the turn", async () => {
    const fetchFn = geminiFetch(async (req) => {
      if (req.url.startsWith("https://cdn.example/")) {
        return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Are you able to interpret this?" }] } }],
      });
    });
    const out = await applyVoiceNoteTranscriptions({
      prompt: "harness preamble here",
      attachments: [voice(), { url: "https://cdn.example/pic.png", filename: "pic.png", contentType: "image/png", size: 10 }],
      apiKey: "test-key",
      speakerLabel: "Jesse Bulpitt",
      fetchFn,
    });
    expect(out.startsWith("harness preamble here")).toBe(true);
    expect(out).toContain("Voice note from Jesse Bulpitt");
    expect(out).toContain("Are you able to interpret this?");
    expect(out).not.toContain("pic.png");
  });

  it("still runs the turn with a fail-visible note when STT errors", async () => {
    const fetchFn = geminiFetch(async (req) => {
      if (req.url.startsWith("https://cdn.example/")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return Response.json({ error: { message: "backend exploded" } }, { status: 500 });
    });
    const out = await applyVoiceNoteTranscriptions({
      prompt: "please transcribe",
      attachments: [voice()],
      apiKey: "test-key",
      speakerLabel: "Jesse",
      fetchFn,
    });
    expect(out).toContain("please transcribe");
    expect(out).toMatch(/transcription failed: backend exploded/);
  });
});
