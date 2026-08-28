/**
 * Pure Discord-component descriptions for the Shared Voice Console.
 *
 * Package E owns interaction acknowledgement, authorization, transactions,
 * persistence, and Discord builders. This module only creates immutable,
 * revisioned presentation contracts and parses untrusted component payloads.
 */
import {
  GEMINI_TTS_VOICES,
  TTS_PACES,
  TTS_STYLES,
  type TtsPace,
  type TtsStyle,
} from "../../core/audio/gemini-tts.js";

export const VOICE_CONSOLE_CUSTOM_ID_PREFIX = "tvc";
export const VOICE_CONSOLE_CUSTOM_ID_MAX = 100;
export const VOICE_CONSOLE_BINDING_LIMIT = 10;
export const VOICE_CONSOLE_FANOUT_LIMIT = 5;

/** Discord measures these limits in JavaScript UTF-16 code units. */
export const VOICE_CONSOLE_DISCORD_LIMITS = {
  selectOptionLabel: 100,
  selectOptionDescription: 100,
  selectPlaceholder: 150,
  buttonLabel: 80,
  modalTitle: 45,
  modalFieldLabel: 45,
} as const;

const DISCORD_TEXT_REPLACEMENTS = new Map<string, string>([
  ["\\", "＼"],
  ["`", "｀"],
  ["*", "＊"],
  ["_", "＿"],
  ["~", "～"],
  ["|", "｜"],
  ["[", "［"],
  ["]", "］"],
  ["(", "（"],
  [")", "）"],
  ["<", "＜"],
  [">", "＞"],
  ["@", "＠"],
  ["#", "＃"],
  ["+", "＋"],
  ["-", "－"],
  ["!", "！"],
  [":", "："],
  ["/", "／"],
  [".", "．"],
]);

/**
 * Truncate by UTF-16 units, matching Discord, without leaving half of a
 * surrogate pair at the cut. A single-unit ellipsis makes truncation visible.
 */
export function truncateVoiceConsoleText(value: string, maxUnits: number): string {
  const max = Math.max(0, Math.trunc(maxUnits));
  if (value.length <= max) return value;
  if (max === 0) return "";
  const suffix = "…";
  let end = Math.max(0, max - suffix.length);
  if (
    end > 0 &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

/**
 * Presentation-safe dynamic text. Full-width replacements make Discord
 * mention, Markdown, spoiler, link, and escape syntax inert without hiding it.
 */
export function inertVoiceConsoleText(input: string): string {
  const visible = input
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...visible]
    .map((character) => DISCORD_TEXT_REPLACEMENTS.get(character) ?? character)
    .join("");
}

/** Backward-compatible semantic name for binding aliases. */
export function inertVoiceConsoleAlias(input: string): string {
  return inertVoiceConsoleText(input);
}

export const VOICE_CONSOLE_ACTIONS = [
  "input",
  "output",
  "configure",
  "input-off",
  "fanout-arm",
  "fanout-disarm",
  "output-all-on",
  "output-all-off",
  "page-prev",
  "page-next",
  "refresh",
  "end",
  "end-preserve",
  "end-discard",
  "end-cancel",
  "fanout-keep",
  "fanout-cancel",
  "edit-alias",
  "edit-voice",
  "edit-pace",
  "edit-style",
  "edit-save",
  "edit-cancel",
  "voice-prev",
  "voice-next",
  "voice-preview",
  "voice-use",
  "voice-back",
  "duplicate-confirm",
  "duplicate-cancel",
  "alias-save",
] as const;

export type VoiceConsoleAction = (typeof VOICE_CONSOLE_ACTIONS)[number];

export type VoiceConsoleButtonStyle = "primary" | "secondary" | "success" | "danger";

export interface VoiceConsoleSelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface VoiceConsoleSelectComponent {
  kind: "select";
  customId: string;
  placeholder: string;
  minValues: number;
  maxValues: number;
  options: VoiceConsoleSelectOption[];
  disabled?: boolean;
}

export interface VoiceConsoleButtonComponent {
  kind: "button";
  customId: string;
  label: string;
  style: VoiceConsoleButtonStyle;
  disabled?: boolean;
}

export type VoiceConsoleComponent =
  | VoiceConsoleSelectComponent
  | VoiceConsoleButtonComponent;

export interface VoiceConsoleComponentRow {
  components: VoiceConsoleComponent[];
}

export interface VoiceConsoleBindingControlOption {
  bindingId: string;
  alias: string;
  threadId: string;
  voice: string;
  outputEnabled: boolean;
}

export interface VoiceConsoleControlState {
  consoleId: string;
  revision: number;
  fanoutArmed: boolean;
  selectedBindingIds: ReadonlyArray<string>;
  bindings: ReadonlyArray<VoiceConsoleBindingControlOption>;
  page: number;
  pageCount: number;
  disabled?: boolean;
}

export interface ParsedVoiceConsoleCustomId {
  consoleId: string;
  revision: number;
  action: VoiceConsoleAction;
  /** Immutable binding id for editor-only actions. */
  subjectId?: string;
}

export type ParsedVoiceConsoleInteraction =
  | {
      ok: true;
      id: ParsedVoiceConsoleCustomId;
      bindingIds: string[];
    }
  | {
      ok: false;
      error:
        | "not-voice-console"
        | "malformed-custom-id"
        | "unexpected-binding-id"
        | "missing-binding-id"
        | "invalid-selection";
    };

export interface VoiceConsoleBindingProfile {
  alias: string;
  voice: string;
  pace: TtsPace;
  style: TtsStyle;
}

export interface VoiceConsoleBindingEditorDraft {
  consoleId: string;
  revision: number;
  bindingId: string;
  snapshot: VoiceConsoleBindingProfile;
  overlay: Partial<VoiceConsoleBindingProfile>;
  voiceIndex: number;
}

export interface VoiceConsoleModalSpec {
  customId: string;
  title: string;
  fields: Array<{
    customId: string;
    label: string;
    style: "short";
    value: string;
    minLength: number;
    maxLength: number;
    required: boolean;
  }>;
}

const ACTION_SET = new Set<string>(VOICE_CONSOLE_ACTIONS);
const ID_TOKEN = /^[A-Za-z0-9_-]{1,48}$/;
const SUBJECT_ACTIONS = new Set<VoiceConsoleAction>([
  "edit-alias",
  "edit-voice",
  "edit-pace",
  "edit-style",
  "edit-save",
  "edit-cancel",
  "voice-prev",
  "voice-next",
  "voice-preview",
  "voice-use",
  "voice-back",
  "duplicate-confirm",
  "duplicate-cancel",
  "alias-save",
]);
const SELECT_ACTIONS = new Set<VoiceConsoleAction>([
  "input",
  "output",
  "configure",
  "fanout-keep",
]);

export function makeVoiceConsoleCustomId(
  consoleId: string,
  revision: number,
  action: VoiceConsoleAction,
  subjectId?: string
): string {
  if (!ID_TOKEN.test(consoleId)) throw new Error("invalid Voice Console id");
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("invalid Voice Console revision");
  }
  const needsSubject = SUBJECT_ACTIONS.has(action);
  if (needsSubject !== Boolean(subjectId)) {
    throw new Error(needsSubject
      ? `Voice Console action ${action} requires a binding id`
      : `Voice Console action ${action} does not accept a binding id`);
  }
  if (subjectId && !ID_TOKEN.test(subjectId)) throw new Error("invalid Voice Console binding id");
  const customId = [VOICE_CONSOLE_CUSTOM_ID_PREFIX, consoleId, revision, action, subjectId]
    .filter((part) => part !== undefined)
    .join(":");
  if (customId.length > VOICE_CONSOLE_CUSTOM_ID_MAX) {
    throw new Error("Voice Console custom id exceeds Discord's 100-character limit");
  }
  return customId;
}

export function parseVoiceConsoleCustomId(
  customId: string
): ParsedVoiceConsoleCustomId | null {
  if (customId.length === 0 || customId.length > VOICE_CONSOLE_CUSTOM_ID_MAX) return null;
  const parts = customId.split(":");
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [prefix, consoleId, revisionRaw, actionRaw, subjectId] = parts;
  if (
    prefix !== VOICE_CONSOLE_CUSTOM_ID_PREFIX ||
    !consoleId ||
    !ID_TOKEN.test(consoleId) ||
    !revisionRaw ||
    !/^(0|[1-9]\d*)$/.test(revisionRaw) ||
    !actionRaw ||
    !ACTION_SET.has(actionRaw)
  ) {
    return null;
  }
  const revision = Number(revisionRaw);
  if (!Number.isSafeInteger(revision)) return null;
  const action = actionRaw as VoiceConsoleAction;
  const needsSubject = SUBJECT_ACTIONS.has(action);
  if (needsSubject) {
    if (!subjectId || !ID_TOKEN.test(subjectId)) return null;
    return { consoleId, revision, action, subjectId };
  }
  if (subjectId !== undefined) return null;
  return { consoleId, revision, action };
}

/** Parse untrusted Discord component values without consulting durable state. */
export function parseVoiceConsoleInteraction(input: {
  customId: string;
  values?: ReadonlyArray<string>;
}): ParsedVoiceConsoleInteraction {
  if (!input.customId.startsWith(`${VOICE_CONSOLE_CUSTOM_ID_PREFIX}:`)) {
    return { ok: false, error: "not-voice-console" };
  }
  const id = parseVoiceConsoleCustomId(input.customId);
  if (!id) return { ok: false, error: "malformed-custom-id" };
  const values = [...(input.values ?? [])];
  if (!SELECT_ACTIONS.has(id.action)) {
    if (values.length > 0) return { ok: false, error: "unexpected-binding-id" };
    return { ok: true, id, bindingIds: [] };
  }
  if (values.some((value) => !ID_TOKEN.test(value)) || new Set(values).size !== values.length) {
    return { ok: false, error: "invalid-selection" };
  }
  const limits = selectionLimits(id.action);
  if (values.length < limits.min || values.length > limits.max) {
    return { ok: false, error: values.length === 0 ? "missing-binding-id" : "invalid-selection" };
  }
  return { ok: true, id, bindingIds: values };
}

/** Exactly five classic action rows for one live canonical card. */
export function buildVoiceConsoleComponentRows(
  state: VoiceConsoleControlState
): VoiceConsoleComponentRow[] {
  validateControlState(state);
  const disabled = Boolean(state.disabled);
  const selected = new Set(state.selectedBindingIds);
  const output = new Set(
    state.bindings.filter((binding) => binding.outputEnabled).map((binding) => binding.bindingId)
  );
  const options = state.bindings.map((binding) => bindingOption(binding));
  const inputMax = state.fanoutArmed
    ? Math.min(VOICE_CONSOLE_FANOUT_LIMIT, options.length)
    : 1;

  const inputRow: VoiceConsoleComponentRow = options.length > 0
    ? {
        components: [{
          kind: "select",
          customId: makeVoiceConsoleCustomId(state.consoleId, state.revision, "input"),
          placeholder: selected.size === 0
            ? "Input off — choose a target"
            : state.fanoutArmed
              ? "Choose 1–5 input targets"
              : "Choose the input target",
          minValues: 1,
          maxValues: inputMax,
          options: options.map((option) => ({
            ...option,
            ...(selected.has(option.value) ? { default: true as const } : {}),
          })),
          disabled,
        }],
      }
    : disabledPlaceholderRow(state, "No input bindings");

  const outputRow: VoiceConsoleComponentRow = options.length > 0
    ? {
        components: [{
          kind: "select",
          customId: makeVoiceConsoleCustomId(state.consoleId, state.revision, "output"),
          placeholder: output.size === 0 ? "VC output off" : "Choose bindings heard in this VC",
          minValues: 0,
          maxValues: options.length,
          options: options.map((option) => ({
            ...option,
            ...(output.has(option.value) ? { default: true as const } : {}),
          })),
          disabled,
        }],
      }
    : disabledPlaceholderRow(state, "No output bindings");

  const configureRow: VoiceConsoleComponentRow = options.length > 0
    ? {
        components: [{
          kind: "select",
          customId: makeVoiceConsoleCustomId(state.consoleId, state.revision, "configure"),
          placeholder: "Configure alias, voice, pace, or style…",
          minValues: 1,
          maxValues: 1,
          options,
          disabled,
        }],
      }
    : disabledPlaceholderRow(state, "No binding to configure");

  const safetyRow: VoiceConsoleComponentRow = {
    components: [
      button(state, "input-off", "Input off", "danger", disabled || selected.size === 0),
      button(
        state,
        state.fanoutArmed ? "fanout-disarm" : "fanout-arm",
        state.fanoutArmed ? "Disarm fan-out" : "Arm fan-out",
        state.fanoutArmed ? "danger" : "secondary",
        disabled
      ),
      button(state, "output-all-on", "Output all on", "secondary", disabled || output.size === options.length),
      button(state, "output-all-off", "Output all off", "secondary", disabled || output.size === 0),
    ],
  };

  const navigation: VoiceConsoleButtonComponent[] = [];
  if (state.pageCount > 1) {
    navigation.push(
      button(state, "page-prev", "◀ Previous", "secondary", disabled || state.page <= 0),
      button(state, "page-next", "Next ▶", "secondary", disabled || state.page >= state.pageCount - 1)
    );
  }
  navigation.push(
    button(state, "refresh", "Refresh", "secondary", disabled),
    button(state, "end", "End console…", "danger", disabled)
  );

  return constrainComponentRows([
    inputRow,
    outputRow,
    configureRow,
    safetyRow,
    { components: navigation },
  ]);
}

export function buildEndConsoleConfirmationRows(opts: {
  consoleId: string;
  revision: number;
  allowDiscard?: boolean;
}): VoiceConsoleComponentRow[] {
  const state = { consoleId: opts.consoleId, revision: opts.revision };
  const buttons: VoiceConsoleButtonComponent[] = [
    simpleButton(state, "end-preserve", "End and preserve pending", "danger"),
  ];
  if (opts.allowDiscard) {
    buttons.push(simpleButton(state, "end-discard", "End and discard eligible pending", "danger"));
  }
  buttons.push(simpleButton(state, "end-cancel", "Cancel", "secondary"));
  return constrainComponentRows([{ components: buttons }]);
}

export function buildFanoutDisarmConfirmationRows(opts: {
  consoleId: string;
  revision: number;
  selectedBindings: ReadonlyArray<VoiceConsoleBindingControlOption>;
}): VoiceConsoleComponentRow[] {
  if (opts.selectedBindings.length < 2) {
    throw new Error("fan-out disarm confirmation requires several selected bindings");
  }
  return constrainComponentRows([
    {
      components: [{
        kind: "select",
        customId: makeVoiceConsoleCustomId(opts.consoleId, opts.revision, "fanout-keep"),
        placeholder: "Keep which input target?",
        minValues: 1,
        maxValues: 1,
        options: opts.selectedBindings.map(bindingOption),
      }],
    },
    {
      components: [simpleButton(opts, "fanout-cancel", "Cancel", "secondary")],
    },
  ]);
}

export function effectiveVoiceConsoleBindingProfile(
  draft: VoiceConsoleBindingEditorDraft
): VoiceConsoleBindingProfile {
  return {
    alias: draft.overlay.alias ?? draft.snapshot.alias,
    voice: draft.overlay.voice ?? draft.snapshot.voice,
    pace: draft.overlay.pace ?? draft.snapshot.pace,
    style: draft.overlay.style ?? draft.snapshot.style,
  };
}

export function isVoiceConsoleBindingEditorDirty(
  draft: VoiceConsoleBindingEditorDraft
): boolean {
  const current = effectiveVoiceConsoleBindingProfile(draft);
  return (
    current.alias !== draft.snapshot.alias ||
    current.voice !== draft.snapshot.voice ||
    current.pace !== draft.snapshot.pace ||
    current.style !== draft.snapshot.style
  );
}

export function cycleVoiceConsolePace(pace: TtsPace): TtsPace {
  const index = TTS_PACES.indexOf(pace);
  return TTS_PACES[(index + 1) % TTS_PACES.length]!;
}

export function cycleVoiceConsoleStyle(style: TtsStyle): TtsStyle {
  const index = TTS_STYLES.indexOf(style);
  return TTS_STYLES[(index + 1) % TTS_STYLES.length]!;
}

export function voiceConsoleVoiceIndex(voice: string): number {
  const index = GEMINI_TTS_VOICES.findIndex((entry) => entry.name === voice);
  return index >= 0 ? index : 0;
}

export function buildBindingEditorRows(
  draft: VoiceConsoleBindingEditorDraft
): VoiceConsoleComponentRow[] {
  const current = effectiveVoiceConsoleBindingProfile(draft);
  const base = editorIdBase(draft);
  return constrainComponentRows([
    {
      components: [
        editorButton(
          base,
          "edit-alias",
          `Alias: ${truncate(inertVoiceConsoleAlias(current.alias), 40)}`,
          "secondary"
        ),
        editorButton(base, "edit-voice", `Voice: ${current.voice}`, "secondary"),
      ],
    },
    {
      components: [
        editorButton(base, "edit-pace", `Pace: ${current.pace}`, "secondary"),
        editorButton(base, "edit-style", `Style: ${current.style}`, "secondary"),
      ],
    },
    {
      components: [
        editorButton(
          base,
          "edit-save",
          "Save",
          "success",
          !isVoiceConsoleBindingEditorDirty(draft)
        ),
        editorButton(base, "edit-cancel", "Cancel", "secondary"),
      ],
    },
  ]);
}

export function buildVoicePreviewRows(
  draft: VoiceConsoleBindingEditorDraft
): VoiceConsoleComponentRow[] {
  const index = clampVoiceIndex(draft.voiceIndex);
  const voice = GEMINI_TTS_VOICES[index]!;
  const current = effectiveVoiceConsoleBindingProfile(draft);
  const base = editorIdBase(draft);
  return constrainComponentRows([
    {
      components: [
        editorButton(base, "voice-prev", "◀ Previous", "secondary", index === 0),
        editorButton(
          base,
          "voice-next",
          "Next ▶",
          "secondary",
          index === GEMINI_TTS_VOICES.length - 1
        ),
      ],
    },
    {
      components: [
        editorButton(base, "voice-preview", "Play preview", "primary"),
        editorButton(
          base,
          "voice-use",
          voice.name === current.voice ? "Using this voice" : "Use this voice",
          "success",
          voice.name === current.voice
        ),
        editorButton(base, "voice-back", "Back", "secondary"),
      ],
    },
  ]);
}

export function buildDuplicateVoiceConfirmationRows(
  draft: VoiceConsoleBindingEditorDraft
): VoiceConsoleComponentRow[] {
  const base = editorIdBase(draft);
  return constrainComponentRows([{
    components: [
      editorButton(base, "duplicate-confirm", "Use duplicate voice", "danger"),
      editorButton(base, "duplicate-cancel", "Choose another voice", "secondary"),
    ],
  }]);
}

export function buildVoiceConsoleAliasModal(
  draft: VoiceConsoleBindingEditorDraft
): VoiceConsoleModalSpec {
  return {
    customId: makeVoiceConsoleCustomId(
      draft.consoleId,
      draft.revision,
      "alias-save",
      draft.bindingId
    ),
    title: truncateVoiceConsoleText(
      "Edit binding alias",
      VOICE_CONSOLE_DISCORD_LIMITS.modalTitle
    ),
    fields: [{
      customId: "alias",
      label: truncateVoiceConsoleText(
        "Alias (unique in this console)",
        VOICE_CONSOLE_DISCORD_LIMITS.modalFieldLabel
      ),
      style: "short",
      value: inertVoiceConsoleAlias(effectiveVoiceConsoleBindingProfile(draft).alias),
      minLength: 1,
      maxLength: 32,
      required: true,
    }],
  };
}

export type VoiceConsoleAliasResult =
  | { ok: true; alias: string; normalized: string }
  | { ok: false; error: "Alias must contain 1–32 visible characters." };

/** Remove controls and neutralize Discord mention/Markdown syntax before persistence/display. */
export function parseVoiceConsoleAlias(input: string): VoiceConsoleAliasResult {
  const visible = inertVoiceConsoleAlias(input);
  const characters = [...visible];
  if (characters.length < 1 || characters.length > 32) {
    return { ok: false, error: "Alias must contain 1–32 visible characters." };
  }
  return { ok: true, alias: visible, normalized: visible.toLocaleLowerCase("en-US") };
}

export function voiceConsolePreviewRequest(
  draft: VoiceConsoleBindingEditorDraft
): {
  bindingId: string;
  voice: string;
  pace: TtsPace;
  style: TtsStyle;
  text: string;
  attachmentName: string;
} {
  const voice = GEMINI_TTS_VOICES[clampVoiceIndex(draft.voiceIndex)]!;
  const current = effectiveVoiceConsoleBindingProfile(draft);
  return {
    bindingId: draft.bindingId,
    voice: voice.name,
    pace: current.pace,
    style: current.style,
    text: "This is the Shared Voice Console preview voice.",
    attachmentName: `voice-preview-${voice.name.toLowerCase()}.ogg`,
  };
}

function selectionLimits(action: VoiceConsoleAction): { min: number; max: number } {
  switch (action) {
    case "input": return { min: 1, max: VOICE_CONSOLE_FANOUT_LIMIT };
    case "output": return { min: 0, max: VOICE_CONSOLE_BINDING_LIMIT };
    case "configure":
    case "fanout-keep":
      return { min: 1, max: 1 };
    default:
      return { min: 0, max: 0 };
  }
}

function validateControlState(state: VoiceConsoleControlState): void {
  makeVoiceConsoleCustomId(state.consoleId, state.revision, "refresh");
  if (state.bindings.length > VOICE_CONSOLE_BINDING_LIMIT) {
    throw new Error("Voice Console supports at most ten bindings");
  }
  const ids = state.bindings.map((binding) => binding.bindingId);
  if (ids.some((id) => !ID_TOKEN.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Voice Console bindings must have unique immutable ids");
  }
  const selected = [...state.selectedBindingIds];
  if (new Set(selected).size !== selected.length || selected.some((id) => !ids.includes(id))) {
    throw new Error("selected Voice Console bindings must be active and unique");
  }
  if (selected.length > VOICE_CONSOLE_FANOUT_LIMIT) {
    throw new Error("Voice Console fan-out supports at most five targets");
  }
  if (!state.fanoutArmed && selected.length > 1) {
    throw new Error("focused Voice Console state may select at most one target");
  }
  if (!Number.isInteger(state.pageCount) || state.pageCount < 1) {
    throw new Error("Voice Console page count must be positive");
  }
  if (!Number.isInteger(state.page) || state.page < 0 || state.page >= state.pageCount) {
    throw new Error("Voice Console page is out of range");
  }
}

function bindingOption(binding: VoiceConsoleBindingControlOption): VoiceConsoleSelectOption {
  return {
    label: truncateVoiceConsoleText(
      inertVoiceConsoleAlias(binding.alias) || "Unnamed binding",
      VOICE_CONSOLE_DISCORD_LIMITS.selectOptionLabel
    ),
    value: binding.bindingId,
    description: truncateVoiceConsoleText(
      `${binding.voice} · thread ${binding.threadId}`,
      VOICE_CONSOLE_DISCORD_LIMITS.selectOptionDescription
    ),
  };
}

function truncate(value: string, max: number): string {
  return truncateVoiceConsoleText(value, max);
}

function button(
  state: Pick<VoiceConsoleControlState, "consoleId" | "revision">,
  action: VoiceConsoleAction,
  label: string,
  style: VoiceConsoleButtonStyle,
  disabled = false
): VoiceConsoleButtonComponent {
  return simpleButton(state, action, label, style, disabled);
}

function simpleButton(
  state: { consoleId: string; revision: number },
  action: VoiceConsoleAction,
  label: string,
  style: VoiceConsoleButtonStyle,
  disabled = false
): VoiceConsoleButtonComponent {
  return {
    kind: "button",
    customId: makeVoiceConsoleCustomId(state.consoleId, state.revision, action),
    label: truncateVoiceConsoleText(label, VOICE_CONSOLE_DISCORD_LIMITS.buttonLabel),
    style,
    ...(disabled ? { disabled: true as const } : {}),
  };
}

function editorIdBase(draft: VoiceConsoleBindingEditorDraft): {
  consoleId: string;
  revision: number;
  bindingId: string;
} {
  return {
    consoleId: draft.consoleId,
    revision: draft.revision,
    bindingId: draft.bindingId,
  };
}

function editorButton(
  state: { consoleId: string; revision: number; bindingId: string },
  action: VoiceConsoleAction,
  label: string,
  style: VoiceConsoleButtonStyle,
  disabled = false
): VoiceConsoleButtonComponent {
  return {
    kind: "button",
    customId: makeVoiceConsoleCustomId(
      state.consoleId,
      state.revision,
      action,
      state.bindingId
    ),
    label: truncateVoiceConsoleText(label, VOICE_CONSOLE_DISCORD_LIMITS.buttonLabel),
    style,
    ...(disabled ? { disabled: true as const } : {}),
  };
}

function disabledPlaceholderRow(
  state: Pick<VoiceConsoleControlState, "consoleId" | "revision">,
  label: string
): VoiceConsoleComponentRow {
  return {
    components: [simpleButton(state, "refresh", label, "secondary", true)],
  };
}

function clampVoiceIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), GEMINI_TTS_VOICES.length - 1);
}

function constrainComponentRows(
  rows: ReadonlyArray<VoiceConsoleComponentRow>
): VoiceConsoleComponentRow[] {
  return rows.slice(0, 5).map((row) => ({
    components: row.components.slice(0, 5).map((component) => {
      if (component.kind === "button") {
        return {
          ...component,
          label: truncateVoiceConsoleText(
            component.label,
            VOICE_CONSOLE_DISCORD_LIMITS.buttonLabel
          ),
        };
      }
      return {
        ...component,
        placeholder: truncateVoiceConsoleText(
          component.placeholder,
          VOICE_CONSOLE_DISCORD_LIMITS.selectPlaceholder
        ),
        options: component.options.slice(0, 25).map((option) => ({
          ...option,
          label: truncateVoiceConsoleText(
            option.label,
            VOICE_CONSOLE_DISCORD_LIMITS.selectOptionLabel
          ),
          ...(option.description !== undefined
            ? {
                description: truncateVoiceConsoleText(
                  option.description,
                  VOICE_CONSOLE_DISCORD_LIMITS.selectOptionDescription
                ),
              }
            : {}),
        })),
      };
    }),
  }));
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
