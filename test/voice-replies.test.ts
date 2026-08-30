import { describe, it, expect, vi } from "vitest";
import { MessageFlags } from "discord.js";
import {
  buildTtsInput,
  findGeminiTtsVoice,
  geminiTtsVoiceChoices,
  GEMINI_TTS_VOICES,
  streamSpeechWithGemini,
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

const sseEncoder = new TextEncoder();

function sseEvent(eventType: string, payload: unknown): Uint8Array {
  return sseEncoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function audioDelta(bytes: readonly number[]): Uint8Array {
  return sseEvent("step.delta", {
    event_type: "step.delta",
    index: 0,
    delta: {
      type: "audio",
      data: Buffer.from(bytes).toString("base64"),
      sample_rate: 24_000,
      channels: 1,
      mime_type: "audio/l16; rate=24000; channels=1",
    },
  });
}

function completedEvent(): Uint8Array {
  return sseEvent("interaction.completed", {
    event_type: "interaction.completed",
    interaction: { status: "completed" },
  });
}

function doneEvent(): Uint8Array {
  return sseEncoder.encode("event: done\ndata: [DONE]\n\n");
}

function audioEvent(delta: Record<string, unknown>): Uint8Array {
  return sseEvent("step.delta", {
    event_type: "step.delta",
    delta: { type: "audio", ...delta },
  });
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
    expect(input).toMatch(/Never read long identifiers, UUIDs, opaque IDs, tokens, or hashes character-by-character/i);
    expect(input).toMatch(/adding only a short distinguishing prefix/i);
    expect(input).toMatch(/Simplify large numbers and long decimals/i);
    expect(input).toMatch(/about 1\.2 million/i);
    expect(input).toMatch(/about 3\.14/i);
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
        store: boolean;
        generation_config: { speech_config: Array<{ voice: string }> };
      };
      expect(body.model).toBe("gemini-3.1-flash-tts-preview");
      expect(body.store).toBe(false);
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

describe("streamSpeechWithGemini", () => {
  it("parses one-byte CRLF SSE with comments, multiline data, unknown events, completion, and [DONE]", async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const raw = [
      ": provider keepalive\r\n",
      "event: future.event\r\n",
      "data: an intentionally unknown payload\r\n\r\n",
      "event: step.delta\r\n",
      'data: {"event_type":"step.delta",\r\n',
      `data: "delta":{"type":"audio","data":"${pcm.toString("base64")}",` +
        '"mime_type":"audio/l16; rate=24000; channels=1"}}\r\n\r\n',
      "event: interaction.completed\r\n",
      'data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ].join("");
    const encoded = sseEncoder.encode(raw);
    const accepted: Buffer[] = [];
    const result = await streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Fragment this",
      unaryFallback: false,
      fetchFn: ttsFetch(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }))),
      onAudioDelta: async (audio) => { accepted.push(Buffer.from(audio.pcm)); },
    });
    expect(result).toEqual({ ok: true, streamed: true, audioDeltas: 1 });
    expect(accepted).toEqual([pcm]);
  });

  it("enqueues ordered PCM deltas before response EOF with the streaming contract", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    }), { headers: { "content-type": "text/event-stream" } });
    const requests: Request[] = [];
    const fetchFn = ttsFetch(async (request) => {
      requests.push(request);
      return response;
    });
    const enqueued: Buffer[] = [];
    let settled = false;
    const resultPromise = streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Stream this",
      fetchFn,
      unaryFallback: false,
      onAudioDelta: async (audio) => { enqueued.push(Buffer.from(audio.pcm)); },
    }).finally(() => { settled = true; });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const request = requests[0]!;
    expect(request.headers.get("accept")).toBe("text/event-stream");
    expect(request.headers.get("api-revision")).toBe("2026-05-20");
    expect(request.headers.get("x-goog-api-key")).toBe("test-key");
    expect(await request.clone().json()).toMatchObject({
      model: "gemini-3.1-flash-tts-preview",
      stream: true,
      store: false,
      response_format: { type: "audio" },
    });

    streamController.enqueue(audioDelta([1, 2, 3, 4]));
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    expect(settled).toBe(false);
    streamController.enqueue(audioDelta([5, 6, 7, 8]));
    streamController.enqueue(audioDelta([9, 10, 11, 12]));
    streamController.enqueue(completedEvent());
    streamController.enqueue(doneEvent());
    streamController.close();

    await expect(resultPromise).resolves.toEqual({ ok: true, streamed: true, audioDeltas: 3 });
    expect(enqueued).toEqual([
      Buffer.from([1, 2, 3, 4]),
      Buffer.from([5, 6, 7, 8]),
      Buffer.from([9, 10, 11, 12]),
    ]);
  });

  it("treats [DONE] as terminal without waiting for the HTTP connection to close", async () => {
    let readerCancelled = false;
    const accepted: Buffer[] = [];
    const result = await streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Finish at the protocol marker",
      unaryFallback: false,
      idleReadTimeoutMs: 10,
      fetchFn: ttsFetch(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(audioDelta([1, 2]));
          controller.enqueue(completedEvent());
          controller.enqueue(doneEvent());
          // Intentionally leave the transport open: [DONE], not HTTP EOF, is
          // the terminal condition for an SSE interaction.
        },
        cancel() { readerCancelled = true; },
      }))),
      onAudioDelta: async (audio) => accepted.push(Buffer.from(audio.pcm)),
    });
    expect(result).toEqual({ ok: true, streamed: true, audioDeltas: 1 });
    expect(accepted).toEqual([Buffer.from([1, 2])]);
    expect(readerCancelled).toBe(true);
  });

  it("does not start another provider request when cancelled during retry backoff", async () => {
    let attempts = 0;
    const accepted: Buffer[] = [];
    const abort = new AbortController();
    const result = streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Cancel between attempts",
      signal: abort.signal,
      retryDelayMs: 1_000,
      unaryFallback: false,
      fetchFn: ttsFetch(async () => {
        attempts += 1;
        return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
      }),
      onAudioDelta: async (audio) => accepted.push(Buffer.from(audio.pcm)),
    });
    await vi.waitFor(() => expect(attempts).toBe(1));
    abort.abort();
    await expect(result).resolves.toEqual({ ok: false, error: "TTS cancelled" });
    expect(attempts).toBe(1);
    expect(accepted).toEqual([]);
  });

  it("does not invoke the audio consumer when cancellation wins before response parsing", async () => {
    const abort = new AbortController();
    const accepted: Buffer[] = [];
    const result = await streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Cancel before parsing",
      signal: abort.signal,
      unaryFallback: false,
      fetchFn: ttsFetch(async () => {
        abort.abort();
        return new Response(Buffer.concat([
          Buffer.from(audioDelta([1, 2])),
          Buffer.from(completedEvent()),
          Buffer.from(doneEvent()),
        ]));
      }),
      onAudioDelta: async (audio) => accepted.push(Buffer.from(audio.pcm)),
    });
    expect(result).toEqual({ ok: false, error: "TTS cancelled" });
    expect(accepted).toEqual([]);
  });

  it("cancels the response reader and accepts no later PCM", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let attempts = 0;
    const fetchFn = ttsFetch(async (request) => {
      attempts += 1;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          request.signal.addEventListener(
            "abort",
            () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true }
          );
        },
      }), { headers: { "content-type": "text/event-stream" } });
      return response;
    });
    const accepted: Buffer[] = [];
    const abort = new AbortController();
    const result = streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Cancel this",
      fetchFn,
      signal: abort.signal,
      retryDelayMs: 0,
      unaryFallback: false,
      onAudioDelta: async (audio) => { accepted.push(Buffer.from(audio.pcm)); },
    });
    await vi.waitFor(() => expect(attempts).toBe(1));
    streamController.enqueue(audioDelta([1, 2]));
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    abort.abort();

    await expect(result).resolves.toEqual({ ok: false, error: "TTS cancelled" });
    expect(attempts).toBe(1);
    expect(accepted).toEqual([Buffer.from([1, 2])]);
  });

  it("fails secret-safely on malformed SSE and permanent non-2xx responses", async () => {
    const malformedFetch = ttsFetch(async () => new Response(
      "event: step.delta\ndata: {not-json}\n\n",
      { headers: { "content-type": "text/event-stream" } }
    ));
    await expect(streamSpeechWithGemini({
      apiKey: "super-secret-key",
      text: "private transcript",
      fetchFn: malformedFetch,
      unaryFallback: false,
      onAudioDelta: async () => {},
    })).resolves.toEqual({ ok: false, error: "TTS stream contained malformed JSON" });

    let attempts = 0;
    const failed = await streamSpeechWithGemini({
      apiKey: "super-secret-key",
      text: "private transcript",
      fetchFn: ttsFetch(async () => {
        attempts += 1;
        return Response.json({ error: { message: "Invalid voice name" } }, { status: 400 });
      }),
      retryDelayMs: 0,
      unaryFallback: false,
      onAudioDelta: async () => {},
    });
    expect(failed).toEqual({ ok: false, error: "Invalid voice name" });
    expect(JSON.stringify(failed)).not.toContain("super-secret-key");
    expect(JSON.stringify(failed)).not.toContain("private transcript");
    expect(attempts).toBe(1);
  });

  it("rejects malformed base64, referenced/compressed audio, and conflicting metadata", async () => {
    const cases: Array<{ delta: Record<string, unknown>; error: string }> = [
      {
        delta: {
          data: "AAAA====",
          mime_type: "audio/l16; rate=24000; channels=1",
        },
        error: "TTS stream contained malformed audio data",
      },
      {
        delta: {
          data: "Af==",
          mime_type: "audio/l16; rate=24000; channels=1",
        },
        error: "TTS stream contained malformed audio data",
      },
      {
        delta: {
          data: "AQI=",
          uri: "https://example.invalid/audio",
          mime_type: "audio/l16; rate=24000; channels=1",
        },
        error: "TTS stream returned referenced audio instead of inline PCM",
      },
      {
        delta: { data: "AQI=", mime_type: "audio/mpeg; rate=24000; channels=1" },
        error: "TTS stream returned unsupported audio encoding",
      },
      {
        delta: {
          data: "AQI=",
          sample_rate: 16_000,
          channels: 1,
          mime_type: "audio/l16; rate=24000; channels=1",
        },
        error: "TTS stream returned conflicting audio metadata",
      },
    ];
    for (const item of cases) {
      let attempts = 0;
      const result = await streamSpeechWithGemini({
        apiKey: "test-key",
        text: "Reject unsafe audio",
        unaryFallback: false,
        retryDelayMs: 0,
        fetchFn: ttsFetch(async () => {
          attempts += 1;
          return new Response(audioEvent(item.delta));
        }),
        onAudioDelta: async () => { throw new Error("must not accept audio"); },
      });
      expect(result).toEqual({ ok: false, error: item.error });
      expect(attempts).toBe(1);
    }
  });

  it("inherits optional audio metadata and uses the pinned 24 kHz mono contract", async () => {
    const chunks = [
      audioEvent({
        data: "AQI=",
        mime_type: "audio/l16; rate=24000; channels=1",
      }),
      audioEvent({ data: "AwQ=" }),
      completedEvent(),
      doneEvent(),
    ];
    const accepted: Buffer[] = [];
    const result = await streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Metadata may be omitted",
      unaryFallback: false,
      fetchFn: ttsFetch(async (request) => {
        expect(await request.clone().json()).toMatchObject({
          response_format: { type: "audio" },
        });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }));
      }),
      onAudioDelta: async (audio) => accepted.push(Buffer.from(audio.pcm)),
    });
    expect(result).toEqual({ ok: true, streamed: true, audioDeltas: 2 });
    expect(accepted).toEqual([Buffer.from([1, 2]), Buffer.from([3, 4])]);
  });

  it("fails closed on explicit failure, missing completion, and truncated events", async () => {
    const streams = [
      {
        body: sseEvent("interaction.failed", {
          event_type: "interaction.failed",
          error: { message: "provider rejected synthesis" },
        }),
        error: "provider rejected synthesis",
      },
      { body: audioDelta([1, 2]), error: "TTS stream ended before completion" },
      {
        body: sseEncoder.encode('event: step.delta\ndata: {"event_type":"step.delta"'),
        error: "TTS stream contained malformed JSON",
      },
      {
        body: completedEvent(),
        error: "TTS stream ended before [DONE]",
      },
      {
        body: sseEvent("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { status: "incomplete" },
        }),
        error: "TTS stream completed with a non-completed status",
      },
    ];
    for (const item of streams) {
      const result = await streamSpeechWithGemini({
        apiKey: "test-key",
        text: "Fail closed",
        unaryFallback: false,
        fetchFn: ttsFetch(async () => new Response(item.body)),
        onAudioDelta: async () => {},
      });
      expect(result).toEqual({ ok: false, error: item.error });
    }
  });

  it("rejects audio after interaction completion before handing it to playback", async () => {
    const accepted: Buffer[] = [];
    const result = await streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Fence completed output",
      unaryFallback: false,
      fetchFn: ttsFetch(async () => new Response(Buffer.concat([
        Buffer.from(completedEvent()),
        Buffer.from(audioDelta([1, 2])),
        Buffer.from(doneEvent()),
      ]))),
      onAudioDelta: async (audio) => accepted.push(Buffer.from(audio.pcm)),
    });
    expect(result).toEqual({ ok: false, error: "TTS stream contained data after completion" });
    expect(accepted).toEqual([]);
  });

  it("enforces idle-read and overall provider watchdogs", async () => {
    const hangingFetch = (attempts: { count: number }): typeof fetch => ttsFetch(async (request) => {
      attempts.count += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", () => controller.error(
            Object.assign(new Error("aborted"), { name: "AbortError" })
          ), { once: true });
        },
      }));
    });
    const idleAttempts = { count: 0 };
    await expect(streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Idle timeout",
      unaryFallback: false,
      retryDelayMs: 0,
      idleReadTimeoutMs: 5,
      overallTimeoutMs: 1_000,
      fetchFn: hangingFetch(idleAttempts),
      onAudioDelta: async () => {},
    })).resolves.toEqual({ ok: false, error: "TTS stream idle read timed out" });
    expect(idleAttempts.count).toBe(3);

    let overallAttempts = 0;
    const overall = await streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Overall timeout after commit",
      unaryFallback: false,
      retryDelayMs: 0,
      idleReadTimeoutMs: 1_000,
      overallTimeoutMs: 10,
      fetchFn: ttsFetch(async (request) => {
        overallAttempts += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(audioDelta([1, 2]));
            request.signal.addEventListener("abort", () => controller.error(
              Object.assign(new Error("aborted"), { name: "AbortError" })
            ), { once: true });
          },
        }));
      }),
      onAudioDelta: async () => {},
    });
    expect(overall).toEqual({ ok: false, error: "TTS timed out" });
    expect(overallAttempts).toBe(1);
  });

  it("never retries after the first audio delta is handed to playback", async () => {
    let attempts = 0;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const accepted: Buffer[] = [];
    const result = streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Do not duplicate",
      retryDelayMs: 0,
      unaryFallback: false,
      fetchFn: ttsFetch(async () => {
        attempts += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(audioDelta([9, 10]));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }),
      onAudioDelta: async (audio) => { accepted.push(Buffer.from(audio.pcm)); },
    });
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    streamController.error(new Error("connection reset"));
    await expect(result).resolves.toEqual({ ok: false, error: "connection reset" });
    expect(attempts).toBe(1);
    expect(accepted).toEqual([Buffer.from([9, 10])]);
  });

  it("uses unary fallback only after a clean completed stream accepted no audio", async () => {
    let attempts = 0;
    const pcm = Buffer.from([1, 2, 3, 4]);
    const result = await streamSpeechWithGemini({
      apiKey: "test-key",
      text: "Fallback safely",
      retryDelayMs: 0,
      fetchFn: ttsFetch(async (request) => {
        attempts += 1;
        const body = await request.clone().json() as { stream?: boolean };
        if (body.stream) {
          return new Response(Buffer.concat([
            Buffer.from(completedEvent()),
            Buffer.from(doneEvent()),
          ]), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({
          steps: [{ content: [{ type: "audio", data: pcm.toString("base64") }] }],
        });
      }),
      onAudioDelta: async () => { throw new Error("must not receive a delta"); },
    });
    expect(result).toEqual({
      ok: true,
      streamed: false,
      audio: { pcm, sampleRate: 24_000, channels: 1 },
    });
    expect(attempts).toBe(2);
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
