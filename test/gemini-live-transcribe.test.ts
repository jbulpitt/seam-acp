import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GEMINI_LIVE_TRANSCRIBE_MODEL,
  GEMINI_PCM16K_MIME,
  GeminiLiveTranscribeClient,
  buildGeminiLiveTranscribeSetup,
  extractGeminiLiveTranscriptions,
  type GeminiLiveTranscribeResult,
  type GeminiUnaryFallback,
} from "../packages/core/src/core/audio/gemini-live-transcribe.js";

class MockWebSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  send(payload: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error("mock socket is not open");
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  server(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  failClose(code = 1011, reason = "server failure"): void {
    this.close(code, reason);
  }
}

interface Harness {
  sockets: MockWebSocket[];
  factory: (url: string) => WebSocket;
}

function socketHarness(): Harness {
  const sockets: MockWebSocket[] = [];
  return {
    sockets,
    factory: (url) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  };
}

async function connectClient(opts: {
  harness: Harness;
  unaryFallback?: GeminiUnaryFallback;
  handlers?: Parameters<typeof GeminiLiveTranscribeClient.connect>[0]["handlers"];
  finalizationTimeoutMs?: number;
  rotationMs?: number;
}): Promise<GeminiLiveTranscribeClient> {
  const connecting = GeminiLiveTranscribeClient.connect({
    apiKey: "test-key",
    webSocketFactory: opts.harness.factory,
    customVocabulary: [" Seam ", "seam", "Allie"],
    ...(opts.unaryFallback ? { unaryFallback: opts.unaryFallback } : {}),
    ...(opts.handlers ? { handlers: opts.handlers } : {}),
    ...(opts.finalizationTimeoutMs !== undefined
      ? { finalizationTimeoutMs: opts.finalizationTimeoutMs }
      : {}),
    ...(opts.rotationMs !== undefined ? { rotationMs: opts.rotationMs } : {}),
  });
  const socket = opts.harness.sockets[0]!;
  socket.open();
  socket.server({ setupComplete: {} });
  return connecting;
}

function audioMessages(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sent.filter((message) => {
    const realtime = message.realtimeInput as { audio?: unknown } | undefined;
    return realtime?.audio !== undefined;
  });
}

describe("Gemini Live Transcribe setup", () => {
  it("builds the fully qualified Vertex Live Transcribe model resource", () => {
    const message = buildGeminiLiveTranscribeSetup({
      provider: "vertex",
      vertexProjectId: "test-project",
      vertexLocation: "global",
      model: "gemini-3.5-transcribe-live-preview",
    });
    expect(message.setup.model).toBe(
      "projects/test-project/locations/global/publishers/google/models/gemini-3.5-transcribe-live-preview"
    );
  });

  it("builds the documented Text, Smart, manual-VAD setup with voice-note vocabulary rules", () => {
    expect(
      buildGeminiLiveTranscribeSetup({
        customVocabulary: [" Seam ", "seam", "", "Allie"],
      })
    ).toEqual({
      setup: {
        model: `models/${GEMINI_LIVE_TRANSCRIBE_MODEL}`,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: {
          languageCodes: [],
          mode: "SMART",
          customVocabulary: ["Seam", "Allie"],
        },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: true },
        },
      },
    });
  });

  it("extracts separate interim and finalized transcription fields", () => {
    expect(
      extractGeminiLiveTranscriptions({
        serverContent: {
          interimInputTranscription: { text: " maybe this " },
          inputTranscription: { text: "This is final." },
        },
      })
    ).toEqual({ interim: "maybe this", final: "This is final." });
    expect(
      extractGeminiLiveTranscriptions({
        server_content: {
          interim_input_transcription: { text: "partial" },
          input_transcription: { text: "done" },
        },
      })
    ).toEqual({ interim: "partial", final: "done" });
  });
});

describe("GeminiLiveTranscribeClient", () => {
  it("brackets PCM with manual activity events, reports forwarded bytes, and commits live final once", async () => {
    const harness = socketHarness();
    const interims: string[] = [];
    const finals: Array<{ text: string; source: string }> = [];
    const bytes: Array<{ bytes: number; totalBytes: number }> = [];
    const unaryFallback = vi.fn<GeminiUnaryFallback>(async () => ({
      ok: true,
      text: "should not run",
    }));
    const client = await connectClient({
      harness,
      unaryFallback,
      handlers: {
        onInterim: (text) => interims.push(text),
        onFinal: (result) => finals.push(result),
        onForwardedBytes: (event) => bytes.push(event),
      },
    });
    const socket = harness.sockets[0]!;

    await client.startUtterance();
    const pcm = new Uint8Array(4_000).fill(7);
    client.sendPcm16k(pcm);
    socket.server({
      serverContent: { interimInputTranscription: { text: "hello wor" } },
    });
    const resultPromise = client.finalizeUtterance(pcm);
    socket.server({
      serverContent: { inputTranscription: { text: "Hello world." } },
    });
    // A late duplicate cannot win after the utterance has committed.
    socket.server({
      serverContent: { inputTranscription: { text: "duplicate" } },
    });

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      text: "Hello world.",
      source: "live",
    });
    expect(unaryFallback).not.toHaveBeenCalled();
    expect(interims).toEqual(["hello wor"]);
    expect(finals).toEqual([{ text: "Hello world.", source: "live" }]);
    expect(client.forwardedBytes).toBe(4_000);
    expect(bytes).toEqual([
      { bytes: 3_200, totalBytes: 3_200 },
      { bytes: 800, totalBytes: 4_000 },
    ]);

    expect(socket.sent[1]).toEqual({ realtimeInput: { activityStart: {} } });
    expect(audioMessages(socket)).toHaveLength(2);
    expect(audioMessages(socket)[0]).toMatchObject({
      realtimeInput: {
        audio: { mimeType: GEMINI_PCM16K_MIME },
      },
    });
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
    client.close();
  });

  it("uses caller-buffered PCM for one unary fallback and ignores a late live-final race", async () => {
    vi.useFakeTimers();
    try {
      const harness = socketHarness();
      let resolveUnary!: (value: { ok: true; text: string }) => void;
      const unaryFallback = vi.fn<GeminiUnaryFallback>(
        () =>
          new Promise((resolve) => {
            resolveUnary = resolve;
          })
      );
      const finals: Array<{ text: string; source: string }> = [];
      const client = await connectClient({
        harness,
        unaryFallback,
        finalizationTimeoutMs: 25,
        handlers: { onFinal: (result) => finals.push(result) },
      });
      const socket = harness.sockets[0]!;
      await client.startUtterance();
      const callerBuffer = new Uint8Array([1, 2, 3, 4]);
      client.sendPcm16k(callerBuffer);
      const resultPromise = client.finalizeUtterance(callerBuffer);
      expect(client.finalizeUtterance(callerBuffer)).toBe(resultPromise);

      await vi.advanceTimersByTimeAsync(25);
      expect(unaryFallback).toHaveBeenCalledTimes(1);
      expect(unaryFallback).toHaveBeenCalledWith({
        apiKey: "test-key",
        model: "gemini-3.5-transcribe",
        pcm16k: callerBuffer,
        customVocabulary: ["Seam", "Allie"],
      });

      socket.server({
        serverContent: { inputTranscription: { text: "late live transcript" } },
      });
      resolveUnary({ ok: true, text: "Unary transcript." });
      await expect(resultPromise).resolves.toEqual({
        ok: true,
        text: "Unary transcript.",
        source: "unary",
      });
      expect(unaryFallback).toHaveBeenCalledTimes(1);
      expect(finals).toEqual([{ text: "Unary transcript.", source: "unary" }]);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels bounded finalization without invoking unary fallback", async () => {
    vi.useFakeTimers();
    try {
      const harness = socketHarness();
      const unaryFallback = vi.fn<GeminiUnaryFallback>(async () => ({
        ok: true,
        text: "must not run",
      }));
      const onFinal = vi.fn();
      const client = await connectClient({
        harness,
        unaryFallback,
        finalizationTimeoutMs: 25,
        handlers: { onFinal },
      });
      const pcm = new Uint8Array([1, 2, 3, 4]);
      await client.startUtterance();
      client.sendPcm16k(pcm);
      const resultPromise = client.finalizeUtterance(pcm);

      client.cancelUtterance();
      client.close();
      await vi.advanceTimersByTimeAsync(100);

      await expect(resultPromise).resolves.toEqual({
        ok: false,
        error: "live transcribe utterance cancelled",
        source: "live",
      });
      expect(unaryFallback).not.toHaveBeenCalled();
      expect(onFinal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves ordinary V1 close fallback when cancellation was not requested", async () => {
    const harness = socketHarness();
    const unaryFallback = vi.fn<GeminiUnaryFallback>(async () => ({
      ok: true,
      text: "V1 recovered transcript",
    }));
    const client = await connectClient({ harness, unaryFallback });
    const pcm = new Uint8Array([1, 2, 3, 4]);
    await client.startUtterance();
    client.sendPcm16k(pcm);
    const resultPromise = client.finalizeUtterance(pcm);

    client.close();

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      text: "V1 recovered transcript",
      source: "unary",
    });
    expect(unaryFallback).toHaveBeenCalledOnce();
  });

  it("falls back once when the socket closes during bounded finalization", async () => {
    const harness = socketHarness();
    const unaryFallback = vi.fn<GeminiUnaryFallback>(async () => ({
      ok: true,
      text: "Recovered transcript",
    }));
    const client = await connectClient({ harness, unaryFallback });
    const socket = harness.sockets[0]!;
    await client.startUtterance();
    client.sendPcm16k(new Uint8Array([1, 2]));
    const resultPromise = client.finalizeUtterance(new Uint8Array([1, 2]));
    socket.failClose();

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      text: "Recovered transcript",
      source: "unary",
    });
    expect(unaryFallback).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("retains the utterance for one unary fallback when reconnect setup fails at start", async () => {
    const harness = socketHarness();
    const unaryFallback = vi.fn<GeminiUnaryFallback>(async ({ pcm16k }) => ({
      ok: true,
      text: `Recovered ${pcm16k.byteLength} bytes`,
    }));
    const client = await connectClient({ harness, unaryFallback });
    // Simulate a connection that became unusable between captures without a
    // close event reaching the client. startUtterance must reserve the capture
    // before attempting its replacement connection.
    harness.sockets[0]!.readyState = WebSocket.CLOSED;
    const starting = client.startUtterance();
    const replacement = harness.sockets[1]!;
    replacement.open();
    replacement.emit("error", new Error("replacement setup failed"));
    await expect(starting).resolves.toBeUndefined();

    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(() => client.sendPcm16k(pcm)).not.toThrow();
    await expect(client.finalizeUtterance(pcm)).resolves.toEqual({
      ok: true,
      text: "Recovered 6 bytes",
      source: "unary",
    });
    expect(unaryFallback).toHaveBeenCalledTimes(1);
    expect(unaryFallback.mock.calls[0]![0].pcm16k).toEqual(pcm);
    expect(client.forwardedBytes).toBe(0);
    client.close();
  });

  it("uses the configured unary Smart API with the same normalized vocabulary", async () => {
    const harness = socketHarness();
    const requests: Request[] = [];
    const connecting = GeminiLiveTranscribeClient.connect({
      apiKey: "test-key",
      unaryModel: "gemini-3.5-transcribe",
      customVocabulary: [" Seam ", "seam", "Allie"],
      webSocketFactory: harness.factory,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "Smart API transcript" }],
            },
          ],
        });
      }) as typeof fetch,
    });
    const socket = harness.sockets[0]!;
    socket.open();
    socket.server({ setupComplete: {} });
    const client = await connecting;
    await client.startUtterance();
    const pcm = new Uint8Array([1, 2, 3, 4]);
    client.sendPcm16k(pcm);
    const resultPromise = client.finalizeUtterance(pcm);
    socket.failClose();

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      text: "Smart API transcript",
      source: "unary",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions"
    );
    expect(requests[0]!.headers.get("x-goog-api-key")).toBe("test-key");
    await expect(requests[0]!.json()).resolves.toMatchObject({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", data: "AQIDBA==", mime_type: "audio/pcm" }],
      generation_config: {
        transcription_config: {
          language_codes: [],
          mode: "smart",
          custom_vocabulary: ["Seam", "Allie"],
        },
      },
    });
    client.close();
  });

  it("opens a replacement session on GoAway and closes the old socket after setup", async () => {
    const harness = socketHarness();
    const events: string[] = [];
    const client = await connectClient({
      harness,
      handlers: { onSessionEvent: (event) => events.push(event.type) },
    });
    const first = harness.sockets[0]!;
    first.server({ goAway: { timeLeft: "30s" } });
    expect(harness.sockets).toHaveLength(2);
    const second = harness.sockets[1]!;
    second.open();
    second.server({ setupComplete: {} });
    await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED));

    expect(events).toEqual(["go_away", "rotated"]);
    expect(second.sent[0]).toEqual(
      buildGeminiLiveTranscribeSetup({ customVocabulary: ["Seam", "Allie"] })
    );
    await client.startUtterance();
    expect(second.sent[1]).toEqual({ realtimeInput: { activityStart: {} } });
    client.close();
  });

  it("rotates an idle connection before the configured session limit", async () => {
    vi.useFakeTimers();
    try {
      const harness = socketHarness();
      const client = await connectClient({ harness, rotationMs: 100 });
      const first = harness.sockets[0]!;
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.sockets).toHaveLength(2);
      const second = harness.sockets[1]!;
      second.open();
      second.server({ setupComplete: {} });
      await Promise.resolve();
      expect(first.readyState).toBe(WebSocket.CLOSED);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a unary error without emitting a successful final callback", async () => {
    const harness = socketHarness();
    const onFinal = vi.fn();
    const unaryFallback = vi.fn<GeminiUnaryFallback>(async () => ({
      ok: false,
      error: "unary unavailable",
    }));
    const client = await connectClient({ harness, unaryFallback, handlers: { onFinal } });
    await client.startUtterance();
    const resultPromise = client.finalizeUtterance(new Uint8Array([1, 2]));
    harness.sockets[0]!.failClose();
    const result: GeminiLiveTranscribeResult = await resultPromise;
    expect(result).toEqual({ ok: false, error: "unary unavailable", source: "unary" });
    expect(onFinal).not.toHaveBeenCalled();
    client.close();
  });
});
