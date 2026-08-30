/** Control-plane Gemini text-to-speech for Discord voice replies. */
import {
  requireVertexConfig,
  resolveSpeechAccessToken,
  vertexModelUrl,
  type GeminiSpeechAuth,
} from "./google-speech-provider.js";
const DEFAULT_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_TTS_VOICE = "Kore";
/** Long replies (up to TTS_MAX_CHARS) can take >90s to synthesize. */
const TTS_TIMEOUT_MS = 180_000;
const TTS_STREAM_IDLE_TIMEOUT_MS = 20_000;
const TTS_MAX_ATTEMPTS = 3;
const TTS_RETRY_DELAY_MS = 250;
const TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TTS_MAX_SSE_EVENT_CHARS = 4 * 1024 * 1024;
const TTS_MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Official Gemini TTS prebuilt voices (30). Preview: https://aistudio.google.com/generate-speech */
export const GEMINI_TTS_VOICES: ReadonlyArray<{ name: string; style: string }> = [
  { name: "Zephyr", style: "Bright" },
  { name: "Puck", style: "Upbeat" },
  { name: "Charon", style: "Informative" },
  { name: "Kore", style: "Firm" },
  { name: "Fenrir", style: "Excitable" },
  { name: "Leda", style: "Youthful" },
  { name: "Orus", style: "Firm" },
  { name: "Aoede", style: "Breezy" },
  { name: "Callirrhoe", style: "Easy-going" },
  { name: "Autonoe", style: "Bright" },
  { name: "Enceladus", style: "Breathy" },
  { name: "Iapetus", style: "Clear" },
  { name: "Umbriel", style: "Easy-going" },
  { name: "Algieba", style: "Smooth" },
  { name: "Despina", style: "Smooth" },
  { name: "Erinome", style: "Clear" },
  { name: "Algenib", style: "Gravelly" },
  { name: "Rasalgethi", style: "Informative" },
  { name: "Laomedeia", style: "Upbeat" },
  { name: "Achernar", style: "Soft" },
  { name: "Alnilam", style: "Firm" },
  { name: "Schedar", style: "Even" },
  { name: "Gacrux", style: "Mature" },
  { name: "Pulcherrima", style: "Forward" },
  { name: "Achird", style: "Friendly" },
  { name: "Zubenelgenubi", style: "Casual" },
  { name: "Vindemiatrix", style: "Gentle" },
  { name: "Sadachbia", style: "Lively" },
  { name: "Sadaltager", style: "Knowledgeable" },
  { name: "Sulafat", style: "Warm" },
];

export const GEMINI_TTS_VOICE_PREVIEW_URL = "https://aistudio.google.com/generate-speech";

export function findGeminiTtsVoice(input: string): { name: string; style: string } | undefined {
  const q = input.trim().toLowerCase();
  if (!q) return undefined;
  return GEMINI_TTS_VOICES.find((v) => v.name.toLowerCase() === q);
}

export function geminiTtsVoiceChoices(prefix: string): { name: string; value: string }[] {
  const q = prefix.trim().toLowerCase();
  const items = !q
    ? GEMINI_TTS_VOICES
    : GEMINI_TTS_VOICES.filter(
        (v) =>
          v.name.toLowerCase().includes(q) || v.style.toLowerCase().includes(q)
      );
  return items.map((v) => ({ name: `${v.name} — ${v.style}`, value: v.name }));
}

export const TTS_PACES = ["slow", "natural", "fast", "faster"] as const;
export type TtsPace = (typeof TTS_PACES)[number];
export const TTS_STYLES = ["neutral", "warm", "clear"] as const;
export type TtsStyle = (typeof TTS_STYLES)[number];

export function isTtsPace(v: string): v is TtsPace {
  return (TTS_PACES as readonly string[]).includes(v);
}
export function isTtsStyle(v: string): v is TtsStyle {
  return (TTS_STYLES as readonly string[]).includes(v);
}

export function buildTtsInput(text: string, pace: TtsPace = "natural", style: TtsStyle = "neutral"): string {
  const transcript = sanitizeTtsTranscript(text);
  const paceNote =
    pace === "slow"
      ? "Speak slowly and clearly, with unhurried pacing. Do not rush."
      : pace === "faster"
        ? "Speak very fast — rapid, high-tempo delivery, noticeably quicker than brisk. Compress the pauses but keep every word crisp and intelligible; do not slur or drop words."
        : pace === "fast"
          ? "Speak at a brisk, energetic pace. Keep it intelligible, not breathless."
          : "Speak at a natural conversational pace.";
  const styleNote =
    style === "warm"
      ? "Warm, friendly, approachable tone."
      : style === "clear"
        ? "Crisp articulation, like explaining something carefully."
        : "Neutral, even delivery. No extra character.";
  return (
    `Director's notes: ${paceNote} ${styleNote} ` +
    `When the transcript contains a URL, name the site or page in a few words ` +
    `(e.g. "a Google search", "a GitHub link") — do not read the address, path, or query string. ` +
    `Paraphrase highly technical content (long shell commands, flags, file paths) in a few words. ` +
    `Never read long identifiers, UUIDs, opaque IDs, tokens, or hashes character-by-character; ` +
    `say what the value represents (for example, "the session ID" or "the commit hash"), ` +
    `adding only a short distinguishing prefix when it is genuinely useful. ` +
    `Simplify large numbers and long decimals for natural speech unless exact precision is essential: ` +
    `round them and use words such as thousand, million, or billion (for example, say ` +
    `"about 1.2 million" or "about 3.14"). ` +
    `Slash commands: say the words without the leading slash (e.g. "seam config tts").\n` +
    `Speak this Discord reply clearly. Read only the following transcript, no commentary.\n\n` +
    `TRANSCRIPT:\n${transcript}`
  );
}

/**
 * Remove terminal/control framing that can survive an agent stream while
 * remaining invisible in Discord. The visible Markdown pass happens earlier;
 * this is the final provider-boundary guard for split escape sequences and
 * Unicode direction/zero-width controls.
 */
export function sanitizeTtsTranscript(text: string): string {
  return text
    // OSC (terminal title/link) and CSI (colour/cursor) escape sequences.
    .replace(/\u001B\](?:[^\u0007\u001B]|\u001B(?!\\))*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    // Preserve ordinary whitespace, but never send other C0/C1 controls.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    // Invisible formatting can alter how adjacent text is interpreted.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .trim();
}

export type TtsPcm = {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
};

export type TtsResult = { ok: true; audio: TtsPcm } | { ok: false; error: string };

export type StreamingTtsResult =
  | { ok: true; streamed: true; audioDeltas: number }
  | { ok: true; streamed: false; audio: TtsPcm }
  | { ok: false; error: string };

export async function synthesizeSpeechWithGemini(opts: {
  apiKey?: string;
  text: string;
  model?: string;
  voice?: string;
  pace?: TtsPace;
  style?: TtsStyle;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** Test hook; production uses a short exponential retry delay. */
  retryDelayMs?: number;
} & GeminiSpeechAuth): Promise<TtsResult> {
  if ((opts.provider ?? "developer") === "vertex") {
    return synthesizeSpeechWithVertex(opts);
  }
  const apiKey = opts.apiKey?.trim() ?? "";
  if (!apiKey) return { ok: false, error: "SEAM_GEMINI_API_KEY is not set" };
  const text = opts.text.trim();
  if (!text) return { ok: false, error: "empty text" };

  const model = (opts.model ?? DEFAULT_TTS_MODEL).trim() || DEFAULT_TTS_MODEL;
  const voice = (opts.voice ?? DEFAULT_TTS_VOICE).trim() || DEFAULT_TTS_VOICE;
  const fetchFn = opts.fetchFn ?? fetch;
  const body = {
    model,
    input: buildTtsInput(text, opts.pace ?? "natural", opts.style ?? "neutral"),
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice }] },
    store: false,
  };

  const retryDelayMs = opts.retryDelayMs ?? TTS_RETRY_DELAY_MS;
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) return { ok: false, error: "TTS cancelled" };
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), TTS_TIMEOUT_MS);
    try {
      const res = await fetchFn(TTS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const raw = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        const error = `TTS HTTP ${res.status}: non-JSON body`;
        if (attempt < TTS_MAX_ATTEMPTS && res.status >= 500) {
          if (!await ttsRetryDelay(retryDelayMs, attempt, opts.signal)) {
            return { ok: false, error: "TTS cancelled" };
          }
          continue;
        }
        return { ok: false, error };
      }
      if (!res.ok) {
        const error = geminiErrorMessage(parsed) ?? `TTS HTTP ${res.status}`;
        if (attempt < TTS_MAX_ATTEMPTS && isRetryableTtsFailure(res.status, error)) {
          if (!await ttsRetryDelay(retryDelayMs, attempt, opts.signal)) {
            return { ok: false, error: "TTS cancelled" };
          }
          continue;
        }
        return { ok: false, error };
      }
      const audio = extractInteractionAudio(parsed);
      if (audio) return { ok: true, audio };
      if (attempt < TTS_MAX_ATTEMPTS) {
        if (!await ttsRetryDelay(retryDelayMs, attempt, opts.signal)) {
          return { ok: false, error: "TTS cancelled" };
        }
        continue;
      }
      return { ok: false, error: "TTS response had no audio" };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        return { ok: false, error: opts.signal?.aborted ? "TTS cancelled" : "TTS timed out" };
      }
      if (attempt < TTS_MAX_ATTEMPTS) {
        if (!await ttsRetryDelay(retryDelayMs, attempt, opts.signal)) {
          return { ok: false, error: "TTS cancelled" };
        }
        continue;
      }
      return { ok: false, error: err instanceof Error ? err.message : "TTS failed" };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  return { ok: false, error: "TTS failed" };
}

/**
 * Streams Gemini Interactions `step.delta` audio into an ordered consumer.
 *
 * The consumer is awaited for every delta, so its playback high-water mark
 * provides network backpressure. A request is never retried after any decoded
 * audio has been handed to the consumer; that fence prevents duplicated speech.
 * The unary fallback is restricted to a clean, successful stream that produced
 * no audio at all.
 */
export async function streamSpeechWithGemini(opts: {
  apiKey?: string;
  text: string;
  onAudioDelta: (audio: TtsPcm) => void | Promise<void>;
  signal?: AbortSignal;
  model?: string;
  voice?: string;
  pace?: TtsPace;
  style?: TtsStyle;
  fetchFn?: typeof fetch;
  /** Test hook; production uses a short exponential retry delay. */
  retryDelayMs?: number;
  /** Disable only in focused protocol tests. Production keeps the safe fallback. */
  unaryFallback?: boolean;
  /** Test hook; production caps the complete provider interaction at 180s. */
  overallTimeoutMs?: number;
  /** Test hook; production aborts a provider body read after 20s without bytes. */
  idleReadTimeoutMs?: number;
} & GeminiSpeechAuth): Promise<StreamingTtsResult> {
  if ((opts.provider ?? "developer") === "vertex") {
    return streamSpeechWithVertex(opts);
  }
  const apiKey = opts.apiKey?.trim() ?? "";
  if (!apiKey) return { ok: false, error: "SEAM_GEMINI_API_KEY is not set" };
  const text = opts.text.trim();
  if (!text) return { ok: false, error: "empty text" };
  if (opts.signal?.aborted) return { ok: false, error: "TTS cancelled" };

  const model = (opts.model ?? DEFAULT_TTS_MODEL).trim() || DEFAULT_TTS_MODEL;
  const voice = (opts.voice ?? DEFAULT_TTS_VOICE).trim() || DEFAULT_TTS_VOICE;
  const fetchFn = opts.fetchFn ?? fetch;
  const retryDelayMs = opts.retryDelayMs ?? TTS_RETRY_DELAY_MS;
  const body = {
    model,
    input: buildTtsInput(text, opts.pace ?? "natural", opts.style ?? "neutral"),
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice }] },
    stream: true,
    store: false,
  };

  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) return { ok: false, error: "TTS cancelled" };
    const result = await streamTtsAttempt({
      apiKey,
      body,
      fetchFn,
      signal: opts.signal,
      onAudioDelta: opts.onAudioDelta,
      overallTimeoutMs: opts.overallTimeoutMs ?? TTS_TIMEOUT_MS,
      idleReadTimeoutMs: opts.idleReadTimeoutMs ?? TTS_STREAM_IDLE_TIMEOUT_MS,
    });
    if (result.ok) {
      if (result.audioDeltas > 0) {
        return { ok: true, streamed: true, audioDeltas: result.audioDeltas };
      }
      if (opts.unaryFallback !== false && !opts.signal?.aborted) {
        const fallback = await synthesizeSpeechWithGemini({
          apiKey,
          text,
          model,
          voice,
          pace: opts.pace,
          style: opts.style,
          fetchFn,
          signal: opts.signal,
          retryDelayMs,
        });
        return fallback.ok
          ? { ok: true, streamed: false, audio: fallback.audio }
          : fallback;
      }
      return { ok: false, error: "TTS stream completed without audio" };
    }
    if (opts.signal?.aborted) {
      return { ok: false, error: "TTS cancelled" };
    }
    if (result.audioAccepted) {
      return { ok: false, error: result.error };
    }
    if (!result.retryable || attempt === TTS_MAX_ATTEMPTS) {
      return { ok: false, error: result.error };
    }
    if (!await ttsRetryDelay(retryDelayMs, attempt, opts.signal)) {
      return { ok: false, error: "TTS cancelled" };
    }
  }
  return { ok: false, error: "TTS failed" };
}

function buildVertexTtsBody(text: string, voice: string, pace: TtsPace, style: TtsStyle): object {
  return {
    contents: {
      role: "user",
      parts: [{ text: buildTtsInput(text, pace, style) }],
    },
    generation_config: {
      response_modalities: ["AUDIO"],
      speech_config: {
        language_code: "en-US",
        voice_config: { prebuilt_voice_config: { voice_name: voice } },
      },
    },
  };
}

async function vertexTtsRequest(opts: GeminiSpeechAuth & {
  model: string;
  method: "generateContent" | "streamGenerateContent";
  sse?: boolean;
  body: object;
  fetchFn: typeof fetch;
  signal: AbortSignal;
}): Promise<Response> {
  const vertex = requireVertexConfig(opts);
  const token = await resolveSpeechAccessToken(opts.accessToken);
  return opts.fetchFn(vertexModelUrl({
    ...vertex,
    model: opts.model,
    method: opts.method,
    sse: opts.sse,
  }), {
    method: "POST",
    headers: {
      accept: opts.sse ? "text/event-stream" : "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-goog-user-project": vertex.projectId,
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
}

async function synthesizeSpeechWithVertex(opts: Parameters<typeof synthesizeSpeechWithGemini>[0]): Promise<TtsResult> {
  const text = opts.text.trim();
  if (!text) return { ok: false, error: "empty text" };
  const model = opts.model?.trim() || DEFAULT_TTS_MODEL;
  const voice = opts.voice?.trim() || DEFAULT_TTS_VOICE;
  const body = buildVertexTtsBody(text, voice, opts.pace ?? "natural", opts.style ?? "neutral");
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const response = await vertexTtsRequest({
      ...opts,
      model,
      method: "generateContent",
      body,
      fetchFn: opts.fetchFn ?? fetch,
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: await interactionHttpError(response) };
    const parsed = await response.json() as unknown;
    const audio = extractVertexAudio(parsed);
    return audio ? { ok: true, audio } : { ok: false, error: "TTS response had no audio" };
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, error: "TTS cancelled" };
    return { ok: false, error: controller.signal.aborted ? "TTS timed out" : safeTtsError(err) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function streamSpeechWithVertex(opts: Parameters<typeof streamSpeechWithGemini>[0]): Promise<StreamingTtsResult> {
  const text = opts.text.trim();
  if (!text) return { ok: false, error: "empty text" };
  if (opts.signal?.aborted) return { ok: false, error: "TTS cancelled" };
  const model = opts.model?.trim() || DEFAULT_TTS_MODEL;
  const voice = opts.voice?.trim() || DEFAULT_TTS_VOICE;
  const body = buildVertexTtsBody(text, voice, opts.pace ?? "natural", opts.style ?? "neutral");
  const retryDelayMs = opts.retryDelayMs ?? TTS_RETRY_DELAY_MS;
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) return { ok: false, error: "TTS cancelled" };
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.overallTimeoutMs ?? TTS_TIMEOUT_MS);
    let accepted = false;
    try {
      const response = await vertexTtsRequest({
        ...opts,
        model,
        method: "streamGenerateContent",
        sse: true,
        body,
        fetchFn: opts.fetchFn ?? fetch,
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await interactionHttpError(response);
        if (attempt < TTS_MAX_ATTEMPTS && isRetryableTtsFailure(response.status, error)) {
          if (!await ttsRetryDelay(retryDelayMs, attempt, opts.signal)) return { ok: false, error: "TTS cancelled" };
          continue;
        }
        return { ok: false, error };
      }
      if (!response.body) throw new Error("TTS stream response had no body");
      const count = await consumeVertexAudioSse(response.body, async (audio) => {
        if (controller.signal.aborted) throw abortError("TTS provider request aborted");
        accepted = true;
        await waitForConsumerOrAbort(opts.onAudioDelta(audio), controller.signal);
      }, {
        idleReadTimeoutMs: opts.idleReadTimeoutMs ?? TTS_STREAM_IDLE_TIMEOUT_MS,
        abort: () => controller.abort(),
      });
      if (count > 0) return { ok: true, streamed: true, audioDeltas: count };
      if (opts.unaryFallback !== false) {
        const fallback = await synthesizeSpeechWithVertex(opts);
        return fallback.ok ? { ok: true, streamed: false, audio: fallback.audio } : fallback;
      }
      return { ok: false, error: "TTS stream completed without audio" };
    } catch (err) {
      if (opts.signal?.aborted) return { ok: false, error: "TTS cancelled" };
      const error = err instanceof TtsIdleReadTimeoutError
        ? "TTS stream idle read timed out"
        : timedOut ? "TTS timed out" : safeTtsError(err);
      if (accepted || err instanceof TtsProtocolError || attempt === TTS_MAX_ATTEMPTS) return { ok: false, error };
      if (!await ttsRetryDelay(retryDelayMs, attempt, opts.signal)) return { ok: false, error: "TTS cancelled" };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  return { ok: false, error: "TTS failed" };
}

async function consumeVertexAudioSse(
  body: ReadableStream<Uint8Array>,
  onAudioDelta: (audio: TtsPcm) => Promise<void>,
  watchdog: { idleReadTimeoutMs: number; abort: () => void }
): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let dataLines: string[] = [];
  let audioDeltas = 0;
  let finished = false;
  const dispatch = async (): Promise<void> => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    let parsed: unknown;
    try { parsed = JSON.parse(data) as unknown; }
    catch { throw new TtsProtocolError("TTS stream contained malformed JSON"); }
    const error = geminiErrorMessage(parsed);
    if (error) throw new TtsProtocolError(error);
    const deltas = extractVertexAudioParts(parsed);
    for (const audio of deltas) {
      audioDeltas++;
      await onAudioDelta(audio);
    }
    const candidates = (parsed as { candidates?: unknown })?.candidates;
    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        const reason = (candidate as { finishReason?: unknown; finish_reason?: unknown }).finishReason ??
          (candidate as { finish_reason?: unknown }).finish_reason;
        if (typeof reason === "string") {
          if (reason !== "STOP") throw new TtsProtocolError(`TTS stream ended with ${reason}`);
          finished = true;
        }
      }
    }
  };
  try {
    while (true) {
      const { value, done } = await readWithIdleWatchdog(reader, watchdog.idleReadTimeoutMs, watchdog.abort);
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > TTS_MAX_SSE_EVENT_CHARS) throw new TtsProtocolError("TTS stream event exceeded size limit");
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        let line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) { await dispatch(); continue; }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    buffered += decoder.decode();
    if (buffered.startsWith("data:")) dataLines.push(buffered.slice(5).replace(/^ /, ""));
    await dispatch();
  } finally {
    reader.releaseLock();
  }
  if (!finished) throw new TtsProtocolError("TTS stream ended before STOP");
  return audioDeltas;
}

function extractVertexAudioParts(parsed: unknown): TtsPcm[] {
  if (!parsed || typeof parsed !== "object") return [];
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  const out: TtsPcm[] = [];
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = (part as { inlineData?: { data?: unknown; mimeType?: unknown }; inline_data?: { data?: unknown; mime_type?: unknown } }).inlineData ??
        (part as { inline_data?: { data?: unknown; mime_type?: unknown } }).inline_data;
      if (!inline || typeof inline.data !== "string") continue;
      const mime = (inline as { mimeType?: unknown }).mimeType ??
        (inline as { mime_type?: unknown }).mime_type;
      if (typeof mime !== "string") {
        throw new TtsProtocolError("TTS stream returned unsupported audio format");
      }
      const format = parseStableL16Mime(mime);
      if (!format || (format.sampleRate ?? 24_000) !== 24_000 || (format.channels ?? 1) !== 1) {
        throw new TtsProtocolError("TTS stream returned unsupported audio format");
      }
      const pcm = decodeCanonicalBase64(inline.data);
      if (pcm.byteLength % 2) throw new TtsProtocolError("TTS stream ended with a partial PCM sample");
      out.push({ pcm, sampleRate: 24_000, channels: 1 });
    }
  }
  return out;
}

function extractVertexAudio(parsed: unknown): TtsPcm | null {
  const parts = extractVertexAudioParts(parsed);
  if (!parts.length) return null;
  return {
    pcm: Buffer.concat(parts.map((part) => Buffer.from(part.pcm))),
    sampleRate: 24_000,
    channels: 1,
  };
}

type StreamAttemptResult =
  | { ok: true; audioDeltas: number }
  | { ok: false; error: string; retryable: boolean; audioAccepted: boolean };

async function streamTtsAttempt(opts: {
  apiKey: string;
  body: object;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  onAudioDelta: (audio: TtsPcm) => void | Promise<void>;
  overallTimeoutMs: number;
  idleReadTimeoutMs: number;
}): Promise<StreamAttemptResult> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  // addEventListener does not replay an abort that happened before registration.
  if (opts.signal?.aborted) controller.abort();
  let overallTimedOut = false;
  const timer = setTimeout(() => {
    overallTimedOut = true;
    controller.abort();
  }, opts.overallTimeoutMs);
  let audioAccepted = false;
  try {
    const response = await opts.fetchFn(TTS_URL, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "api-revision": "2026-05-20",
        "content-type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await interactionHttpError(response);
      return {
        ok: false,
        error,
        retryable: isRetryableTtsFailure(response.status, error),
        audioAccepted: false,
      };
    }
    if (!response.body) {
      return {
        ok: false,
        error: "TTS stream response had no body",
        retryable: true,
        audioAccepted: false,
      };
    }
    const consumed = await consumeInteractionAudioSse(response.body, async (audio) => {
      if (controller.signal.aborted) {
        throw abortError("TTS provider request aborted");
      }
      // Fence retries before invoking an external consumer: it may enqueue and
      // then fail while applying backpressure, which is still accepted audio.
      audioAccepted = true;
      await waitForConsumerOrAbort(opts.onAudioDelta(audio), controller.signal);
    }, {
      idleReadTimeoutMs: opts.idleReadTimeoutMs,
      abort: () => controller.abort(),
    });
    return { ok: true, audioDeltas: consumed };
  } catch (error) {
    const cancelled = Boolean(opts.signal?.aborted);
    return {
      ok: false,
      error: cancelled
        ? "TTS cancelled"
        : error instanceof TtsIdleReadTimeoutError
          ? "TTS stream idle read timed out"
          : overallTimedOut
          ? "TTS timed out"
          : safeTtsError(error),
      retryable: !audioAccepted && !cancelled && !(error instanceof TtsProtocolError),
      audioAccepted,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function waitForConsumerOrAbort(
  value: void | Promise<void>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw abortError("TTS provider request aborted");
  const consumer = Promise.resolve(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortError("TTS provider request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void consumer.then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

class TtsProtocolError extends Error {
  override readonly name = "TtsProtocolError";
}

class TtsIdleReadTimeoutError extends Error {
  override readonly name = "TtsIdleReadTimeoutError";
  constructor() {
    super("TTS stream idle read timed out");
  }
}

async function consumeInteractionAudioSse(
  body: ReadableStream<Uint8Array>,
  onAudioDelta: (audio: TtsPcm) => Promise<void>,
  watchdog: { idleReadTimeoutMs: number; abort: () => void }
): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let dataLines: string[] = [];
  let eventName = "";
  let completed = false;
  let doneMarker = false;
  let audioDeltas = 0;
  let pcmTail = Buffer.alloc(0);
  let audioFormat: { sampleRate: number; channels: number } | undefined;
  let reachedEof = false;

  const acceptAudio = async (delta: unknown): Promise<void> => {
    const parsed = parseAudioDelta(delta, audioFormat);
    if (!parsed) return;
    if (
      audioFormat &&
      (audioFormat.sampleRate !== parsed.sampleRate || audioFormat.channels !== parsed.channels)
    ) {
      throw new TtsProtocolError("TTS stream changed audio format mid-response");
    }
    audioFormat ??= { sampleRate: parsed.sampleRate, channels: parsed.channels };
    const combined = pcmTail.byteLength
      ? Buffer.concat([pcmTail, Buffer.from(parsed.pcm)])
      : Buffer.from(parsed.pcm);
    const completeBytes = combined.byteLength - (combined.byteLength % 2);
    pcmTail = completeBytes === combined.byteLength
      ? Buffer.alloc(0)
      : Buffer.from(combined.subarray(completeBytes));
    if (completeBytes === 0) return;
    audioDeltas += 1;
    await onAudioDelta({
      pcm: new Uint8Array(combined.subarray(0, completeBytes)),
      sampleRate: parsed.sampleRate,
      channels: parsed.channels,
    });
  };

  const dispatchEvent = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = "";
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    const declaredEvent = eventName;
    eventName = "";
    if (data === "[DONE]") {
      doneMarker = true;
      return;
    }
    if (doneMarker) {
      throw new TtsProtocolError("TTS stream contained data after [DONE]");
    }
    if (completed) {
      throw new TtsProtocolError("TTS stream contained data after completion");
    }
    if (declaredEvent && !isKnownInteractionEvent(declaredEvent)) return;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new TtsProtocolError("TTS stream contained malformed JSON");
    }
    if (!event || typeof event !== "object") {
      throw new TtsProtocolError("TTS stream contained a malformed event");
    }
    const record = event as {
      event_type?: unknown;
      delta?: unknown;
      interaction?: { status?: unknown };
      message?: unknown;
      error?: { message?: unknown };
    };
    const eventType = typeof record.event_type === "string"
      ? record.event_type
      : declaredEvent;
    if (!isKnownInteractionEvent(eventType)) return;
    if (
      eventType === "error" ||
      eventType === "interaction.failed" ||
      eventType === "interaction.cancelled"
    ) {
      const detail = typeof record.message === "string"
        ? record.message
        : typeof record.error?.message === "string"
          ? record.error.message
          : "TTS stream reported an error";
      throw new TtsProtocolError(safeTtsError(detail));
    }
    if (eventType === "step.delta") await acceptAudio(record.delta);
    if (eventType === "interaction.completed") {
      if (record.interaction?.status !== "completed") {
        throw new TtsProtocolError("TTS stream completed with a non-completed status");
      }
      completed = true;
    }
  };

  const acceptLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      await dispatchEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
    const eventChars = dataLines.reduce((sum, part) => sum + part.length, 0);
    if (eventChars > TTS_MAX_SSE_EVENT_CHARS) {
      throw new TtsProtocolError("TTS stream event exceeded the buffer limit");
    }
  };

  try {
    stream: while (true) {
      const { value, done } = await readWithIdleWatchdog(
        reader,
        watchdog.idleReadTimeoutMs,
        watchdog.abort
      );
      if (done) {
        reachedEof = true;
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > TTS_MAX_SSE_EVENT_CHARS) {
        throw new TtsProtocolError("TTS stream line exceeded the buffer limit");
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        await acceptLine(line);
        // `[DONE]` is the protocol terminator. Do not wait for the HTTP peer to
        // close a keep-alive connection after the terminal SSE record.
        if (doneMarker) break stream;
      }
    }
    if (!doneMarker) {
      buffered += decoder.decode();
      if (buffered) await acceptLine(buffered);
      await dispatchEvent();
    }
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (pcmTail.byteLength > 0) {
    throw new TtsProtocolError("TTS stream ended with a partial PCM sample");
  }
  if (!completed) throw new TtsProtocolError("TTS stream ended before completion");
  if (!doneMarker) throw new TtsProtocolError("TTS stream ended before [DONE]");
  return audioDeltas;
}

async function readWithIdleWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  abort: () => void
): Promise<{ value: Uint8Array | undefined; done: boolean }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return reader.read();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      abort();
      reject(new TtsIdleReadTimeoutError());
    }, timeoutMs);
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseAudioDelta(
  delta: unknown,
  inheritedFormat?: { sampleRate: number; channels: number }
): TtsPcm | null {
  if (!delta || typeof delta !== "object") return null;
  const record = delta as {
    type?: unknown;
    data?: unknown;
    sample_rate?: unknown;
    channels?: unknown;
    mime_type?: unknown;
    uri?: unknown;
    url?: unknown;
    file_uri?: unknown;
  };
  if (record.type !== "audio") return null;
  if (record.uri != null || record.url != null || record.file_uri != null) {
    throw new TtsProtocolError("TTS stream returned referenced audio instead of inline PCM");
  }
  let fromMime: { sampleRate?: number; channels?: number } | undefined;
  if ("mime_type" in record) {
    if (typeof record.mime_type !== "string") {
      throw new TtsProtocolError("TTS stream contained invalid audio metadata");
    }
    fromMime = parseStableL16Mime(record.mime_type) ?? undefined;
    if (!fromMime) {
      throw new TtsProtocolError("TTS stream returned unsupported audio encoding");
    }
  }
  if (typeof record.data !== "string" || !isStrictBase64(record.data)) {
    throw new TtsProtocolError("TTS stream contained malformed audio data");
  }
  const pcm = Buffer.from(record.data, "base64");
  if (pcm.byteLength === 0) throw new TtsProtocolError("TTS stream contained empty audio data");
  const fieldRate = optionalPositiveAudioInteger(record, "sample_rate");
  const fieldChannels = optionalPositiveAudioInteger(record, "channels");
  if (
    (fieldRate !== undefined && fromMime?.sampleRate !== undefined && fieldRate !== fromMime.sampleRate) ||
    (fieldChannels !== undefined && fromMime?.channels !== undefined && fieldChannels !== fromMime.channels)
  ) {
    throw new TtsProtocolError("TTS stream returned conflicting audio metadata");
  }
  // AudioDelta format fields are optional. The request pins inline L16 at
  // 24 kHz, and Gemini TTS is mono; explicit fields still must agree with that
  // contract and with every earlier delta.
  const sampleRate = fieldRate ?? fromMime?.sampleRate ?? inheritedFormat?.sampleRate ?? 24_000;
  const channels = fieldChannels ?? fromMime?.channels ?? inheritedFormat?.channels ?? 1;
  if (sampleRate !== 24_000 || channels !== 1) {
    throw new TtsProtocolError("TTS stream returned unsupported PCM format");
  }
  return { pcm, sampleRate, channels };
}

function optionalPositiveAudioInteger(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TtsProtocolError("TTS stream contained invalid audio metadata");
  }
  return value;
}

function parseStableL16Mime(
  mime: string
): { sampleRate?: number; channels?: number } | null {
  const parts = mime.split(";");
  if (parts.shift()?.trim().toLowerCase() !== "audio/l16") return null;
  const parsed: { sampleRate?: number; channels?: number } = {};
  for (const rawPart of parts) {
    const match = /^\s*([a-z][a-z0-9_-]*)\s*=\s*(\d+)\s*$/i.exec(rawPart);
    if (!match) throw new TtsProtocolError("TTS stream contained invalid audio metadata");
    const value = Number(match[2]);
    const key = match[1]!.toLowerCase();
    if (key !== "rate" && key !== "channels") {
      throw new TtsProtocolError("TTS stream contained unsupported audio metadata");
    }
    const property = key === "rate" ? "sampleRate" : "channels";
    const existing = parsed[property];
    if (existing !== undefined && existing !== value) {
      throw new TtsProtocolError("TTS stream returned conflicting audio metadata");
    }
    parsed[property] = value;
  }
  return parsed;
}

function isStrictBase64(value: string): boolean {
  if (
    value.length === 0 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!isStrictBase64(value)) {
    throw new TtsProtocolError("TTS stream contained invalid base64 audio");
  }
  const decoded = Buffer.from(value, "base64");
  if (!decoded.byteLength) throw new TtsProtocolError("TTS stream contained empty audio");
  return decoded;
}

function isKnownInteractionEvent(value: string): boolean {
  return value === "step.start" || value === "step.delta" ||
    value === "interaction.completed" || value === "interaction.failed" ||
    value === "interaction.cancelled" || value === "error";
}

async function interactionHttpError(response: Response): Promise<string> {
  const raw = await readResponsePrefix(response, TTS_MAX_ERROR_BODY_BYTES);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return geminiErrorMessage(parsed) ?? `TTS HTTP ${response.status}`;
  } catch {
    return `TTS HTTP ${response.status}: non-JSON body`;
  }
}

async function readResponsePrefix(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function safeTtsError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (sanitized || "TTS failed").slice(0, 500);
}

export function isRetryableTtsFailure(status: number, error: string): boolean {
  if (status === 429 || status >= 500) return true;
  // Observed from Gemini 3.1 Flash TTS on an otherwise valid request; replaying
  // the exact payload succeeds. Keep this deliberately narrow so detailed 400s
  // and policy/validation failures remain fail-fast.
  if (status !== 400) return false;
  const detail = error.trim();
  return /^Request contains an invalid argument\.?$/i.test(detail) ||
    detail === "TTS HTTP 400: non-JSON body";
}

async function ttsRetryDelay(
  baseMs: number,
  attempt: number,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  const delayMs = Math.max(0, baseMs) * attempt;
  if (delayMs === 0) return !signal?.aborted;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function extractInteractionAudio(parsed: unknown): TtsPcm | null {
  if (!parsed || typeof parsed !== "object") return null;
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const rec = part as {
        type?: unknown;
        data?: unknown;
        sample_rate?: unknown;
        channels?: unknown;
        mime_type?: unknown;
      };
      if (rec.type !== "audio" || typeof rec.data !== "string" || !rec.data) continue;
      let pcm: Uint8Array;
      try {
        pcm = Buffer.from(rec.data, "base64");
      } catch {
        continue;
      }
      if (pcm.byteLength === 0) continue;
      const fromMime = parseL16Mime(typeof rec.mime_type === "string" ? rec.mime_type : "");
      const sampleRate =
        (typeof rec.sample_rate === "number" && rec.sample_rate > 0
          ? rec.sample_rate
          : fromMime.sampleRate) || 24_000;
      const channels =
        (typeof rec.channels === "number" && rec.channels > 0
          ? rec.channels
          : fromMime.channels) || 1;
      return { pcm, sampleRate, channels };
    }
  }
  return null;
}

function parseL16Mime(mime: string): { sampleRate?: number; channels?: number } {
  const rate = /rate=(\d+)/i.exec(mime);
  const ch = /channels=(\d+)/i.exec(mime);
  return {
    ...(rate ? { sampleRate: Number(rate[1]) } : {}),
    ...(ch ? { channels: Number(ch[1]) } : {}),
  };
}

function geminiErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const err = (parsed as { error?: { message?: unknown } }).error;
  return typeof err?.message === "string" && err.message.trim() ? err.message.trim() : undefined;
}
