import { describe, it, expect } from "vitest";
import {
  extractInteractionText,
  normalizeCustomVocabulary,
  transcribeAudioWithGemini,
} from "../packages/core/src/core/audio/gemini-stt.js";
import {
  applyVoiceNoteTranscriptions,
  formatHeardMessage,
  formatVoiceNoteBlock,
  isVoiceNoteAttachment,
  withoutVoiceNotes,
} from "../packages/core/src/core/audio/voice-notes.js";
import type { MessageAttachment } from "../packages/core/src/platforms/chat-adapter.js";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";
const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

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

  it("strips voice notes from the attachment list the model would see", () => {
    const kept = withoutVoiceNotes([
      voice(),
      { url: "https://cdn.example/pic.png", filename: "pic.png", contentType: "image/png", size: 10 },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.filename).toBe("pic.png");
  });
});

describe("formatVoiceNoteBlock", () => {
  it("quotes a successful transcript", () => {
    const text = formatVoiceNoteBlock("Jesse", [
      { filename: "voice-message.ogg", transcript: "Hello there" },
    ]);
    expect(text).toContain("The user (Jesse) sent a voice note");
    expect(text).toContain('"Hello there"');
    expect(text).not.toContain("voice-message.ogg");
    expect(text).not.toContain("Original audio");
  });

  it("is fail-visible when STT errors", () => {
    const text = formatVoiceNoteBlock("Jesse", [
      { filename: "voice-message.ogg", error: "STT HTTP 500" },
    ]);
    expect(text).toMatch(/The user \(Jesse\) sent a voice note \(transcription failed: STT HTTP 500\)/);
    expect(text).not.toContain("undefined");
  });

  it("points at Discord's CDN copy instead of a local file", () => {
    const url = "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=abc";
    const text = formatVoiceNoteBlock("Jesse", [
      { filename: "voice-message.ogg", transcript: "Hello there", sourceUrl: url },
    ]);
    expect(text).toContain('"Hello there"');
    expect(text).toContain("Original audio (Discord CDN; signed URL, may expire)");
    expect(text).toContain(url);
  });
});

describe("transcribeAudioWithGemini", () => {
  it("extracts spoken words from the legacy generateContent fallback model", async () => {
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
      model: "gemini-3.7-flash",
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
      model: "gemini-3.7-flash",
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/quota exceeded/);
  });

  it("uses Gemini 3.5 Interactions with Smart mode and custom vocabulary", async () => {
    const fetchFn = geminiFetch(async (req) => {
      expect(req.url).toBe(INTERACTIONS_URL);
      expect(req.headers.get("x-goog-api-key")).toBe("test-key");
      const body = (await req.json()) as {
        model: string;
        input: Array<{ type: string; data: string; mime_type: string }>;
        generation_config: {
          transcription_config: {
            language_codes: string[];
            mode: string;
            custom_vocabulary: string[];
          };
        };
      };
      expect(body.model).toBe("gemini-3.5-transcribe");
      expect(body.input).toEqual([
        { type: "audio", data: "AQID", mime_type: "audio/ogg" },
      ]);
      expect(body.generation_config.transcription_config).toEqual({
        language_codes: [],
        mode: "smart",
        custom_vocabulary: ["Seam", "Allie"],
      });
      return Response.json({
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: "  polished voice note  " }],
          },
        ],
      });
    });

    const result = await transcribeAudioWithGemini({
      apiKey: "test-key",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "application/ogg",
      customVocabulary: ["Seam", " seam ", "Allie"],
      fetchFn,
    });
    expect(result).toEqual({ ok: true, text: "polished voice note" });
  });

  it("falls back to Gemini 3.7 Flash after a transient Transcribe failure", async () => {
    const fallbackEvents: Array<{ fromModel: string; toModel: string; reason: string }> = [];
    let calls = 0;
    const fetchFn = geminiFetch(async (req) => {
      calls += 1;
      if (req.url === INTERACTIONS_URL) {
        return Response.json({ error: { message: "preview unavailable" } }, { status: 503 });
      }
      expect(req.url).toBe(GEMINI_URL);
      return Response.json({
        candidates: [{ content: { parts: [{ text: "fallback transcript" }] } }],
      });
    });

    const result = await transcribeAudioWithGemini({
      apiKey: "test-key",
      bytes: new Uint8Array([1]),
      mimeType: "audio/ogg",
      onFallback: (event) => fallbackEvents.push(event),
      fetchFn,
    });
    expect(result).toEqual({ ok: true, text: "fallback transcript" });
    expect(calls).toBe(2);
    expect(fallbackEvents).toEqual([
      {
        fromModel: "gemini-3.5-transcribe",
        toModel: "gemini-3.7-flash",
        reason: "preview unavailable",
      },
    ]);
  });

  it("does not hide a non-transient Transcribe request error with fallback", async () => {
    let calls = 0;
    const result = await transcribeAudioWithGemini({
      apiKey: "test-key",
      bytes: new Uint8Array([1]),
      mimeType: "audio/ogg",
      fetchFn: geminiFetch(async () => {
        calls += 1;
        return Response.json({ error: { message: "invalid transcription config" } }, { status: 400 });
      }),
    });
    expect(result).toEqual({ ok: false, error: "invalid transcription config" });
    expect(calls).toBe(1);
  });

  it("normalizes vocabulary and parses all model-output text parts", () => {
    const terms = ["Seam", " seam ", "", ...Array.from({ length: 110 }, (_, i) => `term-${i}`)];
    const normalized = normalizeCustomVocabulary(terms);
    expect(normalized).toHaveLength(100);
    expect(normalized.slice(0, 3)).toEqual(["Seam", "term-0", "term-1"]);
    expect(
      extractInteractionText({
        steps: [
          { type: "tool_output", content: [{ type: "text", text: "ignore" }] },
          {
            type: "model_output",
            content: [
              { type: "text", text: "first" },
              { type: "audio", data: "ignore" },
              { type: "text", text: "second" },
            ],
          },
        ],
      })
    ).toBe("first\nsecond");
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
    expect(out.prompt).toBe(prompt);
    expect(out.notes).toEqual([]);
    expect(called).toBe(0);
  });

  it("injects the transcript before the model sees the turn", async () => {
    const fetchFn = geminiFetch(async (req) => {
      if (req.url.startsWith("https://cdn.example/")) {
        return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
      }
      const body = (await req.json()) as {
        generation_config: {
          transcription_config: { custom_vocabulary: string[] };
        };
      };
      expect(body.generation_config.transcription_config.custom_vocabulary).toEqual([
        "Seam",
        "Allie",
        "Jesse Bulpitt",
      ]);
      return Response.json({
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: "Are you able to interpret this?" }],
          },
        ],
      });
    });
    const out = await applyVoiceNoteTranscriptions({
      prompt: "harness preamble here",
      attachments: [voice(), { url: "https://cdn.example/pic.png", filename: "pic.png", contentType: "image/png", size: 10 }],
      apiKey: "test-key",
      speakerLabel: "Jesse Bulpitt",
      customVocabulary: ["Seam", "Allie"],
      fetchFn,
    });
    expect(out.prompt.startsWith("harness preamble here")).toBe(true);
    expect(out.prompt).toContain("The user (Jesse Bulpitt) sent a voice note");
    expect(out.prompt).toContain("Are you able to interpret this?");
    expect(out.prompt).toContain("https://cdn.example/voice-message.ogg");
    expect(out.prompt).not.toContain("pic.png");
    expect(out.notes[0]?.transcript).toBe("Are you able to interpret this?");
    expect(out.notes[0]?.sourceUrl).toBe("https://cdn.example/voice-message.ogg");
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
    expect(out.prompt).toContain("please transcribe");
    expect(out.prompt).toMatch(/transcription failed: backend exploded/);
    expect(out.prompt).toContain("https://cdn.example/voice-message.ogg");
    expect(out.notes[0]?.error).toMatch(/backend exploded/);
    expect(out.notes[0]?.sourceUrl).toBe("https://cdn.example/voice-message.ogg");
  });
});

describe("formatHeardMessage", () => {
  it("shows the user what the model heard", () => {
    expect(formatHeardMessage([{ filename: "v.ogg", transcript: "hello" }])).toBe(
      '_Heard:_ "hello"'
    );
    expect(formatHeardMessage([{ filename: "v.ogg", error: "STT HTTP 500" }])).toBe(
      "_Couldn't transcribe voice note:_ STT HTTP 500"
    );
    expect(formatHeardMessage([])).toBeNull();
  });
});
