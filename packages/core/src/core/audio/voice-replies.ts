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
  | {
      ok: true;
      ogg: Uint8Array;
      filename: string;
      mimeType: string;
      voiceMessage: { durationSeconds: number; waveform: string };
    }
  | { ok: false; error: string };

/**
 * Discord voice-message metadata from signed 16-bit little-endian PCM.
 * The waveform is a compact peak envelope (at most 256 one-byte points).
 */
export function voiceMessageMetadataFromPcm(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number
): { durationSeconds: number; waveform: string } {
  const bytesPerFrame = channels * 2;
  const frames = Math.floor(pcm.byteLength / bytesPerFrame);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channels <= 0 || frames <= 0) {
    throw new Error("invalid PCM for voice-message metadata");
  }

  const durationSeconds = frames / sampleRate;
  const pointCount = Math.min(256, frames, Math.max(1, Math.ceil(durationSeconds * 10)));
  const samples = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const peaks = new Uint16Array(pointCount);
  let maxPeak = 0;

  for (let point = 0; point < pointCount; point += 1) {
    const startFrame = Math.floor((point * frames) / pointCount);
    const endFrame = Math.max(startFrame + 1, Math.floor(((point + 1) * frames) / pointCount));
    let peak = 0;
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const offset = (frame * channels + channel) * 2;
        peak = Math.max(peak, Math.abs(samples.readInt16LE(offset)));
      }
    }
    peaks[point] = peak;
    maxPeak = Math.max(maxPeak, peak);
  }

  const envelope = Buffer.alloc(pointCount);
  if (maxPeak > 0) {
    for (let i = 0; i < pointCount; i += 1) {
      envelope[i] = Math.round((peaks[i]! / maxPeak) * 255);
    }
  }
  return { durationSeconds, waveform: envelope.toString("base64") };
}

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
  const voiceMessage = voiceMessageMetadataFromPcm(
    tts.audio.pcm,
    tts.audio.sampleRate,
    tts.audio.channels
  );
  const ogg = await encodePcmToOggOpus({
    pcm: tts.audio.pcm,
    sampleRate: tts.audio.sampleRate,
    channels: tts.audio.channels,
    ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
  });
  if (!ogg.ok) return ogg;
  return {
    ok: true,
    ogg: ogg.ogg,
    filename: "reply.ogg",
    mimeType: "audio/ogg",
    voiceMessage,
  };
}
