/**
 * Control-plane Gemini text-to-speech for Discord voice replies.
 * Uses the Developer API (SEAM_GEMINI_API_KEY), not agy/Gemini CLI SSO.
 *
 * Studio Interactions returns raw L16 PCM (24 kHz mono). Encoding to Opus
 * is a separate step so this helper stays fetch-mockable.
 */
const DEFAULT_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_TTS_VOICE = "Kore";
const TTS_TIMEOUT_MS = 90_000;
const TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

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

export type TtsPcm = {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
};

export type TtsResult = { ok: true; audio: TtsPcm } | { ok: false; error: string };

export async function synthesizeSpeechWithGemini(opts: {
  apiKey: string;
  text: string;
  model?: string;
  voice?: string;
  fetchFn?: typeof fetch;
}): Promise<TtsResult> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) return { ok: false, error: "SEAM_GEMINI_API_KEY is not set" };
  const text = opts.text.trim();
  if (!text) return { ok: false, error: "empty text" };

  const model = (opts.model ?? DEFAULT_TTS_MODEL).trim() || DEFAULT_TTS_MODEL;
  const voice = (opts.voice ?? DEFAULT_TTS_VOICE).trim() || DEFAULT_TTS_VOICE;
  const fetchFn = opts.fetchFn ?? fetch;
  const body = {
    model,
    input: `Speak this Discord reply clearly. Read only the following text, no commentary:\n\n${text}`,
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice }] },
  };

  const ac = new AbortController();
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
      return { ok: false, error: `TTS HTTP ${res.status}: non-JSON body` };
    }
    if (!res.ok) {
      const msg = geminiErrorMessage(parsed) ?? `TTS HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    const audio = extractInteractionAudio(parsed);
    if (!audio) return { ok: false, error: "TTS response had no audio" };
    return { ok: true, audio };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") return { ok: false, error: "TTS timed out" };
    return { ok: false, error: err instanceof Error ? err.message : "TTS failed" };
  } finally {
    clearTimeout(timer);
  }
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
