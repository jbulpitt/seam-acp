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

export const CFG_EDIT_PREFIX = "seam-cfg-edit";
export const INHERIT_VALUE = "__inherit__";
export const DRAFT_IDLE_TTL_MS = 60 * 60 * 1000;
export const RIDER_MODAL_MAX = 4000;
/** Same 25 MB cap as Discord attach / parked files. */
export const RIDER_FILE_MAX_BYTES = 25 * 1024 * 1024;

export type ConfigEditorAction =
  | "host"
  | "agent"
  | "model"
  | "effort"
  | "repo"
  | "approve"
  | "card"
  | "rider"
  | "attach"
  | "save"
  | "cancel"
  | "rider-save"
  | "rider-get"
  | "rider-put";

export const HUB_FIELD_ACTIONS: ReadonlyArray<Exclude<ConfigEditorAction, "save" | "cancel" | "rider-save">> = [
  "host",
  "agent",
  "model",
  "effort",
  "repo",
  "approve",
  "card",
  "rider",
  "attach",
];

export interface InheritedConfig {
  location: string;
  agent: string;
  model: string;
  effort: string | null;
  cwd: string;
  permission: PermissionPolicyMode;
  detached: boolean;
  statusCardStyle: StatusCardStyle;
}

export interface ThreadConfigSnapshot {
  location: ResolvedSetting<string>;
  agent: ResolvedSetting<string>;
  model: ResolvedSetting<string>;
  effort: ResolvedSetting<string | null>;
  cwd: ResolvedSetting<string>;
  permission: ResolvedSetting<PermissionPolicyMode>;
  detached: ResolvedSetting<boolean>;
  statusCardStyle: ResolvedSetting<StatusCardStyle>;
  rider: { channel?: string; thread?: string };
  locked: boolean;
  /** Values that apply if the thread overlay is removed (inherit). */
  withoutThread: InheritedConfig;
  effortIgnoredNote?: string;
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
  permission?: PermissionPolicyMode | null;
  statusCardStyle?: StatusCardStyle | null;
  /** Channel-preset card write (independent of this thread's session overlay). */
  channelStatusCardStyle?: StatusCardStyle | null;
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
    statusCardStyle: d.statusCardStyle ?? { value: "full", source: "default" },
    rider: d.rider ?? {},
    locked: d.locked,
    withoutThread,
    ...(d.effortIgnoredNote ? { effortIgnoredNote: d.effortIgnoredNote } : {}),
  };
}

export function effectiveAfterDraft(draft: ThreadConfigDraft): {
  location: string;
  agent: string;
  model: string;
  effort: string | null;
  cwd: string;
  permission: PermissionPolicyMode;
  detached: boolean;
  riderThread: string | undefined;
  statusCardStyle: StatusCardStyle;
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
    riderThread: o.rider === undefined ? s.rider.thread : o.rider ?? undefined,
    statusCardStyle: effectiveCardStyle(draft),
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

export function willResetSession(draft: ThreadConfigDraft): boolean {
  const next = effectiveAfterDraft(draft);
  return (
    next.location !== draft.snapshot.location.value ||
    next.agent !== draft.snapshot.agent.value
  );
}

/** Thread rider the draft is editing (overlay, else snapshot). `null` = inherit. */
export function currentThreadRiderText(draft: ThreadConfigDraft): string | null {
  if (draft.overlay.rider !== undefined) return draft.overlay.rider;
  return draft.snapshot.rider.thread ?? null;
}

export function riderDownloadFilename(threadId: string): string {
  const slug = threadId.replace(/[^\w-]+/g, "").slice(0, 24) || "thread";
  return `rider-${slug}.md`;
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
  const current =
    draft.overlay.rider === undefined
      ? draft.snapshot.rider.thread
      : draft.overlay.rider ?? "";
  return (current?.length ?? 0) > RIDER_MODAL_MAX;
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
  if (o.detached !== undefined) {
    const current = s.detached.value === true;
    if (o.detached !== current) changes.detached = o.detached;
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

export function isDirty(draft: ThreadConfigDraft): boolean {
  return (
    Object.keys(dirtyThreadPresetChanges(draft)).length > 0 ||
    dirtyPermission(draft) !== undefined ||
    dirtyStatusCardStyle(draft) !== undefined ||
    dirtyChannelStatusCardStyle(draft) !== undefined
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

  const locCurrent =
    s.location.value === "local" && s.location.source === "default"
      ? "`local` (default)"
      : code(s.location.value);
  const attachCurrent = s.detached.value ? "`detached`" : "`attached`";
  const attachSource = s.detached.value ? "thread" : "default";
  const attachDraft =
    o.detached === undefined
      ? undefined
      : o.detached
        ? "will be `detached`"
        : "will be `attached`";

  const riderThread = o.rider === undefined ? s.rider.thread : o.rider ?? undefined;
  const riderChannel = s.rider.channel;
  const riderLines = [
    `channel: ${riderChannel ? code(trunc(riderChannel, 200)) : "`(none)`"}`,
    `thread: ${riderThread ? code(trunc(riderThread, 200)) : "`(none)`"}`,
  ];
  if (o.rider !== undefined) {
    riderLines.push(
      o.rider === null ? "will inherit (clear thread rider)" : "will be new thread rider"
    );
  }
  if (tooLong) {
    riderLines.push("too long for modal — use Download / Upload (Clear still allowed)");
  }
  if (draft.awaitingRiderUpload) {
    riderLines.push("waiting for a `.md` / `.txt` attachment in this thread");
  }

  const warningBlock =
    draft.warnings.length > 0
      ? draft.warnings.map((wline) => `• ${wline}`).join("\n")
      : undefined;

  const footerParts = ["applies on the next turn"];
  if (reset) footerParts.push("⚠ Saving will reset the ACP session (host/agent change)");
  if (!dirty) footerParts.push("no changes yet");
  if (s.effortIgnoredNote) footerParts.push(s.effortIgnoredNote);

  const id = draft.id;
  const actions: StructuredPanel["actions"] = [
    [
      { customId: makeCustomId(id, "host"), label: "Host", style: "secondary" },
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
      { customId: makeCustomId(id, "approve"), label: "Approve", style: "secondary" },
      { customId: makeCustomId(id, "rider"), label: "Rider", style: "secondary" },
      { customId: makeCustomId(id, "rider-get"), label: "Download", style: "secondary" },
      { customId: makeCustomId(id, "rider-put"), label: "Upload", style: "secondary" },
      { customId: makeCustomId(id, "attach"), label: "Attach", style: "secondary" },
    ],
    [
      {
        customId: makeCustomId(id, "save"),
        label: "Save",
        style: "success",
        disabled: !dirty,
      },
      { customId: makeCustomId(id, "cancel"), label: "Cancel", style: "secondary" },
      { customId: makeCustomId(id, "card"), label: "Card", style: "secondary" },
    ],
  ];

  return {
    color: 0x5865f2,
    title: "🧩 Thread config",
    ...(warningBlock ? { description: warningBlock } : {}),
    fields: [
      {
        name: "Host",
        value: trunc(
          fieldLine(locCurrent, sourceLabel(s.location.source), draftNoteFor(o.location, w.location)),
          1024
        ),
        inline: true,
      },
      {
        name: "Agent",
        value: trunc(
          fieldLine(code(s.agent.value), sourceLabel(s.agent.source), draftNoteFor(o.agent, w.agent)),
          1024
        ),
        inline: true,
      },
      {
        name: "Model",
        value: trunc(
          fieldLine(code(s.model.value), sourceLabel(s.model.source), draftNoteFor(o.model, w.model)),
          1024
        ),
        inline: true,
      },
      {
        name: "Effort",
        value: trunc(
          fieldLine(
            s.effort.value ? code(s.effort.value) : "`not set`",
            sourceLabel(s.effort.source),
            draftNoteFor(o.effort, w.effort ?? "not set")
          ),
          1024
        ),
        inline: true,
      },
      {
        name: "Repo",
        value: trunc(
          fieldLine(code(s.cwd.value), sourceLabel(s.cwd.source), draftNoteFor(o.cwd, w.cwd)),
          1024
        ),
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
      statusCardStyle: {
        value: next.statusCardStyle,
        source: cardSourceAfterSave(o, s),
      },
      withoutThread: o.channelStatusCardStyle
        ? { ...s.withoutThread, statusCardStyle: o.channelStatusCardStyle }
        : s.withoutThread,
      rider: {
        ...(s.rider.channel ? { channel: s.rider.channel } : {}),
        ...(next.riderThread ? { thread: next.riderThread } : {}),
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

  switch (field) {
    case "host":
      overlay.location = inherit ? null : value;
      break;
    case "agent": {
      if (inherit) {
        overlay.agent = null;
      } else {
        const at = value.lastIndexOf("@");
        if (at > 0 && at < value.length - 1) {
          overlay.agent = value.slice(0, at);
          overlay.location = value.slice(at + 1);
        } else {
          overlay.agent = value;
        }
      }
      break;
    }
    case "model":
      overlay.model = inherit ? null : value;
      break;
    case "effort":
      overlay.effort = inherit ? null : value;
      break;
    case "repo":
      overlay.cwd = inherit ? null : value;
      break;
    case "approve":
      overlay.permission = inherit ? null : (value as PermissionPolicyMode);
      break;
    case "rider":
      overlay.rider = inherit || value === "" ? null : value;
      break;
    case "attach":
      if (inherit) overlay.detached = false;
      else overlay.detached = value === "detached";
      break;
    case "card":
      if (inherit) {
        overlay.statusCardStyle = null;
      } else if (value === "channel:full" || value === "channel:simple") {
        overlay.channelStatusCardStyle = value === "channel:simple" ? "simple" : "full";
      } else {
        overlay.statusCardStyle = value as StatusCardStyle;
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
  const agentId = effectiveAfterDraft(updated).agent;
  if (field === "host" || field === "agent") {
    return dropUnsupported(updated, capsForAgent(agentId));
  }
  return updated;
}

export interface ConfigEditorSavePlan {
  threadPreset: ThreadPresetChanges;
  channelPreset?: ChannelPresetChanges;
  permission?: PermissionPolicyMode | null;
  statusCardStyle?: StatusCardStyle | null;
}

export function buildSavePlan(draft: ThreadConfigDraft): ConfigEditorSavePlan {
  const plan: ConfigEditorSavePlan = {
    threadPreset: dirtyThreadPresetChanges(draft),
  };
  const perm = dirtyPermission(draft);
  if (perm !== undefined) plan.permission = perm;
  const card = dirtyStatusCardStyle(draft);
  if (card !== undefined) plan.statusCardStyle = card;
  const channelCard = dirtyChannelStatusCardStyle(draft);
  if (channelCard !== undefined) {
    plan.channelPreset = { statusCardStyle: channelCard };
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
