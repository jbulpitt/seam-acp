/**
 * Decide whether a finished turn should get a spoken Discord attachment.
 * Default off: only threads with `tts: true` speak.
 */
import { synthesizeSpeechWithGemini, type TtsPace, type TtsStyle } from "./gemini-tts.js";
import { encodePcmToOggOpus } from "./pcm-to-opus.js";

export const TTS_MAX_CHARS = 4000;

/** Keep a speakable prefix when the full reply exceeds {@link TTS_MAX_CHARS}. */
export function clipSpokenText(text: string, max = TTS_MAX_CHARS): { text: string; clipped: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, clipped: false };
  const slice = t.slice(0, max);
  const cut = Math.max(
    slice.lastIndexOf("\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? ")
  );
  const out = (cut >= max * 0.5 ? slice.slice(0, cut + 1) : slice).trim();
  return { text: out, clipped: true };
}

export type SpeakSkipReason =
  | "disabled"
  | "no-key"
  | "empty"
  | "too-long"
  | "had-audio"
  | "not-ok";

export type SpeakDecision =
  | { speak: true; text: string }
  | { speak: false; reason: SpeakSkipReason };

export function shouldSpeakReply(opts: {
  enabled: boolean;
  apiKey: string;
  prose: string;
  alreadyHadAudio: boolean;
  turnOk: boolean;
}): SpeakDecision {
  if (!opts.enabled) return { speak: false, reason: "disabled" };
  if (!opts.turnOk) return { speak: false, reason: "not-ok" };
  if (opts.alreadyHadAudio) return { speak: false, reason: "had-audio" };
  if (!opts.apiKey.trim()) return { speak: false, reason: "no-key" };
  const text = opts.prose.trim();
  if (!text) return { speak: false, reason: "empty" };
  if (text.length > TTS_MAX_CHARS) return { speak: false, reason: "too-long" };
  return { speak: true, text };
}

/**
 * Prefer prose after the last tool call (the curated summary). Fall back to
 * the full visible turn when there were no tools, or tools produced no follow-up.
 */
export function selectSpokenProse(opts: {
  all: string;
  afterLastTool: string;
  sawTool: boolean;
}): string {
  const after = opts.afterLastTool.trim();
  if (opts.sawTool && after) return after;
  return opts.all.trim();
}

export type SpokenOgg =
  | { ok: true; ogg: Uint8Array; filename: string; mimeType: string }
  | { ok: false; error: string };

export async function speakReplyToOgg(opts: {
  apiKey: string;
  text: string;
  model?: string;
  voice?: string;
  pace?: TtsPace;
  style?: TtsStyle;
  fetchFn?: typeof fetch;
  ffmpegPath?: string;
}): Promise<SpokenOgg> {
  const tts = await synthesizeSpeechWithGemini({
    apiKey: opts.apiKey,
    text: opts.text,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(opts.pace ? { pace: opts.pace } : {}),
    ...(opts.style ? { style: opts.style } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  if (!tts.ok) return tts;
  const ogg = await encodePcmToOggOpus({
    pcm: tts.audio.pcm,
    sampleRate: tts.audio.sampleRate,
    channels: tts.audio.channels,
    ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
  });
  if (!ogg.ok) return ogg;
  return { ok: true, ogg: ogg.ogg, filename: "reply.ogg", mimeType: "audio/ogg" };
}
