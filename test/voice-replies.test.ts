import { describe, it, expect } from "vitest";
import { MessageFlags } from "discord.js";
import {
  buildTtsInput,
  findGeminiTtsVoice,
  geminiTtsVoiceChoices,
  GEMINI_TTS_VOICES,
  synthesizeSpeechWithGemini,
} from "../packages/core/src/core/audio/gemini-tts.js";
import { ttsSamplePath, TTS_SAMPLE_SCRIPT } from "../packages/core/src/core/audio/tts-samples.js";
import { encodePcmToOggOpus } from "../packages/core/src/core/audio/pcm-to-opus.js";
import {
  clipSpokenText,
  selectSpokenProse,
  shouldSpeakReply,
  TTS_MAX_CHARS,
  voiceMessageMetadataFromPcm,
} from "../packages/core/src/core/audio/voice-replies.js";
import { buildDiscordFileSendPayload } from "../packages/core/src/platforms/discord/adapter.js";

const TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function ttsFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = new Request(url, init);
    return handler(req);
  }) as typeof fetch;
}

describe("Gemini TTS voices", () => {
  it("lists 30 official prebuilt voices including Kore", () => {
    expect(GEMINI_TTS_VOICES).toHaveLength(30);
    expect(findGeminiTtsVoice("kore")?.name).toBe("Kore");
    expect(findGeminiTtsVoice("nope")).toBeUndefined();
  });

  it("filters autocomplete by name or style and caps at 25", () => {
    expect(geminiTtsVoiceChoices("").length).toBe(30);
    expect(geminiTtsVoiceChoices("kore")[0]).toEqual({ name: "Kore — Firm", value: "Kore" });
    expect(geminiTtsVoiceChoices("gravel").map((c) => c.value)).toEqual(["Algenib"]);
  });

  it("puts pace and style into director's notes, not the transcript", () => {
    const input = buildTtsInput("Hello there", "slow", "warm");
    expect(input).toMatch(/slowly/i);
    expect(input).toMatch(/Warm, friendly/i);
    expect(input).toContain("TRANSCRIPT:\nHello there");
    expect(input).toMatch(/name the site or page/i);
    expect(input).toMatch(/do not read the address/i);
    expect(input).toMatch(/Paraphrase highly technical content/i);
    expect(input).toMatch(/without the leading slash/i);
  });

  it("caches voice samples under DATA_DIR", () => {
    expect(ttsSamplePath("/data", "Kore")).toBe("/data/tts-voice-samples/Kore.ogg");
    expect(TTS_SAMPLE_SCRIPT.length).toBeGreaterThan(20);
  });
});

describe("shouldSpeakReply", () => {
  const base = {
    enabled: true,
    apiKey: "test-key",
    prose: "Hello there",
    alreadyHadAudio: false,
    turnOk: true,
  };

  it("speaks trimmed prose when the thread opted in", () => {
    expect(shouldSpeakReply(base)).toEqual({ speak: true, text: "Hello there" });
  });

  it("skips when TTS is off", () => {
    expect(shouldSpeakReply({ ...base, enabled: false })).toEqual({
      speak: false,
      reason: "disabled",
    });
  });

  it("skips when the API key is missing", () => {
    expect(shouldSpeakReply({ ...base, apiKey: "  " })).toEqual({
      speak: false,
      reason: "no-key",
    });
  });

  it("skips empty / placeholder prose", () => {
    expect(shouldSpeakReply({ ...base, prose: "  \n" })).toEqual({
      speak: false,
      reason: "empty",
    });
  });

  it("skips long replies", () => {
    expect(shouldSpeakReply({ ...base, prose: "x".repeat(TTS_MAX_CHARS + 1) })).toEqual({
      speak: false,
      reason: "too-long",
    });
  });

  it("clips a long reply on a sentence boundary", () => {
    const head = `${"word ".repeat(500)}Done. `;
    const clipped = clipSpokenText(`${head}${"x".repeat(TTS_MAX_CHARS)}`);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text.endsWith("Done.")).toBe(true);
    expect(clipped.text.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
  });

  it("skips when the turn already attached audio", () => {
    expect(shouldSpeakReply({ ...base, alreadyHadAudio: true })).toEqual({
      speak: false,
      reason: "had-audio",
    });
  });

  it("prefers prose after the last tool when the turn had tools", () => {
    expect(
      selectSpokenProse({
        all: "I'll check the logs.\n\nThe timeout was ours.",
        afterLastTool: "The timeout was ours.",
        sawTool: true,
      })
    ).toBe("The timeout was ours.");
  });

  it("uses the full turn when there were no tools", () => {
    expect(
      selectSpokenProse({
        all: "TTS is on in this thread.",
        afterLastTool: "TTS is on in this thread.",
        sawTool: false,
      })
    ).toBe("TTS is on in this thread.");
  });

  it("falls back to the full turn if tools ran but no later prose", () => {
    expect(
      selectSpokenProse({
        all: "I'll look that up.",
        afterLastTool: "   ",
        sawTool: true,
      })
    ).toBe("I'll look that up.");
  });

  it("skips cancelled or timed-out turns", () => {
    expect(shouldSpeakReply({ ...base, turnOk: false })).toEqual({
      speak: false,
      reason: "not-ok",
    });
  });
});

describe("Discord voice-message TTS", () => {
  it("builds duration and a normalized waveform from PCM", () => {
    const pcm = Buffer.alloc(8);
    [-1000, 0, 2000, -3000].forEach((sample, i) => pcm.writeInt16LE(sample, i * 2));
    const metadata = voiceMessageMetadataFromPcm(pcm, 4, 1);
    expect(metadata.durationSeconds).toBe(1);
    const waveform = Buffer.from(metadata.waveform, "base64");
    expect([...waveform]).toEqual([85, 0, 170, 255]);
  });

  it("marks generated audio as a native Discord voice message", () => {
    const payload = buildDiscordFileSendPayload({
      data: Buffer.from("OggS"),
      filename: "reply.ogg",
      mimeType: "audio/ogg",
      caption: "must not accompany a voice message",
      voiceMessage: { durationSeconds: 1.25, waveform: "AQID" },
    });
    expect(payload.flags).toBe(MessageFlags.IsVoiceMessage);
    expect("content" in payload).toBe(false);
    expect(payload.files[0]!.duration).toBe(1.25);
    expect(payload.files[0]!.waveform).toBe("AQID");
  });

  it("keeps ordinary file uploads as ordinary attachment messages", () => {
    const payload = buildDiscordFileSendPayload({
      data: Buffer.from("hello"),
      filename: "note.txt",
      mimeType: "text/plain",
      caption: "Note",
    });
    expect(payload.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(payload.content).toBe("Note");
    expect(payload.files[0]!.duration).toBeNull();
    expect(payload.files[0]!.waveform).toBeNull();
  });
});

describe("synthesizeSpeechWithGemini", () => {
  it("extracts L16 PCM from an Interactions audio step", async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const fetchFn = ttsFetch(async (req) => {
      expect(req.url).toBe(TTS_URL);
      expect(req.headers.get("x-goog-api-key")).toBe("test-key");
      const body = (await req.json()) as {
        model: string;
        generation_config: { speech_config: Array<{ voice: string }> };
      };
      expect(body.model).toBe("gemini-3.1-flash-tts-preview");
      expect(body.generation_config.speech_config[0]?.voice).toBe("Kore");
      return Response.json({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "audio",
                data: pcm.toString("base64"),
                sample_rate: 24000,
                channels: 1,
                mime_type: "audio/l16; rate=24000; channels=1",
              },
            ],
          },
        ],
      });
    });
    const result = await synthesizeSpeechWithGemini({
      apiKey: "test-key",
      text: "Hello",
      fetchFn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.audio.pcm)).toEqual(pcm);
    expect(result.audio.sampleRate).toBe(24000);
    expect(result.audio.channels).toBe(1);
  });

  it("returns a visible error on HTTP failure", async () => {
    let attempts = 0;
    const fetchFn = ttsFetch(async () => {
      attempts += 1;
      return Response.json({ error: { message: "quota exceeded" } }, { status: 429 });
    });
    const result = await synthesizeSpeechWithGemini({
      apiKey: "test-key",
      text: "Hello",
      fetchFn,
      retryDelayMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/quota exceeded/);
    expect(attempts).toBe(3);
  });

  it("retries the transient generic invalid-argument response", async () => {
    let attempts = 0;
    const pcm = Buffer.from([1, 2, 3, 4]);
    const fetchFn = ttsFetch(async () => {
      attempts += 1;
      if (attempts === 1) {
        return Response.json(
          { error: { message: "Request contains an invalid argument." } },
          { status: 400 }
        );
      }
      return Response.json({
        steps: [{ content: [{ type: "audio", data: pcm.toString("base64") }] }],
      });
    });
    const result = await synthesizeSpeechWithGemini({
      apiKey: "test-key",
      text: "Hello",
      fetchFn,
      retryDelayMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("does not retry a specific permanent invalid-argument response", async () => {
    let attempts = 0;
    const fetchFn = ttsFetch(async () => {
      attempts += 1;
      return Response.json(
        { error: { message: "Invalid voice name: NotARealVoice" } },
        { status: 400 }
      );
    });
    const result = await synthesizeSpeechWithGemini({
      apiKey: "test-key",
      text: "Hello",
      fetchFn,
      retryDelayMs: 0,
    });
    expect(result).toEqual({ ok: false, error: "Invalid voice name: NotARealVoice" });
    expect(attempts).toBe(1);
  });
});

describe("encodePcmToOggOpus", () => {
  it("pipes silence through ffmpeg to a non-empty ogg", async () => {
    const sampleRate = 24000;
    const pcm = Buffer.alloc(sampleRate * 2); // 1s mono s16le silence
    const result = await encodePcmToOggOpus({ pcm, sampleRate, channels: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ogg.byteLength).toBeGreaterThan(100);
    expect(Buffer.from(result.ogg.subarray(0, 4)).toString("ascii")).toBe("OggS");
  });
});
