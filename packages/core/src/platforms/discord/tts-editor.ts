/**
 * Visual TTS settings card: hub (toggle / voice / pace / style) and a
 * voice-stepper view. Persistence lives in the orchestrator.
 */
import type { StructuredPanel } from "../../core/types.js";
import type { ThreadPresetChanges } from "../../core/config-mutation.js";
import {
  GEMINI_TTS_VOICES,
  GEMINI_TTS_VOICE_PREVIEW_URL,
  TTS_PACES,
  TTS_STYLES,
  type TtsPace,
  type TtsStyle,
} from "../../core/audio/gemini-tts.js";

export const TTS_EDIT_PREFIX = "seam-tts";
export const TTS_DRAFT_TTL_MS = 60 * 60 * 1000;

export type TtsEditorView = "hub" | "voice";
export type TtsEditorAction =
  | "toggle"
  | "voice"
  | "pace"
  | "style"
  | "vprev"
  | "vnext"
  | "vpick"
  | "vback"
  | "save"
  | "cancel";

export interface TtsEditorSnapshot {
  tts: boolean;
  voice: string;
  pace: TtsPace;
  style: TtsStyle;
}

export interface TtsEditorDraft {
  id: string;
  threadId: string;
  parentRef?: string;
  userId: string;
  messageId?: string;
  createdAt: number;
  updatedAt: number;
  snapshot: TtsEditorSnapshot;
  overlay: Partial<TtsEditorSnapshot>;
  view: TtsEditorView;
  voiceIndex: number;
  sampleStatus?: "ready" | "loading" | "error";
  sampleError?: string;
}

export function makeTtsCustomId(draftId: string, action: TtsEditorAction): string {
  return `${TTS_EDIT_PREFIX}:${draftId}:${action}`;
}

export function parseTtsCustomId(
  customId: string
): { draftId: string; action: TtsEditorAction } | null {
  const prefix = `${TTS_EDIT_PREFIX}:`;
  if (!customId.startsWith(prefix)) return null;
  const rest = customId.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const draftId = rest.slice(0, colon);
  const action = rest.slice(colon + 1) as TtsEditorAction;
  const known: TtsEditorAction[] = [
    "toggle",
    "voice",
    "pace",
    "style",
    "vprev",
    "vnext",
    "vpick",
    "vback",
    "save",
    "cancel",
  ];
  if (!known.includes(action)) return null;
  return { draftId, action };
}

export function authorizeTtsDraftClick(
  draft: TtsEditorDraft | undefined,
  userId: string
): "ok" | "not-yours" | "expired" {
  if (!draft) return "expired";
  if (draft.userId !== userId) return "not-yours";
  return "ok";
}

export function effectiveTts(draft: TtsEditorDraft): TtsEditorSnapshot {
  return {
    tts: draft.overlay.tts ?? draft.snapshot.tts,
    voice: draft.overlay.voice ?? draft.snapshot.voice,
    pace: draft.overlay.pace ?? draft.snapshot.pace,
    style: draft.overlay.style ?? draft.snapshot.style,
  };
}

export function isTtsDraftDirty(draft: TtsEditorDraft): boolean {
  const e = effectiveTts(draft);
  const s = draft.snapshot;
  return e.tts !== s.tts || e.voice !== s.voice || e.pace !== s.pace || e.style !== s.style;
}

export function voiceIndexFor(name: string): number {
  const i = GEMINI_TTS_VOICES.findIndex((v) => v.name === name);
  return i >= 0 ? i : 0;
}

export function cyclePace(current: TtsPace): TtsPace {
  const i = TTS_PACES.indexOf(current);
  return TTS_PACES[(i + 1) % TTS_PACES.length]!;
}

export function cycleStyle(current: TtsStyle): TtsStyle {
  const i = TTS_STYLES.indexOf(current);
  return TTS_STYLES[(i + 1) % TTS_STYLES.length]!;
}

export function ttsDirtyChanges(draft: TtsEditorDraft): ThreadPresetChanges {
  const e = effectiveTts(draft);
  const s = draft.snapshot;
  const changes: ThreadPresetChanges = {};
  if (e.tts !== s.tts) changes.tts = e.tts;
  if (e.voice !== s.voice) changes.ttsVoice = e.voice;
  if (e.pace !== s.pace) changes.ttsPace = e.pace === "natural" ? null : e.pace;
  if (e.style !== s.style) changes.ttsStyle = e.style === "neutral" ? null : e.style;
  return changes;
}

export function renderTtsHub(draft: TtsEditorDraft): StructuredPanel {
  const e = effectiveTts(draft);
  const voiceMeta = GEMINI_TTS_VOICES.find((v) => v.name === e.voice);
  const dirty = isTtsDraftDirty(draft);
  const id = draft.id;
  return {
    color: 0x5865f2,
    title: "🔊 Thread TTS",
    description:
      "Spoken copy of completed replies in **this thread**. Gemini has no numeric rate slider — pace and style are director's notes in the prompt.",
    fields: [
      { name: "TTS", value: e.tts ? "`on`" : "`off`", inline: true },
      {
        name: "Voice",
        value: voiceMeta ? `\`${e.voice}\` — ${voiceMeta.style}` : `\`${e.voice}\``,
        inline: true,
      },
      { name: "Pace", value: `\`${e.pace}\``, inline: true },
      { name: "Style", value: `\`${e.style}\``, inline: true },
    ],
    footer: dirty ? "unsaved changes" : "applies on the next turn",
    files: [],
    actions: [
      [
        {
          customId: makeTtsCustomId(id, "toggle"),
          label: e.tts ? "TTS: on" : "TTS: off",
          style: e.tts ? "success" : "secondary",
        },
        { customId: makeTtsCustomId(id, "voice"), label: "Voice…", style: "secondary" },
        { customId: makeTtsCustomId(id, "pace"), label: `Pace: ${e.pace}`, style: "secondary" },
        { customId: makeTtsCustomId(id, "style"), label: `Style: ${e.style}`, style: "secondary" },
      ],
      [
        {
          customId: makeTtsCustomId(id, "save"),
          label: "Save",
          style: "success",
          disabled: !dirty,
        },
        { customId: makeTtsCustomId(id, "cancel"), label: "Cancel", style: "secondary" },
      ],
    ],
  };
}

export function renderTtsVoiceStep(draft: TtsEditorDraft): StructuredPanel {
  const idx = Math.min(Math.max(0, draft.voiceIndex), GEMINI_TTS_VOICES.length - 1);
  const voice = GEMINI_TTS_VOICES[idx]!;
  const e = effectiveTts(draft);
  const selected = voice.name === e.voice;
  const sampleLine =
    draft.sampleStatus === "loading"
      ? "Generating a short sample…"
      : draft.sampleStatus === "error"
        ? `Couldn't attach audio (${draft.sampleError ?? "error"}). Description only.`
        : draft.sampleStatus === "ready"
          ? "Sample attached below (same script for every voice)."
          : "Sample loading…";
  const id = draft.id;
  return {
    color: 0x5865f2,
    title: `🔊 Voice ${idx + 1}/${GEMINI_TTS_VOICES.length} — ${voice.name}`,
    description: `**${voice.name}** — *${voice.style}*\n${sampleLine}\nPreview library: ${GEMINI_TTS_VOICE_PREVIEW_URL}`,
    fields: [
      { name: "Style", value: voice.style, inline: true },
      { name: "This thread", value: selected ? "`selected`" : "`not selected`", inline: true },
    ],
    footer: `${idx + 1} of ${GEMINI_TTS_VOICES.length}`,
    actions: [
      [
        {
          customId: makeTtsCustomId(id, "vprev"),
          label: "◀ Prev",
          style: "secondary",
          disabled: idx === 0,
        },
        {
          customId: makeTtsCustomId(id, "vnext"),
          label: "Next ▶",
          style: "secondary",
          disabled: idx === GEMINI_TTS_VOICES.length - 1,
        },
      ],
      [
        {
          customId: makeTtsCustomId(id, "vpick"),
          label: selected ? "Using this voice" : "Use this voice",
          style: "success",
          disabled: selected,
        },
        { customId: makeTtsCustomId(id, "vback"), label: "Back", style: "secondary" },
      ],
    ],
  };
}

export function renderTtsCancelled(draft: TtsEditorDraft): StructuredPanel {
  return {
    color: 0x99aab5,
    title: "🔊 Thread TTS",
    fields: [],
    footer: "cancelled",
    files: [],
    actions: [],
  };
}

export function renderTtsSaved(draft: TtsEditorDraft): StructuredPanel {
  const e = effectiveTts(draft);
  const voiceMeta = GEMINI_TTS_VOICES.find((v) => v.name === e.voice);
  return {
    color: 0x57f287,
    title: "🔊 Thread TTS",
    fields: [
      { name: "TTS", value: e.tts ? "`on`" : "`off`", inline: true },
      {
        name: "Voice",
        value: voiceMeta ? `\`${e.voice}\` — ${voiceMeta.style}` : `\`${e.voice}\``,
        inline: true,
      },
      { name: "Pace", value: `\`${e.pace}\``, inline: true },
      { name: "Style", value: `\`${e.style}\``, inline: true },
    ],
    footer: "✅ Saved — applies on the next turn.",
    files: [],
    actions: [],
  };
}

export class TtsEditorStore {
  private readonly byId = new Map<string, TtsEditorDraft>();
  private readonly byUserThread = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? TTS_DRAFT_TTL_MS;
    this.now = opts?.now ?? Date.now;
  }

  private key(userId: string, threadId: string): string {
    return `${userId}:${threadId}`;
  }

  private expired(draft: TtsEditorDraft, now: number): boolean {
    return now - draft.updatedAt > this.ttlMs;
  }

  get(id: string): TtsEditorDraft | undefined {
    const draft = this.byId.get(id);
    if (!draft) return undefined;
    if (this.expired(draft, this.now())) {
      this.delete(id);
      return undefined;
    }
    return draft;
  }

  put(draft: TtsEditorDraft): TtsEditorDraft | undefined {
    const key = this.key(draft.userId, draft.threadId);
    const prevId = this.byUserThread.get(key);
    let evicted: TtsEditorDraft | undefined;
    if (prevId && prevId !== draft.id) {
      evicted = this.byId.get(prevId);
      this.byId.delete(prevId);
    }
    this.byId.set(draft.id, draft);
    this.byUserThread.set(key, draft.id);
    return evicted;
  }

  touch(id: string, patch: Partial<TtsEditorDraft>): TtsEditorDraft | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: TtsEditorDraft = {
      ...cur,
      ...patch,
      overlay: patch.overlay ?? cur.overlay,
      updatedAt: this.now(),
    };
    this.byId.set(id, next);
    return next;
  }

  delete(id: string): TtsEditorDraft | undefined {
    const draft = this.byId.get(id);
    if (!draft) return undefined;
    this.byId.delete(id);
    const key = this.key(draft.userId, draft.threadId);
    if (this.byUserThread.get(key) === id) this.byUserThread.delete(key);
    return draft;
  }
}
