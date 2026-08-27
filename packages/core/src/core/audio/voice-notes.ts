/**
 * Inject Discord voice-note transcripts into the agent prompt so models that
 * cannot (or should not) see audio still get the spoken words.
 */
import { isAudioMime } from "../../agents/attachments.js";
import { transcribeAudioWithGemini, type SttFallbackEvent } from "./gemini-stt.js";
import type { MessageAttachment } from "../../platforms/chat-adapter.js";

export interface VoiceNoteResult {
  filename: string;
  transcript?: string;
  error?: string;
  /** Discord CDN URL for the original audio. Signed; typically expires in ~24h. */
  sourceUrl?: string;
}

const VOICE_EXTS = /\.(ogg|opus|oga|mp3|wav|m4a|webm|aac)$/i;

export function isVoiceNoteAttachment(a: {
  contentType?: string | null;
  filename?: string;
}): boolean {
  const mime = (a.contentType ?? "").toLowerCase();
  if (isAudioMime(mime)) return true;
  return VOICE_EXTS.test(a.filename ?? "");
}

export function withoutVoiceNotes<T extends { contentType?: string | null; filename?: string }>(
  attachments: ReadonlyArray<T>
): T[] {
  return attachments.filter((a) => !isVoiceNoteAttachment(a));
}

export function formatVoiceNoteBlock(
  speakerLabel: string,
  notes: ReadonlyArray<VoiceNoteResult>
): string {
  if (notes.length === 0) return "";
  const who = speakerLabel.trim() || "user";
  const parts = notes.map((n) => {
    const spoken = n.transcript
      ? `_The user (${who}) sent a voice note:_ "${n.transcript}"`
      : `_The user (${who}) sent a voice note (transcription failed: ${n.error?.trim() || "unknown error"})._`;
    const source = formatOriginalAudioLine(n.sourceUrl);
    return source ? `${spoken}\n${source}` : spoken;
  });
  return parts.join("\n\n");
}

function formatOriginalAudioLine(url?: string): string | null {
  const src = url?.trim();
  if (!src) return null;
  return `_Original audio (Discord CDN; signed URL, may expire):_ ${src}`;
}

export function formatHeardMessage(notes: ReadonlyArray<VoiceNoteResult>): string | null {
  if (notes.length === 0) return null;
  const lines = notes.map((n) => {
    if (n.transcript) return `_Heard:_ "${n.transcript}"`;
    const err = n.error?.trim() || "unknown error";
    return `_Couldn't transcribe voice note:_ ${err}`;
  });
  return lines.join("\n");
}

export async function applyVoiceNoteTranscriptions(opts: {
  prompt: string;
  attachments: ReadonlyArray<MessageAttachment>;
  apiKey: string;
  model?: string;
  customVocabulary?: ReadonlyArray<string>;
  onFallback?: (event: SttFallbackEvent) => void;
  speakerLabel?: string;
  fetchFn?: typeof fetch;
  downloadFn?: (url: string) => Promise<Uint8Array>;
}): Promise<{ prompt: string; notes: VoiceNoteResult[] }> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) return { prompt: opts.prompt, notes: [] };

  const voice = opts.attachments.filter(isVoiceNoteAttachment);
  if (voice.length === 0) return { prompt: opts.prompt, notes: [] };

  const download = opts.downloadFn ?? defaultDownload(opts.fetchFn ?? fetch);
  const notes: VoiceNoteResult[] = [];
  for (const a of voice) {
    try {
      const bytes = await download(a.url);
      const result = await transcribeAudioWithGemini({
        apiKey,
        bytes,
        mimeType: a.contentType ?? "audio/ogg",
        ...(opts.model ? { model: opts.model } : {}),
        customVocabulary: [
          ...(opts.customVocabulary ?? []),
          ...(opts.speakerLabel?.trim() ? [opts.speakerLabel.trim()] : []),
        ],
        ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      });
      if (result.ok) {
        notes.push({ filename: a.filename, transcript: result.text, sourceUrl: a.url });
      } else {
        notes.push({ filename: a.filename, error: result.error, sourceUrl: a.url });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "download failed";
      notes.push({ filename: a.filename, error: msg, sourceUrl: a.url });
    }
  }

  const block = formatVoiceNoteBlock(opts.speakerLabel ?? "user", notes);
  if (!block) return { prompt: opts.prompt, notes };
  return {
    prompt: opts.prompt ? `${opts.prompt}\n\n${block}` : block,
    notes,
  };
}

function defaultDownload(fetchFn: typeof fetch): (url: string) => Promise<Uint8Array> {
  return async (url: string) => {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}
