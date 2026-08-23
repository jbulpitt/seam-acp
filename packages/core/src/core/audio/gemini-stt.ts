/**
 * Control-plane Gemini speech-to-text for Discord voice notes.
 * Uses the Developer API (SEAM_GEMINI_API_KEY), not agy/Gemini CLI SSO.
 */
const DEFAULT_STT_MODEL = "gemini-3.7-flash";
const STT_TIMEOUT_MS = 30_000;
const STT_PROMPT =
  "Transcribe this Discord voice message verbatim. Return only the spoken words, no commentary.";

export type SttResult = { ok: true; text: string } | { ok: false; error: string };

export async function transcribeAudioWithGemini(opts: {
  apiKey: string;
  bytes: Uint8Array;
  mimeType: string;
  model?: string;
  fetchFn?: typeof fetch;
}): Promise<SttResult> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) return { ok: false, error: "SEAM_GEMINI_API_KEY is not set" };
  if (opts.bytes.byteLength === 0) return { ok: false, error: "empty audio" };

  const model = (opts.model ?? DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL;
  const mime = normalizeAudioMime(opts.mimeType);
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [
      {
        parts: [
          { text: STT_PROMPT },
          {
            inline_data: {
              mime_type: mime,
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
    const res = await fetchFn(url, {
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
