/**
 * Control-plane Gemini speech-to-text for Discord voice notes.
 * Uses the Developer API (SEAM_GEMINI_API_KEY), not agy/Gemini CLI SSO.
 */
const DEFAULT_STT_MODEL = "gemini-3.5-transcribe";
const FALLBACK_STT_MODEL = "gemini-3.7-flash";
const STT_TIMEOUT_MS = 60_000;
const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const STT_PROMPT =
  "Transcribe this Discord voice message verbatim. Return only the spoken words, no commentary.";

export type SttResult = { ok: true; text: string } | { ok: false; error: string };
export interface SttFallbackEvent {
  fromModel: string;
  toModel: string;
  reason: string;
}

export async function transcribeAudioWithGemini(opts: {
  apiKey: string;
  bytes: Uint8Array;
  mimeType: string;
  model?: string;
  customVocabulary?: ReadonlyArray<string>;
  onFallback?: (event: SttFallbackEvent) => void;
  fetchFn?: typeof fetch;
}): Promise<SttResult> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) return { ok: false, error: "SEAM_GEMINI_API_KEY is not set" };
  if (opts.bytes.byteLength === 0) return { ok: false, error: "empty audio" };

  const model = (opts.model ?? DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL;
  const mime = normalizeAudioMime(opts.mimeType);
  const fetchFn = opts.fetchFn ?? fetch;
  if (isDedicatedTranscribeModel(model)) {
    const primary = await transcribeWithInteractions({
      apiKey,
      bytes: opts.bytes,
      mime,
      model,
      customVocabulary: normalizeCustomVocabulary(opts.customVocabulary ?? []),
      fetchFn,
    });
    if (primary.result.ok || !primary.fallbackEligible) return primary.result;

    try {
      opts.onFallback?.({
        fromModel: model,
        toModel: FALLBACK_STT_MODEL,
        reason: primary.result.error,
      });
    } catch {
      // Observability must never make transcription fail.
    }
    const fallback = await transcribeWithGenerateContent({
      apiKey,
      bytes: opts.bytes,
      mime,
      model: FALLBACK_STT_MODEL,
      fetchFn,
    });
    if (fallback.ok) return fallback;
    return {
      ok: false,
      error: `${primary.result.error}; fallback ${FALLBACK_STT_MODEL} failed: ${fallback.error}`,
    };
  }

  return transcribeWithGenerateContent({
    apiKey,
    bytes: opts.bytes,
    mime,
    model,
    fetchFn,
  });
}

function isDedicatedTranscribeModel(model: string): boolean {
  return model.startsWith("gemini-3.5-transcribe") && !model.endsWith("-live");
}

export function normalizeCustomVocabulary(terms: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim();
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === 100) break;
  }
  return out;
}

async function transcribeWithInteractions(opts: {
  apiKey: string;
  bytes: Uint8Array;
  mime: string;
  model: string;
  customVocabulary: string[];
  fetchFn: typeof fetch;
}): Promise<{ result: SttResult; fallbackEligible: boolean }> {
  const transcriptionConfig: Record<string, unknown> = {
    language_codes: [],
    mode: "smart",
  };
  if (opts.customVocabulary.length > 0) {
    transcriptionConfig.custom_vocabulary = opts.customVocabulary;
  }
  const body = {
    model: opts.model,
    input: [
      {
        type: "audio",
        data: Buffer.from(opts.bytes).toString("base64"),
        mime_type: opts.mime,
      },
    ],
    generation_config: { transcription_config: transcriptionConfig },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), STT_TIMEOUT_MS);
  try {
    const res = await opts.fetchFn(INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return {
        result: { ok: false, error: `STT HTTP ${res.status}: non-JSON body` },
        fallbackEligible: res.ok || isTransientStatus(res.status),
      };
    }
    if (!res.ok) {
      const msg = geminiErrorMessage(parsed) ?? `STT HTTP ${res.status}`;
      return {
        result: { ok: false, error: msg },
        fallbackEligible: isTransientStatus(res.status),
      };
    }
    const text = extractInteractionText(parsed).trim();
    if (!text) {
      return {
        result: { ok: false, error: "empty transcript" },
        fallbackEligible: true,
      };
    }
    return { result: { ok: true, text }, fallbackEligible: false };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const error =
      name === "AbortError"
        ? "STT timed out"
        : err instanceof Error
          ? err.message
          : "STT failed";
    return { result: { ok: false, error }, fallbackEligible: true };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeWithGenerateContent(opts: {
  apiKey: string;
  bytes: Uint8Array;
  mime: string;
  model: string;
  fetchFn: typeof fetch;
}): Promise<SttResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  const body = {
    contents: [
      {
        parts: [
          { text: STT_PROMPT },
          {
            inline_data: {
              mime_type: opts.mime,
              data: Buffer.from(opts.bytes).toString("base64"),
            },
          },
        ],
      },
    ],
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), STT_TIMEOUT_MS);
  try {
    const res = await opts.fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: `STT HTTP ${res.status}: non-JSON body` };
    }
    if (!res.ok) {
      const msg = geminiErrorMessage(parsed) ?? `STT HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    const text = extractGenerateContentText(parsed).trim();
    if (!text) {
      const blocked = geminiBlockReason(parsed);
      return { ok: false, error: blocked ?? "empty transcript" };
    }
    return { ok: true, text };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") return { ok: false, error: "STT timed out" };
    return { ok: false, error: err instanceof Error ? err.message : "STT failed" };
  } finally {
    clearTimeout(timer);
  }
}

function isTransientStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
}

export function normalizeAudioMime(mime: string): string {
  const m = (mime || "").toLowerCase().split(";")[0]!.trim();
  if (m.startsWith("audio/")) return m;
  if (m === "application/ogg") return "audio/ogg";
  if (m === "video/webm") return "audio/webm";
  return m || "audio/ogg";
}

function extractGenerateContentText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const cands = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(cands) || cands.length === 0) return "";
  const parts = (cands[0] as { content?: { parts?: Array<{ text?: unknown }> } })?.content
    ?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
}

export function extractInteractionText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const direct = (parsed as { output_text?: unknown }).output_text;
  if (typeof direct === "string" && direct.trim()) return direct;
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return "";
  const text: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const record = step as { type?: unknown; content?: unknown };
    if (record.type !== "model_output" || !Array.isArray(record.content)) continue;
    for (const content of record.content) {
      if (!content || typeof content !== "object") continue;
      const part = content as { type?: unknown; text?: unknown };
      if (part.type === "text" && typeof part.text === "string") text.push(part.text);
    }
  }
  return text.join("\n");
}

function geminiErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const err = (parsed as { error?: { message?: unknown } }).error;
  return typeof err?.message === "string" && err.message.trim() ? err.message.trim() : undefined;
}

function geminiBlockReason(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const reason = (parsed as { promptFeedback?: { blockReason?: unknown } }).promptFeedback
    ?.blockReason;
  return typeof reason === "string" && reason.trim() ? `blocked: ${reason.trim()}` : undefined;
}
