/**
 * Pure presentation for the Shared Voice Console canonical card and ephemeral
 * diagnostics/editor views. Discord I/O and durable mutations belong to
 * Package E; all authority here is expressed with immutable ids + revisions.
 */
import { GEMINI_TTS_VOICES } from "../../core/audio/gemini-tts.js";
import {
  buildBindingEditorRows,
  buildDuplicateVoiceConfirmationRows,
  buildEndConsoleConfirmationRows,
  buildFanoutDisarmConfirmationRows,
  buildVoiceConsoleComponentRows,
  buildVoicePreviewRows,
  effectiveVoiceConsoleBindingProfile,
  voiceConsolePreviewRequest,
  type VoiceConsoleBindingControlOption,
  type VoiceConsoleBindingEditorDraft,
  type VoiceConsoleComponentRow,
} from "./voice-console-components.js";

export const VOICE_CONSOLE_BINDINGS_PER_PAGE = 5;
export const VOICE_CONSOLE_REQUIRED_PERMISSIONS = [
  "ViewChannel",
  "Connect",
  "SendMessages",
  "EmbedLinks",
  "ReadMessageHistory",
] as const;

export type VoiceConsoleRequiredPermission =
  (typeof VOICE_CONSOLE_REQUIRED_PERMISSIONS)[number];

export type VoiceConsoleLifecycleState =
  | "starting"
  | "ready"
  | "stopping"
  | "ended"
  | "failed";

export type VoiceConsoleSpeakerLaneState =
  | "muted-ready"
  | "awaiting-safe-mute"
  | "armed"
  | "capturing"
  | "transcribing"
  | "reconnecting"
  | "failed";

export type VoiceConsoleBindingSpeechState =
  | "idle"
  | "queued"
  | "speaking"
  | "disabled"
  | "failed";

export interface VoiceConsolePanelField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface VoiceConsolePanelSpec {
  color: number;
  title: string;
  description?: string;
  fields: VoiceConsolePanelField[];
  footer?: string;
  components: VoiceConsoleComponentRow[];
  /** Package E may fulfill this descriptor and attach the resulting audio. */
  previewRequest?: ReturnType<typeof voiceConsolePreviewRequest>;
}

export interface VoiceConsoleSpeakerLanePresentation {
  userId: string;
  displayName: string;
  state: VoiceConsoleSpeakerLaneState;
}

export interface VoiceConsoleBindingPresentation extends VoiceConsoleBindingControlOption {
  pace: string;
  style: string;
  acpState: string;
  pendingSegments: number;
  pendingCharacters: number;
  speechState: VoiceConsoleBindingSpeechState;
}

export interface VoiceConsolePanelState {
  consoleId: string;
  revision: number;
  ownerUserId: string;
  ownerName: string;
  voiceChannelId: string;
  /** When present it must equal voiceChannelId; a thread id is never accepted. */
  cardChannelId?: string | null;
  lifecycle: VoiceConsoleLifecycleState;
  runtimeState: string;
  connectionState: string;
  forwardedAudioMs: number;
  fanoutArmed: boolean;
  selectedBindingIds: ReadonlyArray<string>;
  bindings: ReadonlyArray<VoiceConsoleBindingPresentation>;
  speakers: ReadonlyArray<VoiceConsoleSpeakerLanePresentation>;
  unauthorizedListenerCount: number;
  page: number;
  currentSpeaking?: { alias: string; voice: string } | null;
  lastUpdatedUtc: string;
}

export interface VoiceConsoleDiagnosticState extends VoiceConsolePanelState {
  uptimeMs: number;
  transmittedAudioBytes: number;
  activeLaneCount: number;
  schedulerQueueDepth: number;
  schedulerSource?: { alias: string; voice: string } | null;
  leaseHolder: { kind: string; sessionId: string };
  cardJumpUrl?: string | null;
}

export type VoiceConsoleCardLocationResult =
  | { ok: true; channelId: string }
  | {
      ok: false;
      code: "missing-voice-channel" | "card-channel-mismatch";
      error: string;
    };

/**
 * The only valid control destination is the connected VC's built-in chat.
 * Deliberately accepts no thread/fallback channel argument.
 */
export function resolveVoiceConsoleCardLocation(input: {
  voiceChannelId: string;
  persistedCardChannelId?: string | null;
}): VoiceConsoleCardLocationResult {
  const voiceChannelId = input.voiceChannelId.trim();
  if (!voiceChannelId) {
    return {
      ok: false,
      code: "missing-voice-channel",
      error: "Voice Console requires the connected voice channel's built-in chat.",
    };
  }
  const persisted = input.persistedCardChannelId?.trim();
  if (persisted && persisted !== voiceChannelId) {
    return {
      ok: false,
      code: "card-channel-mismatch",
      error:
        `Canonical Voice Console card channel ${persisted} does not match voice channel ` +
        `${voiceChannelId}; the card cannot be relocated to a thread.`,
    };
  }
  return { ok: true, channelId: voiceChannelId };
}

export function voiceConsolePermissionError(input: {
  voiceChannelId: string;
  missing: ReadonlyArray<VoiceConsoleRequiredPermission>;
}): {
  code: "missing-vc-chat-permissions";
  missing: VoiceConsoleRequiredPermission[];
  message: string;
} {
  const missingSet = new Set(input.missing);
  const missing = VOICE_CONSOLE_REQUIRED_PERMISSIONS.filter((permission) =>
    missingSet.has(permission)
  );
  const list = missing.map((permission) => `\`${permission}\``).join(", ");
  return {
    code: "missing-vc-chat-permissions",
    missing,
    message:
      `Cannot use <#${input.voiceChannelId}> as the Shared Voice Console. ` +
      `Missing bot permission${missing.length === 1 ? "" : "s"}: ${list || "unknown"}. ` +
      "The canonical card is not moved to an ACP thread.",
  };
}

export function renderVoiceConsolePermissionError(input: {
  voiceChannelId: string;
  missing: ReadonlyArray<VoiceConsoleRequiredPermission>;
}): VoiceConsolePanelSpec {
  const failure = voiceConsolePermissionError(input);
  return {
    color: 0xed4245,
    title: "🎛️ Shared Voice Console unavailable",
    description: failure.message,
    fields: [
      { name: "Required location", value: `<#${input.voiceChannelId}> built-in chat` },
      { name: "Missing", value: failure.missing.map((permission) => `\`${permission}\``).join(" · ") },
    ],
    footer: "Startup refused before console creation or lease acquisition.",
    components: [],
  };
}

export function paginateVoiceConsoleBindings<T>(
  bindings: ReadonlyArray<T>,
  requestedPage: number
): { page: number; pageCount: number; bindings: T[] } {
  const pageCount = Math.max(1, Math.ceil(bindings.length / VOICE_CONSOLE_BINDINGS_PER_PAGE));
  const page = Math.min(Math.max(0, Math.trunc(requestedPage) || 0), pageCount - 1);
  const start = page * VOICE_CONSOLE_BINDINGS_PER_PAGE;
  return {
    page,
    pageCount,
    bindings: bindings.slice(start, start + VOICE_CONSOLE_BINDINGS_PER_PAGE) as T[],
  };
}

export function renderVoiceConsolePanel(state: VoiceConsolePanelState): VoiceConsolePanelSpec {
  const location = resolveVoiceConsoleCardLocation({
    voiceChannelId: state.voiceChannelId,
    ...(state.cardChannelId !== undefined
      ? { persistedCardChannelId: state.cardChannelId }
      : {}),
  });
  if (!location.ok) throw new Error(location.error);
  const page = paginateVoiceConsoleBindings(state.bindings, state.page);
  const selected = new Set(state.selectedBindingIds);
  const active = state.lifecycle === "starting" || state.lifecycle === "ready";
  const fields: VoiceConsolePanelField[] = [
    {
      name: "Console",
      value:
        `Owner <@${state.ownerUserId}> · VC <#${state.voiceChannelId}>\n` +
        `${safeText(state.runtimeState)} · ${safeText(state.connectionState)}`,
      inline: true,
    },
    {
      name: "Input",
      value: inputStateLabel(state, selected),
      inline: true,
    },
    {
      name: "VC output",
      value: outputStateLabel(state.bindings, state.currentSpeaking),
      inline: true,
    },
    {
      name: "Speakers",
      value: speakerSummary(state.speakers, state.unauthorizedListenerCount),
    },
    {
      name: "Bindings",
      value: page.bindings.length > 0
        ? limit(page.bindings.map((binding) => bindingLine(binding, selected)).join("\n"), 1_024)
        : "No active bindings.",
    },
    {
      name: "STT forwarded",
      value: formatDuration(state.forwardedAudioMs),
      inline: true,
    },
  ];
  const fanoutWarning = state.fanoutArmed && selected.size > 1
    ? "⚠️ Fan-out multiplies ACP and TTS work; STT audio is counted once."
    : undefined;
  const components = buildVoiceConsoleComponentRows({
    consoleId: state.consoleId,
    revision: state.revision,
    fanoutArmed: state.fanoutArmed,
    selectedBindingIds: state.selectedBindingIds,
    bindings: state.bindings,
    page: page.page,
    pageCount: page.pageCount,
    ...(!active ? { disabled: true as const } : {}),
  });
  return {
    color: panelColor(state.lifecycle),
    title: "🎛️ Shared Voice Console",
    ...(fanoutWarning ? { description: fanoutWarning } : {}),
    fields,
    footer:
      `Page ${page.page + 1}/${page.pageCount} · revision ${state.revision} · ` +
      `updated ${state.lastUpdatedUtc}`,
    components,
  };
}

/** Ephemeral slash status; pages retain all shared diagnostics plus five bindings. */
export function renderVoiceConsoleStatusPages(
  state: VoiceConsoleDiagnosticState
): VoiceConsolePanelSpec[] {
  const location = resolveVoiceConsoleCardLocation({
    voiceChannelId: state.voiceChannelId,
    ...(state.cardChannelId !== undefined
      ? { persistedCardChannelId: state.cardChannelId }
      : {}),
  });
  if (!location.ok) throw new Error(location.error);
  const pageCount = Math.max(
    1,
    Math.ceil(state.bindings.length / VOICE_CONSOLE_BINDINGS_PER_PAGE)
  );
  return Array.from({ length: pageCount }, (_, pageNumber) => {
    const page = paginateVoiceConsoleBindings(state.bindings, pageNumber);
    const selected = new Set(state.selectedBindingIds);
    const speakerLines = state.speakers.length > 0
      ? state.speakers.map((speaker) =>
          `<@${speaker.userId}> · ${speakerLaneLabel(speaker.state)}`
        ).join("\n")
      : "None present";
    const bindingFields = page.bindings.map((binding) => ({
      name: `${selected.has(binding.bindingId) ? "🎯" : "○"} ${safeText(binding.alias)}`,
      value:
        `<#${binding.threadId}> · \`${safeText(binding.voice)}\` / ` +
        `\`${safeText(binding.pace)}\` / \`${safeText(binding.style)}\`\n` +
        `ACP ${safeText(binding.acpState)} · ${binding.pendingSegments} pending ` +
        `(${binding.pendingCharacters} chars) · ${speechStateLabel(binding.speechState)}`,
    }));
    return {
      color: panelColor(state.lifecycle),
      title: `🎛️ Shared Voice Console status · ${page.page + 1}/${page.pageCount}`,
      fields: [
        {
          name: "Identity",
          value:
            `Console \`${state.consoleId}\` · owner <@${state.ownerUserId}> · ` +
            `VC <#${state.voiceChannelId}>`,
        },
        {
          name: "Runtime",
          value:
            `${safeText(state.runtimeState)} · ${safeText(state.connectionState)} · ` +
            `uptime ${formatDuration(state.uptimeMs)}`,
          inline: true,
        },
        {
          name: "Input",
          value: inputStateLabel(state, selected),
          inline: true,
        },
        {
          name: "STT usage",
          value:
            `${formatDuration(state.forwardedAudioMs)} · ` +
            `${Math.max(0, Math.trunc(state.transmittedAudioBytes))} bytes`,
          inline: true,
        },
        {
          name: `Authorized speakers · ${state.activeLaneCount} active lane${state.activeLaneCount === 1 ? "" : "s"}`,
          value: limit(speakerLines, 1_024),
        },
        {
          name: "Scheduler",
          value: state.schedulerSource
            ? `${safeText(state.schedulerSource.alias)} / \`${safeText(state.schedulerSource.voice)}\` · queue ${state.schedulerQueueDepth}`
            : `Idle · queue ${state.schedulerQueueDepth}`,
          inline: true,
        },
        {
          name: "Voice lease",
          value: `\`${safeText(state.leaseHolder.kind)}\` / \`${safeText(state.leaseHolder.sessionId)}\``,
          inline: true,
        },
        {
          name: "Canonical card",
          value: state.cardJumpUrl
            ? `[Open VC-chat card](${state.cardJumpUrl}) · revision ${state.revision}`
            : `VC chat <#${state.voiceChannelId}> · revision ${state.revision}`,
          inline: true,
        },
        ...bindingFields,
      ],
      footer:
        `Shared STT usage is not multiplied by fan-out; ACP/TTS work may be. ` +
        `Updated ${state.lastUpdatedUtc}.`,
      components: [],
    };
  });
}

export function renderVoiceConsoleEndConfirmation(input: {
  consoleId: string;
  revision: number;
  bindingCount: number;
  pendingSegments: number;
  allowDiscard?: boolean;
}): VoiceConsolePanelSpec {
  return {
    color: 0xed4245,
    title: "End Shared Voice Console?",
    description:
      `This ends capture and VC speech for ${input.bindingCount} binding${input.bindingCount === 1 ? "" : "s"}. ` +
      `${input.pendingSegments} finalized pending segment${input.pendingSegments === 1 ? "" : "s"} ` +
      "will be preserved by default.",
    fields: [{
      name: "Durability",
      value: "Work already owned by a durable dispatch artifact is never discarded.",
    }],
    footer: "No action is taken until an explicit confirmation is clicked.",
    components: buildEndConsoleConfirmationRows(input),
  };
}

export function renderFanoutDisarmConfirmation(input: {
  consoleId: string;
  revision: number;
  selectedBindings: ReadonlyArray<VoiceConsoleBindingPresentation>;
}): VoiceConsolePanelSpec {
  return {
    color: 0xfee75c,
    title: "Keep which input target?",
    description:
      "Fan-out remains armed and the current target set remains unchanged until one binding is chosen or this view is cancelled.",
    fields: [{
      name: "Currently selected",
      value: input.selectedBindings.map((binding) => safeText(binding.alias)).join(" · "),
    }],
    footer: `revision ${input.revision}`,
    components: buildFanoutDisarmConfirmationRows(input),
  };
}

export function renderVoiceConsoleBindingEditor(input: {
  draft: VoiceConsoleBindingEditorDraft;
  duplicateVoiceAliases?: ReadonlyArray<string>;
}): VoiceConsolePanelSpec {
  const current = effectiveVoiceConsoleBindingProfile(input.draft);
  const duplicate = input.duplicateVoiceAliases ?? [];
  return {
    color: 0x5865f2,
    title: `🎛️ Configure ${safeText(current.alias)}`,
    description:
      "Console-local settings only. This does not change the thread's ordinary `/seam config tts` profile.",
    fields: [
      { name: "Alias", value: safeText(current.alias), inline: true },
      { name: "Voice", value: `\`${safeText(current.voice)}\``, inline: true },
      { name: "Pace", value: `\`${safeText(current.pace)}\``, inline: true },
      { name: "Style", value: `\`${safeText(current.style)}\``, inline: true },
      ...(duplicate.length > 0
        ? [{
            name: "⚠️ Duplicate voice",
            value: `Also used by ${duplicate.map((alias) => safeText(alias)).join(", ")}. Saving requires confirmation.`,
          }]
        : []),
    ],
    footer: `Binding ${input.draft.bindingId} · revision ${input.draft.revision}`,
    components: buildBindingEditorRows(input.draft),
  };
}

export function renderVoiceConsoleVoicePreview(input: {
  draft: VoiceConsoleBindingEditorDraft;
  sampleStatus?: "idle" | "loading" | "ready" | "error";
  sampleError?: string;
}): VoiceConsolePanelSpec {
  const index = Math.min(
    Math.max(0, Math.trunc(input.draft.voiceIndex) || 0),
    GEMINI_TTS_VOICES.length - 1
  );
  const voice = GEMINI_TTS_VOICES[index]!;
  const status = input.sampleStatus === "loading"
    ? "Generating preview…"
    : input.sampleStatus === "ready"
      ? "Preview attached."
      : input.sampleStatus === "error"
        ? `Preview failed: ${safeText(input.sampleError ?? "unknown error")}`
        : "Choose Play preview to hear this voice.";
  return {
    color: 0x5865f2,
    title: `🔊 Voice ${index + 1}/${GEMINI_TTS_VOICES.length} · ${voice.name}`,
    description: `**${voice.name}** — *${voice.style}*\n${status}`,
    fields: [{
      name: "Binding",
      value: safeText(effectiveVoiceConsoleBindingProfile(input.draft).alias),
      inline: true,
    }],
    footer: `Preview only · revision ${input.draft.revision}`,
    components: buildVoicePreviewRows(input.draft),
    previewRequest: voiceConsolePreviewRequest(input.draft),
  };
}

export function renderDuplicateVoiceConfirmation(input: {
  draft: VoiceConsoleBindingEditorDraft;
  duplicateAliases: ReadonlyArray<string>;
}): VoiceConsolePanelSpec {
  const current = effectiveVoiceConsoleBindingProfile(input.draft);
  return {
    color: 0xfee75c,
    title: "Use a duplicate console voice?",
    description:
      `\`${safeText(current.voice)}\` is already used by ` +
      `${input.duplicateAliases.map((alias) => safeText(alias)).join(", ")}. ` +
      "Different voices are the normal source-identification mechanism.",
    fields: [],
    footer: "The binding profile is unchanged until confirmed.",
    components: buildDuplicateVoiceConfirmationRows(input.draft),
  };
}

export function renderVoiceConsoleMutationConfirmation(input: {
  title: string;
  summary: string;
  revision: number;
}): VoiceConsolePanelSpec {
  return {
    color: 0x57f287,
    title: safeText(input.title),
    description: safeText(input.summary),
    fields: [],
    footer: `Saved · revision ${input.revision}`,
    components: [],
  };
}

function inputStateLabel(
  state: Pick<VoiceConsolePanelState, "fanoutArmed" | "bindings">,
  selected: ReadonlySet<string>
): string {
  if (selected.size === 0) return "**Off**\nMute, then unmute after selecting input.";
  if (selected.size > 1) return `**⚠️ FAN-OUT ×${selected.size}**`;
  const binding = state.bindings.find((candidate) => selected.has(candidate.bindingId));
  return binding ? `**${safeText(binding.alias)}**` : "**Unavailable target**";
}

function outputStateLabel(
  bindings: ReadonlyArray<VoiceConsoleBindingPresentation>,
  current: VoiceConsolePanelState["currentSpeaking"]
): string {
  const enabled = bindings.filter((binding) => binding.outputEnabled).length;
  const state = enabled === 0
    ? "**All off**"
    : enabled === bindings.length
      ? "**All on**"
      : `**${enabled}/${bindings.length} enabled**`;
  return current
    ? `${state}\nSpeaking ${safeText(current.alias)} / \`${safeText(current.voice)}\``
    : state;
}

function speakerSummary(
  speakers: ReadonlyArray<VoiceConsoleSpeakerLanePresentation>,
  unauthorizedCount: number
): string {
  const present = speakers.length > 0
    ? speakers.map((speaker) =>
        `<@${speaker.userId}> ${speakerLaneIcon(speaker.state)}`
      ).join(" · ")
    : "No authorized speakers present";
  const capturing = speakers.filter((speaker) => speaker.state === "capturing");
  return limit(
    `${present}\nCapturing: ${capturing.length > 0
      ? capturing.map((speaker) => `<@${speaker.userId}>`).join(", ")
      : "none"}` +
    (unauthorizedCount > 0
      ? ` · ${unauthorizedCount} unauthorized listener${unauthorizedCount === 1 ? "" : "s"}`
      : ""),
    1_024
  );
}

function bindingLine(
  binding: VoiceConsoleBindingPresentation,
  selected: ReadonlySet<string>
): string {
  const input = selected.has(binding.bindingId) ? "🎯" : "○";
  const output = binding.outputEnabled ? "🔊" : "🔇";
  const pending = binding.pendingSegments > 0
    ? `${binding.pendingSegments} pending`
    : "no pending";
  return (
    `${input}${output} **${safeText(binding.alias)}** <#${binding.threadId}> · ` +
    `\`${safeText(binding.voice)}\` · ACP ${safeText(binding.acpState)} · ` +
    `${pending} · ${speechStateLabel(binding.speechState)}`
  );
}

function speakerLaneIcon(state: VoiceConsoleSpeakerLaneState): string {
  switch (state) {
    case "capturing": return "🎙️";
    case "transcribing": return "📝";
    case "armed": return "🟢";
    case "muted-ready": return "🔇";
    case "awaiting-safe-mute": return "⚠️";
    case "reconnecting": return "🔄";
    case "failed": return "❌";
  }
}

function speakerLaneLabel(state: VoiceConsoleSpeakerLaneState): string {
  switch (state) {
    case "muted-ready": return "muted / ready";
    case "awaiting-safe-mute": return "awaiting safe mute";
    case "armed": return "armed";
    case "capturing": return "capturing";
    case "transcribing": return "transcribing";
    case "reconnecting": return "reconnecting";
    case "failed": return "failed";
  }
}

function speechStateLabel(state: VoiceConsoleBindingSpeechState): string {
  switch (state) {
    case "idle": return "speech idle";
    case "queued": return "speech queued";
    case "speaking": return "speaking";
    case "disabled": return "output disabled";
    case "failed": return "speech failed";
  }
}

function panelColor(state: VoiceConsoleLifecycleState): number {
  switch (state) {
    case "failed": return 0xed4245;
    case "ended": return 0x99aab5;
    case "stopping": return 0xfee75c;
    case "starting":
    case "ready":
      return 0x5865f2;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function safeText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, "")
    .replace(/@/g, "＠")
    .trim();
}

function limit(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}
