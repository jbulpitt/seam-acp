/**
 * Inject Discord voice-note transcripts into the agent prompt so models that
 * cannot (or should not) see audio still get the spoken words.
 */
import { isAudioMime } from "../../agents/attachments.js";
import { transcribeAudioWithGemini } from "./gemini-stt.js";
import type { MessageAttachment } from "../../platforms/chat-adapter.js";

export interface VoiceNoteResult {
  filename: string;
  transcript?: string;
  error?: string;
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

export function formatVoiceNoteBlock(
  speakerLabel: string,
  notes: ReadonlyArray<VoiceNoteResult>
): string {
  if (notes.length === 0) return "";
  const who = speakerLabel.trim() || "user";
  const parts = notes.map((n) => {
    const file = n.filename ? ` (\`${n.filename}\`)` : "";
    if (n.transcript) {
      return `_Voice note from ${who}${file}:_\n"${n.transcript}"`;
    }
    const err = n.error?.trim() || "unknown error";
    return `_Voice note from ${who}${file} (transcription failed: ${err})._`;
  });
  return parts.join("\n\n");
}

export async function applyVoiceNoteTranscriptions(opts: {
  prompt: string;
  attachments: ReadonlyArray<MessageAttachment>;
  apiKey: string;
  model?: string;
  speakerLabel?: string;
  fetchFn?: typeof fetch;
  downloadFn?: (url: string) => Promise<Uint8Array>;
}): Promise<string> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) return opts.prompt;

  const voice = opts.attachments.filter(isVoiceNoteAttachment);
  if (voice.length === 0) return opts.prompt;

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
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      });
      if (result.ok) notes.push({ filename: a.filename, transcript: result.text });
      else notes.push({ filename: a.filename, error: result.error });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "download failed";
      notes.push({ filename: a.filename, error: msg });
    }
  }

  const block = formatVoiceNoteBlock(opts.speakerLabel ?? "user", notes);
  if (!block) return opts.prompt;
  return opts.prompt ? `${opts.prompt}\n\n${block}` : block;
}

function defaultDownload(fetchFn: typeof fetch): (url: string) => Promise<Uint8Array> {
  return async (url: string) => {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}
