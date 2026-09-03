/**
 * Visual thread-config editor (#90): in-memory draft, hub render, dirty-field
 * Save plan. Persistence, pickers, and Discord interactions live in the
 * orchestrator — this module is side-effect free besides the draft map.
 */
import type { PermissionPolicyMode, StatusCardStyle, StructuredPanel } from "../../core/types.js";
import type { ChannelPresetChanges, ThreadPresetChanges } from "../../core/config-mutation.js";
import type {
  ConfigDescription,
  ConfigLayer,
  ResolvedSetting,
} from "../../core/session-router.js";
import { formatAgentAtLocation } from "../../core/location.js";
import {
  FAST_MODE_COST_WARNING,
  fastModeNeedsFreshSession,
} from "../../core/fast-mode.js";

export const CFG_EDIT_PREFIX = "seam-cfg-edit";
export const INHERIT_VALUE = "__inherit__";
export const DRAFT_IDLE_TTL_MS = 60 * 60 * 1000;
export const RIDER_MODAL_MAX = 4000;
/** Same 25 MB cap as Discord attach / parked files. */
export const RIDER_FILE_MAX_BYTES = 25 * 1024 * 1024;

export type ConfigEditorAction =
  | "agent"
  | "model"
  | "effort"
  | "repo"
  | "approve"
  | "card"
  | "gif"
  | "rider"
  | "role"
  | "prefix"
  | "attach"
  | "fast"
  | "save"
  | "cancel"
  | "scope"
  | "rider-save"
  | "role-save"
  | "rider-get"
  | "rider-put";

/** Which overlay the hub field actions write. Default `"thread"`. */
export type ConfigEditorScope = "thread" | "channel";

export const HUB_FIELD_ACTIONS: ReadonlyArray<
  Exclude<ConfigEditorAction, "save" | "cancel" | "scope" | "rider-save" | "role-save">
> = [
  "agent",
  "model",
  "effort",
  "repo",
  "approve",
  "card",
  "gif",
  "rider",
  "role",
  "prefix",
  "attach",
  "fast",
];

export interface InheritedConfig {
  location: string;
  agent: string;
  model: string;
  effort: string | null;
  cwd: string;
  permission: PermissionPolicyMode;
  detached: boolean;
  /** Claude Fast mode (#37). Thread-only, so inheriting always means off. */
  fastMode: boolean;
  statusCardStyle: StatusCardStyle;
  simpleCardGif: boolean;
  role: string | null;
  disableThreadPrefix: boolean;
}

export interface ThreadConfigSnapshot {
  location: ResolvedSetting<string>;
  agent: ResolvedSetting<string>;
  model: ResolvedSetting<string>;
  effort: ResolvedSetting<string | null>;
  cwd: ResolvedSetting<string>;
  permission: ResolvedSetting<PermissionPolicyMode>;
  detached: ResolvedSetting<boolean>;
  fastMode: ResolvedSetting<boolean>;
  statusCardStyle: ResolvedSetting<StatusCardStyle>;
  simpleCardGif: ResolvedSetting<boolean>;
  role: ResolvedSetting<string | null>;
  disableThreadPrefix: ResolvedSetting<boolean>;
  rider: { channel?: string; thread?: string };
  locked: boolean;
  /** Raw channel-preset pins (unset = that field is not on the channel entry). */
  channelPins: ChannelPresetPins;
  /** Values that apply if the thread overlay is removed (inherit). */
  withoutThread: InheritedConfig;
  effortIgnoredNote?: string;
}

/** Channel-preset fields the visual editor can pin (mirrors ChannelPresetChanges). */
export interface ChannelPresetPins {
  agent?: string;
  model?: string;
  cwd?: string;
  effort?: string | null;
  role?: string;
  disableThreadPrefix?: boolean;
}

/** Draft overlay. `null` means inherit (remove the thread overlay / session policy). */
export interface DraftOverlay {
  location?: string | null;
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
  cwd?: string | null;
  rider?: string | null;
  detached?: boolean;
  /** Claude Fast mode (#37). Raw boolean like `detached`; inherit ⇒ off. */
  fastMode?: boolean;
  permission?: PermissionPolicyMode | null;
  statusCardStyle?: StatusCardStyle | null;
  /** Channel-preset card write (independent of this thread's session overlay). */
  channelStatusCardStyle?: StatusCardStyle | null;
  simpleCardGif?: boolean | null;
  channelSimpleCardGif?: boolean | null;
  /** Channel-preset rider. `null` clears the channel pin. */
  channelRider?: string | null;
  channelAgent?: string | null;
  channelModel?: string | null;
  channelCwd?: string | null;
  channelEffort?: string | null;
  role?: string | null;
  channelRole?: string | null;
  disableThreadPrefix?: boolean | null;
  channelDisableThreadPrefix?: boolean | null;
}

export interface ThreadConfigDraft {
  id: string;
  threadId: string;
  parentRef?: string;
  userId: string;
  messageId?: string;
  createdAt: number;
  updatedAt: number;
  snapshot: ThreadConfigSnapshot;
  overlay: DraftOverlay;
  warnings: string[];
  /** Hub field actions write the thread overlay or the channel preset. */
  editScope?: ConfigEditorScope;
  /** Next text-file attachment from the editor owner becomes the draft rider. */
  awaitingRiderUpload?: boolean;
}

export interface DraftAgentCapabilities {
  staticModels?: ReadonlyArray<{ modelId: string }>;
  effortMechanism?: string;
  effortLevels?: ReadonlyArray<string>;
}

export interface HubRenderContext {
  effortDisabled?: boolean;
  /** True when the drafted agent has no Fast mode (#37) — Claude-only, and only
   *  for direct-Anthropic backends. Disables the Fast control rather than
   *  offering one that could only ever refuse. */
  fastDisabled?: boolean;
  /** When false, the Thread↔Channel scope toggle is hidden. Default: shown if the draft has a parent channel. */
  canEditChannel?: boolean;
}

export function makeCustomId(draftId: string, action: string): string {
  return `${CFG_EDIT_PREFIX}:${draftId}:${action}`;
}

export function parseCustomId(
  customId: string
): { draftId: string; action: string } | null {
  const prefix = `${CFG_EDIT_PREFIX}:`;
  if (!customId.startsWith(prefix)) return null;
  const rest = customId.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  return { draftId: rest.slice(0, colon), action: rest.slice(colon + 1) };
}

export function sourceLabel(source: ConfigLayer): string {
  switch (source) {
    case "thread preset":
      return "thread";
    case "channel preset":
      return "channel";
    case "session config":
      return "session";
    default:
      return "default";
  }
}

export function snapshotFromDescribe(
  d: ConfigDescription,
  withoutThread: InheritedConfig
): ThreadConfigSnapshot {
  return {
    location: d.location,
    agent: d.agent,
    model: d.model,
    effort: d.effort,
    cwd: d.cwd,
    permission: d.permission,
    detached: d.detached,
    fastMode: d.fastMode ?? { value: false, source: "default" },
    statusCardStyle: d.statusCardStyle ?? { value: "full", source: "default" },
    simpleCardGif: d.simpleCardGif ?? { value: false, source: "default" },
    role: d.role ?? { value: null, source: "default" },
    disableThreadPrefix: d.disableThreadPrefix ?? { value: false, source: "default" },
    rider: d.rider ?? {},
    locked: d.locked,
    channelPins: {},
    withoutThread,
    ...(d.effortIgnoredNote ? { effortIgnoredNote: d.effortIgnoredNote } : {}),
  };
}

export function editScopeOf(draft: ThreadConfigDraft): ConfigEditorScope {
  return draft.editScope === "channel" ? "channel" : "thread";
}

export function effectiveAfterDraft(draft: ThreadConfigDraft): {
  location: string;
  agent: string;
  model: string;
  effort: string | null;
  cwd: string;
  permission: PermissionPolicyMode;
  detached: boolean;
  fastMode: boolean;
  riderThread: string | undefined;
  riderChannel: string | undefined;
  statusCardStyle: StatusCardStyle;
  simpleCardGif: boolean;
  role: string | null;
  disableThreadPrefix: boolean;
} {
  const s = draft.snapshot;
  const o = draft.overlay;
  const w = s.withoutThread;
  return {
    location: o.location === undefined ? s.location.value : o.location ?? w.location,
    agent: o.agent === undefined ? s.agent.value : o.agent ?? w.agent,
    model: o.model === undefined ? s.model.value : o.model ?? w.model,
    effort: o.effort === undefined ? s.effort.value : o.effort ?? w.effort,
    cwd: o.cwd === undefined ? s.cwd.value : o.cwd ?? w.cwd,
    permission:
      o.permission === undefined ? s.permission.value : o.permission ?? w.permission,
    detached: o.detached === undefined ? s.detached.value : o.detached,
    fastMode: o.fastMode === undefined ? s.fastMode?.value === true : o.fastMode === true,
    riderThread: o.rider === undefined ? s.rider.thread : o.rider ?? undefined,
    riderChannel: o.channelRider === undefined ? s.rider.channel : o.channelRider ?? undefined,
    statusCardStyle: effectiveCardStyle(draft),
    simpleCardGif: effectiveGif(draft),
    role:
      o.role === undefined
        ? s.role?.value ?? null
        : o.role ?? w.role ?? null,
    disableThreadPrefix:
      o.disableThreadPrefix === undefined
        ? s.disableThreadPrefix?.value ?? false
        : o.disableThreadPrefix === true || (w.disableThreadPrefix ?? false),
  };
}

/** Session overlay wins; then thread/session snapshot; then channel overlay; then inherit. */
function effectiveCardStyle(draft: ThreadConfigDraft): StatusCardStyle {
  const s = draft.snapshot;
  const o = draft.overlay;
  const w = s.withoutThread;
  if (o.statusCardStyle != null) return o.statusCardStyle;
  if (o.statusCardStyle === null) {
    if (s.statusCardStyle.source === "thread preset") return s.statusCardStyle.value;
    return o.channelStatusCardStyle ?? w.statusCardStyle;
  }
  if (
    s.statusCardStyle.source === "session config" ||
    s.statusCardStyle.source === "thread preset"
  ) {
    return s.statusCardStyle.value;
  }
  return o.channelStatusCardStyle ?? s.statusCardStyle.value;
}

function effectiveGif(draft: ThreadConfigDraft): boolean {
  const s = draft.snapshot;
  const o = draft.overlay;
  const w = s.withoutThread;
  if (o.simpleCardGif != null) return o.simpleCardGif;
  if (o.simpleCardGif === null) {
    if (s.simpleCardGif.source === "thread preset") return s.simpleCardGif.value;
    return o.channelSimpleCardGif ?? w.simpleCardGif;
  }
  if (
    s.simpleCardGif.source === "session config" ||
    s.simpleCardGif.source === "thread preset"
  ) {
    return s.simpleCardGif.value;
  }
  return o.channelSimpleCardGif ?? s.simpleCardGif.value;
}

export function willResetSession(draft: ThreadConfigDraft): boolean {
  const s = draft.snapshot;
  const next = effectiveAfterDraft(draft);
  return (
    next.location !== s.location.value ||
    next.agent !== s.agent.value ||
    // #37: Fast is a session-start dimension. Changing it must land on a fresh
    // session so an accumulated conversation is never repriced mid-flight —
    // and so must a model/agent/host change while Fast is ON, because Fast is
    // advertised per model (Opus has it, Sonnet does not) and a Claude model
    // switch is otherwise live-config on the SAME session.
    fastModeWillResetSession(draft)
  );
}

/** Whether this draft's Fast state requires a fresh session (shared #37 rule). */
export function fastModeWillResetSession(draft: ThreadConfigDraft): boolean {
  const s = draft.snapshot;
  const next = effectiveAfterDraft(draft);
  return fastModeNeedsFreshSession({
    nextFastMode: next.fastMode,
    fastModeChanged: next.fastMode !== (s.fastMode?.value === true),
    modelChanged: next.model !== s.model.value,
    agentChanged: next.agent !== s.agent.value,
    locationChanged: next.location !== s.location.value,
  });
}

/** True when saving this draft turns Fast mode ON (the paid-credit direction). */
export function willEnableFastMode(draft: ThreadConfigDraft): boolean {
  return (
    effectiveAfterDraft(draft).fastMode &&
    draft.snapshot.fastMode?.value !== true
  );
}

/**
 * Whether saving must (re)verify Fast against a fresh session. True whenever
 * Fast ends up ON and something invalidated its capability check — not just
 * when the Fast toggle itself moved.
 */
export function willVerifyFastMode(draft: ThreadConfigDraft): boolean {
  return effectiveAfterDraft(draft).fastMode && fastModeWillResetSession(draft);
}

/** Thread rider the draft is editing (overlay, else snapshot). `null` = inherit. */
export function currentThreadRiderText(draft: ThreadConfigDraft): string | null {
  if (draft.overlay.rider !== undefined) return draft.overlay.rider;
  return draft.snapshot.rider.thread ?? null;
}

/** Channel-preset rider the draft is editing. `null` = inherit/clear. */
export function currentChannelRiderText(draft: ThreadConfigDraft): string | null {
  if (draft.overlay.channelRider !== undefined) return draft.overlay.channelRider;
  return draft.snapshot.rider.channel ?? null;
}

export function currentRiderText(draft: ThreadConfigDraft): string | null {
  return editScopeOf(draft) === "channel"
    ? currentChannelRiderText(draft)
    : currentThreadRiderText(draft);
}

export function riderDownloadFilename(threadId: string, scope: ConfigEditorScope = "thread"): string {
  const slug = threadId.replace(/[^\w-]+/g, "").slice(0, 24) || "thread";
  return scope === "channel" ? `rider-channel-${slug}.md` : `rider-${slug}.md`;
}

export function decodeRiderUpload(
  buf: Buffer,
  filename: string
): { ok: true; text: string | null } | { ok: false; error: string } {
  const name = filename.toLowerCase();
  const extOk =
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".markdown") ||
    name.endsWith(".text");
  if (!extOk) {
    return { ok: false, error: "Attach a `.md` or `.txt` file." };
  }
  if (buf.byteLength > RIDER_FILE_MAX_BYTES) {
    return { ok: false, error: `File exceeds ${RIDER_FILE_MAX_BYTES} byte cap.` };
  }
  if (buf.includes(0)) {
    return { ok: false, error: "Rider file must be UTF-8 text, not binary." };
  }
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, text: null };
  return { ok: true, text };
}

export function riderTooLong(draft: ThreadConfigDraft): boolean {
  const current = currentRiderText(draft) ?? "";
  return current.length > RIDER_MODAL_MAX;
}

function threadOverlayValue<T>(setting: ResolvedSetting<T>): T | undefined {
  return setting.source === "thread preset" ? setting.value : undefined;
}

export function dirtyThreadPresetChanges(draft: ThreadConfigDraft): ThreadPresetChanges {
  const s = draft.snapshot;
  const o = draft.overlay;
  const changes: ThreadPresetChanges = {};

  if (o.location !== undefined) {
    const current =
      s.location.source === "thread preset" && s.location.value !== "local"
        ? s.location.value
        : null;
    const next =
      o.location === null || o.location === "" || o.location === "local" ? null : o.location;
    if (next !== current) changes.location = next;
  }
  if (o.agent !== undefined) {
    const current = threadOverlayValue(s.agent) ?? null;
    const next = o.agent;
    if (next !== current) changes.agent = next;
  }
  if (o.model !== undefined) {
    const current = threadOverlayValue(s.model) ?? null;
    const next = o.model;
    if (next !== current) changes.model = next;
  }
  if (o.effort !== undefined) {
    const current = threadOverlayValue(s.effort) ?? null;
    const next = o.effort;
    if (next !== current) changes.effort = next;
  }
  if (o.cwd !== undefined) {
    const current = threadOverlayValue(s.cwd) ?? null;
    const next = o.cwd;
    if (next !== current) changes.cwd = next;
  }
  if (o.rider !== undefined) {
    const current = s.rider.thread ?? null;
    const next = o.rider;
    if (next !== current) changes.rider = next;
  }
  if (o.role !== undefined) {
    const current = threadOverlayValue(s.role) ?? null;
    const next = o.role;
    if (next !== current) changes.role = next;
  }
  if (o.disableThreadPrefix !== undefined) {
    const current = threadOverlayValue(s.disableThreadPrefix) === true;
    const next = o.disableThreadPrefix === true;
    if (next !== current) changes.disableThreadPrefix = next;
  }
  if (o.detached !== undefined) {
    const current = s.detached.value === true;
    if (o.detached !== current) changes.detached = o.detached;
  }
  if (o.fastMode !== undefined) {
    const current = s.fastMode?.value === true;
    if (o.fastMode !== current) changes.fastMode = o.fastMode;
  }
  return changes;
}

/** `undefined` = permission not part of this save. `null` = inherit (clear session policy). */
export function dirtyPermission(
  draft: ThreadConfigDraft
): PermissionPolicyMode | null | undefined {
  if (draft.overlay.permission === undefined) return undefined;
  const current =
    draft.snapshot.permission.source === "session config"
      ? draft.snapshot.permission.value
      : null;
  const next = draft.overlay.permission;
  if (next === current) return undefined;
  return next;
}

/** `undefined` = style not part of this save. `null` = inherit (clear session style). */
export function dirtyStatusCardStyle(
  draft: ThreadConfigDraft
): StatusCardStyle | null | undefined {
  if (draft.overlay.statusCardStyle === undefined) return undefined;
  const current =
    draft.snapshot.statusCardStyle.source === "session config"
      ? draft.snapshot.statusCardStyle.value
      : null;
  const next = draft.overlay.statusCardStyle;
  if (next === current) return undefined;
  return next;
}

/** Channel-preset card write. `undefined` = not in this save. */
export function dirtyChannelStatusCardStyle(
  draft: ThreadConfigDraft
): StatusCardStyle | null | undefined {
  if (draft.overlay.channelStatusCardStyle === undefined) return undefined;
  const current = draft.snapshot.withoutThread.statusCardStyle;
  const next = draft.overlay.channelStatusCardStyle;
  if (next === current) return undefined;
  return next;
}

export function dirtySimpleCardGif(
  draft: ThreadConfigDraft
): boolean | null | undefined {
  if (draft.overlay.simpleCardGif === undefined) return undefined;
  const current =
    draft.snapshot.simpleCardGif.source === "session config"
      ? draft.snapshot.simpleCardGif.value
      : null;
  const next = draft.overlay.simpleCardGif;
  if (next === current) return undefined;
  return next;
}

export function dirtyChannelSimpleCardGif(
  draft: ThreadConfigDraft
): boolean | null | undefined {
  if (draft.overlay.channelSimpleCardGif === undefined) return undefined;
  const current = draft.snapshot.withoutThread.simpleCardGif;
  const next = draft.overlay.channelSimpleCardGif;
  if (next === current) return undefined;
  return next;
}

export function dirtyChannelRider(
  draft: ThreadConfigDraft
): string | null | undefined {
  if (draft.overlay.channelRider === undefined) return undefined;
  const current = draft.snapshot.rider.channel ?? null;
  const next = draft.overlay.channelRider;
  if (next !== current) return next;
  return undefined;
}

function dirtyChannelPin(
  overlay: string | null | undefined,
  current: string | null | undefined
): string | null | undefined {
  if (overlay === undefined) return undefined;
  const cur = current ?? null;
  const next = overlay;
  if (next !== cur) return next;
  return undefined;
}

export function dirtyChannelAgent(draft: ThreadConfigDraft): string | null | undefined {
  return dirtyChannelPin(draft.overlay.channelAgent, draft.snapshot.channelPins?.agent);
}

export function dirtyChannelModel(draft: ThreadConfigDraft): string | null | undefined {
  return dirtyChannelPin(draft.overlay.channelModel, draft.snapshot.channelPins?.model);
}

export function dirtyChannelCwd(draft: ThreadConfigDraft): string | null | undefined {
  return dirtyChannelPin(draft.overlay.channelCwd, draft.snapshot.channelPins?.cwd);
}

export function dirtyChannelEffort(draft: ThreadConfigDraft): string | null | undefined {
  return dirtyChannelPin(
    draft.overlay.channelEffort,
    draft.snapshot.channelPins?.effort ?? null
  );
}

export function dirtyChannelRole(draft: ThreadConfigDraft): string | null | undefined {
  return dirtyChannelPin(
    draft.overlay.channelRole,
    draft.snapshot.channelPins?.role ?? null
  );
}

export function dirtyChannelDisableThreadPrefix(
  draft: ThreadConfigDraft
): boolean | null | undefined {
  if (draft.overlay.channelDisableThreadPrefix === undefined) return undefined;
  const current = draft.snapshot.channelPins?.disableThreadPrefix === true;
  const next = draft.overlay.channelDisableThreadPrefix === true;
  return current === next ? undefined : next;
}

export function isDirty(draft: ThreadConfigDraft): boolean {
  return (
    Object.keys(dirtyThreadPresetChanges(draft)).length > 0 ||
    dirtyPermission(draft) !== undefined ||
    dirtyStatusCardStyle(draft) !== undefined ||
    dirtyChannelStatusCardStyle(draft) !== undefined ||
    dirtySimpleCardGif(draft) !== undefined ||
    dirtyChannelSimpleCardGif(draft) !== undefined ||
    dirtyChannelRider(draft) !== undefined ||
    dirtyChannelAgent(draft) !== undefined ||
    dirtyChannelModel(draft) !== undefined ||
    dirtyChannelCwd(draft) !== undefined ||
    dirtyChannelEffort(draft) !== undefined ||
    dirtyChannelRole(draft) !== undefined ||
    dirtyChannelDisableThreadPrefix(draft) !== undefined
  );
}

export function authorizeDraftClick(
  draft: ThreadConfigDraft | undefined,
  userId: string
): "ok" | "not-yours" | "expired" {
  if (!draft) return "expired";
  if (draft.userId !== userId) return "not-yours";
  return "ok";
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

function code(value: string | null | undefined): string {
  if (value == null || value === "") return "`not set`";
  return `\`${trunc(value, 80)}\``;
}

function fieldLine(
  current: string,
  source: string,
  draftNote?: string
): string {
  const base = `${current} · ${source}`;
  return draftNote ? `${base}\n${draftNote}` : base;
}

function draftNoteFor(
  overlay: string | null | undefined,
  inherited: string
): string | undefined {
  if (overlay === undefined) return undefined;
  if (overlay === null) return `will inherit ${code(inherited)}`;
  return `will be ${code(overlay)}`;
}

/** The addressable id the thread will run as once this draft is saved (#156). */
export function effectiveAgentAtLocation(draft: ThreadConfigDraft): string {
  const next = effectiveAfterDraft(draft);
  return formatAgentAtLocation(next.agent, next.location);
}

/** Agent + host move together, so they get one "will be `agent@host`" note. */
function agentDraftNote(draft: ThreadConfigDraft): string | undefined {
  const o = draft.overlay;
  if (o.agent === undefined && o.location === undefined) return undefined;
  const w = draft.snapshot.withoutThread;
  if (o.agent === null) {
    return `will inherit ${code(formatAgentAtLocation(w.agent, w.location))}`;
  }
  return `will be ${code(effectiveAgentAtLocation(draft))}`;
}

export function renderHub(
  draft: ThreadConfigDraft,
  ctx: HubRenderContext = {}
): StructuredPanel {
  const s = draft.snapshot;
  const o = draft.overlay;
  const w = s.withoutThread;
  const dirty = isDirty(draft);
  const reset = willResetSession(draft);
  const tooLong = riderTooLong(draft);
  const effortDisabled = ctx.effortDisabled === true;

  const scope = editScopeOf(draft);
  const channelScope = scope === "channel";
  const showScope = ctx.canEditChannel !== false && !!draft.parentRef;
  const pins = s.channelPins ?? {};
  const threadOnlyDisabled = channelScope;

  const locCurrent =
    s.location.value === "local" && s.location.source === "default"
      ? "`local` (default)"
      : code(s.location.value);
  // #37: Fast is thread-only, so channel scope has nothing to show but why.
  const fastCurrent = s.fastMode?.value ? "`on`" : "`off`";
  const fastSource = s.fastMode?.source ?? "default";

  const attachCurrent = s.detached.value ? "`detached`" : "`attached`";
  const attachSource = s.detached.value ? "thread" : "default";
  const attachDraft =
    o.detached === undefined
      ? undefined
      : o.detached
        ? "will be `detached`"
        : "will be `attached`";

  const fastLine = channelScope
    ? fieldLine("`per-thread`", "Fast is never pinned channel-wide")
    : fieldLine(
        fastCurrent,
        sourceLabel(fastSource),
        o.fastMode === undefined
          ? undefined
          : o.fastMode
            ? "will be `on` — fresh session, paid credits"
            : "will be `off` — fresh session"
      );

  const riderThread = o.rider === undefined ? s.rider.thread : o.rider ?? undefined;
  const riderChannel = o.channelRider === undefined ? s.rider.channel : o.channelRider ?? undefined;
  const riderLines = [
    `channel: ${riderChannel ? code(trunc(riderChannel, 200)) : "`(none)`"}`,
    `thread: ${riderThread ? code(trunc(riderThread, 200)) : "`(none)`"}`,
  ];
  if (o.channelRider !== undefined) {
    riderLines.push(
      o.channelRider === null
        ? "will inherit (clear channel rider)"
        : "will be new channel rider"
    );
  }
  if (o.rider !== undefined) {
    riderLines.push(
      o.rider === null ? "will inherit (clear thread rider)" : "will be new thread rider"
    );
  }
  if (tooLong) {
    riderLines.push("too long for modal — use Download / Upload (Clear still allowed)");
  }
  if (draft.awaitingRiderUpload) {
    riderLines.push(
      channelScope
        ? "waiting for a `.md` / `.txt` attachment (channel rider)"
        : "waiting for a `.md` / `.txt` attachment in this thread"
    );
  }
  if (channelScope) {
    riderLines.push("scope: channel preset (Rider/Download/Upload edit the channel rider)");
  }

  const warningBlock =
    draft.warnings.length > 0
      ? draft.warnings.map((wline) => `• ${wline}`).join("\n")
      : undefined;

  const footerParts = channelScope
    ? ["editing channel preset", "all threads inherit", "applies on the next turn"]
    : ["applies on the next turn"];
  const fastChanging = fastModeWillResetSession(draft);
  if (reset) {
    footerParts.push(
      fastChanging
        ? "⚠ Saving will reset the ACP session (Fast mode is applied to a fresh session)"
        : "⚠ Saving will reset the ACP session (host/agent change)"
    );
  }
  if (willEnableFastMode(draft)) footerParts.push(`⚡ ${FAST_MODE_COST_WARNING}`);
  if (!dirty) footerParts.push("no changes yet");
  if (s.effortIgnoredNote) footerParts.push(s.effortIgnoredNote);
  if (s.locked && channelScope) footerParts.push("channel is locked — admin-only");

  const id = draft.id;
  const row2: NonNullable<StructuredPanel["actions"]>[0] = [
    {
      customId: makeCustomId(id, "save"),
      label: "Save",
      style: "success",
      disabled: !dirty,
    },
    { customId: makeCustomId(id, "cancel"), label: "Cancel", style: "secondary" },
    { customId: makeCustomId(id, "card"), label: "Card", style: "secondary" },
    { customId: makeCustomId(id, "gif"), label: "GIF", style: "secondary" },
  ];
  if (showScope) {
    row2.push({
      customId: makeCustomId(id, "scope"),
      label: channelScope ? "Thread" : "Channel",
      style: "primary",
    });
  }
  const actions: StructuredPanel["actions"] = [
    [
      // #156: no separate Host button — Agent picks `agentId@location`, so the
      // host is chosen with the agent and shown read-only below.
      { customId: makeCustomId(id, "agent"), label: "Agent", style: "secondary" },
      { customId: makeCustomId(id, "model"), label: "Model", style: "secondary" },
      {
        customId: makeCustomId(id, "effort"),
        label: "Effort",
        style: "secondary",
        disabled: effortDisabled,
      },
      { customId: makeCustomId(id, "repo"), label: "Repo", style: "secondary" },
    ],
    [
      {
        customId: makeCustomId(id, "approve"),
        label: "Approve",
        style: "secondary",
        disabled: threadOnlyDisabled,
      },
      { customId: makeCustomId(id, "rider"), label: "Rider", style: "secondary" },
      { customId: makeCustomId(id, "rider-get"), label: "Download", style: "secondary" },
      { customId: makeCustomId(id, "rider-put"), label: "Upload", style: "secondary" },
      {
        customId: makeCustomId(id, "attach"),
        label: "Attach",
        style: "secondary",
        disabled: threadOnlyDisabled,
      },
    ],
    row2,
    [
      { customId: makeCustomId(id, "role"), label: "Role", style: "secondary" },
      { customId: makeCustomId(id, "prefix"), label: "Auto-name", style: "secondary" },
      {
        customId: makeCustomId(id, "fast"),
        label: "Fast",
        style: "secondary",
        // Thread-only (a channel pin would bill every sibling) and Claude-only.
        disabled: threadOnlyDisabled || ctx.fastDisabled === true,
      },
    ],
  ];

  // #156: render the addressable id (`agentId@location`) so the card states the
  // host exactly once, on the control that sets it.
  const agentLine = channelScope
    ? fieldLine(
        code(pins.agent),
        pins.agent ? "channel" : "default",
        draftNoteFor(o.channelAgent, "not set")
      )
    : fieldLine(
        code(formatAgentAtLocation(s.agent.value, s.location.value)),
        sourceLabel(s.agent.source),
        agentDraftNote(draft)
      );
  const hostLine = channelScope
    ? fieldLine("`per-thread`", "set with the agent")
    : fieldLine(
        locCurrent,
        `${sourceLabel(s.location.source)} · from agent`,
        draftNoteFor(o.location, w.location)
      );
  const modelLine = channelScope
    ? fieldLine(
        code(pins.model),
        pins.model ? "channel" : "default",
        draftNoteFor(o.channelModel, "not set")
      )
    : fieldLine(code(s.model.value), sourceLabel(s.model.source), draftNoteFor(o.model, w.model));
  const effortLine = channelScope
    ? fieldLine(
        pins.effort ? code(pins.effort) : "`not set`",
        pins.effort ? "channel" : "default",
        draftNoteFor(o.channelEffort, "not set")
      )
    : fieldLine(
        s.effort.value ? code(s.effort.value) : "`not set`",
        sourceLabel(s.effort.source),
        draftNoteFor(o.effort, w.effort ?? "not set")
      );
  const cwdLine = channelScope
    ? fieldLine(
        code(pins.cwd),
        pins.cwd ? "channel" : "default",
        draftNoteFor(o.channelCwd, "not set")
      )
    : fieldLine(code(s.cwd.value), sourceLabel(s.cwd.source), draftNoteFor(o.cwd, w.cwd));
  const roleLine = channelScope
    ? fieldLine(
        code(pins.role),
        pins.role ? "channel" : "default",
        draftNoteFor(o.channelRole, "not set")
      )
    : fieldLine(
        code(s.role.value),
        sourceLabel(s.role.source),
        draftNoteFor(o.role, w.role ?? "not set")
      );
  const prefixDisabled = channelScope
    ? (o.channelDisableThreadPrefix === undefined
        ? pins.disableThreadPrefix === true
        : o.channelDisableThreadPrefix === true)
    : effectiveAfterDraft(draft).disableThreadPrefix;
  const prefixLine = channelScope
    ? fieldLine(
        code(prefixDisabled ? "disabled" : "enabled"),
        pins.disableThreadPrefix ? "channel" : "default",
        o.channelDisableThreadPrefix === undefined
          ? undefined
          : `will be ${code(prefixDisabled ? "disabled" : "enabled")}`
      )
    : fieldLine(
        code(prefixDisabled ? "disabled" : "enabled"),
        sourceLabel(s.disableThreadPrefix.source),
        o.disableThreadPrefix === undefined
          ? undefined
          : `will be ${code(prefixDisabled ? "disabled" : "enabled")}`
      );

  return {
    color: 0x5865f2,
    title: channelScope ? "🧩 Channel preset" : "🧩 Thread config",
    ...(warningBlock ? { description: warningBlock } : {}),
    fields: [
      {
        name: "Agent",
        value: trunc(agentLine, 1024),
        inline: true,
      },
      {
        name: "Host",
        value: trunc(hostLine, 1024),
        inline: true,
      },
      {
        name: "Model",
        value: trunc(modelLine, 1024),
        inline: true,
      },
      {
        name: "Effort",
        value: trunc(effortLine, 1024),
        inline: true,
      },
      {
        name: "Repo",
        value: trunc(cwdLine, 1024),
        inline: true,
      },
      {
        name: "Role",
        value: trunc(roleLine, 1024),
        inline: true,
      },
      {
        name: "Auto-name",
        value: trunc(prefixLine, 1024),
        inline: true,
      },
      {
        name: "Approve",
        value: trunc(
          fieldLine(
            code(s.permission.value),
            sourceLabel(s.permission.source),
            draftNoteFor(o.permission, w.permission)
          ),
          1024
        ),
        inline: true,
      },
      {
        name: "Rider",
        value: trunc(riderLines.join("\n"), 1024),
        inline: false,
      },
      {
        name: "Attached",
        value: trunc(fieldLine(attachCurrent, attachSource, attachDraft), 1024),
        inline: true,
      },
      {
        name: "Fast",
        value: trunc(fastLine, 1024),
        inline: true,
      },
      {
        name: "Card",
        value: trunc(
          fieldLine(
            code(s.statusCardStyle.value),
            sourceLabel(s.statusCardStyle.source),
            [
              draftNoteFor(
                o.statusCardStyle,
                o.channelStatusCardStyle ?? w.statusCardStyle
              ),
              o.channelStatusCardStyle
                ? `channel will be ${code(o.channelStatusCardStyle)}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n") || undefined
          ),
          1024
        ),
        inline: true,
      },
      {
        name: "GIF",
        value: trunc(
          fieldLine(
            code(s.simpleCardGif.value ? "on" : "off"),
            sourceLabel(s.simpleCardGif.source),
            [
              draftNoteFor(
                o.simpleCardGif === undefined
                  ? undefined
                  : o.simpleCardGif === null
                    ? null
                    : o.simpleCardGif
                      ? "on"
                      : "off",
                (o.channelSimpleCardGif ?? w.simpleCardGif) ? "on" : "off"
              ),
              o.channelSimpleCardGif != null
                ? `channel will be ${code(o.channelSimpleCardGif ? "on" : "off")}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n") || undefined
          ),
          1024
        ),
        inline: true,
      },
    ],
    footer: trunc(footerParts.join(" · "), 2048),
    actions,
  };
}

export function renderExpiredHub(draft: ThreadConfigDraft): StructuredPanel {
  const panel = renderHub(draft);
  return {
    ...panel,
    footer: "draft expired",
    actions: [],
  };
}

export function renderCancelledHub(draft: ThreadConfigDraft): StructuredPanel {
  const panel = renderHub(draft);
  return {
    ...panel,
    footer: "✖️ Cancelled — nothing changed.",
    actions: [],
  };
}

/** Fold a saved overlay into the snapshot so the card shows committed values, not "will be". */
export function draftAfterSave(draft: ThreadConfigDraft): ThreadConfigDraft {
  const next = effectiveAfterDraft(draft);
  const s = draft.snapshot;
  const o = draft.overlay;
  const layer = (over: unknown, fallback: ConfigLayer): ConfigLayer =>
    over === undefined ? fallback : over === null ? "default" : "thread preset";
  return {
    ...draft,
    overlay: {},
    warnings: [],
    snapshot: {
      ...s,
      location: { value: next.location, source: layer(o.location, s.location.source) },
      agent: { value: next.agent, source: layer(o.agent, s.agent.source) },
      model: { value: next.model, source: layer(o.model, s.model.source) },
      role: { value: next.role, source: layer(o.role, s.role.source) },
      disableThreadPrefix: {
        value: next.disableThreadPrefix,
        source: next.disableThreadPrefix
          ? (o.disableThreadPrefix === true ? "thread preset" : s.disableThreadPrefix.source)
          : "default",
      },
      effort: { value: next.effort, source: layer(o.effort, s.effort.source) },
      cwd: { value: next.cwd, source: layer(o.cwd, s.cwd.source) },
      permission: {
        value: next.permission,
        source: o.permission === undefined ? s.permission.source : o.permission === null ? "default" : "session config",
      },
      detached: {
        value: next.detached,
        source: next.detached ? "thread preset" : "default",
      },
      fastMode: {
        value: next.fastMode,
        source: next.fastMode ? "thread preset" : "default",
      },
      statusCardStyle: {
        value: next.statusCardStyle,
        source: cardSourceAfterSave(o, s),
      },
      simpleCardGif: {
        value: next.simpleCardGif,
        source: gifSourceAfterSave(o, s),
      },
      rider: {
        ...(next.riderChannel ? { channel: next.riderChannel } : {}),
        ...(next.riderThread ? { thread: next.riderThread } : {}),
      },
      channelPins: {
        ...s.channelPins,
        ...(o.channelAgent ? { agent: o.channelAgent } : {}),
        ...(o.channelModel ? { model: o.channelModel } : {}),
        ...(o.channelCwd ? { cwd: o.channelCwd } : {}),
        ...(o.channelEffort ? { effort: o.channelEffort } : {}),
        ...(o.channelRole !== undefined ? { role: o.channelRole ?? undefined } : {}),
        ...(o.channelDisableThreadPrefix !== undefined
          ? { disableThreadPrefix: o.channelDisableThreadPrefix === true ? true : undefined }
          : {}),
      },
      withoutThread: {
        ...s.withoutThread,
        ...(o.channelStatusCardStyle ? { statusCardStyle: o.channelStatusCardStyle } : {}),
        ...(o.channelSimpleCardGif != null ? { simpleCardGif: o.channelSimpleCardGif } : {}),
        ...(o.channelAgent ? { agent: o.channelAgent } : {}),
        ...(o.channelModel ? { model: o.channelModel } : {}),
        ...(o.channelCwd ? { cwd: o.channelCwd } : {}),
        ...(o.channelEffort !== undefined ? { effort: o.channelEffort } : {}),
        ...(o.channelRole !== undefined ? { role: o.channelRole } : {}),
        ...(o.channelDisableThreadPrefix !== undefined
          ? { disableThreadPrefix: o.channelDisableThreadPrefix === true }
          : {}),
      },
    },
  };
}

function cardSourceAfterSave(o: DraftOverlay, s: ThreadConfigSnapshot): ConfigLayer {
  if (o.statusCardStyle != null) return "session config";
  if (o.statusCardStyle === null) {
    if (s.statusCardStyle.source === "thread preset") return "thread preset";
    if (o.channelStatusCardStyle) return "channel preset";
    return s.statusCardStyle.source === "session config" ? "default" : s.statusCardStyle.source;
  }
  if (
    s.statusCardStyle.source === "session config" ||
    s.statusCardStyle.source === "thread preset"
  ) {
    return s.statusCardStyle.source;
  }
  if (o.channelStatusCardStyle) return "channel preset";
  return s.statusCardStyle.source;
}

function gifSourceAfterSave(o: DraftOverlay, s: ThreadConfigSnapshot): ConfigLayer {
  if (o.simpleCardGif != null) return "session config";
  if (o.simpleCardGif === null) {
    if (s.simpleCardGif.source === "thread preset") return "thread preset";
    if (o.channelSimpleCardGif != null) return "channel preset";
    return s.simpleCardGif.source === "session config" ? "default" : s.simpleCardGif.source;
  }
  if (
    s.simpleCardGif.source === "session config" ||
    s.simpleCardGif.source === "thread preset"
  ) {
    return s.simpleCardGif.source;
  }
  if (o.channelSimpleCardGif != null) return "channel preset";
  return s.simpleCardGif.source;
}

export function renderSavedHub(draft: ThreadConfigDraft): StructuredPanel {
  const reset = willResetSession(draft)
    ? " ACP session will reset on the next spawn."
    : "";
  const panel = renderHub(draftAfterSave(draft));
  return {
    ...panel,
    color: 0x57f287,
    footer: `✅ Saved — applies on the next turn.${reset}`,
    actions: [],
  };
}

function dropUnsupported(
  draft: ThreadConfigDraft,
  caps: DraftAgentCapabilities | undefined
): ThreadConfigDraft {
  const next = effectiveAfterDraft(draft);
  const warnings = [...draft.warnings];
  const overlay = { ...draft.overlay };

  const models = caps?.staticModels?.map((m) => m.modelId);
  if (models && models.length > 0 && overlay.model && overlay.model !== null) {
    if (!models.includes(overlay.model)) {
      overlay.model = null;
      warnings.push(
        `Model dropped — \`${next.agent}\` does not advertise the drafted model.`
      );
    }
  } else if (
    models &&
    models.length > 0 &&
    overlay.model === undefined &&
    next.model &&
    !models.includes(next.model)
  ) {
    overlay.model = null;
    warnings.push(
      `Model dropped — \`${next.agent}\` does not advertise \`${next.model}\`.`
    );
  }

  const mechanism = caps?.effortMechanism ?? "none";
  const levels = caps?.effortLevels ?? [];
  const effort = overlay.effort === undefined ? next.effort : overlay.effort;
  const unsupported =
    mechanism === "none" ||
    levels.length === 0 ||
    (effort != null && !levels.includes(effort));
  if (effort != null && unsupported) {
    overlay.effort = null;
    warnings.push(
      `Effort dropped — \`${next.agent}\` does not support \`${effort}\`.`
    );
  }

  return { ...draft, overlay, warnings };
}

export function applyPickerValue(
  draft: ThreadConfigDraft,
  field: ConfigEditorAction,
  value: string,
  capsForAgent: (agentId: string) => DraftAgentCapabilities | undefined,
  now = Date.now()
): ThreadConfigDraft {
  const inherit = value === INHERIT_VALUE;
  let overlay: DraftOverlay = { ...draft.overlay };
  const warnings: string[] = [];

  const channelScope = editScopeOf(draft) === "channel";

  switch (field) {
    // #156: an agent id already encodes its host (`agentId@location`), so the
    // agent picker is the ONLY writer of `location`. Every branch below writes
    // both halves together — the draft can never hold a host that no agent
    // choice put there.
    case "agent": {
      if (channelScope) {
        // Channel presets pin an agent id only; location stays per-thread.
        overlay.channelAgent = inherit ? null : value.includes("@") ? value.slice(0, value.lastIndexOf("@")) : value;
        break;
      }
      if (inherit) {
        overlay.agent = null;
        overlay.location = null;
        break;
      }
      const at = value.lastIndexOf("@");
      const explicit = at > 0 && at < value.length - 1;
      overlay.agent = explicit ? value.slice(0, at) : value;
      // A bare id means "local" everywhere else in Seam; clearing the overlay
      // inherits local rather than stranding the previous host pin.
      overlay.location = explicit ? value.slice(at + 1) : null;
      break;
    }
    case "model":
      if (channelScope) overlay.channelModel = inherit ? null : value;
      else overlay.model = inherit ? null : value;
      break;
    case "effort":
      if (channelScope) overlay.channelEffort = inherit ? null : value;
      else overlay.effort = inherit ? null : value;
      break;
    case "repo":
      if (channelScope) overlay.channelCwd = inherit ? null : value;
      else overlay.cwd = inherit ? null : value;
      break;
    case "role": {
      const next = inherit || value === "" ? null : value.trim() || null;
      if (channelScope) overlay.channelRole = next;
      else overlay.role = next;
      break;
    }
    case "prefix": {
      const disabled = value === "disabled";
      if (channelScope) overlay.channelDisableThreadPrefix = disabled;
      else overlay.disableThreadPrefix = disabled;
      break;
    }
    case "approve":
      if (channelScope) return draft;
      overlay.permission = inherit ? null : (value as PermissionPolicyMode);
      break;
    case "rider":
      if (channelScope) overlay.channelRider = inherit || value === "" ? null : value;
      else overlay.rider = inherit || value === "" ? null : value;
      break;
    case "attach":
      if (channelScope) return draft;
      if (inherit) overlay.detached = false;
      else overlay.detached = value === "detached";
      break;
    // #37: thread-only, like attach/approve. Inherit means off — there is no
    // channel or session layer beneath a thread's Fast setting.
    case "fast":
      if (channelScope) return draft;
      overlay.fastMode = !inherit && value === "on";
      break;
    case "card":
      if (inherit) {
        if (channelScope) overlay.channelStatusCardStyle = null;
        else overlay.statusCardStyle = null;
      } else if (value === "channel:full" || value === "channel:simple") {
        overlay.channelStatusCardStyle = value === "channel:simple" ? "simple" : "full";
      } else if (channelScope) {
        overlay.channelStatusCardStyle = value as StatusCardStyle;
      } else {
        overlay.statusCardStyle = value as StatusCardStyle;
      }
      break;
    case "gif":
      if (inherit) {
        if (channelScope) overlay.channelSimpleCardGif = null;
        else overlay.simpleCardGif = null;
      } else if (value === "channel:on" || value === "channel:off") {
        overlay.channelSimpleCardGif = value === "channel:on";
      } else if (channelScope) {
        overlay.channelSimpleCardGif = value === "on";
      } else {
        overlay.simpleCardGif = value === "on";
      }
      break;
    default:
      return draft;
  }

  const updated: ThreadConfigDraft = {
    ...draft,
    overlay,
    warnings,
    updatedAt: now,
  };
  if (!channelScope && field === "agent") {
    const agentId = effectiveAfterDraft(updated).agent;
    return dropUnsupported(updated, capsForAgent(agentId));
  }
  return updated;
}

export interface ConfigEditorSavePlan {
  threadPreset: ThreadPresetChanges;
  channelPreset?: ChannelPresetChanges;
  permission?: PermissionPolicyMode | null;
  statusCardStyle?: StatusCardStyle | null;
  simpleCardGif?: boolean | null;
}

export function buildSavePlan(draft: ThreadConfigDraft): ConfigEditorSavePlan {
  const plan: ConfigEditorSavePlan = {
    threadPreset: dirtyThreadPresetChanges(draft),
  };
  const perm = dirtyPermission(draft);
  if (perm !== undefined) plan.permission = perm;
  const card = dirtyStatusCardStyle(draft);
  if (card !== undefined) plan.statusCardStyle = card;
  const gif = dirtySimpleCardGif(draft);
  if (gif !== undefined) plan.simpleCardGif = gif;
  const channelCard = dirtyChannelStatusCardStyle(draft);
  const channelGif = dirtyChannelSimpleCardGif(draft);
  const channelRider = dirtyChannelRider(draft);
  const channelAgent = dirtyChannelAgent(draft);
  const channelModel = dirtyChannelModel(draft);
  const channelCwd = dirtyChannelCwd(draft);
  const channelEffort = dirtyChannelEffort(draft);
  const channelRole = dirtyChannelRole(draft);
  const channelDisableThreadPrefix = dirtyChannelDisableThreadPrefix(draft);
  if (
    channelCard !== undefined ||
    channelGif !== undefined ||
    channelRider !== undefined ||
    channelAgent !== undefined ||
    channelModel !== undefined ||
    channelCwd !== undefined ||
    channelEffort !== undefined ||
    channelRole !== undefined ||
    channelDisableThreadPrefix !== undefined
  ) {
    plan.channelPreset = {
      ...(channelCard !== undefined ? { statusCardStyle: channelCard } : {}),
      ...(channelGif !== undefined ? { simpleCardGif: channelGif } : {}),
      ...(channelRider !== undefined ? { rider: channelRider } : {}),
      ...(channelAgent !== undefined ? { agent: channelAgent } : {}),
      ...(channelModel !== undefined ? { model: channelModel } : {}),
      ...(channelCwd !== undefined ? { cwd: channelCwd } : {}),
      ...(channelEffort !== undefined ? { effort: channelEffort } : {}),
      ...(channelRole !== undefined ? { role: channelRole } : {}),
      ...(channelDisableThreadPrefix !== undefined
        ? { disableThreadPrefix: channelDisableThreadPrefix }
        : {}),
    };
  }
  return plan;
}

export class ConfigEditorStore {
  private readonly byId = new Map<string, ThreadConfigDraft>();
  private readonly byUserThread = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? DRAFT_IDLE_TTL_MS;
    this.now = opts?.now ?? Date.now;
  }

  private userThreadKey(userId: string, threadId: string): string {
    return `${userId}:${threadId}`;
  }

  private isExpired(draft: ThreadConfigDraft, now: number): boolean {
    return now - draft.updatedAt > this.ttlMs;
  }

  get(id: string): ThreadConfigDraft | undefined {
    const draft = this.byId.get(id);
    if (!draft) return undefined;
    if (this.isExpired(draft, this.now())) {
      this.delete(id);
      return undefined;
    }
    return draft;
  }

  getForUserThread(userId: string, threadId: string): ThreadConfigDraft | undefined {
    const id = this.byUserThread.get(this.userThreadKey(userId, threadId));
    return id ? this.get(id) : undefined;
  }

  /**
   * Insert `draft`. If this user already has a draft in the same thread,
   * the previous draft is removed and returned so the caller can expire
   * its card.
   */
  put(draft: ThreadConfigDraft): ThreadConfigDraft | undefined {
    const key = this.userThreadKey(draft.userId, draft.threadId);
    const prevId = this.byUserThread.get(key);
    let evicted: ThreadConfigDraft | undefined;
    if (prevId && prevId !== draft.id) {
      evicted = this.byId.get(prevId);
      this.byId.delete(prevId);
    }
    this.byId.set(draft.id, draft);
    this.byUserThread.set(key, draft.id);
    return evicted;
  }

  touch(id: string, patch: Partial<ThreadConfigDraft>): ThreadConfigDraft | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: ThreadConfigDraft = {
      ...cur,
      ...patch,
      overlay: patch.overlay ?? cur.overlay,
      warnings: patch.warnings ?? cur.warnings,
      updatedAt: this.now(),
    };
    this.byId.set(id, next);
    return next;
  }

  delete(id: string): ThreadConfigDraft | undefined {
    const draft = this.byId.get(id);
    if (!draft) return undefined;
    this.byId.delete(id);
    const key = this.userThreadKey(draft.userId, draft.threadId);
    if (this.byUserThread.get(key) === id) this.byUserThread.delete(key);
    return draft;
  }
}
