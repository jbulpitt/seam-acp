/**
 * Cached Gemini TTS voice-preview clips. Same script for every voice so
 * the stepper is a fair comparison. Stored under DATA_DIR.
 */
import fs from "node:fs";
import path from "node:path";
import { GEMINI_TTS_VOICES } from "./gemini-tts.js";
import { speakReplyToOgg } from "./voice-replies.js";

export const TTS_SAMPLE_SCRIPT =
  "Hello. This is a short sample so you can hear this voice. The wording is the same for every option.";

export function ttsSamplePath(dataDir: string, voice: string): string {
  const safe = voice.replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(dataDir, "tts-voice-samples", `${safe || "voice"}.ogg`);
}

export type SampleResult =
  | { ok: true; ogg: Buffer; cached: boolean }
  | { ok: false; error: string };

export async function getOrCreateTtsSample(opts: {
  dataDir: string;
  apiKey: string;
  voice: string;
  model?: string;
  fetchFn?: typeof fetch;
}): Promise<SampleResult> {
  const dest = ttsSamplePath(opts.dataDir, opts.voice);
  try {
    if (fs.existsSync(dest)) {
      const ogg = fs.readFileSync(dest);
      if (ogg.byteLength > 0) return { ok: true, ogg, cached: true };
    }
  } catch {
    /* fall through to regenerate */
  }
  const spoken = await speakReplyToOgg({
    apiKey: opts.apiKey,
    text: TTS_SAMPLE_SCRIPT,
    voice: opts.voice,
    pace: "natural",
    style: "neutral",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  if (!spoken.ok) return spoken;
  const ogg = Buffer.from(spoken.ogg);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, ogg);
  } catch {
    /* still return the bytes even if cache write fails */
  }
  return { ok: true, ogg, cached: false };
}

/** Fire-and-forget fill of remaining voices. Does not throw. */
export function warmTtsSamples(opts: {
  dataDir: string;
  apiKey: string;
  model?: string;
  concurrency?: number;
}): void {
  const pending = GEMINI_TTS_VOICES.map((v) => v.name).filter((name) => {
    try {
      return !fs.existsSync(ttsSamplePath(opts.dataDir, name));
    } catch {
      return true;
    }
  });
  if (pending.length === 0) return;
  const n = Math.max(1, Math.min(opts.concurrency ?? 2, 4));
  const queue = [...pending];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const voice = queue.shift();
      if (!voice) return;
      try {
        await getOrCreateTtsSample({
          dataDir: opts.dataDir,
          apiKey: opts.apiKey,
          voice,
          ...(opts.model ? { model: opts.model } : {}),
        });
      } catch {
        /* skip */
      }
    }
  };
  void Promise.all(Array.from({ length: n }, () => worker()));
}
