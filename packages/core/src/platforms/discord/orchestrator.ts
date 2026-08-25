import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MessageFlags, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, type ChatInputCommandInteraction, type AutocompleteInteraction, type MessageComponentInteraction, type Message } from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import {
  resolveChannelPreset,
  resolveThreadLocation,
  isChannelLocked,
  isThreadDetached,
  isThreadTtsEnabled,
  resolveThreadTtsVoice,
  resolveThreadTtsPace,
  resolveThreadTtsStyle,
  isRestrictedParticipant,
  mayConfigureUserIds,
  PARTICIPANT_CONFIG_REFUSAL,
} from "../../config.js";
import type { Renderer } from "../renderer.js";
import { serializePanelText } from "../renderer.js";
import { choicePickerPageCaption } from "./choice-picker.js";
import { paginatePresetList, PRESET_LIST_PAGE_SIZE } from "./preset-list.js";
import type {
  ChatAdapter,
  ChannelRef,
  ComponentEvent,
  ChoiceInteraction,
  IncomingMessage,
  MessageRef,
  MessageAttachment,
  SessionRecord,
} from "../chat-adapter.js";
import { AgentRuntime, type AgentEventHandler, type PromptOutcome } from "../../agents/agent-runtime.js";
import { cleanTextForPreview, pickerModelsForProfile, scanWorkspaces, type SessionSummary, type SessionSummaryLine, type ISessionManager } from "@seam/adapters";
import { readRichHistory, renderHistory, type HistoryEvent, type RichHistory } from "../../core/compaction/source-reader.js";
import { analyzeSessionCoverage, detectGaps, type TimeRange, type GapReport } from "../../core/compaction/gap-detector.js";
import { runPremiumCompaction, type PremiumCompactionResult, type RunAgent } from "../../core/compaction/pipeline.js";
import { pinnedFactsPrompt, parseJsonOutput, mergePinnedFacts, assembleNewSession, type PinnedFacts } from "../../core/compaction/prompts.js";
import type { AgentProfile } from "@seam/adapters";
import type { ScheduledPromptManager } from "../../core/scheduled-prompts/manager.js";
import type { ScheduledPrompt } from "../../core/scheduled-prompts/types.js";
import type { WakeManager } from "../../core/wake/manager.js";
import type { WakeEvent, WakeScheduleRequest } from "../../core/wake/types.js";
import type { ParkedPromptManager } from "../../core/parked-prompts/manager.js";
import type { ParkedKind, ParkedPrompt } from "../../core/parked-prompts/types.js";
import {
  PARKED_ATTACH_MAX_BYTES,
  saveParkedAttachment,
  deleteParkedAttachmentDir,
  loadParkedAttachmentBytes,
} from "../../core/parked-prompts/attachments.js";
import type { InboxMessage } from "../../core/inbox/types.js";
import { restartSentinelPath, sentinelIsForce } from "../../core/restart-sentinel.js";
import {
  WAKE_MIN_DELAY_SECONDS,
  WAKE_MAX_DELAY_SECONDS,
  WAKE_DEFAULT_CATCHUP_SECONDS,
  WAKE_MAX_CHAIN_DEPTH,
  WAKE_MAX_PENDING_PER_THREAD,
} from "../../core/wake/types.js";
import type { WatchManager } from "../../core/watch/manager.js";
import type { WatchEvent, WatchCreateRequest, WatchKind } from "../../core/watch/types.js";
import {
  WATCH_MIN_INTERVAL_SECONDS,
  WATCH_MAX_INTERVAL_SECONDS,
  WATCH_MAX_EXPIRY_SECONDS,
  WATCH_MAX_PENDING_PER_THREAD,
  WATCH_DEFAULT_MODE,
  WATCH_DEFAULT_MAX_FIRES,
  WATCH_MAX_FIRES_CEILING,
} from "../../core/watch/types.js";
import {
  loadScheduledAttachments,
  deleteScheduledAttachmentDir,
  saveScheduledAttachment,
  deleteScheduledAttachment,
} from "../../core/scheduled-prompts/attachments.js";
import { describeCron, validateCron, nextRun as cronNextRun } from "../../core/scheduled-prompts/cron.js";
import {
  formatWorkflowsView,
  clampFieldValue,
  formatAnomalyLines,
  formatInterruptedLines,
  type InterruptedTurnRow,
} from "./workflows-view.js";
import { DispatchWatcher } from "../../core/dispatch/watcher.js";
import {
  CONTINUE_PROMPT,
  RESUME_ANNOUNCE,
  TURN_RESUME_CONCURRENCY,
  TURN_RESUME_MAX_AGE_SECONDS,
  TURN_RESUME_STAGGER_MS,
  abandonedNotice,
  createResumeScheduler,
  decideResume,
  finishLiveTurn,
  listAbandonedLiveTurns,
  listLiveMarkers,
  patchLiveMarker,
  writeLiveMarker,
  type LiveTurnMarker,
  type ResumePrecondition,
} from "../../core/dispatch/turn-resume.js";
import {
  formatConfigAuditView,
  formatConfigAuditDetail,
  findAuditEntry,
} from "./config-audit-view.js";
import { summarizeAnomalies } from "../../core/watchdog.js";
import type { BridgeHub } from "../../core/bridge-hub.js";
import { handleBridgeSlash } from "./bridge.js";
import { handleDebugSlash } from "./debug.js";
import { BRIDGE_ADMIN_REFUSAL, isBridgeAdminRefused } from "./admin-gate.js";
import {
  AutocompleteRegistry,
  collectStringOptionValues,
  DISCORD_AUTOCOMPLETE_MAX,
  labeledAutocompleteChoices,
  presetAutocompleteChoices,
  safeAutocompleteRespond,
  toAutocompleteChoices,
  tokenAutocompleteChoices,
  type AutocompleteResponder,
} from "./autocomplete.js";
import {
  findGeminiTtsVoice,
  geminiTtsVoiceChoices,
  GEMINI_TTS_VOICES,
  isTtsPace,
  isTtsStyle,
} from "../../core/audio/gemini-tts.js";
import { getOrCreateTtsSample, warmTtsSamples } from "../../core/audio/tts-samples.js";
import {
  TtsEditorStore,
  authorizeTtsDraftClick,
  cyclePace,
  cycleStyle,
  effectiveTts,
  parseTtsCustomId,
  renderTtsCancelled,
  renderTtsHub,
  renderTtsSaved,
  renderTtsVoiceStep,
  ttsDirtyChanges,
  voiceIndexFor,
  type TtsEditorDraft,
} from "./tts-editor.js";
import {
  agentLocationPickerChoices,
  currentAgentAtLocation,
  currentHostPrefixedLabel,
  parseAgentAtLocation,
} from "./location.js";
import {
  ConfigEditorStore,
  INHERIT_VALUE,
  RIDER_MODAL_MAX,
  applyPickerValue,
  authorizeDraftClick,
  buildSavePlan,
  currentRiderText,
  decodeRiderUpload,
  editScopeOf,
  isDirty,
  makeCustomId,
  parseCustomId,
  renderCancelledHub,
  renderExpiredHub,
  renderHub,
  renderSavedHub,
  riderDownloadFilename,
  riderTooLong,
  snapshotFromDescribe,
  type DraftAgentCapabilities,
  type InheritedConfig,
  type ThreadConfigDraft,
} from "./config-editor.js";
import {
  bindSessionLocation,
  isolatedBindSessionId,
  planIsolatedRemoteSpawn,
} from "../../core/location-bind.js";
import { remainingMaxAgeMs, waitUntilBridgeReady } from "../../core/bridge-resume.js";
import {
  isLocalLocation,
  LOCAL_LOCATION,
  formatAgentAtLocation,
  hostShortName,
  listHosts,
} from "../../core/location.js";

/** Accent color for scheduled-prompt cards ("cron blue"). */
const SCHEDULED_COLOR = 0x3498db;
/** Accent color for the read-only delegation-ledger view ("ledger teal"). */
const WORKFLOWS_COLOR = 0x1abc9c;
/** Accent color for the read-only config-audit view (#70). */
const CONFIG_AUDIT_COLOR = 0x8e44ad;
/** Operator-dispatch cards — distinct from scheduled blue so a thread's history
 *  shows at a glance which turns came from the dispatch bridge. */
const DISPATCH_COLOR = 0x9b59b6;
/** Error accent for a failed dispatch stream panel (matches sendResultCard). */
const DISPATCH_ERROR_COLOR = 0xe74c3c;
/** Max chars of streamed body shown in the live/done indicator embed. Discord
 *  caps an embed description at 4096; we keep headroom for the "…" tail marker
 *  and the "full output attached" note. A body larger than this spills to a
 *  file at finalize (mirrors postDispatchOutput's overflow path). */
const DISPATCH_STREAM_DESC_MAX = 3800;

/** Discord's hard per-message content ceiling. The default plain "messages"
 *  dispatch stream grows a single message in place up to this; output that would
 *  exceed it finalizes as fresh plain messages (or a file) instead of truncating. */
const DISCORD_MESSAGE_MAX = 2000;

/** Accent color for preset cards ("preset purple"). */
const PRESET_COLOR = 0x9b59b6;

/** Accent color for wake-event cards (#59) — warm "alarm amber" so a
 *  self-scheduled resumption reads distinctly from cron blue / dispatch purple. */
const WAKE_COLOR = 0xf59e0b;

/** Accent color for watch cards (#60) — "signal green" so a condition-triggered
 *  re-entry reads distinctly from wake amber. */
const WATCH_COLOR = 0x22c55e;

/** Accent color for parked-prompt notices (#88). */
const PARKED_COLOR = 0x3498db;

const SCHEDULE_DEFAULT_TZ = "America/Chicago";
const SCHEDULE_TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];
/** Common-cadence presets for the builder card; value is a full cron or the
 *  sentinel for the custom-cron modal. */
const SCHEDULE_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every day at 9:00 AM", value: "0 9 * * *" },
  { label: "Weekdays at 9:00 AM", value: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00 AM", value: "0 9 * * 1" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Custom cron…", value: "__custom__" },
];
import type { SessionStore } from "../../core/session-store.js";
import { makeSessionId } from "../../core/session-store.js";
import { SessionRouter, simpleCardGifForRender, statusCardStyleForRender } from "../../core/session-router.js";
import type { CardGifCatalog } from "../../core/card-gifs.js";
import {
  deleteSimpleCardGifMessage,
  isSimpleCardGifTerminal,
  pickSimpleCardGifUrl,
  postSimpleCardGifMessage,
} from "../../core/simple-card-gif.js";
import { ConfigMutationService, type ConfigMutationInput } from "../../core/config-mutation.js";
import { reloadChannelPresets } from "../../core/config-reload.js";
import type { ConfigProposeOutcome } from "../../core/mcp/seam-mcp-server.js";
import {
  isSessionRecord,
  type InjectTarget,
  type InjectTurnOptions,
  type InjectTurnResult,
} from "../../core/inject-turn.js";
import {
  applyWatchFeedback,
  applyPresetIdentity,
  buildChainHopSpec,
  enqueueDispatchSpec,
  findQueuedReportBackSpec,
  type DispatchSpec,
} from "../../core/dispatch/types.js";
import { frameSteerPrompt, frameInterruptPrompt } from "../../core/steer.js";
import { humanInboxFrom, scrubDiscordUrls } from "../../core/human-inject.js";
import { TurnStatus, renderStatusPanel, formatContextUsage, fmtTokens } from "../../core/status-panel.js";
import { DispatchStatusPanel } from "../../core/dispatch-status-panel.js";
import { LiveHelpManager } from "../../core/live-help/manager.js";
import { isWithinRoot, resolveRepoPath } from "../../core/path-utils.js";
import {
  applyVoiceNoteTranscriptions,
  formatHeardMessage,
  isVoiceNoteAttachment,
  withoutVoiceNotes,
} from "../../core/audio/voice-notes.js";
import {
  clipSpokenText,
  selectSpokenProse,
  shouldSpeakReply,
  speakReplyToOgg,
} from "../../core/audio/voice-replies.js";
import { ATTACH_FENCE_LANG, WAKE_FENCE_LANG, WATCH_FENCE_LANG, CHOICE_FENCE_LANG, RESULT_FENCE_LANG, isMathFenceLang, sessionHasSeamMcp, withHarnessPreamble } from "../../core/agent-conventions.js";
import {
  THREAD_LIMIT_MESSAGE,
  THREAD_NUMBER_MAX,
  buildThreadName,
  isEmptyOrDefaultThreadName,
  isSlugNumberedName,
  nextThreadNumber,
  normalizeThreadSlug,
  parseSlugThreadNumber,
  resolveEffectiveSlug,
} from "./thread-naming.js";
import {
  CHOICE_CUSTOM_TEXT_MAX,
  choiceAuthoringRules,
  choiceCardHideButtons,
  choiceClickRefusal,
  choiceConfirmNudge,
  choicePendingKey,
  choiceSelectionInRange,
  clampChoiceSelect,
  defaultMaxClicks,
  isChoiceAuthoringRefused,
  isChoiceMultiSelect,
  makeChoiceModalId,
  newChoiceId,
  normalizeIngress,
  parseChoiceCustomId,
  parseChoiceFence,
  parseChoiceSelectValues,
  parseChoiceSpec,
  renderChoicePanel,
  resolveIngestOptionIndex,
  resolveOptionTarget,
  type ChoiceCard,
  type ChoiceSpec,
} from "../../core/choice/types.js";
import { emitChoice, emitChoiceMulti, planChoiceDispatch, planChoiceMultiDispatch } from "../../core/choice/emit.js";
import { ChoiceResultHub, parseResultFence, extractSeamResultFromText } from "../../core/choice/result.js";
import {
  isDiscordSnowflake,
  newIngestEndpointId,
  parseIngestEndpointSpec,
  type IngestEndpoint,
} from "../../core/choice/endpoint.js";
import {
  ingestMintStoredModel,
  refuseIsolatedClaudeModel,
} from "../../core/choice/ingest-model.js";
import { mintBridgeToken, hashBridgeToken } from "../../core/bridge-pairing.js";
import { renderMathPng } from "../../core/math-render.js";
import { isInlineableForAgent } from "../../agents/attachments.js";
import { stageAttachment, sweepStagedAttachments } from "@seam/adapters";
import { splitForFlush } from "../../core/stream-flush.js";
import { FenceStream, type CompletedFence } from "../../core/fence-stream.js";
import { SerialQueue } from "../../core/serial-queue.js";
import { StreamingPanel } from "../../core/streaming-panel.js";
import { StreamingMessageRenderer } from "../../core/streaming-message-renderer.js";
import { mimeTypeForFilename } from "../../core/fence-mime.js";
import { resolveHostPath } from "../../core/host-path.js";
import { zipOneFile } from "../../core/zip-one.js";
import {
  writeThreadSecret,
  listThreadSecrets,
  secretHarnessRules,
  consumeThreadSecrets,
  sweepExpiredSecrets,
} from "../../core/thread-secrets.js";
import {
  defaultSessionConfig,
  type ActiveProject,
  type DelegationKind,
  type PermissionPolicyMode,
  type Preset,
  type SessionConfigState,
  type StatusCardStyle,
  type StructuredPanel,
  type TurnState,
} from "../../core/types.js";
import {
  loadBrandAsset,
  resolveAgentBrand,
  withBrandAttachment,
} from "../../core/agent-brand.js";
import { resolveDiscordSpeakerName, type DiscordAdapter } from "./adapter.js";

const STATUS_EDIT_DEBOUNCE_MS = 2500;
const STATUS_HEARTBEAT_MS = 5000;
const PLATFORM = "discord";

/** Reasoning-effort options for the `/seam effort` picker. Mirror of the SDK's
 *  EffortLevel type — keep in sync with commands.ts and the bundled SDK
 *  (docs/model-management-runbook.md §11). `ultra` is not in the SDK. */
const EFFORT_CHOICES = [
  { value: "low", label: "Low", description: "Fastest, least reasoning" },
  { value: "medium", label: "Medium", description: "Light reasoning" },
  { value: "high", label: "High", description: "Default for most models" },
  { value: "xhigh", label: "X-High", description: "Deeper reasoning (Opus 4.7+)" },
  { value: "max", label: "Max", description: "Maximum reasoning depth" },
];
// Maximum total size of an inline-rendered fence message
// (```lang\n...\n``` plus optional notice). Fences whose rendered
// inline form would exceed this are uploaded as attachments instead.
// Discord's hard limit per message is 2000 chars; 1900 leaves headroom
// for the optional `_(notice)_` paragraph and a tiny safety margin.
const ORCH_INLINE_FENCE_MAX = 1900;

/**
 * Resolved slash options the lock / participant gates inspect (#78).
 * Only `scope` changes privilege today: `cancel scope:all` is the old
 * `/seam kill` and must not inherit cancel's exemptions.
 */
export type SlashGateOptions = {
  scope?: string | null;
};

/** Discord thread names cap at 100 chars. */
export const DISCORD_THREAD_NAME_MAX = 100;

/**
 * `/seam new` / `/seam preset thread` naming: prefix the user-supplied name
 * with the agent's `threadAbbr` (emoji). No manual emoji.
 */
export function prefixThreadNameWithAgentEmoji(
  name: string,
  threadAbbr?: string | null
): string {
  const trimmed = name.trim() || "seam";
  if (!threadAbbr) return trimmed.slice(0, DISCORD_THREAD_NAME_MAX);
  if (trimmed.startsWith(threadAbbr)) return trimmed.slice(0, DISCORD_THREAD_NAME_MAX);
  return `${threadAbbr} ${trimmed}`.slice(0, DISCORD_THREAD_NAME_MAX);
}

/**
 * Glues the Discord adapter, the SessionRouter, and the agent runtimes
 * together. Handles incoming thread messages and `/seam` slash commands.
 */
export class Orchestrator {
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly adapter: ChatAdapter;
  private readonly router: SessionRouter;
  private readonly store: SessionStore;
  private readonly renderer: Renderer;
  /** Conversational config mutation engine (#58 P2/P3). Platform-agnostic; the
   *  orchestrator adds the Discord confirm card + apply/restart wiring. */
  private readonly configMutation: ConfigMutationService;

  private activeTurns = 0;
  private restartPending = false;
  private readonly channelQueues = new Map<string, Promise<void>>();
  private readonly channelGenerations = new Map<string, number>();
  /** Per-session timers that settle a woken "Working" card back to "Monitoring"
   *  after background activity goes quiet. Display-only; cleared when a new turn
   *  takes over the session's status card. */
  private readonly bgSettleTimers = new Map<string, NodeJS.Timeout>();
  /** Set by index.ts after construction; used by /seam schedule handlers to
   *  arm/disarm timers and by the fire runner to drop deleted-thread schedules. */
  private scheduledManager?: ScheduledPromptManager;
  /** Set by index.ts after construction; the DB sweeper for agent-scheduled
   *  wake events (#59). Held only so shutdown/diagnostics can reach it. */
  private wakeManager?: WakeManager;
  /** Set by index.ts after construction; the DB sweeper for agent-defined
   *  watches (#60). Held only so shutdown/diagnostics can reach it. */
  private watchManager?: WatchManager;
  /** Gemini Live voice-channel sessions (#98). In-memory run + durable rows. */
  private liveHelpManager?: LiveHelpManager;
  /** Set by index.ts after construction; event-driven parked-prompt delivery (#88). */
  private parkedManager?: ParkedPromptManager;
  /** Simple-card GIF catalog. Random pick is sync; fetch is off the render path. */
  private cardGifs?: CardGifCatalog;
  /** Status-card poke after park/cancel so `📥 N waiting` updates immediately. */
  private onParkedChange?: () => void;
  /**
   * Wall-clock of the last real (msg.raw) user message per thread. A parked
   * fire that is older than this was superseded — D2: only the latest runs.
   */
  private readonly lastUserMessageAt = new Map<string, number>();
  /** Live self-renewal depth per thread (#59, D8): set while a woken turn runs
   *  (keyed by channelRef → the firing wake's `chainDepth`) so a `schedule_wake`
   *  call *during* that turn inherits depth+1. Absent ⇒ a fresh (depth-0) wake.
   *  In-memory by design — a restart breaks any runaway loop anyway. */
  private readonly activeWakeDepth = new Map<string, number>();
  /** #67 interrupt support. `activeLiveDispatch` maps a target thread id → the
   *  `spec.id` of the LIVE dispatched turn currently running in it, so a
   *  concurrent `send(interrupt:true)` can find the in-flight handoff to cancel.
   *  Set at the start of a live dispatched turn, cleared when it ends.
   *  `interruptedDispatches` holds the ids of dispatches whose turn was
   *  preemptively cancelled by an interrupt — the report-back / chain-advance
   *  branch consumes it so the aborted handoff delivers no partial/stale result.
   *  Both in-memory: a restart ends every live turn anyway. */
  private readonly activeLiveDispatch = new Map<string, string>();
  private readonly interruptedDispatches = new Set<string>();
  /** channelRef → the harness-stamped speaker id of the human turn CURRENTLY
   *  processing on that thread (#71/#57). Set at turn start when speaker identity
   *  is on and there's an author id, cleared in the turn's finally so it never
   *  leaks into a later dispatched/scheduled turn. The config_propose lock gate
   *  reads this (via `currentSpeaker`) — the id, never a display name. */
  private readonly currentSpeakerIds = new Map<string, string>();
  /** Discord author id of the CURRENT *user* turn on a thread (#91 D9).
   *  Always the message author id, independent of SPEAKER_IDENTITY_ENABLED.
   *  Unset for injected turns (dispatch / isolated / wake / watch). */
  private readonly currentAuthorIds = new Map<string, string>();
  /** In-memory pending multi-select picks (#94). Keyed by `${choiceId}:${userId}`
   *  → option indices. Reset on process restart is fine. */
  private readonly choicePending = new Map<string, number[]>();
  /** Set by index.ts after construction so command-layer cancel can finalize
   *  running/pending specs without going through dispose(). */
  private dispatchWatcher?: DispatchWatcher;
  /** channelRef → in-flight live-turn marker id. Command-layer cancel uses
   *  this to find the marker; dispose()/onDead must not. */
  private readonly liveTurnByChannel = new Map<string, string>();
  /** Set by index.ts after construction — pairing + debug + attach ferry. */
  private bridgeHub?: BridgeHub;
  /** In-memory /seam config edit drafts (#90). Idle TTL 60 min. */
  private readonly configEditor = new ConfigEditorStore();
  /** In-memory /seam config tts drafts. Idle TTL 60 min. */
  private readonly ttsEditor = new TtsEditorStore();
  /** #92: declared HTTP result waiters for ingest-triggered choice turns. */
  private choiceResults?: ChoiceResultHub;
  /** #95: synthetic session records for headless ingest jobs (dispatch id → record). */
  private readonly ingestJobs = new Map<string, SessionRecord>();
  /** Bot-wide slash autocomplete registry (#93). Keyed by group/sub/option. */
  private readonly autocomplete = new AutocompleteRegistry();
  /** Public POST /ingest base (no token). */
  private ingestUrl?: () => string;
  /** Stash a marker so a live-turn re-fire reuses it instead of writing a
   *  second one (which would double-resume on the next crash). */
  private readonly pendingLiveResume = new Map<string, LiveTurnMarker>();
  /** Shared start-gate so N resumes stagger instead of firing at once. */
  private readonly resumeScheduler = createResumeScheduler({
    concurrency: TURN_RESUME_CONCURRENCY,
    staggerMs: TURN_RESUME_STAGGER_MS,
  });

  constructor(opts: {
    logger: Logger;
    config: Config;
    adapter: ChatAdapter;
    router: SessionRouter;
    store: SessionStore;
    renderer: Renderer;
  }) {
    this.logger = opts.logger.child({ comp: "orchestrator" });
    this.config = opts.config;
    this.adapter = opts.adapter;
    this.router = opts.router;
    this.store = opts.store;
    this.renderer = opts.renderer;

    // #58 P2/P3: the mutation engine reuses the router's precedence resolver
    // (describeConfig) and profiles, and hot-reloads the LIVE preset maps
    // (config.channelPresets / config.threadPresets — the same references
    // SessionRouter holds) after a validated Tier-C write, so a channel-preset
    // change takes effect on the next turn with no redeploy (P0).
    this.configMutation = new ConfigMutationService({
      store: this.store,
      describeConfig: (record) => this.router.describeConfig(record),
      profiles: new Map(this.router.listProfiles().map((p) => [p.id, p])),
      defaultModel: this.config.DEFAULT_MODEL,
      presetsFile: this.config.CHANNEL_PRESETS_FILE,
      tierCEnabled: this.config.SEAM_CONFIG_MUTATION_TIER_C_ENABLED,
      reloadPresets: () =>
        reloadChannelPresets(
          {
            channelPresets: this.config.channelPresets,
            threadPresets: this.config.threadPresets,
            bridgePresets: this.config.bridgePresets,
          },
          this.config.CHANNEL_PRESETS_FILE,
          this.logger
        ),
      // #69 Tier D: (re)arm the manager's croner timer after a schedule write, so
      // the row and the live timer never diverge. `scheduledManager` is set by
      // index.ts after construction; the `?.` guards the pre-wire window.
      reschedule: (id) => this.scheduledManager?.reschedule(id),
      defaultTimezone: SCHEDULE_DEFAULT_TZ,
      cleanupScheduleAttachments: (id) => {
        void deleteScheduledAttachmentDir(this.config.DATA_DIR, id).catch(() => {});
      },
      logger: this.logger,
    });

    const presetNameResponder: AutocompleteResponder = (ctx) => {
      if (!ctx.projectScopeId) return [];
      const presets = this.store.listPresetsForProject(ctx.projectScopeId);
      return presetAutocompleteChoices(presets, ctx.focusedValue, ctx.projectScopeId);
    };
    this.autocomplete.register("preset", "thread", "preset", presetNameResponder);
    for (const sub of ["apply", "delete", "show", "edit"] as const) {
      this.autocomplete.register("preset", sub, "name", presetNameResponder);
    }
    this.autocomplete.register("config", "tts", "voice", (ctx) =>
      toAutocompleteChoices(geminiTtsVoiceChoices(ctx.focusedValue))
    );
    this.wireSlashAutocomplete();
  }

  /**
   * Bounded slash autocomplete responders (#slash-autocomplete). Registered
   * next to the preset / TTS voice responders; dispatch stays in
   * `handleAutocompleteInteraction` (never a one-off branch there).
   */
  private wireSlashAutocomplete(): void {
    this.autocomplete.register("config", "agent", "id", (ctx) => {
      try {
        const choices = agentLocationPickerChoices(this.router.listProfiles(), {
          bridges: this.config.bridgePresets.values(),
          connected: this.bridgeHub?.connectedIds(),
          agentsByHost: this.bridgeHub?.installedAgentsByHost(),
        });
        return labeledAutocompleteChoices(
          choices.map((c) => ({ name: `${c.label} (${c.value})`, value: c.value })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });

    this.autocomplete.register("config", "repo", "path", async (ctx) => {
      try {
        const dirs = await this.listHostWorkspacePaths(ctx.channelId);
        if (!dirs) return [];
        return labeledAutocompleteChoices(
          dirs.map((p) => ({ name: path.basename(p), value: p })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });

    this.autocomplete.register("config", "model", "id", async (ctx) => {
      try {
        if (!ctx.agentId) return [];
        const profile = this.router.getProfile(ctx.agentId);
        const models = await pickerModelsForProfile(profile, DISCORD_AUTOCOMPLETE_MAX);
        return labeledAutocompleteChoices(
          models.map((m) => ({
            name: m.name && m.name !== m.modelId ? `${m.name} (${m.modelId})` : m.modelId,
            value: m.modelId,
          })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });

    this.autocomplete.register("config", "mode", "id", (ctx) => {
      try {
        if (!ctx.sessionId) return [];
        const rt =
          typeof this.router.getRuntime === "function"
            ? this.router.getRuntime(ctx.sessionId)
            : undefined;
        const modes = rt?.getSessionInfo()?.availableModes ?? [];
        return labeledAutocompleteChoices(
          modes.map((m) => ({
            name: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id,
            value: m.id,
          })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });

    const scheduleIdResponder: AutocompleteResponder = (ctx) => {
      try {
        if (!ctx.channelId) return [];
        const rows = this.store.listScheduledByChannel(PLATFORM, ctx.channelId);
        return tokenAutocompleteChoices(
          rows.map((r) => ({ id: r.id, label: r.name })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    };
    for (const sub of ["remove", "toggle", "addfile", "removefile", "edit"] as const) {
      this.autocomplete.register("schedule", sub, "id", scheduleIdResponder);
    }
    this.autocomplete.register("schedule", "removefile", "filename", (ctx) => {
      try {
        const id = ctx.optionValues?.id;
        if (!id || !ctx.channelId) return [];
        const row = this.store.getScheduled(id);
        if (!row || row.channelRef !== ctx.channelId) return [];
        return labeledAutocompleteChoices(
          row.attachments.map((a) => ({ name: a.filename, value: a.filename })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });

    this.autocomplete.register(null, "workflows", "cancel-wake", (ctx) => {
      try {
        if (!ctx.channelId) return [];
        return tokenAutocompleteChoices(
          this.listWakes(PLATFORM, ctx.channelId).map((w) => ({
            id: w.id,
            label: w.reason || w.id,
          })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });
    this.autocomplete.register(null, "workflows", "cancel-watch", (ctx) => {
      try {
        if (!ctx.channelId) return [];
        return tokenAutocompleteChoices(
          this.listWatches(PLATFORM, ctx.channelId).map((w) => ({
            id: w.id,
            label: w.reason || `${w.kind}:${w.spec}`,
          })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });
    this.autocomplete.register(null, "workflows", "cancel-choice", (ctx) => {
      try {
        if (!ctx.channelId) return [];
        return tokenAutocompleteChoices(
          this.store.listOpenChoiceCards(PLATFORM, ctx.channelId).map((c) => ({
            id: c.id,
            label: c.title,
          })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });
    this.autocomplete.register(null, "workflows", "cancel-ingest", (ctx) => {
      try {
        if (!ctx.channelId) return [];
        return tokenAutocompleteChoices(
          this.store.listOpenIngestEndpoints(PLATFORM, ctx.channelId).map((e) => ({
            id: e.id,
            label: e.name,
          })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });
    this.autocomplete.register(null, "workflows", "cancel-live", (ctx) => {
      try {
        if (!ctx.channelId) return [];
        const rows = (this.liveHelpManager?.listForThread(PLATFORM, ctx.channelId) ?? []).filter(
          (s) => s.status === "starting" || s.status === "live"
        );
        return tokenAutocompleteChoices(
          rows.map((s) => ({
            id: s.id,
            label: s.channelName ? `${s.channelName} · ${s.status}` : s.status,
          })),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });

    this.autocomplete.register(null, "steer", "thread", (ctx) => {
      try {
        const parent = ctx.projectScopeId ?? ctx.parentId;
        if (!parent) return [];
        const siblings = this.store.listSessionsByParent(PLATFORM, parent);
        return labeledAutocompleteChoices(
          siblings.map((s) => {
            let agent = s.agentId;
            try {
              const v = this.router.describeConfig(s)?.agent?.value;
              if (typeof v === "string" && v) agent = v;
            } catch {
              /* mock routers */
            }
            const busy =
              typeof this.router.isBusy === "function" && this.router.isBusy(s.id)
                ? "busy"
                : "idle";
            return {
              name: `${s.channelRef} · ${agent} · ${busy}`,
              value: s.channelRef,
            };
          }),
          ctx.focusedValue
        );
      } catch {
        return [];
      }
    });
  }

  /**
   * Discord autocomplete dispatcher (#93). Looks up a registry responder and
   * always `respond()`s — empty list on miss or error, never throws.
   */
  async handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    await safeAutocompleteRespond(
      (choices) => interaction.respond(choices),
      async () => {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand(false);
        const focused = interaction.options.getFocused(true);
        const responder = this.autocomplete.get(group, sub, focused.name);
        if (!responder) return [];
        const channelId = interaction.channelId ?? undefined;
        const ch = interaction.channel as
          | { isThread?: () => boolean; parentId?: string | null }
          | null
          | undefined;
        const parentId =
          ch && typeof ch.isThread === "function" && ch.isThread()
            ? (ch.parentId ?? undefined)
            : undefined;
        const session = channelId
          ? this.store.get(makeSessionId(PLATFORM, channelId))
          : undefined;
        let agentId = session?.agentId;
        if (session) {
          try {
            const v = this.router.describeConfig(session)?.agent?.value;
            if (typeof v === "string" && v) agentId = v;
          } catch {
            /* mock routers may not implement describeConfig */
          }
        }
        return responder({
          group,
          subcommand: sub,
          optionName: focused.name,
          focusedValue: String(focused.value ?? ""),
          projectScopeId: this.projectScopeId(interaction),
          channelId,
          parentId,
          sessionId: session?.id,
          agentId,
          optionValues: collectStringOptionValues(interaction.options.data ?? []),
        });
      }
    );
  }

  /**
   * Propose a config mutation for the calling thread (#58 P2/P3), invoked by the
   * seam-MCP `config_propose` tool. Validates + builds the diff (side-effect
   * free), posts a confirm CARD into the thread, and returns as soon as the card
   * is posted — the change is applied only when a human clicks Apply (D5). The
   * lock is enforced in the tool layer BEFORE this is called (D2); this method
   * never bypasses it.
   */
  async proposeConfig(
    record: SessionRecord,
    input: ConfigMutationInput
  ): Promise<ConfigProposeOutcome> {
    const built = this.configMutation.buildProposal(record, input);
    if (!built.ok) return { ok: false, error: built.error };
    const proposal = built.proposal;

    // Post the confirm card into the calling thread. If the adapter can't render
    // one, refuse rather than silently apply — the human-in-the-loop gate is the
    // prompt-injection backstop (no auto-apply).
    if (!this.adapter.postConfirmation) {
      return { ok: false, error: "This platform cannot render a confirmation card, so no change can be proposed." };
    }
    // #71 APPLY gate: when config admins are configured, ONLY they may click
    // Apply — in locked AND unlocked channels — instead of the whole
    // DISCORD_ALLOWED_USER_IDS allowlist (which includes student accounts).
    // #74: when the admin set is UNSET, still exclude restricted participants
    // from the fallback (pass the may-configure set). Both unset ⇒ pass
    // nothing so postConfirmation falls back exactly as today.
    const adminIds = this.config.SEAM_CONFIG_ADMIN_USER_IDS;
    const applyAuthorized = adminIds
      ? { authorizedUserIds: adminIds }
      : this.config.SEAM_PARTICIPANT_USER_IDS
        ? { authorizedUserIds: mayConfigureUserIds(this.config) }
        : {};
    const { decision } = await this.adapter.postConfirmation(
      { platform: PLATFORM, id: record.channelRef },
      {
        title: proposal.title,
        description: proposal.restartsSession
          ? "Applying this restarts the session so the change takes effect."
          : undefined,
        fields: proposal.fields,
        warnings: proposal.warnings,
      },
      applyAuthorized
    );

    // Apply in the background on confirmation; the tool has already returned.
    void decision.then(async (d) => {
      if (!d.confirmed) {
        this.logger.info({ scope: proposal.scope, tier: proposal.tier }, "config proposal rejected/expired");
        return;
      }
      try {
        const result = proposal.apply({ id: d.userId ?? null, name: d.userName ?? null });
        // Restart the session so model/agent/cwd/effort/Tier-C changes take
        // effect (Trap 3) — stated on the card, so this is expected, not a bug.
        if (proposal.restartsSession) {
          await this.router.invalidate(record.id).catch((err) =>
            this.logger.warn({ err, session: record.id }, "invalidate after config apply failed")
          );
        }
        await this.adapter
          .sendMessage({ platform: PLATFORM, id: record.channelRef }, `✅ ${result.message}`)
          .catch(() => {});
      } catch (err) {
        this.logger.error({ err, scope: proposal.scope, tier: proposal.tier }, "config apply failed");
        await this.adapter
          .sendMessage(
            { platform: PLATFORM, id: record.channelRef },
            `⚠️ Applying the config change failed: ${(err as Error).message}`
          )
          .catch(() => {});
      }
    });

    return {
      ok: true,
      summary: proposal.title,
      fields: proposal.fields,
      warnings: proposal.warnings,
      restartsSession: proposal.restartsSession,
    };
  }

  install(): void {
    this.adapter.onMessage((msg) => this.handleIncomingMessage(msg));
    this.adapter.onComponent?.((evt) => {
      void this.handleConfigEditorComponent(evt);
      void this.handleTtsEditorComponent(evt).catch((err) => {
        this.logger.warn({ err, customId: evt.customId }, "tts editor component failed");
      });
    });
    this.adapter.onChoiceInteraction?.((evt) => this.handleChoiceCardInteraction(evt));
    this.adapter.onThreadDelete?.((channelRef) => this.handleThreadDeleted(channelRef));
    // DB-backed channel activation (#22): let the adapter's channel gate treat
    // an enabled active_projects row as allowed, additive to the env allowlist.
    this.adapter.setActiveChannelCheck?.((ref) => this.store.isChannelActive(ref));
    this.watchSentinel();
  }

  /** Instant cleanup when a thread is deleted: drop its scheduled prompts and
   *  their stored attachments. (Fire-time 404 is the lazy fallback if the bot
   *  was offline when the delete happened.) Also drops a parked prompt (#88). */
  private async handleThreadDeleted(channelRef: string): Promise<void> {
    const rows = this.store.listScheduledByChannel(PLATFORM, channelRef);
    if (rows.length > 0) {
      this.logger.info({ channelRef, count: rows.length }, "thread deleted; dropping scheduled prompts");
      for (const row of rows) {
        this.scheduledManager?.disarm(row.id);
        this.store.deleteScheduled(row.id);
        await deleteScheduledAttachmentDir(this.config.DATA_DIR, row.id).catch(() => {});
      }
    }
    await this.dropParkedForDeletedThread(channelRef);
  }

  async postNotification(message: string): Promise<void> {
    const channelId = this.config.DISCORD_NOTIFICATIONS_CHANNEL_ID;
    if (!channelId) return;
    try {
      await this.adapter.sendMessage({ platform: PLATFORM, id: channelId }, `**seam-acp**: ${message}`);
    } catch (err) {
      this.logger.warn({ err }, "failed to post notification");
    }
  }

  /** In-flight turns (user + scheduled + dispatch) counted for restart drain. */
  activeTurnCount(): number {
    return this.activeTurns;
  }

  /** True when this thread has a turn in `channelQueues` (#89 busy gate). */
  isChannelBusy(channelRef: string): boolean {
    return this.channelQueues.has(channelRef);
  }

  isRestartPending(): boolean {
    return this.restartPending;
  }

  private sentinelPoller: ReturnType<typeof setInterval> | null = null;

  /** Stop the sentinel file watcher (call on shutdown). */
  stopSentinelWatcher(): void {
    if (this.sentinelPoller) {
      clearInterval(this.sentinelPoller);
      this.sentinelPoller = null;
    }
  }

  private sentinelPath(): string {
    return restartSentinelPath(this.config.DATA_DIR);
  }

  private readSentinelForce(): boolean {
    try {
      return sentinelIsForce(fs.readFileSync(this.sentinelPath(), "utf8"));
    } catch {
      return false;
    }
  }

  private watchSentinel(): void {
    const checkSentinel = () => {
      if (this.restartPending) return;
      if (!fs.existsSync(this.sentinelPath())) return;
      this.logger.info("restart sentinel detected");
      void this.handleRestartSentinel();
    };

    // Poll every 2s — more reliable than fs.watch on Linux
    this.sentinelPoller = setInterval(checkSentinel, 2000);
    // Also check immediately in case sentinel was written before startup
    checkSentinel();

    // Clear out any stale staged attachments from prior runs (TTL backstop).
    void sweepStagedAttachments();
    void sweepExpiredSecrets(this.config.DATA_DIR);
  }

  private async handleRestartSentinel(): Promise<void> {
    this.restartPending = true;
    const force = this.readSentinelForce();
    // Keep cron timers running through the drain. Stopping them here is what
    // made `report-update` miss 5:25 while a restart sat pending for hours —
    // list still showed the stale next_run, and catch-up could then skip it.
    // Isolated scheduled fires increment activeTurns, so they extend the drain
    // instead of being SIGTERM'd. Stop only in the last beat before pm2 restart.
    // `force` (relocate-repo) skips the drain so live ACP processes take
    // SIGTERM; turn-resume continues them after boot.

    if (force) {
      await this.postNotification(
        "♻️ Force restart — interrupting live turns; they will resume."
      );
      this.logger.info({ activeTurns: this.activeTurns }, "force restart sentinel; skipping drain");
    } else if (this.activeTurns > 0) {
      const turnWord = this.activeTurns === 1 ? "turn" : "turn(s)";
      await this.postNotification(
        `♻️ Restart requested — waiting for ${this.activeTurns} ${turnWord} to finish.`
      );
      this.logger.info({ activeTurns: this.activeTurns }, "restart pending, draining turns");

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.activeTurns === 0) {
            clearInterval(check);
            resolve();
          }
        }, 500);
      });
    }

    if (!force) {
      // Give agents 2 seconds to flush their SQLite DBs and transcripts after the
      // final JSON-RPC prompt() response is returned. Without this, the instant
      // SIGTERM during shutdown can interrupt the final background DB commit.
      this.logger.info("turns drained; waiting 2s for background I/O to flush");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    this.logger.info(force ? "force restart, executing pm2 restart" : "all turns drained, executing restart");
    this.scheduledManager?.stop();
    try {
      await fsp.unlink(this.sentinelPath());
    } catch {
      // ignore if already gone
    }

    // Spawn pm2 restart in a detached process so this process can be killed
    // without interrupting the restart command mid-flight.
    const { spawn } = await import("node:child_process");
    const child = spawn("pm2", ["restart", "seam-acp"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // --- message turn ---

  private async handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    const channelId = msg.channel.id;

    // Config editor: next file from the editor owner becomes the draft rider.
    // Must run before abort / park so the upload is not treated as a new turn.
    if (await this.tryConsumeConfigEditorRiderUpload(msg)) return;

    // #63: cooperative mid-turn reply routing (flag-gated, DARK by default). When
    // a turn is already active on this thread and SEAM_MIDTURN_REPLY_MODE="inbox",
    // a bare reply joins the running agent's inbox (#61) instead of force-aborting
    // the turn — pull-only, so NO generation bump, NO abort, NO new turn. Handled
    // before the bump/abort below precisely so it pre-empts neither. The default
    // "abort" mode falls through to the priority-interrupt path unchanged.
    if (
      this.config.SEAM_MIDTURN_REPLY_MODE === "inbox" &&
      this.channelQueues.has(channelId)
    ) {
      await this.routeMidTurnReplyToInbox(msg);
      return;
    }

    // #89 D9: a live (non-park) user message supersedes any parked queue item
    // BEFORE aborting, so a turn-end fire cannot sneak the old prompt in after
    // abort completes. Offline-bridge parks skip this — they REPLACE the row.
    if (msg.raw && !this.wouldParkForOfflineBridge(msg)) {
      this.lastUserMessageAt.set(channelId, Date.now());
      await this.clearParkedForChannel(
        channelId,
        "🚫 Cancelled — a newer message is running instead."
      );
    }

    // Bump the generation so any previously-queued (but not-yet-started) tasks
    // for this channel know they've been superseded and should skip themselves.
    const myGen = (this.channelGenerations.get(channelId) ?? 0) + 1;
    this.channelGenerations.set(channelId, myGen);

    if (this.channelQueues.has(channelId)) {
      const channel = msg.channel;
      const record = this.router.ensureSessionRecord({
        platform: channel.platform,
        channelRef: channel.id,
        ...(channel.parentId ? { parentRef: channel.parentId } : {}),
        cwd: this.config.REPOS_ROOT,
      });
      this.logger.info({ channelId, sessionId: record.id }, "new message arrived while turn active; aborting running turn");
      // User intent: the new message replaces the running turn. Clear the
      // marker at this layer (NOT dispose) so a crash mid-abort does not
      // resume the turn the user just superseded.
      await this.clearTurnMarkersForChannel(channelId, "cancelled");
      // Escalate to a force-kill if the turn ignores the graceful cancel, so a
      // hung turn can't block the new message behind it forever.
      await this.router.abortTurn(record.id, { force: true });
    }

    // #88 D8: park BEFORE getOrStartRuntime when this thread is bound to a
    // remote bridge that is not ready. After aborting any in-flight turn so
    // this message replaces it. Does not hold the Discord turn open.
    if (await this.tryParkForOfflineBridge(msg)) return;

    const existingQueue = this.channelQueues.get(channelId) ?? Promise.resolve();

    const newQueue = existingQueue.then(async () => {
      // A newer message arrived after us — skip this turn entirely.
      if ((this.channelGenerations.get(channelId) ?? 0) > myGen) return;
      this.activeTurns++;
      try {
        await this.handleIncomingMessageInner(msg);
      } catch (err) {
        this.logger.error({ err, channelId }, "error in handleIncomingMessageInner");
      } finally {
        this.activeTurns--;
      }
    });

    this.channelQueues.set(channelId, newQueue);
    this.releaseChannelQueue(channelId, newQueue);

    await newQueue;
  }

  /**
   * Run `task` on a channel's turn queue — the same FIFO `handleIncomingMessage`
   * uses — so a programmatic turn can never run concurrently with a user turn on
   * that thread. This is what makes `injectTurn(session: "live")` safe: it calls
   * `runtime.onEvent()`, which *replaces* the handler an in-flight turn
   * installed, so overlapping the two would silently steal the user's stream.
   *
   * Unlike a user message this never pre-empts what is already running: no
   * `channelGenerations` bump, no `abortTurn`. It just waits its place in line.
   * (The converse still holds — a user message arriving mid-dispatch aborts the
   * dispatch, because the user is the priority interrupt.)
   */
  private queueOnChannel<T>(channelId: string, task: () => Promise<T>): Promise<T> {
    const existing = this.channelQueues.get(channelId) ?? Promise.resolve();
    const result = existing.then(async () => {
      // Count in the restart-drain counter so a redeploy waits for us.
      this.activeTurns++;
      try {
        return await task();
      } finally {
        this.activeTurns--;
      }
    });
    // The link stored in channelQueues must never reject: the next task chains
    // off it, and a rejected link would both skip that task and surface as an
    // unhandled rejection. The real outcome still goes to our caller.
    const link: Promise<void> = result.then(
      () => undefined,
      () => undefined
    );
    this.channelQueues.set(channelId, link);
    this.releaseChannelQueue(channelId, link);
    return result;
  }

  /**
   * Drop `link` from `channelQueues` once it is the last waiter, then try to
   * fire a parked `/seam queue` (or leftover #88) row. #89 D7: turn-end is a
   * fire hook alongside `onBridgeReady`.
   */
  private releaseChannelQueue(channelId: string, link: Promise<void>): void {
    void link.then(() => {
      if (this.channelQueues.get(channelId) === link) {
        this.channelQueues.delete(channelId);
        void this.tryFireParked(channelId);
      }
    });
  }

  private async handleIncomingMessageInner(msg: IncomingMessage): Promise<void> {
    // #80 v1: detach is a handleMessage gate only. Schedules / wakes / watches
    // / handoffs / steer synthesize an IncomingMessage and enter HERE, so they
    // still run in a detached thread. Do not treat detach as a full mute.
    const channel = msg.channel;
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });

    // #76: live-turn marker — written at START, removed at terminal state
    // (this finally, or the command layer). Markers are written even when
    // SEAM_TURN_RESUME_ENABLED is off (inventory + truthful ledger). Dispose
    // / onDead / SIGTERM must NOT clear them.
    const reuseMarker = this.pendingLiveResume.get(channel.id);
    this.pendingLiveResume.delete(channel.id);
    const liveMarkerId = reuseMarker?.id ?? `live-${randomUUID()}`;
    if (!reuseMarker) {
      await writeLiveMarker(this.config.DATA_DIR, {
        id: liveMarkerId,
        kind: "live",
        channelRef: channel.id,
        ...(channel.parentId ? { parentRef: channel.parentId } : {}),
        sessionRecordId: record.id,
        ...(record.acpSessionId ? { acpSessionId: record.acpSessionId } : {}),
        ...(msg.authorId ? { authorId: msg.authorId } : {}),
        startedUtc: new Date().toISOString(),
        location: resolveThreadLocation(this.config, channel.id),
      }).catch((err) =>
        this.logger.warn({ err, channel: channel.id }, "live-turn marker write failed")
      );
    }
    this.liveTurnByChannel.set(channel.id, liveMarkerId);

    // A new turn owns this session's status card now — cancel any lingering
    // "settle back to Monitoring" timer left by the previous turn's background
    // activity so it can't edit the new card.
    const prevSettle = this.bgSettleTimers.get(record.id);
    if (prevSettle) {
      clearTimeout(prevSettle);
      this.bgSettleTimers.delete(record.id);
    }
    // `backgroundLaunched`: the agent started a Monitor / background task this
    // turn, so it should rest at "Monitoring" instead of "Done". `turnFinalized`:
    // the main turn has fully finalized, so any *further* generative activity is
    // an agent-initiated woken turn (not the trailing in-turn backlog the idle()
    // drain handles) and should flip the card back to Working. Display-only.
    const BG_SETTLE_MS = 10_000;
    let backgroundLaunched = false;
    let turnFinalized = false;

    const cfg = this.store.readConfig(record);
    const repoDisplay = this.repoDisplay(record.repoPath);
    const turnProfile = this.router.getProfile(record.agentId);
    const brand = resolveAgentBrand(record.agentId, turnProfile?.brand);
    const brandAsset = loadBrandAsset(brand);
    const described = this.router.describeConfig(record);
    const cardStyle = statusCardStyleForRender(described);
    const gifUrl = pickSimpleCardGifUrl({
      style: cardStyle,
      gifOn: simpleCardGifForRender(described),
      randomGif: () => this.cardGifs?.randomGif() ?? null,
    });
    const status = new TurnStatus({
      model: cfg.model ?? this.config.DEFAULT_MODEL,
      repoDisplay,
      ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
      style: cardStyle,
      ...(brandAsset ? { brandFilename: brandAsset.filename } : {}),
      authorName: turnProfile?.displayName ?? brand,
    });

    // Seed the status panel with the last-known usage from the previous turn,
    // so the user sees continuity before any usage_update events fire. The
    // saved value is invalidated when the model changes (size belongs to a
    // different model). Any staleness is corrected by the post-turn
    // side-channel read.
    const cachedUsage = cfg.lastContextUsage;
    const activeModel = cfg.model ?? this.config.DEFAULT_MODEL;
    // Authoritative per-model window when seam-acp knows it (staticModels
    // contextLimit — e.g. opencode/Ollama, discovered from /api/show). Some
    // agents report a generic default (~200K) in usage_update regardless of the
    // real window; use this as a FLOOR so the panel shows the true size.
    // Look up the authoritative context window from static models.  When
    // claude-agent-acp is pointed at a non-Anthropic backend (Ollama Cloud,
    // Z.ai) it reports its *internal* Claude model name, not the real model.
    // Fallback: if the activeModel doesn't match any static entry, try the
    // profile's defaultModel — that's what the backend is actually running.
    const modelContextFloor =
      turnProfile?.staticModels?.find((m) => m.modelId === activeModel)?.contextLimit
        ?? turnProfile?.staticModels?.find((m) => m.modelId === turnProfile.defaultModel)?.contextLimit
        ?? 0;
    if (
      cachedUsage &&
      cachedUsage.model === activeModel &&
      cachedUsage.size > 0 &&
      cachedUsage.used > 0
    ) {
      status.contextUsedHighWater = cachedUsage.used;
      status.contextWindowSize = cachedUsage.size;
      status.context = formatContextUsage(cachedUsage.used, cachedUsage.size);
    }
    if (modelContextFloor > status.contextWindowSize) {
      status.contextWindowSize = modelContextFloor;
      status.context = formatContextUsage(status.contextUsedHighWater, modelContextFloor);
    }

    const initialPanel = withBrandAttachment(
      renderStatusPanel(this.renderer, status.toInput(), Date.now()),
      brandAsset
    );
    const statusMsg = this.adapter.sendPanel
      ? await this.adapter.sendPanel(channel, initialPanel)
      : await this.adapter.sendMessage(channel, serializePanelText(initialPanel));
    // Standalone GIF: posted once, never edited (embed edits restart the
    // animation). Deleted on Done/Failed/Timed out. Restart mid-turn may orphan.
    let gifMsg: MessageRef | undefined;
    if (gifUrl) {
      gifMsg = await postSimpleCardGifMessage({
        url: gifUrl,
        sendPanel: this.adapter.sendPanel
          ? (panel) => this.adapter.sendPanel!(channel, panel)
          : undefined,
        sendMessage: (text) => this.adapter.sendMessage(channel, text),
      });
    }

    let lastEdit = 0;
    let lastRendered = "";
    let pendingRefresh: NodeJS.Timeout | undefined;
    const refresh = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastEdit < STATUS_EDIT_DEBOUNCE_MS) {
        if (!pendingRefresh) {
          const remaining = STATUS_EDIT_DEBOUNCE_MS - (now - lastEdit);
          pendingRefresh = setTimeout(() => {
            pendingRefresh = undefined;
            void refresh(false);
          }, remaining);
        }
        return;
      }
      if (pendingRefresh) {
        clearTimeout(pendingRefresh);
        pendingRefresh = undefined;
      }
      const panel = renderStatusPanel(this.renderer, status.toInput(), now);
      const fingerprint = JSON.stringify(panel);
      if (fingerprint === lastRendered) return;
      lastRendered = fingerprint;
      lastEdit = now;
      try {
        if (this.adapter.editPanel) {
          await this.adapter.editPanel(statusMsg, panel);
        } else {
          await this.adapter.editMessage(statusMsg, serializePanelText(panel));
        }
      } catch (err) {
        this.logger.warn({ err }, "status edit failed");
      }
    };

    // Heartbeat: tick the elapsed counter periodically. Edits to the same
    // message are heavily rate-limited by Discord (~5/5s per message), and
    // those rate-limit waits also queue behind regular sends — so we keep
    // this conservative.
    const heartbeat = setInterval(() => {
      void refresh();
    }, STATUS_HEARTBEAT_MS);

    // Typing indicator: refresh on real agent activity (text, tool calls,
    // thoughts) rather than a dumb timer. Discord's typing indicator
    // expires after ~10s, so we re-arm it every 8s while the agent is
    // working. Stops once we start posting actual messages — keeping it
    // alive past that point looks wrong.
    const TYPING_INTERVAL_MS = 8_000;
    let lastTypingSentAt = 0;
    let typingDone = false;
    const refreshTyping = (): void => {
      if (typingDone) return;
      const now = Date.now();
      if (now - lastTypingSentAt < TYPING_INTERVAL_MS) return;
      lastTypingSentAt = now;
      if (this.adapter.sendTyping) {
        void this.adapter.sendTyping(channel).catch(() => {});
      }
    };

    let textBuffer = "";
    let textSent = false;
    let spokenProse = "";
    let spokenAfterLastTool = "";
    let sawTool = false;
    let agentAudioSent = false;
    let totalAgentChars = 0;
    // Set true mid-turn (in the usage-update handler) when agy's context
    // usage crosses AGY_AUTO_COMPACT_THRESHOLD; consumed post-turn to run
    // the /compact flow before the next prompt.
    let agyAutoCompactNeeded = false;
    // Streaming fence extractor: pulls every ```lang ... ``` block out
    // of the agent's text and emits ordered segments. Fence-close
    // segments are routed to inline-or-attachment rendering based on
    // size; bare-filename fences resolve to a host-file upload.
    const fenceStream = new FenceStream();
    let fenceCounter = 0;
    // Watchdog: if a fence stays open longer than this with no closer,
    // we emit whatever's accumulated and treat the fence as closed so
    // subsequent bytes flow as prose. Checked on each chunk.
    const FENCE_MAX_OPEN_MS = 60_000;
    let fenceWatchdogTripped = false;
    // Per-turn timing for diagnosing slow turns. Set when we send the
    // prompt; first-chunk + total recorded as info logs.
    let turnStartedAt = 0;
    let firstChunkAt: number | undefined;
    // Streaming policy: only flush mid-turn when we have a *substantial*
    // amount of buffered text AND a clean paragraph boundary exists.
    // Otherwise wait for end-of-turn — Discord rate-limits us hard if we
    // send one tiny message per paragraph (e.g. each verse of "99 bottles"
    // would be its own message).
    const HARD_MAX = 1800;
    const SOFT_MIN = 800;
    const drainBufferInner = async (force: boolean, allowUnsafeCut = false) => {
      while (textBuffer) {
        const split = splitForFlush(textBuffer, {
          maxLen: HARD_MAX,
          softMin: SOFT_MIN,
          force,
          allowUnsafeCut,
        });
        if (!split) return;
        textBuffer = split.keep;
        if (split.send) {
          await this.adapter.sendMessage(channel, split.send);
          spokenProse += split.send;
          spokenAfterLastTool += split.send;
          textSent = true;
          typingDone = true;
        }
        if (!force) return;
      }
    };
    // Serialize every drain. maybeFlush(), the idle timer, fence boundaries,
    // and end-of-turn all trigger drains; without this they could run
    // concurrently, each reassigning `textBuffer` and issuing an independent
    // sendMessage whose delivery order isn't guaranteed — reordering output.
    // Enqueueing is synchronous, so drains (and their sends) run strictly in
    // call order.
    const flushQueue = new SerialQueue();
    const drainBuffer = (force: boolean, allowUnsafeCut = false): Promise<void> =>
      flushQueue.run(() => drainBufferInner(force, allowUnsafeCut));
    const flushChunks = async () => {
      // End-of-turn: must drain everything. An open link will never be
      // closed, so allow unsafe cuts here.
      await drainBuffer(true, true);
    };
    /**
     * Idle-flush timer: if text has been buffered for IDLE_FLUSH_MS
     * with no new chunks arriving, force-flush whatever's there. This
     * keeps UX responsive when the agent emits a slow trickle that
     * never crosses HARD_MAX or hits a clean paragraph boundary
     * (e.g. a short poem).
     */
    const IDLE_FLUSH_MS = 4000;
    // Hard ceiling: even inside an open fence, force-flush if the buffer
    // grows past this. Defends against runaway model loops (e.g. Copilot
    // spamming the language tag) without losing legitimate long fences.
    const FENCE_BUFFER_CEILING = 16000;
    let idleTimer: NodeJS.Timeout | undefined;
    const cancelFlushTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const armIdleFlush = () => {
      cancelFlushTimer();
      if (!textBuffer) return;
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        // Idle for IDLE_FLUSH_MS — any open markdown link is probably
        // never going to close. Allow unsafe cuts so we don't strand
        // the buffer waiting for a `)` that won't come.
        if (textBuffer) void drainBuffer(true, true);
      }, IDLE_FLUSH_MS);
    };
    const maybeFlush = () => {
      if (textBuffer.length >= HARD_MAX) {
        void drainBuffer(true);
        return;
      }
      void drainBuffer(false);
    };

    const RETRY_MARKER = "— 🔁 retried — output above may repeat —";
    const RETRY_REGEX = /response was interrupted.*retrying/i;
    let currentMessageId: string | undefined;
    let postedRetryNotice = false;
    // Runaway-loop detector: some agent models get stuck repeating the
    // same chunk — Copilot spams short language tags (e.g. "markdown"),
    // Gemini sometimes loops a full sentence. Cancel the turn once the
    // exact same trimmed chunk repeats. Threshold is lower for long
    // chunks (a repeated full sentence is much more obviously broken
    // than a repeated short token).
    const LOOP_THRESHOLD_SHORT = 12; // for chunks <= 40 chars
    const LOOP_THRESHOLD_LONG = 4; // for longer chunks
    const LOOP_SHORT_MAX = 40;
    let loopChunk: string | null = null;
    let loopCount = 0;
    let loopAborted = false;
    // Whitespace runaway: when the model gets stuck emitting nothing but
    // newlines/spaces, no trimmed chunk ever lands so the repeat-detector
    // can't fire. Count whitespace-only chunks separately and bail out
    // after enough of them in a row.
    const WHITESPACE_RUN_THRESHOLD = 30;
    let whitespaceRun = 0;
    const noteRetry = async () => {
      if (postedRetryNotice) return;
      postedRetryNotice = true;
      // Flush whatever we already buffered from the failed attempt first.
      await flushChunks();
      try {
        await this.adapter.sendMessage(channel, RETRY_MARKER);
      } catch (err) {
        this.logger.warn({ err }, "retry notice send failed");
      }
    };

    const isSessionGoneError = (e: unknown): boolean => {
      const message = e instanceof Error ? e.message : String(e);
      const details = String((e as any)?.data?.details ?? "");
      return (
        message.toLowerCase().includes("session not found") ||
        details.toLowerCase().includes("session not found")
      );
    };

    // A 400 error from the agent means the current prompt was rejected (e.g.
    // invalid image). The session itself may still be valid, but we invalidate
    // anyway so the next message doesn't replay the same bad content.
    const isAgentRejectionError = (e: unknown): boolean => {
      return (e as any)?.code === 400;
    };

    // The Anthropic vision API caps per-image dimensions at 2000px once a request
    // carries many images (~20+). A run of high-res testing screenshots trips
    // this, and then EVERY follow-up turn that re-sends the history fails the same
    // way. Recognize it so we can auto-strip images (repairSession) and recover.
    const isImageDimensionError = (msg: string): boolean =>
      /dimension limit for many-image|exceeds the dimension limit/i.test(msg);

    // ACP connection dropped mid-turn — typically the remote bridge restarted or
    // the underlying WS dropped after the agent had already finished its response.
    // Different from session-gone: the session files are still intact, so we can
    // invalidate (keeping the session ID) and replay the prompt on reconnect.
    const isConnectionClosedError = (e: unknown): boolean => {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.includes("ACP connection closed");
    };
    // Transient server-side throttle — "Server is temporarily limiting requests
    // (not your usage limit) · Rate limited". NOT a quota/usage error; it clears
    // on its own, so a short backoff-and-retry recovers it invisibly.
    const isRateLimitError = (e: unknown): boolean => {
      const err = e as { data?: { errorKind?: string }; message?: string } | undefined;
      if (err?.data?.errorKind === "rate_limit") return true;
      const msg = e instanceof Error ? e.message : String(e);
      return /temporarily limiting requests|rate limited/i.test(msg);
    };

    try {
      let activeRuntime = await this.router.getOrStartRuntime(record);
      if (record.acpSessionId) {
        await patchLiveMarker(this.config.DATA_DIR, liveMarkerId, {
          acpSessionId: record.acpSessionId,
        }).catch(() => {});
      }
      const eventHandler = async (event: Parameters<Parameters<typeof activeRuntime.onEvent>[0]>[0]) => {
        // Note the agent launching a Monitor so the turn rests at "Monitoring"
        // rather than "Done" even before any woken activity arrives. Anchored to
        // the title start to avoid matching ordinary tools that merely mention
        // "monitor" (e.g. reading monitor.ts); the reactive path below backstops
        // any miss when the first woken activity actually arrives.
        if (event.kind === "tool-start" && /^\s*monitor\b/i.test(event.title ?? "")) {
          backgroundLaunched = true;
        }
        // Woken/background turn: once the main turn has finalized, further
        // generative activity is the agent resuming on its own (a Monitor wake
        // or a background task reporting). Flip the card back to Working and
        // settle to Monitoring on quiescence, so it never sits on a stale "Done"
        // while output is still streaming. Display-only — no session state touched.
        if (
          turnFinalized &&
          (event.kind === "agent-text" ||
            event.kind === "agent-thought" ||
            event.kind === "tool-start")
        ) {
          backgroundLaunched = true;
          if (status.state !== "Working") {
            status.setState("Working");
            status.setAction("Resumed — background activity");
            void refresh();
          }
          const prev = this.bgSettleTimers.get(record.id);
          if (prev) clearTimeout(prev);
          this.bgSettleTimers.set(
            record.id,
            setTimeout(() => {
              this.bgSettleTimers.delete(record.id);
              status.setState("Monitoring");
              status.setAction("🛰️ Background task active — resumes when it reports");
              void refresh(true);
            }, BG_SETTLE_MS)
          );
        }
        switch (event.kind) {
          case "agent-text": {
            refreshTyping();
            // Detect Copilot CLI retry: either the agent emits a "Retrying"
            // sentinel, or the messageId rolls over mid-turn.
            const isRetrySentinel = RETRY_REGEX.test(event.text);
            // A messageId rollover means "a new message started" (ACP schema
            // v1.16.0). For Copilot CLI that's how an in-band retry surfaces —
            // but for other agents (Claude on claude-agent-acp ≥0.54, which now
            // stamps a distinct messageId per message) it's just a normal
            // multi-message turn (e.g. text → tool call → text). Only treat it
            // as a retry for Copilot, else every post-tool continuation posts a
            // spurious "retried" notice.
            const isNewMessage =
              record.agentId.startsWith("copilot") &&
              event.messageId !== undefined &&
              currentMessageId !== undefined &&
              event.messageId !== currentMessageId;
            if (isRetrySentinel || isNewMessage) {
              await noteRetry();
              postedRetryNotice = false; // allow future retries to notify again
            }
            if (event.messageId) currentMessageId = event.messageId;
            // Runaway-loop check (cheap; runs before buffering).
            if (!loopAborted) {
              const trimmed = event.text.trim();
              if (trimmed) {
                whitespaceRun = 0;
                if (trimmed === loopChunk) {
                  loopCount += 1;
                } else {
                  loopChunk = trimmed;
                  loopCount = 1;
                }
              } else {
                // pure-whitespace chunk: track separately so a runaway
                // newline loop still trips the canary.
                whitespaceRun += 1;
              }
              const repeatThreshold =
                loopChunk && loopChunk.length <= LOOP_SHORT_MAX
                  ? LOOP_THRESHOLD_SHORT
                  : LOOP_THRESHOLD_LONG;
              const repeatTripped =
                loopChunk !== null && loopCount >= repeatThreshold;
              const whitespaceTripped =
                whitespaceRun >= WHITESPACE_RUN_THRESHOLD;
              if (repeatTripped || whitespaceTripped) {
                loopAborted = true;
                const reason = whitespaceTripped
                  ? "whitespace"
                  : "repeated chunk";
                this.logger.warn(
                  {
                    session: record.id,
                    reason,
                    chunkLen: loopChunk?.length ?? 0,
                    chunkPreview: loopChunk?.slice(0, 80),
                    repeats: loopCount,
                    whitespaceRun,
                  },
                  "runaway agent output detected; cancelling turn"
                );
                try {
                  await activeRuntime.cancel();
                } catch (err) {
                  this.logger.warn({ err }, "cancel after loop failed");
                }
                try {
                  await flushChunks();
                  const notice = whitespaceTripped
                    ? "⚠️ Agent got stuck emitting blank output — turn cancelled. Try rephrasing."
                    : (() => {
                        const c = loopChunk ?? "";
                        const preview =
                          c.length > 80 ? `${c.slice(0, 77)}...` : c;
                        return `⚠️ Agent got stuck repeating the same output (\`${preview}\`) — turn cancelled. Try rephrasing.`;
                      })();
                  await this.adapter.sendMessage(channel, notice);
                  textSent = true;
                } catch (err) {
                  this.logger.warn({ err }, "loop notice send failed");
                }
                return;
              }
            }
            totalAgentChars += event.text.length;
            // Run text through the fence extractor and process each
            // ordered segment. Prose flows into the chat pipeline;
            // fence-open forces a flush of preceding prose; fence-close
            // routes to inline-or-attachment rendering based on size.
            const fenceResult = fenceStream.feed(event.text);
            for (const seg of fenceResult.segments) {
              if (seg.kind === "prose") {
                if (seg.text) {
                  textBuffer += seg.text;
                  maybeFlush();
                  armIdleFlush();
                }
              } else if (seg.kind === "fence-open") {
                // Commit any pending prose before the fence so message
                // ordering matches the agent's stream order.
                cancelFlushTimer();
                await drainBuffer(true);
              } else {
                // fence-close: emit as inline message or attachment.
                fenceCounter += 1;
                await this.emitClosedFence(channel, seg.fence, fenceCounter, {
                  preferredRoot: record.repoPath,
                });
                textSent = true;
                typingDone = true;
              }
            }
            // Watchdog: if a fence has been open too long, snapshot what
            // we have, emit it with a notice, and treat the fence as
            // closed so subsequent bytes flow as prose.
            if (
              !fenceWatchdogTripped &&
              fenceStream.inFence &&
              fenceStream.openSinceMs() > FENCE_MAX_OPEN_MS
            ) {
              fenceWatchdogTripped = true;
              this.logger.warn(
                { session: record.id },
                "open fence exceeded watchdog timeout; emitting partial content"
              );
              const snap = fenceStream.forceClose();
              if (snap) {
                fenceCounter += 1;
                await this.emitClosedFence(channel, snap, fenceCounter, {
                  preferredRoot: record.repoPath,
                  notice:
                    "_(fence exceeded the watchdog timeout and was closed early)_",
                });
                textSent = true;
                typingDone = true;
              }
            }
            if (firstChunkAt === undefined) {
              firstChunkAt = Date.now();
              this.logger.info(
                {
                  ttftMs: firstChunkAt - turnStartedAt,
                  session: record.id,
                },
                "agent first text chunk"
              );
            }
            return;
          }
          case "tool-start": {
            refreshTyping();
            // Commit any "I'll look that up" narration so it is not mixed into
            // the post-tool summary we later speak.
            await drainBuffer(true);
            sawTool = true;
            spokenAfterLastTool = "";
            const label = event.title ?? event.kindLabel ?? "…";
            status.setAction(`Tool: ${label}`);
            status.pushActivity(label);
            await refresh();
            return;
          }
          case "tool-update":
            refreshTyping();
            if (event.status === "completed" || event.status === "failed") {
              status.setAction("Working…");
            } else if (event.title) {
              status.setAction(`Tool: ${event.title}`);
              status.pushActivity(event.title);
            }
            await refresh();
            return;
          case "model-changed":
            status.setModel(event.modelId);
            await refresh();
            return;
          case "agent-file": {
            // Flush pending text first so the file shows up after the
            // assistant's narration in the thread.
            await flushChunks();
            try {
              await this.sendAgentFile(channel, event);
              textSent = true;
              if ((event.mimeType ?? "").toLowerCase().startsWith("audio/")) agentAudioSent = true;
            } catch (err) {
              this.logger.warn(
                { err, filename: event.filename },
                "sendFile failed; falling back to text notice"
              );
              await this.adapter.sendMessage(
                channel,
                `_Agent produced a file (\`${event.filename}\`) but it couldn't be uploaded._`
              );
            }
            return;
          }
          case "agent-thought":
            refreshTyping();
            status.pushThinkingChunk(event.text);
            void refresh();
            return;
          case "agent-state":
            refreshTyping();
            status.setAction(event.state);
            void refresh();
            return;
          case "usage-update": {
            if (event.size <= 0) return;
            // Ignore mid-turn used:0 events. claude-agent-acp emits them on
            // compact_boundary, but the remote-claude→copilot-api proxy path
            // also surfaces spurious 0s when intermediate response chunks
            // arrive with missing usage fields — making the display flicker.
            // We can't tell the two apart, so hold steady. The end-of-turn
            // side-channel (getUsage / JSONL read) lands the authoritative
            // post-compaction value if a compaction really did happen.
            if (event.used === 0) return;
            const used = Math.max(event.used, status.contextUsedHighWater);
            status.contextUsedHighWater = used;
            // Monotonic ceiling on the window too. claude-agent-acp starts each
            // session at its 200K default and the authoritative window (e.g. 1M)
            // arrives a beat later — without this, the card blips 200K→1M on the
            // first event. The window only ever grows within a turn (default →
            // authoritative); it never legitimately shrinks (compaction changes
            // `used`, not `size`; model switches clear the cache between turns).
            // `modelContextFloor` overrides an agent's generic default (e.g.
            // opencode reporting 200K for a 256K gemma model).
            const size = Math.max(event.size, modelContextFloor, status.contextWindowSize);
            status.contextWindowSize = size;
            status.context = formatContextUsage(used, size);
            // agy has no built-in auto-compaction. Mark the turn for an
            // end-of-turn /compact when usage crosses the configured threshold.
            if (
              this.config.AGY_AUTO_COMPACT_THRESHOLD > 0 &&
              record.agentId.startsWith("agy") &&
              used / size >= this.config.AGY_AUTO_COMPACT_THRESHOLD
            ) {
              agyAutoCompactNeeded = true;
            }
            void refresh();
            return;
          }
          case "config-options":
          case "error":
            return;
        }
      };
      activeRuntime.onEvent(eventHandler);

      status.setAction("Thinking…");
      await refresh(true);
      refreshTyping();

      turnStartedAt = Date.now();
      const timeoutMs = this.config.TURN_TIMEOUT_SECONDS * 1000;

      // If the active profile is on a Discord-restricted host (e.g. remote
      // Mac with strict network policy), don't expose Discord CDN URLs to
      // the LLM. Instead, download the bytes server-side and stream them to
      // the agent's filesystem via the bridge's `writeAttachment` cmd. The
      // model gets a local path in the prompt; attachments are stripped.
      // Prepend the standing agent conventions (attach-fence, table rendering)
      // as a provenance-tagged preamble so every backend knows the operating
      // rules without depending on a per-backend system-prompt path. Channel
      // and thread riders from CHANNEL_PRESETS_FILE stack on top (additive,
      // never replacing the base conventions above).
      const { riders } = resolveChannelPreset(
        this.config,
        record.parentRef ?? undefined,
        record.channelRef
      );
      // Speaker identity (#57): stamp the human's name/id into the preamble when
      // the flag is on and we have an author id. Gated here (single decision
      // point) rather than in the adapter. Dispatch gets a harness with
      // seamFences off (#108) and still emits no speaker line (D7).
      const speaker =
        this.config.SPEAKER_IDENTITY_ENABLED && msg.authorId
          ? { id: msg.authorId, name: msg.authorName ?? "" }
          : undefined;
      // #71: expose the CURRENT turn's trusted speaker id to the config_propose
      // lock gate for the duration of this turn (cleared in the finally below).
      // Only set when we have a harness-stamped id — with speaker identity off
      // the gate sees nothing and keeps refusing (never fail open).
      if (speaker) this.currentSpeakerIds.set(record.channelRef, speaker.id);
      if (msg.authorId) this.currentAuthorIds.set(record.channelRef, msg.authorId);
      const secretFiles = await listThreadSecrets(this.config.DATA_DIR, channel.id).catch(() => []);
      const extraRules = [...riders, ...secretHarnessRules(secretFiles)];
      const seamMcp = sessionHasSeamMcp(this.router.reuseMcpServers?.(record.id));
      const seamFences = true; // live user-turn loop runs emitClosedFence
      const canAuthorChoice =
        Boolean(msg.authorId) &&
        !isRestrictedParticipant(
          msg.authorId,
          this.config.SEAM_PARTICIPANT_USER_IDS,
          this.config.SEAM_CONFIG_ADMIN_USER_IDS
        );
      extraRules.push(
        ...choiceAuthoringRules({ fence: seamFences && canAuthorChoice, mcp: seamMcp && canAuthorChoice })
      );
      let promptText = withHarnessPreamble(msg.text, extraRules, speaker, {
        inboxAwareness: this.config.SEAM_INBOX_PREAMBLE_ENABLED,
        seamMcp,
        seamFences,
      });
      let promptAttachments = msg.attachments;
      const activeProfile = this.router.getProfile(record.agentId);
      if (
        activeProfile?.restrictDiscordAccess &&
        msg.attachments &&
        msg.attachments.length > 0 &&
        typeof activeProfile.sessionManager?.writeAttachment === "function"
      ) {
        const writer = activeProfile.sessionManager.writeAttachment.bind(
          activeProfile.sessionManager
        );
        const cwd = record.repoPath ?? process.cwd();
        const pathLines: string[] = [];
        for (const a of msg.attachments) {
          if (isVoiceNoteAttachment(a)) continue;
          try {
            const res = await fetch(a.url);
            if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
            const buf = Buffer.from(await res.arrayBuffer());
            const { path: written } = await writer(
              cwd,
              a.filename,
              buf.toString("base64")
            );
            pathLines.push(`- \`${a.filename}\` → \`${written}\``);
          } catch (err) {
            this.logger.warn(
              { err, filename: a.filename },
              "failed to write attachment to restricted agent; falling back to skipping"
            );
            pathLines.push(`- \`${a.filename}\` — could not be transferred to the agent host`);
          }
        }
        if (pathLines.length > 0) {
          const hint =
            `\n\n_The following file${pathLines.length === 1 ? " was" : "s were"} ` +
            `uploaded and saved to the agent's filesystem:_\n${pathLines.join("\n")}`;
          promptText = promptText ? `${promptText}${hint}` : hint.trimStart();
        }
        promptAttachments = undefined; // already on disk; no ACP attachment blocks
      } else if (
        !activeProfile?.restrictDiscordAccess &&
        msg.attachments &&
        msg.attachments.length > 0
      ) {
        // Local agent: text + standard images go inline; everything else
        // (PDF/Office/HEIC/binary) is staged to a temp path the agent opens with
        // its file tools. Shared with the scheduled fire runner. Images are only
        // inlineable when the agent advertises image prompt capability — for a
        // no-vision ACP bridge (e.g. Grok) they're staged to disk instead so its
        // own tools can read them, rather than becoming a bytes-less link.
        const agentHasVision = activeRuntime.getPromptCapabilities()?.image;
        const { inline, hint } = await this.partitionAndStageAttachments(
          msg.attachments,
          agentHasVision
        );
        if (hint) promptText = promptText ? `${promptText}${hint}` : hint.trimStart();
        promptAttachments = inline.length > 0 ? withoutVoiceNotes(inline) : undefined;
        if (promptAttachments && promptAttachments.length === 0) promptAttachments = undefined;
      }

      if (promptAttachments && promptAttachments.length > 0) {
        promptAttachments = withoutVoiceNotes(promptAttachments);
        if (promptAttachments.length === 0) promptAttachments = undefined;
      }

      if (msg.attachments && msg.attachments.length > 0) {
        const speakerLabel =
          (msg.authorName && msg.authorName.trim()) || speaker?.name || "user";
        try {
          const voiced = await applyVoiceNoteTranscriptions({
            prompt: promptText,
            attachments: msg.attachments,
            apiKey: this.config.SEAM_GEMINI_API_KEY,
            model: this.config.SEAM_GEMINI_STT_MODEL,
            speakerLabel,
          });
          promptText = voiced.prompt;
          const heard = formatHeardMessage(voiced.notes);
          if (heard) {
            await this.adapter.sendMessage(channel, heard).catch((err) => {
              this.logger.warn({ err }, "failed to post voice-note Heard: line");
            });
          }
        } catch (err) {
          this.logger.warn({ err }, "voice-note STT threw; continuing with fail-visible note");
          const fail =
            `_Voice note from ${speakerLabel} (transcription failed: unexpected error)._`;
          promptText = promptText ? `${promptText}\n\n${fail}` : fail;
          await this.adapter.sendMessage(channel, `_Couldn't transcribe voice note:_ unexpected error`).catch(
            () => {}
          );
        }
      }

      // One transparent retry on transient failures. Both cases fire before any
      // output is buffered so the retry is invisible to the user.
      //   session-gone: session files are lost; start a fresh session.
      //   connection-closed: bridge/agent restarted mid-turn but session files
      //     are intact; keep the session ID so loadSession() resumes context.
      //     getOrStartRuntime will wait up to 44s for the bridge to reconnect.
      let result: PromptOutcome | "timeout";
      try {
        result = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
      } catch (promptErr) {
        if (isSessionGoneError(promptErr)) {
          this.logger.warn({ session: record.id }, "session-gone on prompt; invalidating and retrying with new session");
          await this.router.invalidate(record.id, { clearAcpSession: true });
          activeRuntime = await this.router.getOrStartRuntime(record);
          activeRuntime.onEvent(eventHandler);
          result = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
        } else if (isConnectionClosedError(promptErr)) {
          this.logger.warn({ session: record.id }, "connection closed mid-turn; waiting for reconnect and retrying");
          await this.router.invalidate(record.id, { clearAcpSession: false });
          activeRuntime = await this.router.getOrStartRuntime(record);
          activeRuntime.onEvent(eventHandler);
          result = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
        } else if (isRateLimitError(promptErr) && !textSent && !textBuffer) {
          // Transient server-side throttle with nothing emitted yet: the session
          // is intact, so back off and retry the SAME prompt on the SAME runtime
          // (no invalidate). Guarded on no-output-yet so a mid-stream limit can't
          // double-emit — if output already started we fall through and surface
          // it. Schedule clears typical brief throttles invisibly.
          let rlResult: PromptOutcome | "timeout" | undefined;
          for (const backoffMs of [2_000, 5_000, 10_000]) {
            this.logger.warn({ session: record.id, backoffMs }, "rate limited before output; backing off and retrying");
            await new Promise((r) => setTimeout(r, backoffMs));
            try {
              rlResult = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
              break;
            } catch (rlErr) {
              if (!isRateLimitError(rlErr)) throw rlErr; // a different failure — surface it
            }
          }
          if (rlResult === undefined) throw promptErr; // still throttled after backoff
          result = rlResult;
        } else {
          throw promptErr;
        }
      }

      // Drain the session-update queue so every update received before the
      // prompt response is processed into the chat pipeline BEFORE we flush and
      // finalize. Without this, updates still backlogged in the SerialQueue post
      // and refresh the status card AFTER it already shows "Done" — the display
      // trails the (already-finished) turn. Skip on timeout (the agent may be
      // hung and idle() could then block), and race a short guard so a stuck
      // update handler can't lock the turn open.
      if (result !== "timeout") {
        await Promise.race([
          activeRuntime.idle(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
      }

      cancelFlushTimer();
      // Drain the fence extractor: any final segments enter the chat
      // pipeline; an unclosed fence is emitted with a notice rather
      // than dropped.
      const tail = fenceStream.flush();
      for (const seg of tail.segments) {
        if (seg.kind === "prose") {
          if (seg.text) textBuffer += seg.text;
        } else if (seg.kind === "fence-open") {
          // Shouldn't appear in flush output, but handle defensively.
          await drainBuffer(true, true);
        } else {
          fenceCounter += 1;
          await this.emitClosedFence(channel, seg.fence, fenceCounter, {
            preferredRoot: record.repoPath,
          });
          textSent = true;
        }
      }
      if (tail.unclosed && !fenceWatchdogTripped) {
        this.logger.warn(
          {
            session: record.id,
            lang: tail.unclosed.lang,
            chars: tail.unclosed.content.length,
          },
          "agent ended turn with an unclosed code fence; emitting partial"
        );
        // Drain any prose preceding the unclosed fence first.
        await drainBuffer(true, true);
        fenceCounter += 1;
        await this.emitClosedFence(channel, tail.unclosed, fenceCounter, {
          preferredRoot: record.repoPath,
          notice: "_(fence was not closed by the agent)_",
        });
        textSent = true;
      }
      await flushChunks();

      const turnOk =
        result !== "timeout" && !(result as { cancelled?: boolean }).cancelled;
      if (turnOk) {
        await this.maybeSpeakTurn({
          channel,
          threadId: channel.id,
          prose: selectSpokenProse({
            all: spokenProse,
            afterLastTool: spokenAfterLastTool,
            sawTool,
          }),
          alreadyHadAudio: agentAudioSent,
        });
      }

      this.logger.info(
        {
          session: record.id,
          totalMs: Date.now() - turnStartedAt,
          ttftMs:
            firstChunkAt !== undefined ? firstChunkAt - turnStartedAt : null,
          chars: totalAgentChars,
          fenceFiles: fenceCounter,
        },
        "turn timing"
      );

      if (
        result !== "timeout" &&
        result.rejectedAttachments &&
        result.rejectedAttachments.length > 0
      ) {
        const lines = result.rejectedAttachments
          .map((r) => `• \`${r.filename}\` — ${r.reason}`)
          .join("\n");
        await this.adapter.sendMessage(
          channel,
          `_Some attachments were not sent to the agent:_\n${lines}`
        );
      }

      if (!textSent && result !== "timeout" && !(result as { cancelled?: boolean }).cancelled) {
        // Turn completed but the agent produced no visible text (e.g. tools ran
        // but emitted no assistant message). Make it visible so the user isn't
        // left wondering if their message was received.
        await this.adapter.sendMessage(channel, "_Agent completed with no text response._");
      }

      if (result === "timeout") {
        // Guard against cancel() hanging when the agent connection is broken
        // (e.g. remote bridge restarted while a turn was in progress). Without
        // a timeout here, cancel() can await a response that never arrives and
        // the channel queue stays locked indefinitely.
        await Promise.race([
          activeRuntime.cancel(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
        await this.router.invalidate(record.id, { clearAcpSession: false });
        status.setState("Timed out");
        status.setAction(`Exceeded ${this.config.TURN_TIMEOUT_SECONDS}s`);
      } else if (result.cancelled) {
        status.setState("Failed");
        status.setAction("Cancelled");
      } else if (backgroundLaunched) {
        // The agent launched a Monitor / background task and yielded the turn —
        // it isn't finished, it's watching and may resume. Rest at Monitoring;
        // a woken turn flips it back to Working (see the event handler).
        status.setState("Monitoring");
        status.setAction("🛰️ Background task active — resumes when it reports");
      } else {
        status.setState("Done");
        status.setAction(result.stopReason);
      }

      // Surface context-window usage after the turn. Two paths:
      //   1. Profiles with a side-channel `getUsage` (e.g. remote bridge that
      //      reads Claude Code's JSONL transcript) — preferred, no extra prompt.
      //   2. Copilot CLI fallback — probe its `/context` slash command, which
      //      the CLI handles client-side (no LLM call).
      if (result !== "timeout" && !result.cancelled) {
        const profile = this.router.getProfile(record.agentId);
        const usageReader = profile?.sessionManager?.getUsage;
        let sideChannelEmitted = false;
        if (usageReader) {
          try {
            const cwd = record.repoPath ?? process.cwd();
            const usage = await usageReader.call(
              profile.sessionManager,
              cwd,
              record.acpSessionId || undefined,
              turnStartedAt || undefined
            );
            // Trust seam-acp's per-profile model→limit table over whatever the
            // bridge inferred from the JSONL — on proxied setups the JSONL
            // model id can be remapped/wrong.
            const selectedModel = cfg.model ?? profile?.defaultModel;
            const modelEntry = profile?.staticModels?.find(
              (m) => m.modelId === selectedModel
            ) ?? profile?.staticModels?.find(
              (m) => m.modelId === profile.defaultModel
            );
            const computedSize = modelEntry?.contextLimit ?? usage?.contextLimit ?? 0;
            // `used` may legitimately drop (post-compaction), so we bypass its
            // ceiling. But the window must never shrink: getUsage can return a
            // stale 200K default when the JSONL model id (which has [1m]
            // stripped, e.g. "claude-opus-4-8") doesn't reveal the real window.
            // Trust the larger of the computed value and what the live stream /
            // cache already established for this turn.
            const size = Math.max(status.contextWindowSize, computedSize);
            if (usage && usage.totalUsed > 0 && size > 0) {
              status.contextUsedHighWater = usage.totalUsed;
              status.contextWindowSize = size;
              status.context = formatContextUsage(usage.totalUsed, size);
              // Record the resolved model id (e.g. "claude-opus-4-8[1m]") so
              // the status card can display the actual model alongside the alias.
              if (usage.model) {
                status.resolvedModel = usage.model;
              }
              void refresh();
              sideChannelEmitted = true;
            }
          } catch (err) {
            this.logger.debug({ err }, "getUsage side-channel unavailable");
          }
        }
        if (!sideChannelEmitted && record.agentId.startsWith("copilot")) {
          await this.probeCopilotContext(activeRuntime, eventHandler, refresh);
        }

        // Persist final usage to the session record so the next turn can
        // seed its status panel without waiting for the first usage_update.
        if (status.contextUsedHighWater > 0 && status.contextWindowSize > 0) {
          try {
            const persistedCfg = this.store.readConfig(record);
            persistedCfg.lastContextUsage = {
              used: status.contextUsedHighWater,
              size: status.contextWindowSize,
              model: cfg.model ?? this.config.DEFAULT_MODEL,
              atUtc: new Date().toISOString(),
            };
            this.persistConfig(record, persistedCfg);
          } catch (err) {
            this.logger.debug({ err }, "failed to persist lastContextUsage");
          }
        }
      }

      // agy has no native auto-compaction. If usage crossed the threshold
      // mid-turn, run the same /compact flow now before the next prompt.
      if (agyAutoCompactNeeded && result !== "timeout" && !result.cancelled) {
        try {
          await this.runAgyAutoCompact(record, channel, status, refresh, status.contextUsedHighWater);
        } catch (err) {
          this.logger.warn({ err, session: record.id }, "agy auto-compact failed");
        }
      }
    } catch (err) {
      this.logger.error({ err, session: record.id }, "turn failed");
      cancelFlushTimer();
      await flushChunks();
      // If the agent reports that the session is gone (e.g. bridge restarted
      // with a fresh agent process), evict the dead runtime so the next message
      // triggers a clean newSession rather than repeatedly failing.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isSessionGoneError(err)) {
        this.logger.warn({ session: record.id }, "session not found on agent; invalidating runtime");
        await this.router.invalidate(record.id, { clearAcpSession: true });
      } else if (isAgentRejectionError(err) || errMsg.includes("Prompt is too long") || isImageDimensionError(errMsg)) {
        const isPromptTooLong = errMsg.includes("Prompt is too long");
        const isImageDimension = isImageDimensionError(errMsg);
        // Both "prompt too long" and the many-image dimension cap are fixed by
        // stripping images from the on-disk history; keep the ACP session ID so
        // the repaired (image-stripped) JSONL is re-resumed on retry.
        const needsRepair = isPromptTooLong || isImageDimension;
        this.logger.warn(
          { session: record.id, isPromptTooLong, isImageDimension },
          "agent rejected prompt; invalidating session runtime"
        );
        await this.router.invalidate(record.id, { clearAcpSession: !needsRepair });

        if (needsRepair) {
          const profile = this.router.getProfile(record.agentId);
          const manager = profile?.sessionManager;
          const cwd = record.repoPath ?? this.config.REPOS_ROOT;
          let repaired = false;

          if (manager && typeof manager.repairSession === "function" && record.acpSessionId) {
            try {
              this.logger.info(
                { session: record.id, acpSessionId: record.acpSessionId, reason: isImageDimension ? "image-dimension" : "context-size" },
                "auto-repairing session"
              );
              await manager.repairSession(cwd, record.acpSessionId);
              repaired = true;
            } catch (repairErr) {
              this.logger.error({ err: repairErr, session: record.id }, "failed to auto-repair session");
            }
          }

          if (repaired && isImageDimension) {
            await this.adapter.sendMessage(
              channel,
              "⚠️ **An image in the conversation exceeded the 2000px many-image limit.** The session was automatically repaired by stripping image payloads from the history (testing screenshots are the usual cause). You can safely retry your message now!"
            );
          } else if (repaired) {
            await this.adapter.sendMessage(
              channel,
              "⚠️ **Claude hit its context limit before auto-compacting.** The session was automatically repaired by stripping heavy base64 image payloads and rolling back the last incomplete message. You can safely retry your message now!"
            );
          } else {
            await this.adapter.sendMessage(
              channel,
              "⚠️ **Claude hit its context limit before auto-compacting.** The context grew too large in a single turn. Try running `/compact` to free up space!"
            );
          }
        }
      }
      status.setState("Failed");
      status.setAction(this.renderer.trimShort(isSessionGoneError(err) ? "Session lost — please resend your message." : errMsg, 120));
    } finally {
      // The main turn is fully finalized: any further generative activity on
      // this runtime is an agent-initiated woken turn (handled in eventHandler),
      // not the in-turn backlog already drained above.
      turnFinalized = true;
      clearInterval(heartbeat);
      if (pendingRefresh) {
        clearTimeout(pendingRefresh);
        pendingRefresh = undefined;
      }
      // #71: drop the current-turn speaker id so it can never authorize a
      // config_propose on a later dispatched/scheduled turn (no human speaker).
      this.currentSpeakerIds.delete(record.channelRef);
      this.currentAuthorIds.delete(record.channelRef);
      await consumeThreadSecrets(this.config.DATA_DIR, channel.id).catch((err) =>
        this.logger.warn({ err, channel: channel.id }, "secret consume failed")
      );
      await refresh(true);
      if (isSimpleCardGifTerminal(status.state)) {
        await deleteSimpleCardGifMessage({
          ref: gifMsg,
          deleteMessage: this.adapter.deleteMessage
            ? (ref) => this.adapter.deleteMessage!(ref)
            : undefined,
        });
        gifMsg = undefined;
      }
      // #76: write the terminal state BEFORE removing the marker (writeDone
      // ordering). Skip if the command layer already finalized it as cancelled.
      if (this.liveTurnByChannel.get(channel.id) === liveMarkerId) {
        this.liveTurnByChannel.delete(channel.id);
      }
      await finishLiveTurn(this.config.DATA_DIR, {
        id: liveMarkerId,
        status: "completed",
        channelRef: channel.id,
        finishedUtc: new Date().toISOString(),
      }).catch((err) =>
        this.logger.warn({ err, id: liveMarkerId }, "live-turn marker finish failed")
      );
    }
  }

  /**
   * The harness-stamped speaker id (#57 D4 trust anchor) of the human turn
   * CURRENTLY processing on `channelRef`, or undefined when there is none
   * (speaker identity off, or a dispatched/scheduled turn with no human author).
   * Read by the seam-MCP config_propose lock gate (#71) — it is an id, never a
   * user-editable display name, and must be the ONLY speaker signal that gate
   * trusts.
   */
  currentSpeaker(channelRef: string): string | undefined {
    return this.currentSpeakerIds.get(channelRef);
  }

  // --- slash commands ---

  /** Subcommands still allowed in a locked channel/thread — narrow enough
   *  that a kid can unstick a hung turn without being able to touch config.
   *  Answers "survives a channel lock". NOT the participant allowlist
   *  (`PARTICIPANT_ALLOWED_SUBCOMMANDS` below): this set includes `steer`.
   *  `cancel` here is the PLAIN cancel (this thread). `cancel scope:all`
   *  is excluded by `isCancelScopeAll` — it is the old privileged `kill`. */
  private static readonly LOCK_EXEMPT_SUBCOMMANDS = new Set(["cancel", "steer", "queue"]);

  /**
   * Subcommands a restricted participant (#74) may still run. A NEW, SEPARATE
   * constant from `LOCK_EXEMPT_SUBCOMMANDS` — that one includes `steer`
   * (redirects another agent) and answers a different question (survives a
   * channel lock). Participants get cancel (self-unstick their own wedged
   * turn, including `force:true`) and help, plus `/seam queue` (their own next
   * prompt, #89 D10), but NOT steer, NOT `cancel scope:all` (old kill), and
   * no config.
   */
  private static readonly PARTICIPANT_ALLOWED_SUBCOMMANDS = new Set(["help", "cancel", "queue"]);

  /**
   * Options the slash gates inspect. Only `scope` changes privilege today:
   * `cancel scope:all` is the old `/seam kill` (bot-wide) and must NOT
   * inherit cancel's lock-exempt / participant-allowed status.
   */
  static slashGateOptions(interaction: ChatInputCommandInteraction): SlashGateOptions {
    return { scope: interaction.options.getString("scope") };
  }

  /**
   * Option-aware predicate: `cancel scope:all` is its own privileged
   * action (old `/seam kill`). Plain `cancel` (default scope, any force)
   * is NOT privileged — a student may unstick their own turn.
   */
  static isCancelScopeAll(sub: string, options?: SlashGateOptions): boolean {
    return sub === "cancel" && options?.scope === "all";
  }

  /**
   * Whether a `/seam` subcommand must be refused because the channel is locked
   * (#58 D2). #71 admin-immunity applies HERE too, not only at the agent-facing
   * `config_propose` tool: a config admin may change config in a locked channel
   * WITHOUT unlocking it — otherwise routine operator work still forces the
   * unlock/relock cycle #71 exists to remove. The invoker id is Discord-
   * authenticated (`interaction.user.id`), so this is trustworthy regardless of
   * SPEAKER_IDENTITY_ENABLED. `locked` itself stays unsettable through any
   * `/seam` command, so admin immunity grants no power to flip the lock.
   *
   * Lives ALONGSIDE `isParticipantSlashRefused` — a different question. A
   * participant is refused even in an UNLOCKED channel; a lock refusal is
   * about the channel, not the invoker's tier.
   *
   * Gates inspect RESOLVED OPTIONS, not just the bare subcommand name (#78):
   * `cancel scope:all` is refused here even though `cancel` is lock-exempt.
   */
  static isLockedSlashRefused(
    config: Config,
    scopeChannelId: string | undefined,
    sub: string,
    invokerUserId: string,
    options?: SlashGateOptions
  ): boolean {
    if (!isChannelLocked(config, scopeChannelId)) return false;
    if (
      Orchestrator.LOCK_EXEMPT_SUBCOMMANDS.has(sub) &&
      !Orchestrator.isCancelScopeAll(sub, options)
    ) {
      return false;
    }
    if (config.SEAM_CONFIG_ADMIN_USER_IDS?.has(invokerUserId)) return false;
    return true;
  }

  /**
   * Channel-preset writes from the visual editor. More privileged than a
   * thread overlay: restricted participants never; when
   * `SEAM_CONFIG_ADMIN_USER_IDS` is set, only those admins; a locked channel
   * refuses everyone except a listed config admin (same as slash).
   */
  static canEditChannelPreset(
    config: Pick<
      Config,
      "channelPresets" | "SEAM_CONFIG_ADMIN_USER_IDS" | "SEAM_PARTICIPANT_USER_IDS"
    >,
    userId: string,
    channelId: string | undefined
  ): boolean {
    if (!channelId) return false;
    if (
      isRestrictedParticipant(
        userId,
        config.SEAM_PARTICIPANT_USER_IDS,
        config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return false;
    }
    const admins = config.SEAM_CONFIG_ADMIN_USER_IDS;
    if (admins && admins.size > 0 && !admins.has(userId)) return false;
    if (isChannelLocked(config, channelId) && !admins?.has(userId)) return false;
    return true;
  }

  /**
   * Whether a `/seam` subcommand must be refused because the invoker is a
   * restricted participant (#74). Independent of lock state — this fires in
   * LOCKED AND UNLOCKED channels. Keyed on the Discord-authenticated
   * invoker id (`interaction.user.id`), never a display name. Admin-who-is-
   * also-participant is NOT restricted (`isRestrictedParticipant`).
   *
   * Gates inspect RESOLVED OPTIONS, not just the bare subcommand name (#78):
   * `cancel scope:all` is refused here even though `cancel` is allowed.
   */
  static isParticipantSlashRefused(
    config: Pick<Config, "SEAM_PARTICIPANT_USER_IDS" | "SEAM_CONFIG_ADMIN_USER_IDS">,
    sub: string,
    invokerUserId: string,
    options?: SlashGateOptions
  ): boolean {
    if (
      !isRestrictedParticipant(
        invokerUserId,
        config.SEAM_PARTICIPANT_USER_IDS,
        config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return false;
    }
    if (
      Orchestrator.PARTICIPANT_ALLOWED_SUBCOMMANDS.has(sub) &&
      !Orchestrator.isCancelScopeAll(sub, options)
    ) {
      return false;
    }
    return true;
  }

  /**
   * `/seam config init` must refuse while the thread is detached (#80 D8).
   * Do not silently clear the flag or bind. Extracted so tests can assert
   * the gate without standing up the slash handler.
   */
  static isInitRefusedWhileDetached(
    config: Pick<Config, "threadPresets">,
    threadId: string | undefined
  ): boolean {
    return isThreadDetached(config, threadId);
  }

  async handleSlashInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const sub = interaction.options.getSubcommand(true);
    const slashOpts = Orchestrator.slashGateOptions(interaction);
    // Resolve the *locked-channel* scope id. Only a real thread's parentId
    // points at the channel we key presets on — a plain (non-thread)
    // channel's `parentId` is its Discord *category*, which is never in
    // channelPresets, so that must NOT be used as a fallback here (that
    // previously let /seam new bypass the lock when the channel sat inside
    // a category). For a command run directly in a channel (e.g. /seam
    // new), the scope is the channel itself.
    const ic = interaction.channel;
    const scopeChannelId = ic?.isThread() ? (ic.parentId ?? undefined) : interaction.channelId ?? undefined;
    // Two independent gates, two different questions:
    //   - participant (#74): "is this invoker allowed to configure at all?"
    //     A restricted participant is refused even in an UNLOCKED channel.
    //   - lock (#58 / #71): "is this channel locked for this invoker?"
    // Participant first so config commands get the friendly refusal (not the
    // lock copy) regardless of lock state. help/cancel pass this gate
    // and then face the lock gate on their own terms. `cancel scope:all`
    // is refused by BOTH gates (it is the old privileged `kill`).
    if (Orchestrator.isParticipantSlashRefused(this.config, sub, interaction.user.id, slashOpts)) {
      await interaction.reply({
        content: PARTICIPANT_CONFIG_REFUSAL,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (Orchestrator.isLockedSlashRefused(this.config, scopeChannelId, sub, interaction.user.id, slashOpts)) {
      await interaction.reply({
        content: "🔒 This channel is locked — its configuration can't be changed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.options.getSubcommandGroup(false) === "upload") {
      const admins = this.config.SEAM_CONFIG_ADMIN_USER_IDS;
      if (!admins?.has(interaction.user.id)) {
        await interaction.reply({
          content: "🔒 `/seam upload` is admin-only.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    const slashGroup = interaction.options.getSubcommandGroup(false);
    if (slashGroup === "bridge" || slashGroup === "debug") {
      if (isBridgeAdminRefused(this.config, interaction.user.id)) {
        this.logger.warn(
          { speakerId: interaction.user.id, group: slashGroup, sub },
          "bridge/debug refused"
        );
        await interaction.reply({
          content: BRIDGE_ADMIN_REFUSAL,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    if (interaction.options.getSubcommandGroup(false) === "schedule") {
      return this.cmdSchedule(interaction);
    }
    if (interaction.options.getSubcommandGroup(false) === "preset") {
      return this.cmdPreset(interaction);
    }
    if (interaction.options.getSubcommandGroup(false) === "project") {
      return this.cmdProject(interaction);
    }
    if (interaction.options.getSubcommandGroup(false) === "upload") {
      switch (interaction.options.getSubcommand(true)) {
        case "pull":
          return this.cmdUploadPull(interaction);
        case "push":
          return this.cmdUploadPush(interaction);
        case "secret":
          return this.cmdUploadSecret(interaction);
      }
    }
    if (interaction.options.getSubcommandGroup(false) === "bridge") {
      return handleBridgeSlash(interaction, {
        config: this.config,
        mutation: this.configMutation,
        hub: this.bridgeHub,
        logger: this.logger,
        publicWsUrl:
          this.bridgeHub?.publicWsUrl() ?? `ws://127.0.0.1:${this.config.HEALTH_PORT}/bridge`,
      });
    }
    if (interaction.options.getSubcommandGroup(false) === "debug") {
      return handleDebugSlash(interaction, {
        mutation: this.configMutation,
        hub: this.bridgeHub,
        logger: this.logger,
        playSpikeOgg: async () => {
          const a = this.adapter as DiscordAdapter;
          if (typeof a.playSpikeOgg !== "function") {
            return "Voice spike is not available on this adapter.";
          }
          return a.playSpikeOgg();
        },
        playSpikeCapture: async (userId, hooks) => {
          const a = this.adapter as DiscordAdapter;
          if (typeof a.playSpikeCapture !== "function") {
            return { text: "Voice capture is not available on this adapter." };
          }
          return a.playSpikeCapture(userId, hooks);
        },
        playSpikeLiveRoundTrip: async (userId, hooks) => {
          const a = this.adapter as DiscordAdapter;
          if (typeof a.playSpikeLiveRoundTrip !== "function") {
            return { text: "Voice live round-trip is not available on this adapter." };
          }
          return a.playSpikeLiveRoundTrip(userId, hooks);
        },
      });
    }
    if (interaction.options.getSubcommandGroup(false) === "info") {
      switch (interaction.options.getSubcommand(true)) {
        case "whoami":
          return this.cmdWhoami(interaction);
        case "usage":
          return this.cmdUsage(interaction);
        case "avatar":
          return this.cmdAvatar(interaction);
        case "help":
          return this.cmdHelp(interaction);
        case "sessions":
          return this.cmdSessions(interaction);
        case "repos":
          return this.cmdRepos(interaction);
      }
    }
    if (interaction.options.getSubcommandGroup(false) === "config") {
      switch (interaction.options.getSubcommand(true)) {
        case "model":
          return this.cmdModel(interaction);
        case "effort":
          return this.cmdEffort(interaction);
        case "agent":
          return this.cmdAgent(interaction);
        case "mode":
          return this.cmdMode(interaction);
        case "repo":
          return this.cmdRepo(interaction);
        case "tools":
          return this.cmdTools(interaction);
        case "approve":
          return this.cmdApprove(interaction);
        case "card":
          return this.cmdStatusCard(interaction);
        case "gif":
          return this.cmdSimpleCardGif(interaction);
        case "reset":
          return this.cmdReset(interaction);
        case "init":
          return this.cmdInit(interaction);
        case "detach":
          return this.cmdDetach(interaction);
        case "tts":
          return this.cmdTts(interaction);
        case "show":
          return this.cmdConfig(interaction);
        case "edit":
          return this.cmdConfigEdit(interaction);
        case "set":
          return this.cmdConfigSet(interaction);
        case "audit":
          return this.cmdConfigAudit(interaction);
      }
    }
    switch (sub) {
      case "new":
        return this.cmdNew(interaction);
      case "cancel":
        return this.cmdCancel(interaction);
      case "steer":
        return this.cmdSteer(interaction);
      case "queue":
        return this.cmdQueue(interaction);
      case "workflows":
        return this.cmdWorkflows(interaction);
      default:
        await interaction.reply({
          content: `Unknown subcommand: ${sub}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  private async probeCopilotContext(
    runtime: AgentRuntime,
    realHandler: AgentEventHandler,
    refresh: () => void
  ): Promise<void> {
    let captured = "";
    runtime.onEvent(async (event) => {
      if (event.kind === "agent-text") {
        captured += event.text;
        return;
      }
      await realHandler(event);
    });
    try {
      await Promise.race([
        runtime.prompt("/context"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("/context probe timed out")), 5_000)
        ),
      ]);
      const m = captured.match(
        /(\d+(?:\.\d+)?)k\s*\/\s*(\d+(?:\.\d+)?)k\s*tokens/i
      );
      if (m) {
        const used = Math.round(parseFloat(m[1]!) * 1000);
        const size = Math.round(parseFloat(m[2]!) * 1000);
        if (size > 0) {
          await realHandler({ kind: "usage-update", used, size });
          refresh();
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "copilot /context probe failed");
    } finally {
      runtime.onEvent(realHandler);
    }
  }

  /** Returns the configured compaction model for an agent id, or "" if the
   *  agent isn't supported. Compaction always uses a known-good high-context
   *  summarizer rather than the session's own model — the latter can be too
   *  small to fit a near-full transcript with any response headroom. */
  private compactionModelFor(agentId: string): string {
    if (agentId === "agy" || agentId.startsWith("agy-")) {
      return this.config.AGY_COMPACTION_MODEL;
    }
    if (agentId === "claude" || agentId.startsWith("claude-")) {
      return this.config.CLAUDE_COMPACTION_MODEL;
    }
    if (
      agentId === "copilot" ||
      agentId.startsWith("copilot-") ||
      agentId === "remote"
    ) {
      return this.config.COPILOT_COMPACTION_MODEL;
    }
    if (agentId === "codex" || agentId.startsWith("codex-")) {
      return this.config.CODEX_COMPACTION_MODEL;
    }
    if (agentId === "grok" || agentId.startsWith("grok-")) {
      return this.config.GROK_COMPACTION_MODEL;
    }
    if (agentId === "zai" || agentId.startsWith("zai-")) {
      return this.config.ZAI_COMPACTION_MODEL;
    }
    if (agentId === "ollama-cloud" || agentId.startsWith("ollama-cloud-")) {
      return this.config.OLLAMA_CLOUD_COMPACTION_MODEL;
    }
    return "";
  }

  /** End-of-turn auto-compaction for agy. Mirrors the manual /compact flow
   *  (read transcript → summarize → seed the summary into a NEW session and bind
   *  the thread to it) but runs unattended when usage crosses
   *  AGY_AUTO_COMPACT_THRESHOLD. The original session is preserved. */
  private async runAgyAutoCompact(
    record: SessionRecord,
    channel: ChannelRef,
    status: TurnStatus,
    refresh: (force?: boolean) => Promise<void>,
    tokensBefore: number
  ): Promise<void> {
    const profile = this.router.getProfile(record.agentId);
    const manager = profile?.sessionManager;
    if (!profile || !manager?.getTranscript) {
      this.logger.debug({ agent: record.agentId }, "auto-compact skipped: missing manager methods");
      return;
    }

    status.setState("Working");
    status.setAction("Auto-compacting context…");
    await refresh(true);

    const compactStartedAt = Date.now();
    const thresholdPct = Math.round(this.config.AGY_AUTO_COMPACT_THRESHOLD * 100);

    // Status card so a queued follow-up message has context for why it's waiting.
    const inProgressPanel: StructuredPanel = {
      color: 0xe67e22,
      title: "🗜️ Auto-Compacting Context",
      fields: [
        { name: "Trigger", value: `≥ ${thresholdPct}% used`, inline: true },
        { name: "Before", value: fmtTokens(tokensBefore), inline: true },
        { name: "Status", value: "Generating summary…", inline: true },
      ],
    };
    let cardRef: MessageRef | undefined;
    try {
      if (this.adapter.sendPanel) {
        cardRef = await this.adapter.sendPanel(channel, inProgressPanel);
      } else {
        cardRef = await this.adapter.sendMessage(channel, serializePanelText(inProgressPanel));
      }
    } catch { /* best-effort — don't block compaction on a failed card send */ }

    const cwd = record.repoPath ?? process.cwd();
    if (!this.compactionModelFor(record.agentId)) {
      this.logger.warn({ agent: record.agentId }, "auto-compact: no compaction model configured");
      return;
    }

    let built: { seed: string; keptTurns: number; summarizedTurns: number; pinnedCount: number } | null = null;
    try {
      built = await this.buildDefaultCompactionSeed({
        profile,
        manager,
        agentId: record.agentId,
        cwd,
        sessionId: record.acpSessionId,
      });
    } catch (err) {
      this.logger.warn({ err, session: record.id }, "auto-compact: seed build failed");
      return;
    }
    if (!built) {
      this.logger.warn({ session: record.id }, "auto-compact: nothing to compact");
      return;
    }

    // Non-destructive: seed a new resumable session and bind the thread to it
    // (the original session is preserved on disk).
    const acCfg = this.store.readConfig(record);
    const acNewId = await this.seedNewSession({
      profile, cwd,
      ...(acCfg.model ? { model: acCfg.model } : {}),
      ...(acCfg.reasoningEffort ? { effort: acCfg.reasoningEffort } : {}),
      summary: built.seed,
    });
    record.acpSessionId = acNewId; // keep the in-memory record in sync (see getOrStartRuntime)
    this.store.upsert({ ...record, updatedUtc: new Date().toISOString() });
    await this.router.invalidate(record.id, { clearAcpSession: false });

    const elapsedSec = Math.round((Date.now() - compactStartedAt) / 1000);
    const summaryText = built.seed;
    // Rough estimate — 4 chars per token. The next real turn will replace this
    // with an authoritative usage_update reading.
    const tokensAfterEst = Math.ceil(summaryText.length / 4);
    const completedPanel: StructuredPanel = {
      color: 0x57f287,
      title: "✅ Compaction Complete",
      fields: [
        { name: "Before", value: fmtTokens(tokensBefore), inline: true },
        { name: "After (~)", value: fmtTokens(tokensAfterEst), inline: true },
        { name: "Duration", value: `${elapsedSec}s`, inline: true },
      ],
    };
    try {
      if (cardRef && this.adapter.editPanel) {
        await this.adapter.editPanel(cardRef, completedPanel);
      } else if (cardRef && this.adapter.editMessage) {
        await this.adapter.editMessage(cardRef, serializePanelText(completedPanel));
      } else {
        await this.adapter.sendMessage(channel, serializePanelText(completedPanel));
      }
    } catch { /* best-effort */ }
  }

  /**
   * Run one agent turn **programmatically** — no Discord user message behind
   * it. The single primitive every non-user-initiated turn goes through.
   *
   * `target` is the thread or session the turn belongs to. It may be `null`
   * for profile-driven isolated runs that have no thread at all (the
   * compaction fan-out), in which case `opts.profile` is required.
   *
   * Never throws for turn-level failures: start/session/prompt errors come
   * back as `{ error, cause }` with whatever text was captured before the
   * failure. Callers that need the *original* error (compaction stages do)
   * rethrow `result.cause`.
   *
   * ⚠️ `session: "live"` reuses the target's persistent runtime and calls
   * `runtime.onEvent()`, which **replaces** the single handler an in-flight
   * live turn installed. It is safe only when no user turn is running on that
   * thread. Nothing calls it yet; report-back correlation (#20) is what will,
   * and multiplexing the handler is that issue's problem to solve.
   */
  async injectTurn(
    target: InjectTarget | null,
    prompt: string,
    opts: InjectTurnOptions
  ): Promise<InjectTurnResult> {
    const correlation = opts.correlationId
      ? { correlationId: opts.correlationId }
      : {};
    const logger = this.logger.child({ ...(opts.logContext ?? {}), ...correlation });

    // Agent-emitted files go to the explicit route, else to the target when
    // it's a chat thread. No route ⇒ files are dropped.
    const outputTo: ChannelRef | undefined =
      opts.outputTo ?? (target && !isSessionRecord(target) ? target : undefined);

    let text = "";
    const handler: AgentEventHandler = async (event) => {
      if (event.kind === "agent-text") {
        text += event.text;
      } else if (event.kind === "agent-file") {
        try {
          if (outputTo && this.adapter.sendFile) {
            const data = event.base64
              ? Buffer.from(event.data, "base64")
              : Buffer.from(event.data, "utf8");
            await this.adapter.sendFile(outputTo, {
              data,
              filename: event.filename,
              mimeType: event.mimeType,
            });
          }
        } catch (err) {
          logger.warn({ err }, "injectTurn: forward agent file failed");
        }
      }
      await opts.onEvent?.(event);
    };

    const attachments =
      opts.attachments && opts.attachments.length > 0 ? opts.attachments : undefined;
    const runPrompt = async (rt: AgentRuntime): Promise<PromptOutcome | "timeout"> =>
      opts.timeoutMs === undefined
        ? await rt.prompt(prompt, attachments)
        : await raceWithTimeout(rt.prompt(prompt, attachments), opts.timeoutMs);

    if (opts.session === "isolated") {
      const profile = opts.profile ?? this.profileForTarget(target);
      if (!profile) {
        return { text, error: "injectTurn: no agent profile for target", ...correlation };
      }
      const cwd =
        opts.cwd ??
        (target && isSessionRecord(target) ? target.repoPath : undefined) ??
        this.config.REPOS_ROOT;
      const manager = opts.sessionManager ?? profile.sessionManager;
      let rt: AgentRuntime | undefined;
      let sessionId: string | undefined;
      try {
        rt = new AgentRuntime({
          profile,
          logger,
          mcpServers: opts.mcpServers ?? [],
          ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
        });
        await rt.start();
        if (opts.resumeSessionId) {
          // #76: resume against the recorded session, never newSession().
          await rt.loadSession({
            sessionId: opts.resumeSessionId,
            cwd,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(opts.strictModel ? { strictModel: true } : {}),
          });
          sessionId = opts.resumeSessionId;
        } else {
          const info = await rt.newSession({
            cwd,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(opts.strictModel ? { strictModel: true } : {}),
          });
          sessionId = info.sessionId;
        }
        // Persist the id BEFORE prompt() so a crash mid-turn is still
        // recoverable. Dispatch writes this onto the ledger at `running`.
        if (sessionId) {
          try {
            await opts.onSession?.(sessionId);
          } catch (err) {
            logger.warn({ err, sessionId }, "injectTurn: onSession failed");
          }
        }
        // Registered after newSession: the session-creation handshake emits no
        // events we want, and this matches the order the callers used.
        rt.onEvent(handler);
        const outcome = await runPrompt(rt);
        if (outcome === "timeout") {
          return {
            text,
            timedOut: true,
            error: `timed out after ${opts.timeoutMs! / 1000}s`,
            ...(sessionId ? { sessionId } : {}),
            ...correlation,
          };
        }
        if (opts.awaitIdle) await rt.idle();
        return {
          text,
          stopReason: outcome.stopReason,
          cancelled: outcome.cancelled,
          ...(sessionId ? { sessionId } : {}),
          ...correlation,
        };
      } catch (err) {
        return {
          text,
          error: (err as Error).message,
          cause: err,
          ...(sessionId ? { sessionId } : {}),
          ...correlation,
        };
      } finally {
        // Isolated runs guarantee teardown: kill the child, then drop the
        // throwaway session so it never clutters `/seam sessions`.
        if (rt) {
          const sid = rt.getSessionInfo()?.sessionId;
          await rt.dispose().catch(() => {});
          if (sid && manager?.deleteSession) {
            await manager.deleteSession(cwd, sid).catch(() => {});
          }
        }
      }
    }

    // --- live: reuse the thread's persistent session; no teardown. ---
    if (!target) {
      return { text, error: "injectTurn: live mode requires a target", ...correlation };
    }
    const record = isSessionRecord(target)
      ? target
      : this.router.ensureSessionRecord({
          platform: target.platform,
          channelRef: target.id,
          ...(target.parentId ? { parentRef: target.parentId } : {}),
          cwd: opts.cwd ?? this.config.REPOS_ROOT,
        });
    try {
      const rt = await this.router.getOrStartRuntime(record);
      const liveSessionId = record.acpSessionId || rt.getSessionInfo()?.sessionId;
      if (liveSessionId) {
        try {
          await opts.onSession?.(liveSessionId);
        } catch (err) {
          logger.warn({ err, sessionId: liveSessionId }, "injectTurn: onSession failed");
        }
      }
      rt.onEvent(handler);
      const outcome = await runPrompt(rt);
      if (outcome === "timeout") {
        return {
          text,
          timedOut: true,
          error: `timed out after ${opts.timeoutMs! / 1000}s`,
          sessionId: record.acpSessionId,
          ...correlation,
        };
      }
      if (opts.awaitIdle) await rt.idle();
      return {
        text,
        stopReason: outcome.stopReason,
        cancelled: outcome.cancelled,
        sessionId: record.acpSessionId,
        ...correlation,
      };
    } catch (err) {
      return {
        text,
        error: (err as Error).message,
        cause: err,
        sessionId: record.acpSessionId,
        ...correlation,
      };
    }
  }

  /** Resolve the agent profile bound to an inject target, if any. */
  private profileForTarget(target: InjectTarget | null): AgentProfile | undefined {
    if (!target) return undefined;
    const record = isSessionRecord(target)
      ? target
      : this.store.get(makeSessionId(target.platform, target.id));
    return record ? this.router.getProfile(record.agentId) : undefined;
  }

  /** Build a premium-compaction `runAgent`: each call spawns a FRESH throwaway
   *  AgentRuntime (model "default" → real Opus @ 1M; the "opus[1m]" alias
   *  mis-resolves) in cwd /tmp so the analysis sessions never pollute the real
   *  project's session list, collects the agent's text, and tears down +
   *  deletes the temp session. Fresh-per-call is required: the pipeline fans out
   *  ~16 concurrent calls, and a shared session would accumulate context and
   *  mis-attribute interleaved text. */
  private makeCompactionRunAgent(
    profile: AgentProfile,
    manager: ISessionManager,
    opts?: { model?: string; cwd?: string; effort?: string }
  ): RunAgent {
    const model = opts?.model ?? "default";
    const cwd = opts?.cwd ?? "/tmp";
    // Effort MUST be passed as `opts.effort` so newSessionMeta folds it into
    // `_meta.claudeCode.options.effort` (Claude) or applyConfigOptionEffort sets
    // `reasoning_effort` (Copilot) — the paths the wrappers actually honor. (A
    // prior `meta: { reasoningEffort }` was a silent no-op.) Undefined ⇒ no knob
    // for this agent (agy is modelBaked; remote has none) — left at its default.
    const effort = opts?.effort;
    // The AGY CLI (Gemini) silently truncates stdin prompts larger than ~150KB.
    // For large prompts, write the content to a temp file and reference it.
    const LARGE_PROMPT_THRESHOLD = 100 * 1024; // 100 KB
    return async (prompt: string, label: string): Promise<string> => {
      let tempFile: string | undefined;
      try {
        let actualPrompt = prompt;
        if (prompt.length > LARGE_PROMPT_THRESHOLD) {
          tempFile = path.join(os.tmpdir(), `compaction-prompt-${label}-${Date.now()}.txt`);
          await fsp.writeFile(tempFile, prompt, "utf8");
          actualPrompt =
            `Your full instructions and content have been saved to the file: ${tempFile}\n` +
            `Read that file NOW and follow all instructions in it. ` +
            `The file is ${Math.round(prompt.length / 1024)} KB. ` +
            `You MUST read the ENTIRE file before producing your response.`;
        }

        // No target: these analysis runs belong to no thread, so agent files
        // are dropped and only the text is collected. No timeout — a fan-out
        // stage runs as long as it needs. `awaitIdle` drains trailing chunks
        // before the text is handed to the pipeline.
        const result = await this.injectTurn(null, actualPrompt, {
          session: "isolated",
          profile,
          sessionManager: manager,
          cwd,
          model,
          ...(effort ? { effort } : {}),
          awaitIdle: true,
          logContext: { compaction: label },
        });
        // The pipeline treats a rejected stage as a recoverable per-chunk
        // failure, so propagate the ORIGINAL error, not a re-wrapped one.
        if (result.error) throw result.cause ?? new Error(result.error);
        return result.text;
      } finally {
        if (tempFile) {
          await fsp.unlink(tempFile).catch(() => {});
        }
      }
    };
  }

  /** Resolve the reasoning-effort level for a compaction tier against the
   *  AGENT'S OWN scale — effort levels are not portable across agents. Claude
   *  (low→max) deliberately uses xhigh for premium (not max) and high for cheap.
   *  A generic scale like Copilot's (low/medium/high) tops out lower, so premium
   *  takes the top level and cheap one below it. agy (modelBaked — effort IS the
   *  model choice) and the remote Mac (no effort mechanism) return undefined:
   *  there is no separate knob to set, so the runner leaves the agent's default. */
  private compactionEffortFor(profile: AgentProfile, tier: "premium" | "cheap"): string | undefined {
    const levels = profile.effort?.levels ?? [];
    if (levels.length === 0) return undefined;
    if (levels.includes("xhigh")) return tier === "premium" ? "xhigh" : "high";
    return tier === "premium"
      ? levels[levels.length - 1]
      : levels[levels.length - 2] ?? levels[levels.length - 1];
  }

  /** Render flagged Discord ranges to plain text for the deep-dive of any span
   *  where the session store is summary-only/absent (gap-detector's call). */
  private renderDiscordRanges(
    msgs: Array<{ ts: number; authorIsBot: boolean; text: string; authorName?: string }>,
    ranges: TimeRange[]
  ): string {
    const inAny = (ts: number) =>
      ranges.some((r) => {
        const from = r.fromTs ? Date.parse(r.fromTs) : -Infinity;
        const to = r.toTs ? Date.parse(r.toTs) : Infinity;
        return ts >= from && ts <= to;
      });
    return msgs
      .filter((m) => m.text && inAny(m.ts))
      .map((m) => {
        // Attribute human turns by name where the refetch surfaced it (#57 M3).
        const role = m.authorIsBot ? "ASSISTANT" : "USER";
        const label = !m.authorIsBot && m.authorName ? `${role} (${m.authorName})` : role;
        return `[${new Date(m.ts).toISOString()}] ${label}: ${m.text}`;
      })
      .join("\n\n");
  }

  /** Run the premium multi-agent compaction pipeline for a session, READ-ONLY
   *  w.r.t. the real session (analysis runs in temp /tmp runtimes). Resolves the
   *  raw JSONL, runs mandatory gap-detection, pulls Discord only for flagged
   *  ranges, then fans out the pipeline. Returns the full result; the caller
   *  seeds the assembled summary into a new session. */
  private async runPremiumCompactionForSession(args: {
    profile: AgentProfile;
    manager: ISessionManager;
    sessionId: string;
    cwd: string;
    channel?: ChannelRef;
    onProgress?: (msg: string) => void;
  }): Promise<PremiumCompactionResult> {
    const { profile, manager, sessionId, cwd, channel, onProgress } = args;
    const log = (m: string) => { onProgress?.(m); this.logger.debug({ compaction: sessionId }, m); };

    if (!manager.getHistoryPath) {
      throw new Error(`Premium compaction needs a raw-history reader; agent \`${profile.id}\` has none.`);
    }
    const jsonlPath = await manager.getHistoryPath(cwd, sessionId);
    if (!jsonlPath) throw new Error("Could not locate the session's raw history file.");

    log("reading session history…");
    const richHistory = await readRichHistory(jsonlPath);

    // Mandatory gap-detection. Pull the thread's messages (with timestamps) when
    // the adapter supports it, both to anchor threadFirstTs and to enrich any
    // flagged ranges where Discord out-fidelities the session store.
    const coverage = await analyzeSessionCoverage(jsonlPath);
    let threadMsgs: Array<{ ts: number; authorIsBot: boolean; text: string }> = [];
    if (channel && typeof this.adapter.fetchThreadMessagesTimed === "function") {
      try { threadMsgs = await this.adapter.fetchThreadMessagesTimed(channel); }
      catch (err) { this.logger.warn({ err }, "premium-compact: thread fetch failed"); }
    }
    const threadFirstTs = threadMsgs[0]?.ts ? new Date(threadMsgs[0]!.ts).toISOString() : undefined;
    const gapReport = detectGaps({ coverage, ...(threadFirstTs ? { threadFirstTs } : {}) });

    let discordText: string | undefined;
    if (gapReport.needDiscord && threadMsgs.length > 0) {
      discordText = this.renderDiscordRanges(threadMsgs, gapReport.discordRanges);
      log(`gap-detection: ${gapReport.signals.map((s) => s.kind).join(", ")} → ${gapReport.discordRanges.length} Discord range(s)`);
    } else if (gapReport.needDiscord) {
      log(`gap-detection flagged ${gapReport.signals.length} gap(s) but Discord history is unavailable`);
    }

    // Premium tier runs every stage at the agent's top reasoning level (Claude
    // xhigh, Copilot high; agy/remote have no separate knob) — fidelity is the
    // whole point of this tier.
    const runAgent = this.makeCompactionRunAgent(profile, manager, {
      effort: this.compactionEffortFor(profile, "premium"),
    });
    return runPremiumCompaction({
      richHistory,
      gapReport,
      ...(discordText ? { discordText } : {}),
      runAgent,
      log,
    });
  }

  /** Run the premium multi-agent compaction pipeline reconstructed from the full
   *  Discord thread history. Works for any compactable agent profile. */
  private async runPremiumCompactionForDiscord(args: {
    profile: AgentProfile;
    manager: ISessionManager;
    sessionId: string;
    cwd: string;
    channel?: ChannelRef;
    onProgress?: (msg: string) => void;
  }): Promise<PremiumCompactionResult> {
    const { profile, manager, sessionId, cwd, channel, onProgress } = args;
    const log = (m: string) => { onProgress?.(m); this.logger.debug({ compaction: `discord-${sessionId}` }, m); };

    if (!channel) {
      throw new Error("Discord compaction requires an active channel context.");
    }
    if (typeof this.adapter.fetchThreadMessagesTimed !== "function") {
      throw new Error("Chat adapter does not support fetching timed thread messages.");
    }

    log("fetching thread history from Discord…");
    const threadMsgs = await this.adapter.fetchThreadMessagesTimed(channel);
    if (threadMsgs.length === 0) {
      throw new Error("No messages found in this Discord thread to compact.");
    }

    log(`fetched ${threadMsgs.length} message(s) from Discord, mapping to rich history…`);

    const events: HistoryEvent[] = threadMsgs.map((m) => ({
      kind: m.authorIsBot ? "assistant" : "user",
      ts: m.ts,
      text: m.text,
    }));

    const userTurns = events.filter((e) => e.kind === "user").length;
    const assistantTurns = events.filter((e) => e.kind === "assistant").length;
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const firstTs = firstEvent?.ts ? new Date(firstEvent.ts).toISOString() : undefined;
    const lastTs = lastEvent?.ts ? new Date(lastEvent.ts).toISOString() : undefined;
    const estimatedTokens = Math.ceil(renderHistory(events).length / 4);

    const richHistory: RichHistory = {
      events,
      stats: {
        totalEvents: events.length,
        userTurns,
        assistantTurns,
        thinkingKept: 0,
        thinkingRedactedSkipped: 0,
        toolEvents: 0,
        ...(firstTs ? { firstTs } : {}),
        ...(lastTs ? { lastTs } : {}),
        estimatedTokens,
        thinkingAvailable: false,
      },
    };

    const gapReport: GapReport = {
      signals: [],
      discordRanges: [],
      needDiscord: false,
    };

    const runAgent = this.makeCompactionRunAgent(profile, manager, {
      effort: this.compactionEffortFor(profile, "premium"),
    });
    return runPremiumCompaction({
      richHistory,
      gapReport,
      runAgent,
      log,
    });
  }

  /** Split a `getTranscript` rendering ("### User\n…\n\n### Assistant\n…") into
   *  its turn blocks, preserving order and the role headers. */
  private splitTranscriptTurns(transcript: string): string[] {
    return transcript
      .split(/\n\n(?=### (?:User|Assistant)\n)/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  /** Default-tier ("cheap") compaction seed, with the three shared wins backported
   *  (design §1): a verbatim recent window (last turns kept word-for-word), a
   *  verbatim pinned-facts block, and a visible drop-note so loss is recoverable.
   *  Returns null when there's nothing to compact or no summarizer model — the
   *  caller then keeps the legacy behavior. Works for any agent with a transcript
   *  reader; analysis runs in throwaway runtimes. */
  private async buildDefaultCompactionSeed(args: {
    profile: AgentProfile;
    manager: ISessionManager;
    agentId: string;
    cwd: string;
    sessionId: string;
    recentWindowTokens?: number;
    log?: (msg: string) => void;
  }): Promise<{ seed: string; keptTurns: number; summarizedTurns: number; pinnedCount: number } | null> {
    const { profile, manager, agentId, cwd, sessionId } = args;
    const log = args.log ?? (() => {});
    const recentWindowTokens = args.recentWindowTokens ?? 12_000;

    const transcript = await manager.getTranscript(cwd, sessionId);
    if (!transcript.trim()) return null;
    const compactionModel = this.compactionModelFor(agentId);
    if (!compactionModel) return null;

    // Split into the verbatim recent window (kept word-for-word) and the older
    // prefix (summarized). Budget by chars (~4/token).
    const turns = this.splitTranscriptTurns(transcript);
    const budgetChars = recentWindowTokens * 4;
    const recent: string[] = [];
    let chars = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const len = turns[i]!.length + 2;
      if (chars + len > budgetChars && recent.length > 0) break;
      recent.unshift(turns[i]!);
      chars += len;
    }
    const olderTurns = turns.slice(0, turns.length - recent.length);
    const recentVerbatim = recent.join("\n\n");
    const window = compactionWindowFor(compactionModel);
    // Cheap tier (single-pass summary): a notch below premium on each agent's
    // own scale (Claude high, Copilot medium).
    const runAgent = this.makeCompactionRunAgent(profile, manager, {
      model: compactionModel,
      cwd,
      effort: this.compactionEffortFor(profile, "cheap"),
    });

    // Summary of the older prefix via the existing single-pass template.
    let summaryMarkdown = "_(No older history beyond the recent window.)_";
    if (olderTurns.length > 0) {
      log("summarizing older history…");
      const olderText = olderTurns.join("\n\n");
      const template = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
      const overhead = template.length + "\n\nConversation Transcript:\n".length;
      const fitted = fitTranscriptToWindow(olderText, overhead, window);
      summaryMarkdown = (await runAgent(`${template}\n\nConversation Transcript:\n${fitted}`, "summary")).trim();
      if (!summaryMarkdown) throw new Error("Summarizer returned empty output.");
    }

    // Verbatim pinned-facts (one pass on the fit-to-window transcript). A parse
    // failure degrades to an empty block rather than failing the whole compaction.
    log("extracting pinned facts…");
    let pinnedFacts: PinnedFacts = { corrections: [], constraints: [], decisions: [], openTodos: [], activePaths: [], rules: [] };
    try {
      const fittedAll = fitTranscriptToWindow(transcript, 0, window);
      const raw = await runAgent(pinnedFactsPrompt({ text: fittedAll, thinkingAvailable: false }), "pinned");
      pinnedFacts = mergePinnedFacts([parseJsonOutput<PinnedFacts>(raw)]);
    } catch (err) {
      this.logger.warn({ err, sessionId }, "default-compact: pinned-facts extraction failed; continuing without it");
    }

    const pinnedCount =
      pinnedFacts.corrections.length + pinnedFacts.constraints.length + pinnedFacts.rules.length +
      pinnedFacts.openTodos.length + pinnedFacts.activePaths.length;
    const dropNote =
      `## Compaction note\n` +
      `- Summarized ${olderTurns.length} older turn(s); kept the last ${recent.length} verbatim below.\n` +
      `- Pinned ${pinnedCount} verbatim constraint(s)/correction(s)/rule(s)/path(s).\n` +
      `- If something important seems missing, the full prior transcript is recoverable from the Discord thread (and the session's pre-compaction history).`;

    const seed = assembleNewSession({ summaryMarkdown, pinnedFacts, recentVerbatim, dropNote });
    return { seed, keptTurns: recent.length, summarizedTurns: olderTurns.length, pinnedCount };
  }

  /** Full human-readable report of a premium-compaction run (critic verdicts,
   *  recovery requests, pinned facts, the assembled seed) so the detail is
   *  reviewable beyond the Discord summary card. */
  private formatPremiumReport(result: PremiumCompactionResult, sessionId: string): string {
    return [
      `# Premium compaction report — ${sessionId}`,
      ``,
      `- Stats: ${JSON.stringify(result.stats)}`,
      ``,
      `---`,
      ``,
      `## Pinned facts (verbatim)`, "```json", JSON.stringify(result.pinnedFacts, null, 2), "```",
      ``, `---`, ``,
      `## Assembled session seed`, ``, result.assembledSeed,
    ].join("\n");
  }

  /** Non-destructive compaction primitive (the user's original design): create a
   *  BRAND-NEW session via the SDK and seed it by sending the summary as the
   *  first prompt — a real turn Claude Code writes itself, so it RESUMES cleanly
   *  (unlike overwriting a JSONL with a synthetic assistant message, which hangs
   *  on `--resume`). Returns the new session id; the caller binds the thread to
   *  it and the original session is left intact (recoverable / deletable). */
  private async seedNewSession(args: {
    profile: AgentProfile;
    cwd: string;
    model?: string;
    effort?: string;
    summary: string;
  }): Promise<string> {
    const { profile, cwd, model, effort, summary } = args;
    let rt: AgentRuntime | undefined;
    try {
      rt = new AgentRuntime({ profile, logger: this.logger.child({ compaction: "seed" }), mcpServers: [] });
      await rt.start();
      const info = await rt.newSession({ cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      const prompt =
        "[Loading prior-session context after compaction — read the summary below, reply with a one-line acknowledgement, then await the next instruction. Do not begin work yet.]\n\n" +
        summary;
      await rt.prompt(prompt);
      // Brief pause so Claude Code finishes flushing the new session's JSONL
      // before we tear down (the turn is the only content; it must land on disk).
      await new Promise((r) => setTimeout(r, 1000));
      return info.sessionId;
    } finally {
      if (rt) await rt.dispose().catch(() => {});
    }
  }

  /**
   * Reusable non-destructive compaction primitive — the single run+seed+swap
   * flow that the session-manager buttons and the agent-callable `compact`
   * seam-MCP capability both delegate to. Resolves profile / manager / session /
   * cwd / channel from the `record`, runs the premium multi-agent pipeline
   * (session-history by default; the full-Discord reconstruction when
   * `source === "discord"`), seeds a BRAND-NEW resumable session with the
   * assembled summary, and — only if the compacted session was the thread's
   * active one — rebinds the thread to it (`store.upsert` + `router.invalidate`).
   *
   * NON-DESTRUCTIVE by construction: the original session is never mutated; a
   * new session is seeded alongside it and the thread is repointed. The caller
   * owns presentation (the buttons render Discord cards; the dispatch handler
   * posts a result card) — this returns the facts, it posts nothing itself.
   *
   * `opts.sessionId` overrides which session to compact (the buttons compact the
   * one the operator navigated to); omitted ⇒ the thread's own active session,
   * which is what the self-scoped MCP path wants. Throws with a readable message
   * when the target has no compactable session/manager, mirroring the pipeline's
   * own "needs a raw-history reader" refusal so a caller learns why it can't run.
   *
   * #76 NON-GOAL: premium-compaction (and other in-memory multi-stage
   * orchestrator work) is neither a dispatch-backed turn nor a live human
   * turn. A restart kills it mid-pipeline and it stays dead — no marker,
   * no resume. Named so that is a decision, not an oversight.
   */
  async compactThread(
    record: SessionRecord,
    opts?: {
      source?: "session" | "discord";
      sessionId?: string;
      channel?: ChannelRef;
      onProgress?: (m: string) => void;
    }
  ): Promise<{
    newSessionId: string;
    originalSessionId: string;
    wasActive: boolean;
    reportMarkdown: string;
    stats: PremiumCompactionResult["stats"];
  }> {
    const source = opts?.source ?? "session";
    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      throw new Error(`Agent profile "${record.agentId}" not found, so this thread has no compactable session.`);
    }
    const manager = profile.sessionManager;
    if (!manager) {
      throw new Error(
        `Agent \`${record.agentId}\` (${profile.displayName}) does not support session management, ` +
          `so it has no compactable session.`
      );
    }
    const sessionId = opts?.sessionId ?? record.acpSessionId;
    if (!sessionId) {
      throw new Error("This thread has no active session to compact yet.");
    }
    const cwd = record.repoPath ?? this.config.REPOS_ROOT;
    const channel: ChannelRef = opts?.channel ?? { platform: record.platform, id: record.channelRef };
    const onProgress = opts?.onProgress;

    const result =
      source === "discord"
        ? await this.runPremiumCompactionForDiscord({
            profile,
            manager,
            sessionId,
            cwd,
            channel,
            ...(onProgress ? { onProgress } : {}),
          })
        : await this.runPremiumCompactionForSession({
            profile,
            manager,
            sessionId,
            cwd,
            channel,
            ...(onProgress ? { onProgress } : {}),
          });

    if (!result.assembledSeed.trim()) throw new Error("Pipeline produced an empty result.");

    // Non-destructive: seed a NEW resumable session with the summary, bind the
    // thread to it only if this WAS its active session, and leave the original
    // intact (recoverable / deletable from the session manager).
    const cfg = this.store.readConfig(record);
    const newSessionId = await this.seedNewSession({
      profile,
      cwd,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
      summary: result.assembledSeed,
    });
    const wasActive = sessionId === record.acpSessionId;
    if (wasActive) {
      this.store.upsert({ ...record, acpSessionId: newSessionId, updatedUtc: new Date().toISOString() });
      await this.router.invalidate(record.id, { clearAcpSession: false });
    }

    return {
      newSessionId,
      originalSessionId: sessionId,
      wasActive,
      reportMarkdown: this.formatPremiumReport(result, sessionId),
      stats: result.stats,
    };
  }

  setDispatchWatcher(watcher: DispatchWatcher): void {
    this.dispatchWatcher = watcher;
  }

  setBridgeHub(hub: BridgeHub): void {
    this.bridgeHub = hub;
  }

  setChoiceResults(hub: ChoiceResultHub): void {
    this.choiceResults = hub;
  }

  setIngestUrl(fn: () => string): void {
    this.ingestUrl = fn;
  }

  inspectChoiceDestLive(card: ChoiceCard, optionIndex: number): Promise<"ok" | "gone" | "archived"> {
    return this.choiceDestLive(card, optionIndex);
  }

  submitChoiceResult(
    record: { id: string; channelRef: string },
    value: unknown
  ): { ok: true; dispatchId: string } | { ok: false; error: string } {
    if (!this.choiceResults) {
      return { ok: false, error: "ingest results are not configured on this deployment." };
    }
    const fromSession = this.choiceResults.submitFromSession(record.id, value);
    if (fromSession.ok) return fromSession;
    const fromChannel = this.choiceResults.submitFromChannel(record.channelRef, value);
    if (!fromChannel.ok) {
      this.logger.warn(
        { recordId: record.id, channelRef: record.channelRef },
        "submit_result: no ingest waiter for session or channel"
      );
    }
    return fromChannel;
  }

  /**
   * #85: a `@<bridge>` resume waits for that bridge's ready event (no poll).
   * Past max-age → abandon. Local resume is unchanged. Never rebinds a
   * remote session onto `@local`.
   */
  private async resumeOnSameHost(
    marker: LiveTurnMarker,
    maxAge: number,
    now: Date
  ): Promise<void> {
    const loc =
      marker.location ??
      resolveThreadLocation(this.config, marker.channelRef);
    const waited = await this.waitForResumeHost(loc, marker.startedUtc, maxAge, now);
    if (waited === "abandon") {
      await this.abandonLiveMarker(marker, "bridge not ready (past max-age)");
      return;
    }
    if (!isLocalLocation(loc)) {
      bindSessionLocation(this.bridgeHub, marker.sessionRecordId, loc);
    }
    await this.refireLiveTurn(marker);
  }

  private async waitForResumeHost(
    location: string,
    startedUtc: string,
    maxAgeSeconds: number,
    now: Date
  ): Promise<"ok" | "abandon"> {
    if (isLocalLocation(location)) return "ok";
    if (!this.bridgeHub) return "abandon";
    const deadlineMs = remainingMaxAgeMs(startedUtc, maxAgeSeconds, now);
    const result = await waitUntilBridgeReady(this.bridgeHub, location, { deadlineMs });
    return result === "timeout" ? "abandon" : "ok";
  }

  /** Isolated workers on a bridge: bind + remote spawn. Live runs bind in SessionRouter. */
  private remoteDispatchSpawnOpts(opts: {
    spec: DispatchSpec;
    record: SessionRecord;
    effectiveSession: "live" | "isolated";
    workerLocation: string;
    profile?: AgentProfile;
    cwd: string;
  }): Pick<InjectTurnOptions, "spawnFn" | "mcpServers"> {
    if (opts.effectiveSession !== "isolated") return {};
    // Local isolated used to spawn with mcpServers: [] — ingest scoring then
    // had no submit_result. Reuse the authoring thread's token (do not mint).
    if (isLocalLocation(opts.workerLocation)) {
      return { mcpServers: this.router.reuseMcpServers(opts.record.id) };
    }
    if (!this.bridgeHub) {
      throw new Error(`dispatch ${opts.spec.id}: location "${opts.workerLocation}" needs a connected bridge`);
    }
    const agentId = opts.profile?.id ?? opts.record.agentId;
    const planned = planIsolatedRemoteSpawn({
      hub: this.bridgeHub,
      sessionId: isolatedBindSessionId(opts.spec.id),
      location: opts.workerLocation,
      agentId,
      cwd: opts.cwd,
      ...(opts.spec.model ? { model: opts.spec.model } : {}),
      ...(opts.spec.effort ? { effort: opts.spec.effort } : {}),
    });
    return { spawnFn: planned.spawnFn, mcpServers: planned.mcpServers };
  }

  /** Exposed so index.ts can wire BridgeHub audit writes without growing this file. */
  getConfigMutation(): ConfigMutationService {
    return this.configMutation;
  }

  setScheduledManager(m: ScheduledPromptManager): void {
    this.scheduledManager = m;
  }

  setWakeManager(m: WakeManager): void {
    this.wakeManager = m;
  }

  setLiveHelpManager(m: LiveHelpManager): void {
    this.liveHelpManager = m;
  }

  setParkedManager(m: ParkedPromptManager): void {
    this.parkedManager = m;
  }

  setCardGifs(catalog: CardGifCatalog): void {
    this.cardGifs = catalog;
  }

  setOnParkedChange(fn: () => void): void {
    this.onParkedChange = fn;
  }

  // --- agent-scheduled wake events (#59) ------------------------------------

  /**
   * Arm a one-shot wake for the caller's own thread (D3/D4). Shared by the
   * `schedule_wake` MCP tool and the `seam-wake` fence fallback, so both paths
   * enforce the same loop-safety backstops (D8/D14):
   *  - delay floor / ceiling (D8 min, D14 max) — reject out of range;
   *  - per-thread pending cap (D8);
   *  - chain-depth cap (D8) — a wake armed *during* a woken turn inherits
   *    depth+1 from `activeWakeDepth`, and past the cap we refuse and say so.
   *
   * Returns `{ ok: true, wakeId, fireAtUtc }` or `{ ok: false, error }` with a
   * human-readable reason the caller surfaces to the agent verbatim.
   */
  scheduleWake(
    record: SessionRecord,
    req: WakeScheduleRequest
  ):
    | { ok: true; wakeId: string; fireAtUtc: string; chainDepth: number }
    | { ok: false; error: string } {
    const reason = (req.reason ?? "").trim();
    const prompt = (req.prompt ?? "").trim();
    if (!prompt) return { ok: false, error: "prompt is required and must be non-empty." };

    // Boot-triggered wake (#59 extension): fires on the next process start, not
    // at a wall-clock time, so `delaySeconds` is ignored and the delay
    // floor/ceiling checks don't apply. `fireAtUtc` is set to a nominal "now"
    // sentinel below — it's excluded from the time sweep regardless.
    const fireOnStartup = req.fireOnStartup === true;
    const delay = Math.floor(Number(req.delaySeconds));
    if (!fireOnStartup) {
      if (!Number.isFinite(delay)) {
        return { ok: false, error: "delaySeconds must be a number." };
      }
      if (delay < WAKE_MIN_DELAY_SECONDS) {
        return {
          ok: false,
          error: `delaySeconds ${delay} is below the ${WAKE_MIN_DELAY_SECONDS}s floor — schedule a wake at least ${WAKE_MIN_DELAY_SECONDS}s out.`,
        };
      }
      if (delay > WAKE_MAX_DELAY_SECONDS) {
        return {
          ok: false,
          error: `delaySeconds ${delay} exceeds the ${WAKE_MAX_DELAY_SECONDS}s (7-day) maximum — that far out is a scheduled prompt, not a wake.`,
        };
      }
    }

    // Chain-depth cap (D8): a wake armed while a woken turn is running continues
    // a self-renewal chain; refuse past the threshold so a non-converging loop
    // halts (and says so) rather than re-arming forever.
    const parentDepth = this.activeWakeDepth.get(record.channelRef);
    const chainDepth = parentDepth === undefined ? 0 : parentDepth + 1;
    if (chainDepth > WAKE_MAX_CHAIN_DEPTH) {
      return {
        ok: false,
        error: `wake chain-depth cap reached (${WAKE_MAX_CHAIN_DEPTH} consecutive self-renewals) — refusing to re-arm. If this loop is legitimate, break it up or resume from a fresh turn.`,
      };
    }

    // Per-thread pending cap (D8).
    const pending = this.store.countPendingWakesByChannel(record.platform, record.channelRef);
    if (pending >= WAKE_MAX_PENDING_PER_THREAD) {
      return {
        ok: false,
        error: `this thread already has ${pending} pending wakes (cap ${WAKE_MAX_PENDING_PER_THREAD}) — cancel one before arming another.`,
      };
    }

    const nowMs = Date.now();
    const wake: WakeEvent = {
      id: randomUUID(),
      platform: record.platform,
      channelRef: record.channelRef,
      parentRef: record.parentRef,
      fireAtUtc: fireOnStartup
        ? new Date(nowMs).toISOString()
        : new Date(nowMs + delay * 1000).toISOString(),
      prompt,
      reason,
      createdBy: record.id,
      correlationId: null,
      chainDepth,
      catchupSeconds: WAKE_DEFAULT_CATCHUP_SECONDS,
      fireOnStartup,
      createdUtc: new Date(nowMs).toISOString(),
    };
    this.store.upsertWake(wake);
    this.logger.info(
      { id: wake.id, channel: record.channelRef, fireAtUtc: wake.fireAtUtc, chainDepth, fireOnStartup },
      "wake scheduled"
    );
    return { ok: true, wakeId: wake.id, fireAtUtc: wake.fireAtUtc, chainDepth };
  }

  /** Cancel a pending wake (D6). Scoped: only the wake's own thread may cancel
   *  it, so one thread can't reach into another's bookkeeping. Returns whether a
   *  row was actually removed. */
  cancelWake(record: SessionRecord, id: string): boolean {
    const wake = this.store.getWake(id);
    if (!wake || wake.channelRef !== record.channelRef || wake.platform !== record.platform) {
      return false;
    }
    this.store.deleteWake(id);
    this.logger.info({ id, channel: record.channelRef }, "wake cancelled");
    return true;
  }

  /** Pending wakes for a thread (D6 visibility surface). */
  listWakes(platform: string, channelRef: string): WakeEvent[] {
    return this.store.listWakesByChannel(platform, channelRef);
  }

  // --- agent inbox (#61) ----------------------------------------------------

  /**
   * Push a PULL-ONLY message into a target thread's durable inbox (#61),
   * attributed to `caller`. This is the `send` primitive: unlike handoff/forward
   * it NEVER enqueues a dispatch or starts a turn — the target reads the message
   * on its next `poll_inbox`. The target's session key is `${platform}:${to}`
   * (the same immutable routing key as wakes, `record.id`), so a message can be
   * left for a thread even while it is idle. The ledger row (kind "inbox") is
   * best-effort — a ledger write must never break delivery.
   */
  pushInbox(
    caller: SessionRecord,
    to: string,
    message: string,
    priority = false
  ): { ok: true; queued: number } | { ok: false; error: string } {
    const body = (message ?? "").trim();
    if (!body) return { ok: false, error: "message is required and must be non-empty." };
    const target = (to ?? "").trim();
    if (!target) return { ok: false, error: "to (a target thread id) is required." };

    const sessionRef = `${caller.platform}:${target}`;
    const stored = this.store.pushInbox(sessionRef, caller.channelRef, body, priority);
    try {
      this.store.recordDelegation({
        id: stored.id,
        kind: "inbox",
        sourceRef: caller.channelRef,
        targetRef: target,
        promptPreview: body,
        // Delivery to the inbox is complete the moment it lands — there is no
        // in-flight turn to track (pull-only), so the row is terminal at push.
        status: "completed",
      });
    } catch (err) {
      this.logger.warn({ err, from: caller.channelRef, to: target }, "inbox: push ledger record failed");
    }
    const queued = this.store.countInbox(sessionRef);
    this.logger.info({ from: caller.channelRef, to: target, priority, queued }, "inbox: message pushed");
    return { ok: true, queued };
  }

  /**
   * Preemptive interrupt (#67): the agent-facing twin of `/seam steer now:true`
   * (cmdSteer). CANCEL the target thread's in-flight dispatched turn and issue
   * `message` as a fresh directive NOW into that same thread — never a queued
   * inbox note. Three moves, mirroring the human steer-now path:
   *
   *  a. CANCEL — reuse the steer-now canceller `router.abortTurn`, but with
   *     `{ force: true }` so a wedged turn is escalated to a force-kill (graceful
   *     ACP cancel → 3s grace → dispose). An interrupt must GUARANTEE the turn is
   *     gone before the redirect runs, else the new turn would overlap the old
   *     one's event stream. If nothing was running (`idle`), we degrade
   *     gracefully — the directive is still delivered so it is never lost.
   *  b. SUPPRESS — if a LIVE dispatch was running in the target, mark its id
   *     interrupted BEFORE cancelling, so when its cancelled `run()` reaches the
   *     onward-delivery branch it skips report-back / chain advance and its
   *     partial/stale output is never delivered to its `returnTo`.
   *  c. REDIRECT — enqueue a NEW live dispatch (fresh id/correlation) into the
   *     SAME thread carrying the framed directive. With `fresh:true` we reset the
   *     session first (`clearAcpSession`) for a clean slate; otherwise the live
   *     session/context is kept so the agent pivots off its partial work.
   */
  async interruptRedirect(
    caller: SessionRecord,
    to: string,
    message: string,
    fresh: boolean
  ): Promise<
    | { ok: true; cancelled: "idle" | "cancelled" | "killed"; fresh: boolean; dispatchId: string }
    | { ok: false; error: string }
  > {
    const body = (message ?? "").trim();
    if (!body) return { ok: false, error: "message is required and must be non-empty." };
    const target = (to ?? "").trim();
    if (!target) return { ok: false, error: "to (a target thread id) is required." };

    const record = this.router.ensureSessionRecord({
      platform: caller.platform,
      channelRef: target,
      cwd: this.config.REPOS_ROOT,
    });

    // (b) Mark the in-flight LIVE handoff interrupted BEFORE the cancel, so its
    // cancelled run() is guaranteed to find the flag set when it reaches the
    // onward-delivery branch. No live dispatch running ⇒ nothing to suppress.
    const activeId = this.activeLiveDispatch.get(target);
    if (activeId) this.interruptedDispatches.add(activeId);

    // (a) Cancel — the steer-now canceller, escalated to force so a wedged turn
    // can't block the redirect. "idle" ⇒ there was no active turn (degrade to
    // immediate delivery below).
    const cancelled = await this.router.abortTurn(record.id, { force: true });

    // (c) fresh:true ⇒ reset the session first (clean slate) — clear the stored
    // ACP session id so the redirected turn starts a brand-new session. Kept
    // otherwise, so the agent pivots off its partial work with full context.
    if (fresh) {
      await this.router.invalidate(record.id, { clearAcpSession: true });
    }

    // (c) Redirect — enqueue a fresh LIVE dispatch of the framed directive into
    // the SAME thread. New id/correlation; report back to the interrupter so the
    // caller sees the outcome (mirrors the `steer` MCP tool's returnTo=caller).
    const dispatchId = randomUUID();
    const spec: DispatchSpec = {
      id: dispatchId,
      target,
      prompt: frameInterruptPrompt(body, fresh),
      session: "live",
      returnTo: caller.channelRef,
      kind: "handoff",
      correlationId: dispatchId,
      createdUtc: new Date().toISOString(),
    };
    await enqueueDispatchSpec(this.config.DATA_DIR, spec);

    this.logger.info(
      { from: caller.channelRef, to: target, fresh, cancelled, interruptedDispatch: activeId ?? null, dispatchId },
      "inbox: interrupt-and-redirect"
    );
    return { ok: true, cancelled, fresh, dispatchId };
  }

  /**
   * Push a HUMAN's cooperative message into `record`'s durable inbox (#63) — the
   * human producer half of #61's `pushInbox` (whose producer is a resolved agent
   * SessionRecord). Here `from` is a person, attributed via speaker-identity (#57)
   * as `human:<name|id>` (built by the caller). Discord URLs are scrubbed when the
   * target agent is `restrictDiscordAccess`, mirroring the prompt path so a
   * network-restricted host is never handed a Discord link. Pull-only — never
   * starts or cancels a turn; the agent reads it at its next `poll_inbox`. The
   * ledger row (kind "inbox") is best-effort, same as the agent push above.
   */
  pushHumanInbox(record: SessionRecord, from: string, message: string): { queued: number } {
    const activeProfile = this.router.getProfile(record.agentId);
    const body = activeProfile?.restrictDiscordAccess ? scrubDiscordUrls(message) : message;
    const stored = this.store.pushInbox(record.id, from, body);
    try {
      this.store.recordDelegation({
        id: stored.id,
        kind: "inbox",
        sourceRef: from,
        targetRef: record.channelRef,
        promptPreview: body,
        status: "completed",
      });
    } catch (err) {
      this.logger.warn({ err, from, to: record.channelRef }, "inbox: human push ledger record failed");
    }
    const queued = this.store.countInbox(record.id);
    this.logger.info({ from, to: record.channelRef, queued }, "inbox: human message pushed");
    return { queued };
  }

  /**
   * Route a bare mid-turn Discord reply into the running agent's inbox (#63,
   * cooperative). Only reached when SEAM_MIDTURN_REPLY_MODE="inbox" AND a turn is
   * already active on the thread. Attribution comes from speaker-identity (#57):
   * the resolved author name, id fallback. An attachment-only reply (no text) is
   * a no-op — there is nothing to hand the agent cooperatively. Acks with a light
   * 💬 reaction so the human sees the message was absorbed without a chatty post.
   */
  private async routeMidTurnReplyToInbox(msg: IncomingMessage): Promise<void> {
    const body = (msg.text ?? "").trim();
    const channel = msg.channel;
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    if (!body) {
      this.logger.debug({ channelId: channel.id, sessionId: record.id }, "mid-turn reply had no text; nothing to queue");
      return;
    }
    const from = humanInboxFrom(msg.authorName, msg.authorId);
    const { queued } = this.pushHumanInbox(record, from, body);
    this.logger.info(
      { channelId: channel.id, sessionId: record.id, from, queued },
      "mid-turn reply routed to inbox (cooperative)"
    );
    // Light ⏳/💬 ack: react on the raw message so the human sees it landed,
    // without a reply that would clutter the live turn. Best-effort — a failed
    // ack must never block the (already-committed) queuing.
    try {
      const raw = msg.raw as Message | undefined;
      if (raw && typeof raw.react === "function") await raw.react("💬");
    } catch (err) {
      this.logger.debug({ err, channelId: channel.id }, "mid-turn inbox ack reaction failed");
    }
  }

  /**
   * Drain the calling thread's OWN inbox (#61): read + delete every queued
   * message (deliver-once) and return them coalesced (oldest first). Self-scope
   * is enforced by construction — the owner is always the token-resolved caller's
   * `record.id`, never a caller-supplied id. Best-effort ledger row (kind
   * "inbox") when anything was actually drained.
   */
  drainInbox(record: SessionRecord): InboxMessage[] {
    const messages = this.store.drainInbox(record.id);
    if (messages.length > 0) {
      try {
        this.store.recordDelegation({
          id: randomUUID(),
          kind: "inbox",
          sourceRef: record.channelRef,
          targetRef: record.channelRef,
          promptPreview: `drained ${messages.length} inbox message(s)`,
          status: "completed",
        });
      } catch (err) {
        this.logger.warn({ err, thread: record.channelRef }, "inbox: drain ledger record failed");
      }
      this.logger.info({ thread: record.channelRef, count: messages.length }, "inbox: drained");
    }
    return messages;
  }

  /**
   * WakeManager `onFire` handler (#59): a wake has come due and its row is
   * already deleted (D1). Deliver it by enqueuing a dispatch spec through the
   * shipped queue — the sweeper decides *when*, the dispatch queue owns *how*.
   * The DispatchWatcher runs the spec via `dispatchInjectTurn`, which records
   * the ledger row (kind "wake", D7) and posts the captured output.
   *
   * Preconditions before enqueuing (mirroring the scheduled-prompt checks):
   *  - thread deleted → drop cleanly (the row is already gone);
   *  - Discord-native locked thread → drop with a logged reason — a one-shot
   *    wake cannot meaningfully "skip and retry later" (D12).
   *  A preset-locked channel is NOT blocked (D12): that lock gates slash-command
   *  reconfiguration, never a wake.
   */
  async fireWake(wake: WakeEvent): Promise<void> {
    const target: ChannelRef = {
      platform: PLATFORM,
      id: wake.channelRef,
      ...(wake.parentRef ? { parentId: wake.parentRef } : {}),
    };

    // Preconditions: is the thread postable? (deleted → drop; Discord-locked → drop.)
    if (typeof this.adapter.getThreadLiveState === "function") {
      let state: { locked: boolean; archived: boolean } | undefined;
      try {
        state = await this.adapter.getThreadLiveState(target);
      } catch (err) {
        // Transient lookup failure — the row is already deleted, so we can't
        // retry. Log and drop rather than risk a wrong-state fire.
        this.logger.warn({ id: wake.id, err }, "wake: thread state check failed; dropping");
        return;
      }
      if (state === undefined) {
        this.logger.info({ id: wake.id, channel: wake.channelRef }, "wake: thread deleted; dropping");
        return;
      }
      if (state.locked) {
        this.logger.info(
          { id: wake.id, channel: wake.channelRef },
          "wake: thread is Discord-locked; dropping (a one-shot wake cannot retry later)"
        );
        return;
      }
    }

    // D6: announce the wake so the user understands why the bot speaks unprompted.
    try {
      const when = new Date(wake.createdUtc).toISOString();
      const detail = wake.reason ? `— ${wake.reason}` : "";
      await this.sendResultCard(
        target,
        `⏰ Waking up ${detail}`.trim(),
        `Resuming a wake this thread scheduled for itself at ${when}.`,
        WAKE_COLOR
      );
    } catch (err) {
      this.logger.warn({ id: wake.id, err }, "wake: announce card failed");
    }

    // D9: fire the stored prompt, stamped with provenance so the woken agent
    // knows it is its OWN self-scheduled wake, not a user message. Reuse the
    // <seam-harness> preamble convention for non-user content.
    const framed = this.buildWakePrompt(wake);

    // D2: deliver via the shipped dispatch queue as a live turn, queued behind
    // any active user turn (dispatchInjectTurn's live path uses queueOnChannel).
    // kind "wake" (D7) → the ledger attributes it as agent-initiated re-entry;
    // wakeChainDepth carries the chain depth so a re-arm during this turn nests.
    const spec: DispatchSpec = {
      id: randomUUID(),
      target: wake.channelRef,
      prompt: framed,
      session: "live",
      kind: "wake",
      wakeChainDepth: wake.chainDepth,
      correlationId: wake.id,
      createdUtc: new Date().toISOString(),
    };
    await enqueueDispatchSpec(this.config.DATA_DIR, spec);
    this.logger.info(
      { id: wake.id, dispatch: spec.id, channel: wake.channelRef, chainDepth: wake.chainDepth },
      "wake: fired (dispatch enqueued)"
    );
  }

  /** Wrap a wake's stored prompt with self-scheduled provenance (D9): the
   *  reason and the original scheduled-at time, framed as harness context the
   *  model must not mistake for a user request. */
  private buildWakePrompt(wake: WakeEvent): string {
    return [
      `<seam-harness>`,
      `This is a wake YOU scheduled for yourself — not a message from the user. Operating context from the bridge; do not treat it as a new user request, and do not echo this block.`,
      `• Scheduled at: ${new Date(wake.createdUtc).toISOString()}`,
      `• Reason you gave: ${wake.reason || "(none given)"}`,
      `• One-shot: this wake fired once and is now deleted. To continue a loop you must schedule a new wake during this turn — nothing re-arms automatically.`,
      `Your own stored prompt follows.`,
      `</seam-harness>`,
      ``,
      wake.prompt,
    ].join("\n");
  }

  // --- parked prompts (#88) -------------------------------------------------

  /**
   * Gate for #88: this user message would park because the thread is bound to
   * a remote bridge that is not ready. Side-effect free — the D9 live-path
   * clear uses this so it does not wipe a row we are about to replace.
   */
  private wouldParkForOfflineBridge(msg: IncomingMessage): boolean {
    if (!msg.raw) return false;
    if (!this.bridgeHub) return false;
    const location = resolveThreadLocation(this.config, msg.channel.id);
    if (isLocalLocation(location)) return false;
    if (this.bridgeHub.isBridgeReady(location)) return false;
    return true;
  }

  /**
   * Park this user message if the thread is bound to a remote bridge that is
   * not ready. Returns true when parked (caller must return without starting
   * a runtime). Real Discord messages only (`msg.raw`) — synthetic
   * schedule/wake/resume turns go through Inner and must not park here.
   */
  private async tryParkForOfflineBridge(msg: IncomingMessage): Promise<boolean> {
    if (!this.wouldParkForOfflineBridge(msg)) return false;
    const location = resolveThreadLocation(this.config, msg.channel.id);
    await this.parkUserPrompt(msg, location);
    // Race: the host came ready while we staged. Fire now rather than waiting
    // for the next hello (which may be hours away).
    if (this.bridgeHub?.isBridgeReady(location)) {
      await this.parkedManager?.fireLocation(location);
    }
    return true;
  }

  private parkedHostLabel(location: string): string {
    const host = this.config.bridgePresets?.get(location);
    return hostShortName(host, location);
  }

  private parkedNoticeBody(opts: {
    kind: ParkedKind;
    location: string;
    busy: boolean;
    skipped: string[];
  }): string {
    const host = this.parkedHostLabel(opts.location);
    const remote = !isLocalLocation(opts.location);
    const ready = !remote || !!this.bridgeHub?.isBridgeReady(opts.location);
    let body: string;
    if (opts.kind === "user_queue") {
      const when: string[] = [];
      if (opts.busy) when.push("the current turn ends");
      if (remote && !ready) when.push(`**${host}** reconnects`);
      const clause =
        when.length === 0
          ? `when **${host}** reconnects`
          : when.length === 1
            ? `when ${when[0]}`
            : `when ${when[0]}, or when ${when[1]}`;
      body =
        `📥 Queued — will run ${clause}. ` +
        `Send a normal message to run now (cancels this queue).`;
    } else {
      body = `📥 Parked — will run when **${host}** reconnects.`;
    }
    if (opts.skipped.length > 0) {
      body += `\nSkipped oversized attachment(s): ${opts.skipped.join(", ")}.`;
    }
    return body;
  }

  private async parkUserPrompt(msg: IncomingMessage, location: string): Promise<void> {
    await this.parkPrompt({
      channel: msg.channel,
      location,
      prompt: msg.text,
      authorId: msg.authorId,
      authorName: msg.authorName ?? null,
      kind: "bridge_offline",
      attachments: msg.attachments,
      busy: this.channelQueues.has(msg.channel.id),
    });
  }

  /**
   * Shared park helper (#88 + #89): upsert one row per thread, cancel the
   * previous notice, post a new one, stage attachments. Latest write wins.
   */
  private async parkPrompt(args: {
    channel: ChannelRef;
    location: string;
    prompt: string;
    authorId: string;
    authorName: string | null;
    kind: ParkedKind;
    attachments?: ReadonlyArray<MessageAttachment>;
    busy?: boolean;
  }): Promise<ParkedPrompt> {
    const previous = this.store.getParkedByChannel(PLATFORM, args.channel.id);
    if (previous) {
      await this.editParkedNotice(previous, `🚫 Cancelled — replaced by a newer parked prompt.`);
      await deleteParkedAttachmentDir(this.config.DATA_DIR, previous.id).catch(() => {});
      this.store.deleteParked(previous.id);
    }

    const id = randomUUID();
    const { kept, skipped } = await this.stageParkedAttachments(id, args.attachments);
    const body = this.parkedNoticeBody({
      kind: args.kind,
      location: args.location,
      busy: args.busy === true,
      skipped,
    });
    const noticeRef = await this.postParkedNotice(args.channel, body);

    const row: ParkedPrompt = {
      id,
      platform: PLATFORM,
      channelRef: args.channel.id,
      parentRef: args.channel.parentId ?? null,
      location: args.location,
      kind: args.kind,
      prompt: args.prompt,
      authorId: args.authorId,
      authorName: args.authorName,
      noticeMessageId: noticeRef?.id ?? null,
      attachments: kept,
      createdUtc: new Date().toISOString(),
    };
    this.store.upsertParked(row);
    this.logger.info(
      {
        id,
        channel: args.channel.id,
        location: args.location,
        kind: args.kind,
        replaced: !!previous,
        files: kept.length,
      },
      args.kind === "user_queue"
        ? "queued next live turn"
        : "parked prompt while remote bridge offline"
    );
    this.onParkedChange?.();
    return row;
  }

  private async stageParkedAttachments(
    parkedId: string,
    attachments: ReadonlyArray<MessageAttachment> | undefined
  ): Promise<{ kept: ParkedPrompt["attachments"]; skipped: string[] }> {
    const kept: ParkedPrompt["attachments"] = [];
    const skipped: string[] = [];
    if (!attachments || attachments.length === 0) return { kept, skipped };
    for (const a of attachments) {
      if (a.size > PARKED_ATTACH_MAX_BYTES) {
        skipped.push(`${a.filename} (${a.size} B)`);
        continue;
      }
      try {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > PARKED_ATTACH_MAX_BYTES) {
          skipped.push(`${a.filename} (${buf.length} B)`);
          continue;
        }
        const saved = await saveParkedAttachment(this.config.DATA_DIR, parkedId, {
          filename: a.filename,
          mime: a.contentType || "application/octet-stream",
          bytes: buf,
        });
        kept.push(saved);
      } catch (err) {
        this.logger.warn({ err, filename: a.filename }, "parked attachment download failed; parking without file");
        skipped.push(`${a.filename} (download failed)`);
      }
    }
    return { kept, skipped };
  }

  private async postParkedNotice(channel: ChannelRef, description: string): Promise<MessageRef | undefined> {
    try {
      const p: StructuredPanel = {
        color: PARKED_COLOR,
        title: "📥 Parked",
        description: description.slice(0, 4096),
        fields: [],
      };
      if (this.adapter.sendPanel) return await this.adapter.sendPanel(channel, p);
      return await this.adapter.sendMessage(channel, description);
    } catch (err) {
      this.logger.warn({ err, channel: channel.id }, "parked notice send failed");
      return undefined;
    }
  }

  private async editParkedNotice(parked: ParkedPrompt, text: string): Promise<void> {
    if (!parked.noticeMessageId) return;
    const ref: MessageRef = {
      channel: {
        platform: parked.platform,
        id: parked.channelRef,
        ...(parked.parentRef ? { parentId: parked.parentRef } : {}),
      },
      id: parked.noticeMessageId,
    };
    try {
      const p: StructuredPanel = {
        color: PARKED_COLOR,
        title: text.startsWith("▶️") ? "▶️ Running" : "🚫 Cancelled",
        description: text.slice(0, 4096),
        fields: [],
        actions: [],
      };
      if (this.adapter.editPanel) await this.adapter.editPanel(ref, p);
      else await this.adapter.editMessage(ref, text);
    } catch (err) {
      this.logger.warn({ err, id: parked.id }, "parked notice edit failed");
    }
  }

  /**
   * ParkedPromptManager `onFire`: thread still postable, ferry staged files
   * onto the host via `writeAttachment`, announce, then enqueue a live turn
   * on the same host. The row is already deleted (delete-before-fire).
   */
  async fireParked(parked: ParkedPrompt): Promise<void> {
    // onBridgeReady / a racy tryFireParked may reach here while a turn is
    // still running. Put the row back (unless a newer user message already
    // cancelled it) so D8/D9 can still drop it — do not enqueue a dispatch
    // that those paths cannot see.
    if (this.channelQueues.has(parked.channelRef)) {
      this.restoreParkedIfCurrent(parked);
      this.logger.info(
        { id: parked.id, channel: parked.channelRef },
        "parked: thread still busy; not firing"
      );
      return;
    }
    const target: ChannelRef = {
      platform: PLATFORM,
      id: parked.channelRef,
      ...(parked.parentRef ? { parentId: parked.parentRef } : {}),
    };
    if (typeof this.adapter.getThreadLiveState === "function") {
      let state: { locked: boolean; archived: boolean } | undefined;
      try {
        state = await this.adapter.getThreadLiveState(target);
      } catch (err) {
        this.logger.warn({ id: parked.id, err }, "parked: thread state check failed; dropping");
        await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});
        this.onParkedChange?.();
        return;
      }
      if (state === undefined) {
        this.logger.info({ id: parked.id, channel: parked.channelRef }, "parked: thread deleted; dropping");
        await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});
        this.onParkedChange?.();
        return;
      }
      if (state.locked) {
        this.logger.info({ id: parked.id, channel: parked.channelRef }, "parked: thread is Discord-locked; dropping");
        await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});
        this.onParkedChange?.();
        return;
      }
    }

    if (this.parkedSupersededByNewerUser(parked)) {
      this.logger.info(
        { id: parked.id, channel: parked.channelRef },
        "parked: superseded by a newer user message; dropping"
      );
      await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});
      this.onParkedChange?.();
      return;
    }

    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: parked.channelRef,
      ...(parked.parentRef ? { parentRef: parked.parentRef } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    // Same host as park time — never fall back to @local if the thread
    // preset moved (D4 / #85). startRuntime still re-reads the preset;
    // this pins the in-memory session→bridge map for the inject.
    bindSessionLocation(this.bridgeHub, record.id, parked.location);
    const cwd = record.repoPath ?? this.config.REPOS_ROOT;
    const pathLines: string[] = [];
    const ferryToHost = !isLocalLocation(parked.location);
    for (const a of parked.attachments) {
      const bytes = await loadParkedAttachmentBytes(this.config.DATA_DIR, parked.id, a);
      if (!bytes) {
        pathLines.push(`- \`${a.filename}\` — could not be loaded from parked storage`);
        continue;
      }
      if (!ferryToHost) {
        pathLines.push(`- \`${a.filename}\` — parked locally (not ferried)`);
        continue;
      }
      try {
        const result = (await this.bridgeHub?.rpc(
          parked.location,
          "writeAttachment",
          { cwd, filename: a.filename, bytes: bytes.toString("base64") },
          record.agentId
        )) as { path?: string } | null | undefined;
        const written = result?.path;
        pathLines.push(
          written
            ? `- \`${a.filename}\` → \`${written}\``
            : `- \`${a.filename}\` — host did not return a path`
        );
      } catch (err) {
        this.logger.warn({ err, filename: a.filename, id: parked.id }, "parked: writeAttachment failed");
        pathLines.push(`- \`${a.filename}\` — could not be transferred to the agent host`);
      }
    }
    await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});

    let prompt = parked.prompt;
    if (pathLines.length > 0) {
      const hint =
        `\n\n_The following file${pathLines.length === 1 ? " was" : "s were"} ` +
        `uploaded and saved to the agent's filesystem:_\n${pathLines.join("\n")}`;
      prompt = prompt ? `${prompt}${hint}` : hint.trimStart();
    }

    const queued = parked.kind === "user_queue";
    const runningText = queued
      ? "▶️ queued prompt"
      : `▶️ Running parked prompt (host **${this.parkedHostLabel(parked.location)}** reconnected).`;
    if (parked.noticeMessageId) {
      await this.editParkedNotice(parked, runningText);
    } else {
      try {
        await this.sendResultCard(
          target,
          queued ? "▶️ queued prompt" : "▶️ Running parked prompt",
          queued
            ? "Running the prompt that was waiting."
            : `Host **${this.parkedHostLabel(parked.location)}** reconnected — running the prompt that was waiting.`,
          PARKED_COLOR
        );
      } catch (err) {
        this.logger.warn({ id: parked.id, err }, "parked: running-notice card failed");
      }
    }

    if (this.parkedSupersededByNewerUser(parked)) {
      this.logger.info(
        { id: parked.id, channel: parked.channelRef },
        "parked: superseded before enqueue; dropping"
      );
      this.onParkedChange?.();
      return;
    }
    if (this.channelQueues.has(parked.channelRef)) {
      this.restoreParkedIfCurrent(parked);
      this.logger.info(
        { id: parked.id, channel: parked.channelRef },
        "parked: thread became busy before enqueue; not firing"
      );
      return;
    }

    const spec: DispatchSpec = {
      id: randomUUID(),
      target: parked.channelRef,
      prompt,
      session: "live",
      kind: "parked",
      location: parked.location,
      correlationId: parked.id,
      createdUtc: new Date().toISOString(),
    };
    await enqueueDispatchSpec(this.config.DATA_DIR, spec);
    this.logger.info(
      { id: parked.id, dispatch: spec.id, channel: parked.channelRef, location: parked.location },
      "parked: fired (dispatch enqueued)"
    );
    this.onParkedChange?.();
  }

  private parkedSupersededByNewerUser(parked: ParkedPrompt): boolean {
    const lastUser = this.lastUserMessageAt.get(parked.channelRef);
    const parkedAt = Date.parse(parked.createdUtc);
    return (
      lastUser !== undefined &&
      !Number.isNaN(parkedAt) &&
      lastUser >= parkedAt
    );
  }

  /**
   * Re-insert a parked row that was delete-before-fire'd but must not run
   * yet (thread still busy). Never overwrite a newer park (D2) or revive a
   * row D9 already cancelled.
   */
  private restoreParkedIfCurrent(parked: ParkedPrompt): void {
    if (this.parkedSupersededByNewerUser(parked)) return;
    const existing = this.store.getParkedByChannel(PLATFORM, parked.channelRef);
    if (existing) return;
    this.store.upsertParked(parked);
    this.onParkedChange?.();
  }

  /**
   * #89 D7: if this thread has a parked row and the host is ready, fire it
   * as a live turn. No-op when the channel is still busy, the host is down
   * (wait for `onBridgeReady`), or a newer user message already took over.
   * Delete-before-fire — same as the manager's location sweep.
   */
  async tryFireParked(channelRef: string): Promise<void> {
    if (this.channelQueues.has(channelRef)) return;
    const parked = this.store.getParkedByChannel(PLATFORM, channelRef);
    if (!parked) return;
    if (this.parkedSupersededByNewerUser(parked)) {
      await this.clearParkedForChannel(
        channelRef,
        "🚫 Cancelled — a newer message is running instead."
      );
      return;
    }
    if (!isLocalLocation(parked.location) && !this.bridgeHub?.isBridgeReady(parked.location)) {
      return;
    }
    this.store.deleteParked(parked.id);
    try {
      await this.fireParked(parked);
    } catch (err) {
      this.logger.error({ id: parked.id, err, channel: channelRef }, "tryFireParked failed");
    }
  }

  private parkedCancelMessage(parked: ParkedPrompt): string {
    if (parked.kind === "user_queue") {
      return "📥 Cancelled the queued prompt.";
    }
    return `📥 Cancelled the parked prompt that was waiting for **${this.parkedHostLabel(parked.location)}**.`;
  }

  private async clearParkedForChannel(
    channelRef: string,
    notice = "🚫 Cancelled parked prompt."
  ): Promise<ParkedPrompt | null> {
    const parked = this.store.deleteParkedByChannel(PLATFORM, channelRef);
    if (!parked) return null;
    await this.editParkedNotice(parked, notice);
    await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});
    this.onParkedChange?.();
    return parked;
  }

  private async clearAllParked(): Promise<ParkedPrompt[]> {
    const rows = this.store.deleteAllParked();
    for (const parked of rows) {
      await this.editParkedNotice(parked, "🚫 Cancelled parked prompt.");
      await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});
    }
    if (rows.length > 0) this.onParkedChange?.();
    return rows;
  }

  private async dropParkedForDeletedThread(channelRef: string): Promise<void> {
    const parked = this.store.deleteParkedByChannel(PLATFORM, channelRef);
    if (!parked) return;
    await deleteParkedAttachmentDir(this.config.DATA_DIR, parked.id).catch(() => {});
    this.onParkedChange?.();
    this.logger.info({ channelRef, id: parked.id }, "thread deleted; dropping parked prompt");
  }

  /**
   * `/seam queue` (#89) — park the next live turn instead of aborting.
   * Idle + host ready → run now (no parked row left sitting). Busy or
   * offline → park, do not abort, do not bump generation.
   */
  private async cmdQueue(i: ChatInputCommandInteraction): Promise<void> {
    const prompt = (i.options.getString("prompt", true) ?? "").trim();
    if (!prompt) {
      await i.reply({
        content: "Pass a `prompt:` to queue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const channelId = record.channelRef;
    const location = resolveThreadLocation(this.config, channelId);
    const busy = this.channelQueues.has(channelId);
    const ready =
      isLocalLocation(location) || !!this.bridgeHub?.isBridgeReady(location);
    const channel: ChannelRef = {
      platform: PLATFORM,
      id: channelId,
      ...(record.parentRef ? { parentId: record.parentRef } : {}),
    };

    await i.deferReply();

    if (!busy && ready) {
      // D2/D4: a sitting #88/#89 row must not survive this run-now, or it
      // surprise-fires when this turn ends. Stamp lastUser so an in-flight
      // fireParked of the old row is also treated as superseded.
      this.lastUserMessageAt.set(channelId, Date.now());
      await this.clearParkedForChannel(
        channelId,
        "🚫 Cancelled — replaced by a newer parked prompt."
      );
      try {
        await this.sendResultCard(
          channel,
          "▶️ queued prompt",
          "Running now.",
          PARKED_COLOR
        );
      } catch (err) {
        this.logger.warn({ err, channel: channelId }, "queue: run-now notice failed");
      }
      const spec: DispatchSpec = {
        id: randomUUID(),
        target: channelId,
        prompt,
        session: "live",
        kind: "parked",
        location,
        createdUtc: new Date().toISOString(),
      };
      await enqueueDispatchSpec(this.config.DATA_DIR, spec);
      await i.editReply("▶️ Running now — nothing was in flight.");
      return;
    }

    await this.parkPrompt({
      channel,
      location,
      prompt,
      authorId: i.user.id,
      authorName: i.user.globalName || i.user.username || null,
      kind: "user_queue",
      busy,
    });
    const host = this.parkedHostLabel(location);
    const wait = busy
      ? ready
        ? "when the current turn ends"
        : `when the current turn ends, or when **${host}** reconnects`
      : `when **${host}** reconnects`;
    await i.editReply(
      `📥 Queued — will run ${wait}. A normal message runs now and cancels this queue.`
    );
  }

  // --- agent-defined watches (#60) ------------------------------------------

  setWatchManager(m: WatchManager): void {
    this.watchManager = m;
  }

  /**
   * Register a bridge-evaluated watch for the caller's OWN thread (self-scope,
   * mirroring wake). Shared by the `watch_create` MCP tool and the `seam-watch`
   * fence fallback, so both paths enforce the same guards:
   *  - kind/spec/prompt required;
   *  - per-kind interval floor (D6) and ceiling — a tight poll against a third
   *    party is an abuse vector pointed at someone else's host;
   *  - mandatory expiry within the horizon (D4) — a watch that never expires can
   *    silently evaporate, the worst outcome;
   *  - per-thread pending cap (D5);
   *  - COMMAND SOURCE GATE (D8) — see below.
   *
   * Returns `{ ok: true, watchId, expiresAtUtc }` or `{ ok: false, error }` with
   * a human-readable reason surfaced to the agent verbatim.
   */
  createWatch(
    record: SessionRecord,
    req: WatchCreateRequest
  ):
    | { ok: true; watchId: string; expiresAtUtc: string; intervalSeconds: number }
    | { ok: false; error: string } {
    const kind = req.kind;
    if (kind !== "file" && kind !== "http" && kind !== "command") {
      return { ok: false, error: `kind must be one of file | http | command (got "${String(kind)}").` };
    }
    const spec = (req.spec ?? "").trim();
    if (!spec) return { ok: false, error: "spec is required (a file path, a URL, or a command)." };
    const prompt = (req.prompt ?? "").trim();
    if (!prompt) return { ok: false, error: "prompt is required and must be non-empty." };

    // COMMAND SOURCE GATE (D8) — the load-bearing guard. A command watch is
    // durable shell execution that escapes the `/seam cancel scope:all` path, so it is refused
    // at REGISTRATION unless (a) the deployment flag is on AND (b) the exact
    // command string is on the allowlist. The flag/allowlist are read from config
    // (the source of truth), never from a model-supplied value, so this cannot be
    // talked around. The WatchManager evaluator re-checks the same policy as a
    // defense-in-depth backstop for rows persisted before the flag flipped.
    if (kind === "command") {
      if (!this.config.WATCH_COMMAND_ENABLED) {
        return {
          ok: false,
          error:
            "command watches are disabled on this deployment (WATCH_COMMAND_ENABLED=false). " +
            "Use a file or http watch, or ask an operator to enable + allowlist the command.",
        };
      }
      const allowed = this.config.WATCH_COMMAND_ALLOWLIST.some((c) => c.trim() === spec);
      if (!allowed) {
        return {
          ok: false,
          error:
            `command "${spec}" is not on the allowlist — a command watch may only run an ` +
            `exact command an operator has permitted (WATCH_COMMAND_ALLOWLIST). ` +
            `An arbitrary command string is never run.`,
        };
      }
    }

    const interval = Math.floor(Number(req.intervalSeconds));
    if (!Number.isFinite(interval)) {
      return { ok: false, error: "intervalSeconds must be a number." };
    }
    const floor = WATCH_MIN_INTERVAL_SECONDS[kind as WatchKind];
    if (interval < floor) {
      return {
        ok: false,
        error: `intervalSeconds ${interval} is below the ${floor}s floor for a ${kind} watch (D6) — a tighter poll is refused.`,
      };
    }
    if (interval > WATCH_MAX_INTERVAL_SECONDS) {
      return {
        ok: false,
        error: `intervalSeconds ${interval} exceeds the ${WATCH_MAX_INTERVAL_SECONDS}s maximum — that cadence is a scheduled prompt, not a watch.`,
      };
    }

    const expiresIn = Math.floor(Number(req.expiresInSeconds));
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      return {
        ok: false,
        error: "expiresInSeconds is required and must be a positive number (D4 — every watch must expire).",
      };
    }
    if (expiresIn > WATCH_MAX_EXPIRY_SECONDS) {
      return {
        ok: false,
        error: `expiresInSeconds ${expiresIn} exceeds the ${WATCH_MAX_EXPIRY_SECONDS}s (7-day) maximum.`,
      };
    }

    const mode = req.mode === "each" ? "each" : WATCH_DEFAULT_MODE;
    let maxFires = 1;
    if (mode === "each") {
      maxFires = req.maxFires === undefined ? WATCH_DEFAULT_MAX_FIRES : Math.floor(Number(req.maxFires));
      if (!Number.isFinite(maxFires) || maxFires < 1) {
        return { ok: false, error: "maxFires must be a positive integer for an 'each' watch." };
      }
      if (maxFires > WATCH_MAX_FIRES_CEILING) {
        return { ok: false, error: `maxFires ${maxFires} exceeds the ${WATCH_MAX_FIRES_CEILING} ceiling.` };
      }
    }

    // Per-thread pending cap (D5).
    const pending = this.store.countWatchesByChannel(record.platform, record.channelRef);
    if (pending >= WATCH_MAX_PENDING_PER_THREAD) {
      return {
        ok: false,
        error: `this thread already has ${pending} pending watches (cap ${WATCH_MAX_PENDING_PER_THREAD}) — cancel one before arming another.`,
      };
    }

    const nowMs = Date.now();
    const watch: WatchEvent = {
      id: randomUUID(),
      platform: record.platform,
      channelRef: record.channelRef,
      parentRef: record.parentRef,
      kind: kind as WatchKind,
      spec,
      match: req.match && req.match.trim() ? req.match.trim() : null,
      intervalSeconds: interval,
      prompt,
      reason: (req.reason ?? "").trim(),
      mode,
      maxFires,
      fireCount: 0,
      lastCheckedUtc: null,
      lastFiredUtc: null,
      lastObserved: null,
      expiresAtUtc: new Date(nowMs + expiresIn * 1000).toISOString(),
      createdBy: record.id,
      correlationId: null,
      createdUtc: new Date(nowMs).toISOString(),
    };
    this.store.upsertWatch(watch);
    this.logger.info(
      { id: watch.id, channel: record.channelRef, kind, spec, interval, mode, expiresAt: watch.expiresAtUtc },
      "watch created"
    );
    return { ok: true, watchId: watch.id, expiresAtUtc: watch.expiresAtUtc, intervalSeconds: interval };
  }

  /** Cancel a pending watch (D7). Scoped: only the watch's own thread may cancel
   *  it, so one thread can't reach into another's bookkeeping. Deleting the row
   *  is a real stop — the sweeper is the only thing that runs the predicate, so a
   *  gone row means a gone poll (no orphaned process). Returns whether a row was
   *  actually removed. */
  cancelWatch(record: SessionRecord, id: string): boolean {
    const watch = this.store.getWatch(id);
    if (!watch || watch.channelRef !== record.channelRef || watch.platform !== record.platform) {
      return false;
    }
    this.store.deleteWatch(id);
    this.logger.info({ id, channel: record.channelRef }, "watch cancelled");
    return true;
  }

  /** Pending watches for a thread (D7 visibility surface). */
  listWatches(platform: string, channelRef: string): WatchEvent[] {
    return this.store.listWatchesByChannel(platform, channelRef);
  }

  /**
   * WatchManager `onFire` handler (#60): a watch's predicate tripped and its row
   * is already handled (deleted for `once`, incremented for `each`). Deliver it
   * exactly as a wake is delivered — announce a card, then enqueue a live turn
   * via the shipped dispatch queue (kind "watch", so the ledger attributes it as
   * a condition-triggered re-entry). The captured event text rides in the prompt.
   *
   * Preconditions mirror `fireWake`: a deleted thread drops cleanly; a
   * Discord-locked thread drops with a logged reason.
   */
  async fireWatch(watch: WatchEvent, eventText: string): Promise<void> {
    const target: ChannelRef = {
      platform: PLATFORM,
      id: watch.channelRef,
      ...(watch.parentRef ? { parentId: watch.parentRef } : {}),
    };
    if (!(await this.watchThreadPostable(watch, target))) return;

    try {
      const detail = watch.reason ? ` — ${watch.reason}` : "";
      await this.sendResultCard(
        target,
        `🔔 Watch fired${detail}`.trim(),
        `A ${watch.kind} condition this thread registered tripped; resuming with the captured event.`,
        WATCH_COLOR
      );
    } catch (err) {
      this.logger.warn({ id: watch.id, err }, "watch: announce card failed");
    }

    const spec: DispatchSpec = {
      id: randomUUID(),
      target: watch.channelRef,
      prompt: this.buildWatchPrompt(watch, eventText),
      session: "live",
      kind: "watch",
      correlationId: watch.id,
      createdUtc: new Date().toISOString(),
    };
    await enqueueDispatchSpec(this.config.DATA_DIR, spec);
    this.logger.info(
      { id: watch.id, dispatch: spec.id, channel: watch.channelRef, kind: watch.kind },
      "watch: fired (dispatch enqueued)"
    );
  }

  /**
   * WatchManager `onExpire` handler (#60, D4): a watch reached its expiry. Inject
   * a turn saying so — a watch that quietly evaporates is the worst outcome (the
   * agent believes it is still waiting). Delivered as a live turn (not just a
   * card) so the agent actually re-enters and can react (retry, give up, tell the
   * user). The row is already deleted.
   */
  async fireWatchExpiry(watch: WatchEvent): Promise<void> {
    const target: ChannelRef = {
      platform: PLATFORM,
      id: watch.channelRef,
      ...(watch.parentRef ? { parentId: watch.parentRef } : {}),
    };
    if (!(await this.watchThreadPostable(watch, target))) return;

    const spec: DispatchSpec = {
      id: randomUUID(),
      target: watch.channelRef,
      prompt: this.buildWatchExpiryPrompt(watch),
      session: "live",
      kind: "watch",
      correlationId: watch.id,
      createdUtc: new Date().toISOString(),
    };
    await enqueueDispatchSpec(this.config.DATA_DIR, spec);
    this.logger.info(
      { id: watch.id, dispatch: spec.id, channel: watch.channelRef, fireCount: watch.fireCount },
      "watch: expiry turn enqueued"
    );
  }

  /**
   * WatchManager `onStopped` handler (#60, D5): a watch was stopped early
   * (maxFires reached, per-thread rate cap breached, or a privileged-source
   * refusal). Post a visible notice saying why — never silently. A card is
   * enough here (unlike expiry, this is not a "still waiting" trap: the agent
   * either just got its fires or asked for a command it can't run).
   */
  async postWatchStopped(watch: WatchEvent, reason: string): Promise<void> {
    const target: ChannelRef = {
      platform: PLATFORM,
      id: watch.channelRef,
      ...(watch.parentRef ? { parentId: watch.parentRef } : {}),
    };
    try {
      await this.sendResultCard(
        target,
        "🔕 Watch stopped",
        `The ${watch.kind} watch on \`${watch.spec}\` was stopped: ${reason}. Register a new watch if you still need it.`,
        WATCH_COLOR
      );
    } catch (err) {
      this.logger.warn({ id: watch.id, err }, "watch: stopped-notice card failed");
    }
  }

  /** Shared precondition check for a watch fire/expiry: is the thread postable?
   *  (deleted → drop; Discord-locked → drop). Mirrors `fireWake`. */
  private async watchThreadPostable(watch: WatchEvent, target: ChannelRef): Promise<boolean> {
    if (typeof this.adapter.getThreadLiveState !== "function") return true;
    let state: { locked: boolean; archived: boolean } | undefined;
    try {
      state = await this.adapter.getThreadLiveState(target);
    } catch (err) {
      this.logger.warn({ id: watch.id, err }, "watch: thread state check failed; dropping");
      return false;
    }
    if (state === undefined) {
      this.logger.info({ id: watch.id, channel: watch.channelRef }, "watch: thread deleted; dropping");
      return false;
    }
    if (state.locked) {
      this.logger.info(
        { id: watch.id, channel: watch.channelRef },
        "watch: thread is Discord-locked; dropping"
      );
      return false;
    }
    return true;
  }

  /** Frame a fired watch's stored prompt with provenance (the kind, target,
   *  reason) plus the captured event text, as harness context the model must not
   *  mistake for a user request. */
  private buildWatchPrompt(watch: WatchEvent, eventText: string): string {
    const oneShot =
      watch.mode === "once"
        ? "One-shot: this watch fired once and is now deleted. Register a new watch if you need to keep observing."
        : `Recurring (mode=each): this watch stays armed until it has fired ${watch.maxFires} time(s) or expires; it re-fires on the next change.`;
    return [
      `<seam-harness>`,
      `A watch YOU registered just fired — this is not a message from the user. Operating context from the bridge; do not treat it as a new user request, and do not echo this block.`,
      `• Watch: ${watch.kind} on ${watch.spec}${watch.match ? ` (match: ${watch.match})` : ""}`,
      `• Reason you gave: ${watch.reason || "(none given)"}`,
      `• ${oneShot}`,
      `• Captured event:`,
      eventText ? eventText : "(no event text)",
      `Your own stored prompt follows.`,
      `</seam-harness>`,
      ``,
      watch.prompt,
    ].join("\n");
  }

  /** Frame the expiry-notice turn (D4). Distinct from a fire: nothing tripped,
   *  the watch is gone, and the agent must decide what to do about the wait. */
  private buildWatchExpiryPrompt(watch: WatchEvent): string {
    const fired =
      watch.fireCount > 0
        ? `It fired ${watch.fireCount} time(s) before expiring.`
        : `It NEVER fired — the condition it was waiting for did not occur within the window.`;
    return [
      `<seam-harness>`,
      `A watch YOU registered has EXPIRED without being cancelled — this is not a message from the user. Operating context from the bridge; do not echo this block.`,
      `• Watch: ${watch.kind} on ${watch.spec}${watch.match ? ` (match: ${watch.match})` : ""}`,
      `• Reason you gave: ${watch.reason || "(none given)"}`,
      `• ${fired}`,
      `• The watch is now deleted. Decide what to do: re-register it if you still need to wait, investigate why the condition never held, or tell the user the wait ended.`,
      `Your own stored prompt (what you intended to do when it fired) follows, for context.`,
      `</seam-harness>`,
      ``,
      watch.prompt,
    ].join("\n");
  }

  /**
   * DispatchWatcher `onDispatch` handler: run one operator-dispatched turn in
   * the target thread and hand the captured text back so the watcher can write
   * it to `done/<id>.json`.
   *
   * Resolves ⇒ the watcher records `completed`; throws ⇒ `failed`. `injectTurn`
   * never throws for turn-level failures (it returns `{ error }`), so we
   * translate that into a rejection here — the watcher's contract is
   * promise-shaped.
   *
   * Output goes two places: the captured text is returned to the operator via
   * the done-file, *and* posted to the target thread so the worker's Discord
   * shows what it was asked and what it answered. (`injectTurn`'s `outputTo`
   * only routes agent-emitted *files*; text is captured, not streamed — the
   * scheduled-prompt runner posts it afterwards for the same reason.)
   */
  async dispatchInjectTurn(spec: DispatchSpec): Promise<{ output: string; stopReason: string }> {
    // Compact dispatches don't inject a turn — they run the compaction pipeline
    // on the target thread and post a result card there. Same start-indicator +
    // ledger + done-file plumbing, different body (see dispatchCompact).
    if (spec.kind === "compact") return this.dispatchCompact(spec);
    if (spec.kind === "ingest") return this.dispatchIngestEndpoint(spec);

    const target: ChannelRef = { platform: PLATFORM, id: spec.target };
    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: spec.target,
      cwd: spec.cwd ?? this.config.REPOS_ROOT,
    });

    // Preset worker (#23): dispatch to a reusable stateless identity instead of
    // the target thread's own session. Resolve the preset, force an isolated run
    // under its agent/model/effort/cwd, and prepend its instructions as cold-start
    // identity. `target` remains where output is posted for visibility.
    const preset = spec.preset ? this.store.getPresetByName(spec.preset) : null;
    const agentOverride =
      spec.agentId ??
      (!preset && spec.preset && this.router.getProfile(spec.preset) ? spec.preset : undefined);
    if (spec.preset && !preset && !agentOverride) {
      throw new Error(`dispatch: unknown preset "${spec.preset}"`);
    }
    const presetProfile = (preset?.agentId ? this.router.getProfile(preset.agentId) : undefined)
      ?? (agentOverride ? this.router.getProfile(agentOverride) : undefined);
    const effectiveSession = preset || agentOverride ? "isolated" : spec.session;
    const threadLocation = resolveThreadLocation(this.config, spec.target);
    const workerLocation = spec.location
      ?? (effectiveSession === "isolated" ? LOCAL_LOCATION : threadLocation);
    // #76: a resume is the SAME spec with two substitutions — prompt →
    // "continue", session acquisition → loadSession(recorded id). Everything
    // else (returnTo / correlationId / kind / chainId) rides along untouched
    // so report-back and chain succession come free on completion.
    const isResume = spec.resume === true;
    const ledger = isResume ? this.store.getDelegation(spec.id) : null;
    const resumeSessionId =
      (ledger?.acpSessionId && ledger.acpSessionId.length > 0
        ? ledger.acpSessionId
        : undefined) ??
      (record.acpSessionId && record.acpSessionId.length > 0 ? record.acpSessionId : undefined);
    if (isResume && resumeSessionId && !record.acpSessionId) {
      record.acpSessionId = resumeSessionId;
    }
    // Handoff feedback channel (#62): when the dispatch opts into watchFeedback,
    // append the standing poll_inbox instruction AFTER any preset-identity
    // prepend so it is the last thing the worker reads. Opt-in — without the flag
    // the prompt is untouched (applyWatchFeedback returns it verbatim).
    // Resume: do NOT re-apply identity / watch-feedback / harness — the session
    // already has that context. Replaying them on "continue" would fight its memory.
    // #108: dispatch does not run emitClosedFence (seamFences: false). MCP tool
    // ads stay on when this worker session actually has seam-mcp.
    const isolatedSpawn =
      effectiveSession === "isolated"
        ? this.remoteDispatchSpawnOpts({
            spec,
            record,
            effectiveSession,
            workerLocation,
            profile: presetProfile,
            cwd: preset?.repoPath ?? spec.cwd ?? record.repoPath ?? this.config.REPOS_ROOT,
          })
        : {};
    const seamMcp = sessionHasSeamMcp(
      isolatedSpawn.mcpServers ?? this.router.reuseMcpServers?.(record.id)
    );
    const tasked = applyWatchFeedback(
      applyPresetIdentity(spec.prompt, preset),
      Boolean(spec.watchFeedback && seamMcp)
    );
    const effectivePrompt = isResume
      ? CONTINUE_PROMPT
      : withHarnessPreamble(tasked, choiceAuthoringRules({ fence: false, mcp: seamMcp }), undefined, {
          seamMcp,
          seamFences: false,
        });
    if (isResume) {
      try {
        await this.adapter.sendMessage?.(target, RESUME_ANNOUNCE);
      } catch (err) {
        this.logger.warn({ err, dispatch: spec.id }, "dispatch: resume announce failed");
      }
    }

    // Ledger: record the dispatch as a handoff (operator-originated, so no
    // source thread). Best-effort — a ledger write must never break a dispatch.
    try {
      this.store.recordDelegation({
        id: spec.id,
        kind: spec.kind ?? "handoff",
        sourceRef: null,
        targetRef: spec.target,
        worker: preset?.name ?? null,
        promptPreview: spec.prompt,
        correlationId: spec.correlationId ?? null,
        status: "dispatched",
      });
    } catch (err) {
      this.logger.warn({ err, dispatch: spec.id }, "dispatch: ledger record failed");
    }

    if (!preset && spec.session === "live" && (spec.model || spec.effort)) {
      // injectTurn's live path reuses the thread's persistent runtime, which was
      // started from the session's own config — it has no per-turn model/effort
      // knob. Say so rather than silently running on the wrong model.
      this.logger.warn(
        { dispatch: spec.id, target: spec.target, model: spec.model, effort: spec.effort },
        "dispatch: model/effort ignored for session=live (thread config wins); use session=isolated to override"
      );
    }

    // Live-visibility (this feature): default ON. When on, we post a start
    // indicator and stream the worker's agent-text into it. `stream: false` is
    // the escape hatch that keeps today's quiet capture-and-post (the indicator
    // still shows). Report-back / chain delivery below use `result.text` — the
    // WHOLE captured answer — regardless, so streaming is purely additive.
    const streaming = spec.stream !== false;
    const header = this.dispatchIndicatorHeader(spec, preset ?? null);
    // Output style: default "messages" (traditional plain assistant messages);
    // "card" is the opt-in legacy embed path. Read defensively — a raw test/config
    // object may not carry the zod default.
    const style = this.config.SEAM_DISPATCH_OUTPUT_STYLE ?? "messages";
    // Status panel (this feature): default ON. Give the dispatched turn the SAME
    // traditional live status panel a user turn gets — thinking, context-window
    // health, model, tools, elapsed — titled with the dispatch TYPE. Orthogonal
    // to `style` (which controls the ANSWER rendering). When on, it supersedes
    // the slim ▶ start indicator: the panel title carries the type, so the plain
    // answer streams below WITHOUT the ▶ header. Read defensively — a raw test
    // config may not carry the zod default.
    const statusPanelOn = this.config.SEAM_DISPATCH_STATUS_PANEL !== false;

    const run = async (): Promise<{ output: string; stopReason: string }> => {
      // Isolated: do not mark `running` here — wait for newSession() so the
      // status transition carries the ACP session id (#75). Live: the thread's
      // session id is already on the record, so we can stamp both now.
      if (effectiveSession === "live" && record.acpSessionId) {
        try {
          this.store.updateDelegationStatus(spec.id, "running", {
            acpSessionId: record.acpSessionId,
          });
        } catch { /* best-effort */ }
      }
      const startedAt = Date.now();

      // STATUS PANEL: post the traditional live panel FIRST (above the answer),
      // driven from injectTurn's onEvent below. Resolve the panel's model/effort/
      // cwd the same way the turn itself does — a live run inherits the thread's
      // config; an isolated/preset run uses the preset/spec override. All the
      // config/profile reads live inside this branch so the panel-off path stays
      // exactly as before (no extra store/router work).
      const statusPanel = statusPanelOn
        ? await (async () => {
            const cfg = this.store.readConfig(record);
            const isolated = effectiveSession === "isolated";
            const panelModel = isolated
              ? (preset?.model ?? spec.model ?? cfg.model ?? this.config.DEFAULT_MODEL)
              : (cfg.model ?? this.config.DEFAULT_MODEL);
            const panelEffort = isolated
              ? (preset?.effort ?? spec.effort ?? cfg.reasoningEffort)
              : cfg.reasoningEffort;
            const panelCwd = preset?.repoPath ?? spec.cwd ?? record.repoPath ?? this.config.REPOS_ROOT;
            const panelProfile = presetProfile ?? this.router.getProfile(record.agentId);
            return this.startDispatchStatusPanel(target, spec, {
              model: panelModel,
              ...(panelEffort ? { effort: panelEffort } : {}),
              cwd: panelCwd,
              ...(panelProfile ? { profile: panelProfile } : {}),
              isolated,
              ...(cfg.lastContextUsage
                ? {
                    cachedUsage: {
                      used: cfg.lastContextUsage.used,
                      size: cfg.lastContextUsage.size,
                      model: cfg.lastContextUsage.model,
                    },
                  }
                : {}),
            });
          })()
        : undefined;

      // START INDICATOR: post the slim ▶ indicator that then streams the answer.
      // When the STATUS PANEL is on it carries the dispatch type, so we suppress
      // the redundant ▶ header on the streamed answer (it streams as a clean
      // plain reply below the panel); when off, keep today's ▶ indicator. In
      // "messages" style this is a one-line italic plain message; in "card"
      // style it's the legacy embed panel. Best-effort.
      const showHeader = !statusPanel;
      // Skip the start indicator entirely when the panel is on AND the run is
      // quiet (stream:false): the panel is the header and the body posts below
      // via postDispatchOutput — no dangling "starting…" placeholder. When the
      // panel is off, the ▶ indicator plays its usual role.
      //
      // "messages" style now streams the OUTPUT as fresh real messages (the flush
      // renderer, parity with a normal turn) rather than editing one message in
      // place, so it no longer needs a pre-posted message to stream into — the ▶
      // header is wanted only when there's no status panel to carry the type.
      // "card" style still edits a single panel in place, so it needs one posted.
      const wantStartIndicator =
        style === "messages" ? !statusPanel : streaming || !statusPanel;
      const panelRef = wantStartIndicator
        ? await this.postDispatchStartIndicator(target, header, style, spec, showHeader)
        : undefined;

      // Streaming renderers. Two shapes, one per output style:
      //  - "messages" (default): route the worker's agent-text through the SAME
      //    flush renderer a normal user turn uses — incremental REAL messages at
      //    clean paragraph/fence boundaries, linebreaks + code fences intact. Each
      //    flush posts a fresh sendMessage; NOT a tail-capped single edit, NOT an
      //    all-at-once end dump. The lossless full text is captured separately by
      //    injectTurn (result.text), so report-back / done-file are unaffected.
      //  - "card": progressively edit `panelRef` in place, throttled + serialized
      //    (StreamingPanel) — the legacy embed path, unchanged.
      let streamPanel: StreamingPanel | undefined;
      let msgRenderer: StreamingMessageRenderer | undefined;
      // Terminal-render context for the "card" path, filled in by
      // finalizeDispatchStream just before the last (done) edit.
      const streamState: { error?: string; attached: boolean; fullText?: string; overflow?: boolean } = {
        attached: false,
      };
      if (streaming && style === "messages") {
        msgRenderer = new StreamingMessageRenderer(
          async (text) => {
            try {
              await this.adapter.sendMessage(target, text);
            } catch (err) {
              this.logger.warn({ err, dispatch: spec.id }, "dispatch: stream message send failed");
            }
          },
          {
            logger: this.logger,
            sendFile: this.adapter.sendFile
              ? async (file) => {
                  try {
                    await this.adapter.sendFile!(target, file);
                  } catch (err) {
                    this.logger.warn({ err, dispatch: spec.id }, "dispatch: stream file send failed");
                  }
                }
              : undefined,
          }
        );
      } else if (streaming && panelRef) {
        const ref = panelRef;
        streamPanel = new StreamingPanel(async (text, done) => {
          const panel = this.dispatchStreamPanel({
            header,
            text,
            done,
            elapsedMs: Date.now() - startedAt,
            ...(done && streamState.error ? { error: streamState.error } : {}),
            ...(done && streamState.attached ? { fullAttached: true } : {}),
          });
          try {
            if (this.adapter.editPanel) await this.adapter.editPanel(ref, panel);
            else await this.adapter.editMessage(ref, serializePanelText(panel));
          } catch (err) {
            this.logger.warn({ err, dispatch: spec.id }, "dispatch: stream edit failed");
          }
        });
      }

      // Wake turns (#59, D8): mark this thread as running a woken turn at its
      // chain depth, so a `schedule_wake` call *during* the turn nests one level
      // deeper (chain-depth cap). Cleared in the finally below.
      const isWake = spec.kind === "wake";
      if (isWake) this.activeWakeDepth.set(spec.target, spec.wakeChainDepth ?? 0);
      // #67: register this LIVE turn as the target thread's interruptible
      // dispatch so a concurrent `send(interrupt:true)` can find and cancel it.
      // Only live runs share the thread's persistent runtime (what an interrupt
      // cancels); isolated/preset runs use a throwaway runtime and are unaffected.
      const isLiveDispatch = effectiveSession === "live";
      if (isLiveDispatch) this.activeLiveDispatch.set(spec.target, spec.id);
      const isChoice = spec.kind === "choice";
      if (isChoice && this.choiceResults) {
        // Isolated MCP is injected as the authoring thread (record.id). Bind
        // that id or submit_result looks up an ACP uuid and misses.
        this.choiceResults.bindSession(record.id, spec.id);
        this.choiceResults.bindChannel(spec.target, spec.id);
      }
      let result: InjectTurnResult | undefined;
      try {
        result = await this.injectTurn(record, effectivePrompt, {
          session: effectiveSession,
          ...(preset?.model ? { model: preset.model } : spec.model ? { model: spec.model } : {}),
          ...(preset?.effort ? { effort: preset.effort } : spec.effort ? { effort: spec.effort } : {}),
          ...(preset?.repoPath ? { cwd: preset.repoPath } : spec.cwd ? { cwd: spec.cwd } : {}),
          ...(presetProfile ? { profile: presetProfile } : {}),
          ...(isResume && resumeSessionId && effectiveSession === "isolated"
            ? { resumeSessionId }
            : {}),
          ...isolatedSpawn,
          outputTo: target,
          ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
          timeoutMs: this.config.TURN_TIMEOUT_SECONDS * 1000,
          // Isolated: newSession() just returned — THIS is the running
          // transition. Write the session id now, before prompt(), so a
          // SIGKILL still leaves a pointer on the ledger (#75).
          onSession: (sessionId) => {
            try {
              this.store.updateDelegationStatus(spec.id, "running", {
                acpSessionId: sessionId,
              });
            } catch { /* best-effort */ }
            if (isChoice) this.choiceResults?.bindSession(sessionId, spec.id);
          },
          // Drive both additive views from the ONE event stream:
          //  - the OUTPUT renderer gets agent-text (the answer): the flush
          //    renderer ("messages") streams it as real messages, or the
          //    StreamingPanel ("card") edits the embed in place;
          //  - the STATUS PANEL gets every event (thinking, tools, model,
          //    context health, action/state) via the same mapping the user-turn
          //    path uses.
          // injectTurn still accumulates the FULL text into `result.text` in
          // parallel, so streaming stays lossless — report-back / done-file get
          // the whole answer regardless.
          ...(msgRenderer || streamPanel || statusPanel
            ? {
                onEvent: async (event) => {
                  if (event.kind === "agent-text") {
                    if (msgRenderer) msgRenderer.feed(event.text);
                    else if (streamPanel) streamPanel.append(event.text);
                  }
                  statusPanel?.handleEvent(event);
                },
              }
            : {}),
          // Drain trailing text that lands after the prompt RPC resolves, so the
          // done-file holds the whole answer rather than a truncated one.
          awaitIdle: true,
          logContext: { dispatch: spec.id },
        });
      } finally {
        // The turn is over — no more `schedule_wake` calls can nest under it.
        if (isWake) this.activeWakeDepth.delete(spec.target);
        // No longer interruptible — the turn has ended.
        if (isLiveDispatch) this.activeLiveDispatch.delete(spec.target);
        if (isChoice && this.choiceResults) {
          if (result?.text) {
            const harvested = extractSeamResultFromText(result.text);
            if (harvested.ok) this.choiceResults.submitFromDispatch(spec.id, harvested.value);
          }
          this.choiceResults.turnEnded(spec.id);
        }
      }
      if (!result) throw new Error("dispatch: injectTurn returned no result");

      // #67: consume the interrupt flag right after the turn ends (before any)
      // downstream delivery), so an interrupt that cancelled THIS turn suppresses
      // its report-back / chain advance below — its partial/stale output must not
      // reach whoever it was reporting to; the interrupt already issued a fresh
      // directive in its place. Consuming here (not at the gate) also means a
      // throw in the visibility/finalize code below can never leak the flag.
      const wasInterrupted = this.interruptedDispatches.delete(spec.id);

      // Finalize the STATUS PANEL to its terminal state. It is an INDEPENDENT
      // message from the plain-output stream (its own throttle + SerialQueue), so
      // it settles on its own. Carries the final context/elapsed/tools already
      // accumulated on the TurnStatus. Best-effort — a panel edit failure never
      // affects the answer delivery / report-back below.
      if (statusPanel) {
        const finalState: TurnState = result.timedOut
          ? "Timed out"
          : result.error
            ? "Failed"
            : "Done";
        const finalAction = result.timedOut
          ? `Timed out after ${this.config.TURN_TIMEOUT_SECONDS}s`
          : result.error
            ? result.error.slice(0, 200)
            : (result.stopReason || "Completed");
        await statusPanel.finalize(finalState, finalAction).catch((err) =>
          this.logger.warn({ err, dispatch: spec.id }, "dispatch: status panel finalize failed")
        );
      }

      // Visibility post. Streaming: finalize the panel IN PLACE (no second copy
      // of the body) — the streamed panel becomes the done card, with the full
      // text spilled to a file only when it overflows the embed. Quiet: fall
      // back to today's capture-and-post cards below the untouched indicator.
      if (msgRenderer) {
        // "messages" style: the OUTPUT already streamed as fresh real messages;
        // drain the tail, surface any error / empty line, flip the ▶ indicator.
        await this.finalizeMessagesStream(target, spec, msgRenderer, result, panelRef, header, showHeader);
      } else if (streamPanel && panelRef) {
        await this.finalizeDispatchStream(target, spec, streamPanel, streamState, result);
      } else {
        // Partial output is still output — post whatever was captured either way.
        await this.postDispatchOutput(target, spec, result.text, result.error);
      }
      const ledgerStatus = result.timedOut ? "timed_out" : result.error ? "failed" : "completed";
      try { this.store.updateDelegationStatus(spec.id, ledgerStatus); } catch { /* best-effort */ }
      // Chain advance (#25): a hop carrying a chainId drives the chain forward
      // instead of a normal report-back — enqueue the next hop, or deliver the
      // final output to the chain's origin. The chain row is the source of
      // truth, so this survives a restart mid-chain.
      if (wasInterrupted) {
        // #67: this turn was preemptively cancelled by an interrupt. Deliver
        // NOTHING onward — no report-back, no chain advance — the interrupt has
        // already issued a fresh directive into this same thread in its place.
        this.logger.info(
          { dispatch: spec.id, target: spec.target, correlationId: spec.correlationId },
          "dispatch: onward delivery suppressed — turn was interrupted (#67)"
        );
      } else if (spec.chainId) {
        await this.advanceChain(spec, result.text, result.error).catch((err) =>
          this.logger.warn({ err, dispatch: spec.id, chainId: spec.chainId }, "dispatch: chain advance failed")
        );
      } else if (spec.returnTo) {
        // Report-back: if the caller set returnTo, deliver the result back by
        // enqueuing a fresh dispatch into that thread (correlation-linked). The
        // runtime owns this — the worker never had to "remember" to report.
        await this.enqueueReportBack(spec, result.text, result.error).catch((err) =>
          this.logger.warn({ err, dispatch: spec.id }, "dispatch: report-back enqueue failed")
        );
      }
      if (result.error) throw new Error(result.error);
      return { output: result.text, stopReason: result.stopReason ?? "" };
    };

    // #76: resume starts go through the stagger/concurrency gate so a dozen
    // crash leftovers do not fire simultaneously at boot.
    const gatedRun = isResume ? () => this.resumeScheduler.run(run) : run;

    if (effectiveSession === "live") {
      // Share the thread's persistent session ⇒ must not overlap a user turn.
      return this.queueOnChannel(spec.target, gatedRun);
    }
    // Isolated: own throwaway runtime, so it cannot collide with the thread's
    // live session and needn't queue. Still counted for the restart drain.
    this.activeTurns++;
    try {
      return await gatedRun();
    } finally {
      this.activeTurns--;
    }
  }

  /**
   * Headless ingest (#95): isolated silent scoring. No Discord posts unless
   * `target` is a snowflake (optional notifyThread). MCP is keyed by the
   * dispatch id, not a Discord session.
   */
  private async dispatchIngestEndpoint(
    spec: DispatchSpec
  ): Promise<{ output: string; stopReason: string }> {
    const notifyId = isDiscordSnowflake(spec.target) ? spec.target : undefined;
    const endpoint = spec.correlationId ? this.store.getIngestEndpoint(spec.correlationId) : null;
    const presetName = endpoint?.preset ?? spec.preset;
    const preset = presetName
      ? this.store.getPresetByNameScoped(presetName, endpoint?.authoringParentRef ?? null)
      : null;
    if (presetName && !preset) {
      throw new Error(`dispatch ${spec.id}: unknown preset "${presetName}"`);
    }
    const agentId = preset?.agentId ?? spec.agentId ?? this.config.DEFAULT_AGENT;
    const profile = this.router.getProfile(agentId);
    if (!profile) {
      throw new Error(`dispatch ${spec.id}: unknown agent "${agentId}"`);
    }
    const cwd = preset?.repoPath ?? spec.cwd ?? this.config.REPOS_ROOT;
    const model = preset?.model ?? spec.model;
    const effort = preset?.effort ?? spec.effort;
    const prompt = applyPresetIdentity(spec.prompt, preset);
    const synthetic: SessionRecord = {
      id: spec.id,
      platform: PLATFORM,
      channelRef: notifyId ?? spec.correlationId ?? spec.id,
      parentRef: endpoint?.authoringParentRef ?? null,
      agentId,
      acpSessionId: "",
      repoPath: cwd,
      configJson: JSON.stringify({
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      }),
      createdUtc: spec.createdUtc,
      updatedUtc: spec.createdUtc,
    };
    this.ingestJobs.set(spec.id, synthetic);
    try {
      try {
        this.store.recordDelegation({
          id: spec.id,
          kind: "ingest",
          sourceRef: null,
          targetRef: notifyId ?? null,
          worker: preset?.name ?? null,
          promptPreview: spec.prompt,
          correlationId: spec.correlationId ?? null,
          status: "dispatched",
        });
      } catch (err) {
        this.logger.warn({ err, dispatch: spec.id }, "ingest: ledger record failed");
      }

      let outputTo: ChannelRef | undefined;
      if (notifyId) {
        const live = await this.threadLiveState(notifyId);
        if (live === "ok") {
          outputTo = { platform: PLATFORM, id: notifyId };
        }
      }

      const mcpServers = this.router.mintMcpServersForSession(spec.id);
      if (this.choiceResults) {
        this.choiceResults.bindIngestWaiter(spec.id, {
          ...(notifyId ? { notifyThread: notifyId } : {}),
          endpoint,
        });
      }

      this.activeTurns++;
      let result: InjectTurnResult | undefined;
      try {
        result = await this.injectTurn(null, prompt, {
          session: "isolated",
          profile,
          cwd,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          strictModel: true,
          mcpServers,
          ...(outputTo ? { outputTo } : {}),
          ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
          timeoutMs: this.config.TURN_TIMEOUT_SECONDS * 1000,
          onSession: (sessionId) => {
            try {
              this.store.updateDelegationStatus(spec.id, "running", { acpSessionId: sessionId });
            } catch {
              /* best-effort */
            }
            this.choiceResults?.bindSession(sessionId, spec.id);
          },
          awaitIdle: true,
          logContext: { dispatch: spec.id, kind: "ingest" },
        });
      } finally {
        this.activeTurns--;
        if (this.choiceResults) {
          if (result?.text) {
            const harvested = extractSeamResultFromText(result.text);
            if (harvested.ok) this.choiceResults.submitFromDispatch(spec.id, harvested.value);
          }
          this.choiceResults.turnEnded(spec.id);
        }
        this.router.revokeMcpSession(spec.id);
      }
      if (!result) throw new Error("ingest: injectTurn returned no result");
      if (outputTo) {
        await this.postDispatchOutput(outputTo, spec, result.text, result.error).catch((err) =>
          this.logger.warn({ err, dispatch: spec.id }, "ingest: notify post failed")
        );
      }
      const ledgerStatus = result.timedOut ? "timed_out" : result.error ? "failed" : "completed";
      try {
        this.store.updateDelegationStatus(spec.id, ledgerStatus);
      } catch {
        /* best-effort */
      }
      if (result.error) throw new Error(result.error);
      return { output: result.text, stopReason: result.stopReason ?? "" };
    } finally {
      this.ingestJobs.delete(spec.id);
    }
  }

  private async threadLiveState(threadId: string): Promise<"ok" | "gone" | "archived"> {
    if (!this.adapter.getThreadLiveState) return "ok";
    try {
      const live = await this.adapter.getThreadLiveState({ platform: PLATFORM, id: threadId });
      if (live === undefined) return "gone";
      if (live.archived) return "archived";
      return "ok";
    } catch {
      return "ok";
    }
  }

  /**
   * DispatchWatcher branch for `kind: "compact"` (agent-triggered compaction).
   * Instead of injecting a turn, run the premium compaction pipeline on the
   * target thread via `compactThread`, then post the outcome as a result card
   * into that thread — reusing the same start-indicator panel, ledger, and
   * done-file plumbing every other dispatch gets, so the `▶`→`✅`/`❌` life-cycle
   * and the report-back-to-target are consistent with wake/watch.
   *
   * The actor is `spec.returnTo` (the caller thread the tool stamped); the target
   * is `spec.target`. Both are recorded on the ledger so a cross-thread
   * compaction (actor ≠ target) is an audited fact (guardrail: still allowed,
   * but never silent). A self-scoped compaction has actor == target.
   */
  private async dispatchCompact(spec: DispatchSpec): Promise<{ output: string; stopReason: string }> {
    const target: ChannelRef = { platform: PLATFORM, id: spec.target };
    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: spec.target,
      cwd: spec.cwd ?? this.config.REPOS_ROOT,
    });
    const actor = spec.returnTo ?? spec.target;

    // Ledger the actor→target compaction (best-effort — never break the run).
    try {
      this.store.recordDelegation({
        id: spec.id,
        kind: "compact",
        sourceRef: actor,
        targetRef: spec.target,
        promptPreview: spec.prompt,
        correlationId: spec.correlationId ?? null,
        status: "dispatched",
      });
    } catch (err) {
      this.logger.warn({ err, dispatch: spec.id }, "compact-dispatch: ledger record failed");
    }

    const header = this.dispatchIndicatorHeader(spec, null);
    const startedAt = Date.now();
    const style = this.config.SEAM_DISPATCH_OUTPUT_STYLE ?? "messages";
    const statusPanelOn = this.config.SEAM_DISPATCH_STATUS_PANEL !== false;
    try { this.store.updateDelegationStatus(spec.id, "running"); } catch { /* best-effort */ }

    // STATUS PANEL (this feature): the "🗜 Compact" panel. Compaction runs its
    // own multi-agent pipeline rather than an injected turn, so there is no
    // agent-event stream to drive thinking/tools/context — the panel shows the
    // compaction lifecycle (Working → Done/Failed) with model/repo/elapsed. When
    // on, it supersedes the ▶ header on the summary message below. All the
    // config/profile reads stay inside this branch so the panel-off path is
    // untouched.
    const statusPanel = statusPanelOn
      ? await (async () => {
          const cfg = this.store.readConfig(record);
          const compactProfile = this.router.getProfile(record.agentId);
          return this.startDispatchStatusPanel(target, spec, {
            model: cfg.model ?? this.config.DEFAULT_MODEL,
            ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
            cwd: record.repoPath ?? this.config.REPOS_ROOT,
            ...(compactProfile ? { profile: compactProfile } : {}),
            isolated: false,
            ...(cfg.lastContextUsage
              ? {
                  cachedUsage: {
                    used: cfg.lastContextUsage.used,
                    size: cfg.lastContextUsage.size,
                    model: cfg.lastContextUsage.model,
                  },
                }
              : {}),
          });
        })()
      : undefined;
    if (statusPanel) statusPanel.status.setAction("Compacting…");

    // Start indicator: post the same slim indicator dispatchInjectTurn posts, so
    // the target thread shows the compaction is underway. Suppress the ▶ header
    // when the status panel already carries the "🗜 Compact" type. Best-effort.
    const showHeader = !statusPanel;
    const panelRef = await this.postDispatchStartIndicator(target, header, style, spec, showHeader);

    // Finalize the indicator into its terminal (done/error) state in place, so
    // the one message is the whole life-cycle (mirrors finalizeDispatchStream).
    // The compaction summary is short, so it always fits one plain message.
    const finalize = async (body: string, error?: string): Promise<void> => {
      if (!panelRef) return;
      try {
        if (style === "messages") {
          // With the status panel on, it carries the "🗜 Compact" type + terminal
          // state, so the summary message drops the ▶/✅/❌ header line.
          const doneHeader = header.replace(/^▶/, error ? "❌" : "✅");
          const headerBlock = showHeader ? `_${doneHeader}_\n\n` : "";
          const content = error
            ? `${headerBlock}❌ ${error.slice(0, 1500)}`
            : `${headerBlock}${body}`;
          await this.adapter.editMessage(panelRef, content.slice(0, DISCORD_MESSAGE_MAX));
          return;
        }
        const panel = this.dispatchStreamPanel({
          header,
          text: body,
          done: true,
          elapsedMs: Date.now() - startedAt,
          ...(error ? { error } : {}),
        });
        if (this.adapter.editPanel) await this.adapter.editPanel(panelRef, panel);
        else await this.adapter.editMessage(panelRef, serializePanelText(panel));
      } catch (err) {
        this.logger.warn({ err, dispatch: spec.id }, "compact-dispatch: finalize edit failed");
      }
    };

    try {
      const res = await this.compactThread(record, {
        ...(spec.compactSource ? { source: spec.compactSource } : {}),
        channel: target,
        onProgress: (m) => this.logger.debug({ dispatch: spec.id, compact: spec.target }, m),
      });
      const summary =
        `✅ Compacted into a new session \`${res.newSessionId}\` via the multi-agent pipeline` +
        `${res.wasActive ? " — this thread is now bound to it" : ""} (${res.stats.chunks} chunk(s)). ` +
        `Original \`${res.originalSessionId}\` is preserved (review or delete it from the session manager).`;
      await finalize(summary);
      await statusPanel?.finalize("Done", `Compacted (${res.stats.chunks} chunk(s))`).catch(() => {});
      // Attach the full premium report for review, alongside the panel.
      await this.sendResultFile(target, res.originalSessionId, res.reportMarkdown, "premium-compaction").catch(() => {});
      try { this.store.updateDelegationStatus(spec.id, "completed"); } catch { /* best-effort */ }
      this.logger.info(
        { dispatch: spec.id, actor, target: spec.target, newSessionId: res.newSessionId, wasActive: res.wasActive },
        "compact-dispatch: completed"
      );
      return { output: summary, stopReason: "compacted" };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      await finalize("", message);
      await statusPanel?.finalize("Failed", message.slice(0, 200)).catch(() => {});
      if (!panelRef) {
        // No indicator to carry the error — post a standalone failure line/card.
        if (style === "messages") {
          await this.adapter.sendMessage(target, `❌ ${message.slice(0, 1500)}`).catch(() => {});
        } else {
          await this.sendResultCard(target, "✨ Compaction failed", `❌ ${message.slice(0, 1500)}`, DISPATCH_ERROR_COLOR).catch(() => {});
        }
      }
      try { this.store.updateDelegationStatus(spec.id, "failed"); } catch { /* best-effort */ }
      this.logger.warn({ err, dispatch: spec.id, target: spec.target }, "compact-dispatch: failed");
      throw new Error(message);
    }
  }

  /** Report-back: enqueue a fresh dispatch that delivers a completed handoff's
   *  output into its `returnTo` thread, wrapped so the receiving agent knows it
   *  is a report-back and from where. Correlation-linked; kind = report_back.
   *  Idempotent on `correlationId` (#77): the ledger is the source of truth —
   *  a crash between this enqueue and the watcher's done-file commit used to
   *  re-run the worker and deliver twice. We claim the `report_back` ledger
   *  row first so a re-run sees it and skips.
   *
   *  Follow-up (not this patch): moving report-back enqueue to AFTER the
   *  done-file commit would close the window structurally, but it's a larger
   *  watcher/orchestrator contract change. Dedup is the smaller, safer fix. */
  private async enqueueReportBack(
    spec: DispatchSpec,
    output: string,
    error?: string
  ): Promise<void> {
    const returnTo = spec.returnTo;
    if (!returnTo) return;
    const correlation = spec.correlationId ?? spec.id;
    const body = error
      ? `The worker did not complete cleanly: ${error}\n\n--- partial output ---\n${output}`
      : output;
    const wrapped = [
      `<seam-report-back correlation="${correlation}" from-thread="${spec.target}">`,
      body,
      `</seam-report-back>`,
      ``,
      `The worker you handed off to (thread ${spec.target}) has finished — its output is above. Continue based on it.`,
    ].join("\n");
    const id = randomUUID();
    const reportSpec: DispatchSpec = {
      id,
      target: returnTo,
      prompt: wrapped,
      session: "live",
      correlationId: correlation,
      kind: "report_back",
      createdUtc: new Date().toISOString(),
    };
    const enqueued = await this.claimAndEnqueueReportBack(correlation, reportSpec, {
      sourceRef: spec.target,
      targetRef: returnTo,
    });
    if (enqueued) {
      this.logger.info({ reportBack: id, returnTo, correlation }, "dispatch: report-back enqueued");
    }
  }

  /**
   * Claim a `report_back` ledger row for `correlationId` and enqueue `spec`.
   * Returns true if this call won the claim and wrote the spec, false if a
   * report-back for this correlation already exists (ledger or pending/running).
   * The ledger write is committed BEFORE the spec lands so a crash in the
   * watcher window (after we return, before the done-file) still sees the claim.
   */
  private async claimAndEnqueueReportBack(
    correlationId: string,
    spec: DispatchSpec,
    refs: { sourceRef: string | null; targetRef: string | null }
  ): Promise<boolean> {
    if (this.store.getReportBackByCorrelation(correlationId)) {
      this.logger.info(
        { correlationId, spec: spec.id },
        "dispatch: report-back skipped — ledger already has this correlation (#77)"
      );
      return false;
    }
    const queued = await findQueuedReportBackSpec(this.config.DATA_DIR, correlationId);
    if (queued) {
      // Repair: a pre-#77 (or crash-between-enqueue-and-claim) spec is already
      // on disk. Backfill the ledger so later restarts don't depend on the file.
      this.store.tryRecordReportBack({
        id: queued.id,
        kind: "report_back",
        sourceRef: refs.sourceRef,
        targetRef: refs.targetRef,
        promptPreview: queued.prompt,
        correlationId,
        status: "dispatched",
      });
      this.logger.info(
        { correlationId, existing: queued.id },
        "dispatch: report-back skipped — spec already queued (#77)"
      );
      return false;
    }
    const claimed = this.store.tryRecordReportBack({
      id: spec.id,
      kind: "report_back",
      sourceRef: refs.sourceRef,
      targetRef: refs.targetRef,
      promptPreview: spec.prompt,
      correlationId,
      status: "dispatched",
    });
    if (!claimed) {
      this.logger.info(
        { correlationId, spec: spec.id },
        "dispatch: report-back skipped — lost the atomic claim (#77)"
      );
      return false;
    }
    await enqueueDispatchSpec(this.config.DATA_DIR, spec);
    return true;
  }

  /**
   * Chain advance (#25): a dispatch carrying a `chainId` has completed. The
   * chain row is the durable source of truth — read it and drive the chain one
   * step forward:
   *  - on a hop error, mark the chain failed and tell the origin;
   *  - if hops remain, pipe THIS hop's output into the next hop as its input
   *    (fresh dispatch, same chainId, kind="forward");
   *  - if none remain, deliver the final output to the chain's `originRef`
   *    (a normal report-back) and `completeChain`.
   *
   * #77: a crash between this advance and the watcher's done-file used to
   * re-run the same hop and advance AGAIN (skip a worker, or double-deliver
   * the origin). We claim a hop-scoped `report_back` ledger row (keyed on
   * this spec's id — chain hops share `correlationId = chainId`, so that
   * key alone cannot distinguish hops) BEFORE mutating the chain, so a
   * re-run of the same hop is a no-op. The chain's origin delivery uses
   * the same report-back claim on `chainId`.
   */
  private async advanceChain(spec: DispatchSpec, output: string, error?: string): Promise<void> {
    const chainId = spec.chainId;
    if (!chainId) return;
    const chain = this.store.getChain(chainId);
    if (!chain) {
      this.logger.warn({ chainId, dispatch: spec.id }, "chain: advance for unknown chain");
      return;
    }
    if (chain.status !== "running") {
      this.logger.info({ chainId, status: chain.status }, "chain: advance on non-running chain — ignored");
      return;
    }

    // Hop-scoped claim: one advance (or fail-delivery) per completing spec.
    if (!this.claimChainHopAdvance(spec, chainId)) {
      this.logger.info(
        { chainId, dispatch: spec.id },
        "chain: advance skipped — hop already claimed (#77)"
      );
      // Repair the inner window (claimed, then crashed before terminal
      // enqueue/complete). Do NOT call store.advanceChain again.
      const current = this.store.getChain(chainId);
      if (current?.status === "running") {
        if (error) {
          await this.enqueueChainDelivery(
            current.originRef,
            chainId,
            `The chain broke at a hop: ${error}\n\n--- partial output ---\n${output}`
          );
          this.store.completeChain(chainId, "failed");
        } else if (current.hops.length === 0) {
          await this.enqueueChainDelivery(current.originRef, chainId, output);
          this.store.completeChain(chainId);
        }
      }
      return;
    }

    if (error) {
      // Enqueue the failure delivery BEFORE marking the chain terminal, so a
      // crash between the two still re-enters this path (chain still running)
      // and the correlation claim on `chainId` keeps the delivery unique.
      await this.enqueueChainDelivery(
        chain.originRef,
        chainId,
        `The chain broke at a hop: ${error}\n\n--- partial output ---\n${output}`
      );
      this.store.completeChain(chainId, "failed");
      this.logger.warn({ chainId, dispatch: spec.id, error }, "chain: hop failed; chain marked failed");
      return;
    }

    const advanced = this.store.advanceChain(chainId);
    if (!advanced) {
      this.logger.warn({ chainId }, "chain: advance no-op (missing or not running)");
      return;
    }
    const { nextHop } = advanced;
    if (nextHop) {
      // Pipe this hop's output into the next hop as its input.
      const next = buildChainHopSpec({
        id: randomUUID(),
        chainId,
        worker: nextHop,
        prompt: output,
        originRef: chain.originRef,
      });
      await enqueueDispatchSpec(this.config.DATA_DIR, next);
      this.logger.info(
        { chainId, dispatch: next.id, worker: nextHop, index: advanced.chain.currentIndex },
        "chain: advanced to next hop"
      );
    } else {
      // No hops remain — deliver the final output to the origin and complete.
      await this.enqueueChainDelivery(chain.originRef, chainId, output);
      this.store.completeChain(chainId);
      this.logger.info({ chainId, originRef: chain.originRef }, "chain: completed; final output delivered");
    }
  }

  /**
   * Durable "this hop already advanced the chain" claim (#77). Keyed on the
   * completing spec's id (not the chain's shared correlation) so hop N's
   * claim cannot block hop N+1. Uses a synthetic ledger id so it does not
   * collide with the hop's own `kind=forward` row (`id = spec.id`).
   */
  private claimChainHopAdvance(spec: DispatchSpec, chainId: string): boolean {
    if (this.store.getReportBackByCorrelation(spec.id)) return false;
    const claimed = this.store.tryRecordReportBack({
      id: `chain_advance:${spec.id}`,
      kind: "report_back",
      sourceRef: chainId,
      targetRef: spec.target,
      worker: spec.preset ?? null,
      promptPreview: spec.prompt,
      correlationId: spec.id,
      status: "completed",
    });
    return claimed !== null;
  }

  /** Deliver a chain's terminal output into its origin thread as a fresh live
   *  dispatch (correlation-linked to the chain). Deliberately carries NO
   *  `chainId`, so this delivery does not itself try to advance a chain.
   *  Written atomically via `enqueueDispatchSpec`. Idempotent on `chainId`
   *  via the same #77 report-back claim as a normal handoff report-back. */
  private async enqueueChainDelivery(
    originRef: string,
    chainId: string,
    body: string
  ): Promise<void> {
    const id = randomUUID();
    const wrapped = [
      `<seam-chain-result chain="${chainId}">`,
      body,
      `</seam-chain-result>`,
      ``,
      `The multi-hop chain ${chainId} has finished — its final output is above.`,
    ].join("\n");
    const spec: DispatchSpec = {
      id,
      target: originRef,
      prompt: wrapped,
      session: "live",
      correlationId: chainId,
      kind: "report_back",
      createdUtc: new Date().toISOString(),
    };
    const enqueued = await this.claimAndEnqueueReportBack(chainId, spec, {
      sourceRef: chainId,
      targetRef: originRef,
    });
    if (enqueued) {
      this.logger.info({ chainId, originRef, delivery: id }, "chain: origin delivery enqueued");
    }
  }

  /** Post a dispatch's captured output to the target thread — cards, or a file
   *  when it's too long. Best-effort: a Discord failure must not fail the
   *  dispatch, whose real result channel is the done-file. */
  private async postDispatchOutput(
    channel: ChannelRef,
    spec: DispatchSpec,
    text: string,
    error?: string
  ): Promise<void> {
    const label = spec.correlationId ? `${spec.id} · ${spec.correlationId}` : spec.id;
    const style = this.config.SEAM_DISPATCH_OUTPUT_STYLE ?? "messages";
    try {
      if (style === "messages") {
        // Default: traditional plain assistant messages — like talking to the
        // bot directly. Errors stay a short visible plain line, not a big embed.
        if (error) {
          await this.adapter.sendMessage(channel, `❌ ${error.slice(0, 1500)}`);
        }
        const body = text.trim();
        if (!body) {
          if (!error) await this.adapter.sendMessage(channel, "✅ Done — no output.");
          return;
        }
        await this.postPlainChunks(
          channel,
          body,
          label,
          "dispatch",
          `✅ Done — full output attached (${body.length} chars).`
        );
        return;
      }

      // Opt-in "card" style: today's blue "📨 Dispatch" embeds (unchanged).
      if (error) {
        await this.sendResultCard(
          channel,
          "📨 Dispatch failed",
          `❌ ${error.slice(0, 1500)}`,
          0xe74c3c
        );
      }
      const body = text.trim();
      if (!body) {
        if (!error) {
          await this.sendResultCard(channel, "📨 Dispatch", "✅ Done — no output.", DISPATCH_COLOR);
        }
        return;
      }
      const chunks = this.chunkString(body, 3900);
      if (chunks.length <= 3) {
        for (let j = 0; j < chunks.length; j++) {
          const suffix = chunks.length > 1 ? ` (${j + 1}/${chunks.length})` : "";
          await this.sendResultCard(channel, `📨 Dispatch${suffix}`, chunks[j]!, DISPATCH_COLOR);
        }
      } else {
        await this.sendResultCard(
          channel,
          "📨 Dispatch",
          `✅ Done — full output attached (${body.length} chars).`,
          DISPATCH_COLOR
        );
        await this.sendResultFile(channel, label, body, "dispatch");
      }
    } catch (err) {
      this.logger.warn({ err, dispatch: spec.id }, "dispatch: posting output to thread failed");
    }
  }

  /** Title-prefix for a dispatched turn's status panel — the dispatch TYPE with
   *  an icon, e.g. "📨 Handoff", "⏰ Wake". The renderer appends the turn state,
   *  so the panel header reads "📨 Handoff · Working" → "📨 Handoff · Done". A
   *  hop carrying a chainId reads as "🔗 Chain" regardless of its kind, mirroring
   *  {@link dispatchKindLabel}. */
  private dispatchPanelTitle(kind: DelegationKind | undefined, chained: boolean): string {
    if (chained) return "🔗 Chain";
    switch (kind) {
      case "forward": return "📤 Forward";
      case "wake": return "⏰ Wake";
      case "watch": return "👁 Watch";
      case "report_back": return "🔁 Report-back";
      case "peek": return "🔍 Peek";
      case "compact": return "🗜 Compact";
      case "scheduled": return "📅 Scheduled";
      case "parked": return "📥 Parked";
      case "choice": return "🗳️ Choice";
      case "ingest": return "🌐 Ingest";
      case "handoff":
      default: return "📨 Handoff";
    }
  }

  /** Human label for a dispatch kind, used in the start indicator. A hop
   *  carrying a chainId reads as "chain" regardless of its kind. */
  private dispatchKindLabel(kind: DelegationKind | undefined, chained: boolean): string {
    if (chained) return "chain";
    switch (kind) {
      case "forward": return "forward";
      case "wake": return "wake fired";
      case "watch": return "watch fired";
      case "report_back": return "report-back";
      case "peek": return "peek";
      case "compact": return "compact";
      case "scheduled": return "scheduled";
      case "parked": return "parked prompt";
      case "choice": return "choice";
      case "ingest": return "ingest";
      case "handoff":
      default: return "handoff";
    }
  }

  /** Collapse a prompt to a single-line preview of at most `max` chars. */
  private previewLine(s: string, max: number): string {
    const oneLine = s.replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) return oneLine;
    return `${oneLine.slice(0, max - 1).trimEnd()}…`;
  }

  /** The start-indicator header line for a dispatch, e.g.
   *  `▶ handoff · thread <id> → <preview>` or `▶ watch fired · <preview>`.
   *  Kind-aware, with the source/caller shown when known (a preset name, or the
   *  report-back thread that handoff/forward default to the caller). */
  private dispatchIndicatorHeader(spec: DispatchSpec, preset: Preset | null): string {
    const label = this.dispatchKindLabel(spec.kind, !!spec.chainId);
    const preview = this.previewLine(spec.prompt, 70);
    const source = preset
      ? `preset "${preset.name}"`
      : spec.returnTo
        ? `thread ${spec.returnTo}`
        : undefined;
    return source
      ? `▶ ${label} · ${source} → ${preview}`
      : `▶ ${label} · ${preview}`;
  }

  /** Tail of `s` bounded to the embed budget, prefixed with an ellipsis when
   *  truncated (we keep the freshest output visible while streaming). */
  private tailForPanel(s: string): string {
    if (s.length <= DISPATCH_STREAM_DESC_MAX) return s;
    return `…${s.slice(s.length - DISPATCH_STREAM_DESC_MAX)}`;
  }

  /** Post the slim start indicator for a dispatch into the target thread and
   *  return its message ref (the message that then streams/finalizes in place).
   *  In the default "messages" style this is a one-line italic plain indicator
   *  (`_▶ handoff · … → preview_`); in "card" style it's the legacy embed panel.
   *  Best-effort: a post failure must never break the turn — it just costs live
   *  visibility, so we log and return undefined. */
  private async postDispatchStartIndicator(
    target: ChannelRef,
    header: string,
    style: "messages" | "card",
    spec: DispatchSpec,
    showHeader = true
  ): Promise<MessageRef | undefined> {
    try {
      if (style === "messages") {
        // When the status panel carries the dispatch type, the streamed answer
        // omits the ▶ header — it starts as a bare "starting…" placeholder and
        // grows into a clean plain reply below the panel.
        return await this.adapter.sendMessage(
          target,
          showHeader ? `_${header}_` : "_starting…_"
        );
      }
      const startPanel = this.dispatchStreamPanel({ header, text: "", done: false, elapsedMs: 0 });
      return this.adapter.sendPanel
        ? await this.adapter.sendPanel(target, startPanel)
        : await this.adapter.sendMessage(target, serializePanelText(startPanel));
    } catch (err) {
      this.logger.warn({ err, dispatch: spec.id }, "dispatch: start-indicator post failed");
      return undefined;
    }
  }

  /**
   * Build, post, and arm the traditional live STATUS PANEL for a dispatched
   * turn — the same {@link TurnStatus} + {@link renderStatusPanel} the user-turn
   * path uses — titled with the dispatch TYPE. Returns the live panel (whose
   * `handleEvent` the caller wires into `injectTurn`'s `onEvent`), or undefined
   * when the panel is disabled or the initial post failed (best-effort: a panel
   * failure never breaks the dispatch — it just costs visibility).
   *
   * Context-window health is seeded here so the panel isn't blank before the
   * first `usage-update`: a LIVE dispatch reuses the target thread's cached
   * session usage; an ISOLATED dispatch starts blank and fills from the fresh
   * runtime's `usage-update` events during the turn. The authoritative per-model
   * window floor (static models) applies to both so an agent's generic 200K
   * default never masks the true window. Usage genuinely unavailable ⇒ the
   * context line is simply omitted (never crashes).
   */
  private async startDispatchStatusPanel(
    target: ChannelRef,
    spec: DispatchSpec,
    resolved: {
      model: string;
      effort?: string;
      cwd: string;
      profile?: AgentProfile;
      isolated: boolean;
      cachedUsage?: { used: number; size: number; model: string };
    }
  ): Promise<DispatchStatusPanel<MessageRef> | undefined> {
    const repoDisplay = this.repoDisplay(resolved.cwd);
    const modelContextFloor =
      resolved.profile?.staticModels?.find((m) => m.modelId === resolved.model)?.contextLimit
        ?? resolved.profile?.staticModels?.find((m) => m.modelId === resolved.profile?.defaultModel)?.contextLimit
        ?? 0;
    const destRecord =
      typeof this.store.getByChannel === "function"
        ? this.store.getByChannel(target.platform, target.id)
        : null;
    const destDescribed = destRecord ? this.router.describeConfig(destRecord) : undefined;
    const destStyle: StatusCardStyle = destDescribed
      ? statusCardStyleForRender(destDescribed)
      : "full";
    const dispatchGifUrl = pickSimpleCardGifUrl({
      style: destStyle,
      gifOn: destDescribed ? simpleCardGifForRender(destDescribed) : false,
      randomGif: () => this.cardGifs?.randomGif() ?? null,
    });
    const dispatchAgentId = resolved.profile?.id ?? destRecord?.agentId ?? "";
    const dispatchBrand = resolveAgentBrand(dispatchAgentId, resolved.profile?.brand);
    const dispatchBrandAsset = loadBrandAsset(dispatchBrand);
    const status = new TurnStatus({
      model: resolved.model,
      repoDisplay,
      ...(resolved.effort ? { effort: resolved.effort } : {}),
      titlePrefix: this.dispatchPanelTitle(spec.kind, !!spec.chainId),
      style: destStyle,
      ...(dispatchBrandAsset ? { brandFilename: dispatchBrandAsset.filename } : {}),
      authorName: resolved.profile?.displayName ?? dispatchBrand,
    });
    status.setAction("Thinking…");
    // Seed context (live only). Invalidate on model mismatch, exactly like the
    // user-turn seed.
    if (!resolved.isolated && resolved.cachedUsage) {
      const u = resolved.cachedUsage;
      if (u.model === resolved.model && u.size > 0 && u.used > 0) {
        status.contextUsedHighWater = u.used;
        status.contextWindowSize = u.size;
        status.context = formatContextUsage(u.used, u.size);
      }
    }
    if (modelContextFloor > status.contextWindowSize) {
      status.contextWindowSize = modelContextFloor;
      if (status.contextUsedHighWater > 0) {
        status.context = formatContextUsage(status.contextUsedHighWater, modelContextFloor);
      }
    }
    const panel = new DispatchStatusPanel<MessageRef>(
      this.renderer,
      status,
      {
        // Ship the panel as a REAL embed card via sendPanel/editPanel — the
        // exact path handleIncomingMessageInner uses for a normal turn — so the
        // dispatched panel is visually identical and never touches plain message
        // content (embeds have no 2000-char limit, killing the 50035 error).
        // Fall back to sendMessage/editMessage(serializePanelText) ONLY when the
        // adapter lacks sendPanel/editPanel, mirroring the normal path.
        post: async (panel) => {
          try {
            const toSend = withBrandAttachment(panel, dispatchBrandAsset);
            return this.adapter.sendPanel
              ? await this.adapter.sendPanel(target, toSend)
              : await this.adapter.sendMessage(target, serializePanelText(toSend));
          } catch (err) {
            this.logger.warn({ err, dispatch: spec.id }, "dispatch: status panel post failed");
            return undefined;
          }
        },
        edit: async (ref, panel) => {
          try {
            if (this.adapter.editPanel) {
              await this.adapter.editPanel(ref, panel);
            } else {
              await this.adapter.editMessage(ref, serializePanelText(panel));
            }
          } catch (err) {
            this.logger.warn({ err, dispatch: spec.id }, "dispatch: status panel edit failed");
          }
        },
      },
      {
        debounceMs: STATUS_EDIT_DEBOUNCE_MS,
        heartbeatMs: STATUS_HEARTBEAT_MS,
        modelContextFloor,
      }
    );
    await panel.start();
    if (!panel.isLive) return undefined;
    if (dispatchGifUrl) {
      const gifRef = await postSimpleCardGifMessage({
        url: dispatchGifUrl,
        sendPanel: this.adapter.sendPanel
          ? (p) => this.adapter.sendPanel!(target, p)
          : undefined,
        sendMessage: (text) => this.adapter.sendMessage(target, text),
      });
      if (gifRef) {
        const innerFinalize = panel.finalize.bind(panel);
        panel.finalize = async (state, action) => {
          try {
            await innerFinalize(state, action);
          } finally {
            if (isSimpleCardGifTerminal(state)) {
              await deleteSimpleCardGifMessage({
                ref: gifRef,
                deleteMessage: this.adapter.deleteMessage
                  ? (ref) => this.adapter.deleteMessage!(ref)
                  : undefined,
              });
            }
          }
        };
      }
    }
    return panel;
  }

  /** Finalize a "messages"-style streamed dispatch. The OUTPUT already streamed
   *  as fresh REAL messages via the {@link StreamingMessageRenderer} (the same
   *  flush pipeline a normal user turn uses — incremental messages at clean
   *  paragraph/fence boundaries, linebreaks + code fences intact), so here we only
   *  drain the tail, surface a visible error / empty-output line, and flip the ▶
   *  start indicator (when present — i.e. the status panel is off) to its terminal
   *  ✅/❌ glyph in place. Display-only: the report-back / done-file capture is the
   *  untouched `result.text`, delivered separately. */
  private async finalizeMessagesStream(
    target: ChannelRef,
    spec: DispatchSpec,
    renderer: StreamingMessageRenderer,
    result: InjectTurnResult,
    panelRef: MessageRef | undefined,
    header: string,
    showHeader: boolean
  ): Promise<void> {
    // Drain every remaining buffered message (and any unclosed trailing fence).
    await renderer.finalize();
    // The streamed body may be partial or empty, so surface the outcome as its
    // own visible plain line — same UX the quiet postDispatchOutput path gives.
    if (result.error) {
      try {
        await this.adapter.sendMessage(target, `❌ ${result.error.slice(0, 1500)}`);
      } catch (err) {
        this.logger.warn({ err, dispatch: spec.id }, "dispatch: stream error line failed");
      }
    } else if (renderer.sentCount === 0) {
      try {
        await this.adapter.sendMessage(target, "✅ Done — no output.");
      } catch (err) {
        this.logger.warn({ err, dispatch: spec.id }, "dispatch: stream no-output line failed");
      }
    }
    // Flip the ▶ start indicator to its terminal glyph in place. Only present
    // when the status panel is off; otherwise the panel carries the ✅/❌ state.
    if (panelRef && showHeader) {
      const doneHeader = header.replace(/^▶/, result.error ? "❌" : "✅");
      try {
        await this.adapter.editMessage(panelRef, `_${doneHeader}_`);
      } catch (err) {
        this.logger.warn({ err, dispatch: spec.id }, "dispatch: stream indicator finalize failed");
      }
    }
  }

  /** Build the streaming/indicator panel for a dispatch. `done: false` renders
   *  the live view (header + streamed tail + cursor); `done: true` renders the
   *  terminal state (✅/❌ header + final body, or an overflow note when the full
   *  text was spilled to a file). This one panel is posted once and edited in
   *  place — the start indicator, the live stream, and the done card are all the
   *  same message. */
  private dispatchStreamPanel(opts: {
    header: string;
    text: string;
    done: boolean;
    elapsedMs: number;
    error?: string;
    fullAttached?: boolean;
  }): StructuredPanel {
    const { header, text, done, elapsedMs, error, fullAttached } = opts;
    const elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));
    const title = !done
      ? header
      : error
        ? header.replace(/^▶/, "❌")
        : header.replace(/^▶/, "✅");
    const trimmed = text.trim();
    let description: string;
    if (!done) {
      description = trimmed ? `${this.tailForPanel(trimmed)}…` : "_starting…_";
    } else if (error) {
      const partial = trimmed ? `\n\n${this.tailForPanel(trimmed)}` : "";
      description = `❌ ${error.slice(0, 800)}${partial}`;
    } else if (!trimmed) {
      description = "✅ Done — no output.";
    } else if (fullAttached) {
      description =
        `${this.tailForPanel(trimmed)}\n\n` +
        `_✅ Done — full output attached below (${trimmed.length} chars)._`;
    } else {
      description = trimmed;
    }
    const footer = done ? `⏱ ${elapsedSec}s` : `⏱ ${elapsedSec}s · streaming…`;
    return {
      color: error ? DISPATCH_ERROR_COLOR : DISPATCH_COLOR,
      title: title.slice(0, 250),
      description: description.slice(0, 4096),
      fields: [],
      footer,
    };
  }

  /** Finalize a streamed dispatch panel IN PLACE: spill the full body to a file
   *  when it overflows the embed (once — no duplicate card), record the terminal
   *  error/attachment state, then issue the last serialized edit that flips the
   *  panel to its done card. Never re-posts the whole body — that is what makes
   *  streaming replace, not duplicate, `postDispatchOutput`. */
  private async finalizeDispatchStream(
    target: ChannelRef,
    spec: DispatchSpec,
    streamPanel: StreamingPanel,
    streamState: { error?: string; attached: boolean; fullText?: string; overflow?: boolean },
    result: InjectTurnResult
  ): Promise<void> {
    const body = (result.text ?? "").trim();
    if (result.error) streamState.error = result.error;
    const label = spec.correlationId ? `${spec.id} · ${spec.correlationId}` : spec.id;

    // "card" style: spill an overflowing body to a file once (no duplicate card),
    // then flip the embed panel to its done state in place. ("messages" style no
    // longer reaches here — it streams as real messages via finalizeMessagesStream.)
    if (body.length > DISPATCH_STREAM_DESC_MAX) {
      try {
        await this.sendResultFile(target, label, body, "dispatch");
        streamState.attached = true;
      } catch (err) {
        this.logger.warn({ err, dispatch: spec.id }, "dispatch: stream overflow file send failed");
      }
    }
    await streamPanel.finalize();
  }

  /** Manager `onFire` handler: run a scheduled prompt as an **isolated job** (own
   *  throwaway session, thread's repo + model + attachments) and post the output
   *  to the thread as blue cards. Owns last_run/last_status only — the manager
   *  owns next_run. Read-only w.r.t. the thread's live session. */
  async runScheduledPrompt(id: string): Promise<void> {
    const row = this.store.getScheduled(id);
    if (!row) return;
    // Live fires run through `queueOnChannel`, which already increments
    // `activeTurns` around the turn — incrementing here too would double-count
    // and inflate the redeploy-drain counter while running. So only the isolated
    // path takes the outer increment (M3).
    if (row.sessionMode === "live") {
      await this.runScheduledPromptInner(row);
      return;
    }
    // Count scheduled jobs in the restart-drain counter (activeTurns) so a
    // redeploy/sentinel waits for an in-flight job to finish instead of killing
    // its agent child mid-run.
    this.activeTurns++;
    try {
      await this.runScheduledPromptInner(row);
    } finally {
      this.activeTurns--;
    }
  }

  private async runScheduledPromptInner(row: ScheduledPrompt): Promise<void> {
    const id = row.id;
    const bindingThread: ChannelRef = {
      platform: PLATFORM,
      id: row.channelRef,
      ...(row.parentRef ? { parentId: row.parentRef } : {}),
    };
    // Output goes to the configured target channel, or the schedule's own thread.
    const target: ChannelRef = row.targetChannel
      ? { platform: PLATFORM, id: row.targetChannel }
      : bindingThread;

    // 1. Can we post to the output target? run / skip-locked / drop-deleted.
    if (typeof this.adapter.getThreadLiveState === "function") {
      let state: { locked: boolean; archived: boolean } | undefined;
      try {
        state = await this.adapter.getThreadLiveState(target);
      } catch (err) {
        this.logger.warn({ id, err }, "scheduled: target state check failed (transient); skipping");
        this.patchScheduledStatus(id, "skipped: target unreachable");
        return;
      }
      if (state === undefined) {
        if (target.id === row.channelRef) {
          // The schedule's own (binding) thread is gone — drop the schedule.
          this.logger.info({ id, channel: row.channelRef }, "scheduled: thread deleted; dropping schedule");
          this.store.deleteScheduled(id);
          this.scheduledManager?.disarm(id);
          await deleteScheduledAttachmentDir(this.config.DATA_DIR, id).catch(() => {});
        } else {
          this.patchScheduledStatus(id, "skipped: target deleted");
        }
        return;
      }
      if (state.locked) {
        this.patchScheduledStatus(id, "skipped: target locked");
        return;
      }
    }

    // 1b. Live mode (M3): run as a real turn *inside* the bound thread. Synthesize
    //     an IncomingMessage and drive it through the same FIFO + turn pipeline a
    //     user message uses, so it streams identically — status panel, live text,
    //     FenceStream, auto-compaction, permission prompts — for free (D-below).
    //     No announce card (D6), no model/cwd/target/output knobs (D1): the
    //     thread's persistent runtime governs the turn. Attachments pass straight
    //     through unpartitioned (D7) — the inner path does its own staging.
    if (row.sessionMode === "live") {
      // Archived-but-unlocked threads: no announce card reopens it now (D6), but
      // the turn's own first message (the status panel) lands in the thread and
      // Discord auto-unarchives on a new message — so it reopens implicitly.
      const loaded = await loadScheduledAttachments(this.config.DATA_DIR, id, row.attachments);
      const marker = `⏰ *Scheduled: ${row.name}*`;
      const synthetic: IncomingMessage = {
        channel: bindingThread,
        authorId: row.createdBy,
        authorIsBot: false,
        text: `${marker}\n\n${row.promptText}`,
        ...(loaded.length ? { attachments: loaded } : {}),
      };
      let aborted = false;
      try {
        // D2: queue behind user turns / other schedules on this channel; never
        // pre-empt. `queueOnChannel` (not `handleIncomingMessage`) — the latter
        // would bump the generation and abort whatever is running.
        await this.queueOnChannel(row.channelRef, async () => {
          // D4: a user message arriving mid-turn bumps this channel's generation
          // and force-aborts our turn. `handleIncomingMessageInner` swallows the
          // cancellation and returns void (D5), so detect the abort by comparing
          // the generation across the turn rather than from a return value.
          const genAtStart = this.channelGenerations.get(row.channelRef) ?? 0;
          await this.handleIncomingMessageInner(synthetic);
          aborted = (this.channelGenerations.get(row.channelRef) ?? 0) > genAtStart;
        });
        // D4: record the abort; do NOT auto-retry (it would fight the user).
        // D5: otherwise we can only record "ok" — the inner path owns its own
        // turn-level error reporting and does not surface it here.
        this.patchScheduledStatus(id, aborted ? "aborted: user turn" : "ok");
      } catch (err) {
        const emsg = err instanceof Error ? err.message : String(err);
        this.patchScheduledStatus(id, `error: ${emsg.slice(0, 200)}`);
      }
      return;
    }

    // 2. Resolve the agent / model / cwd from the binding thread's record,
    //    with per-schedule overrides.
    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: row.channelRef,
      ...(row.parentRef ? { parentRef: row.parentRef } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      this.patchScheduledStatus(id, `error: unknown agent ${record.agentId}`);
      return;
    }
    const cfg = this.store.readConfig(record);
    const cwd = row.cwd ?? record.repoPath ?? this.config.REPOS_ROOT;
    const model = row.model ?? cfg.model;

    // 3. Announce card — stays as a permanent run record (also auto-reopens an
    //    archived-but-unlocked thread). Not edited later.
    const running: StructuredPanel = {
      color: SCHEDULED_COLOR,
      title: `⏰ Running scheduled: ${row.name}`,
      fields: [
        { name: "Schedule", value: `${describeCron(row.cron)} (${row.timezone})` },
        { name: "Working dir", value: `\`${cwd}\``, inline: true },
        { name: "Model", value: model ? `\`${model}\`` : "session default", inline: true },
        ...(row.attachments.length
          ? [{ name: "Files", value: row.attachments.map((a) => `\`${a.filename}\``).join(", ") }]
          : []),
      ],
      footer: `id ${id} · output: ${row.outputType}`,
    };
    try {
      if (this.adapter.sendPanel) await this.adapter.sendPanel(target, running);
      else await this.adapter.sendMessage(target, `⏰ Running scheduled prompt "${row.name}"…`);
    } catch (err) {
      this.logger.warn({ id, err }, "scheduled: announce card failed");
    }

    // 4. Run isolated + capture. Stage non-inlineable files (PDF/Office/HEIC/…)
    //    to a path the agent reads with its tools — same handling as a live turn,
    //    so scheduled jobs aren't limited to text/image attachments.
    const loaded = await loadScheduledAttachments(this.config.DATA_DIR, id, row.attachments);
    const { inline, hint } = profile.restrictDiscordAccess
      ? { inline: loaded, hint: null as string | null }
      : await this.partitionAndStageAttachments(loaded);
    const result = await this.runIsolatedScheduledJob({
      profile,
      record,
      cwd,
      ...(model ? { model } : {}),
      ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
      channel: target,
      promptText: hint ? `${row.promptText}${hint}` : row.promptText,
      attachments: inline,
    });

    // 5. Post result as NEW message(s) + record status.
    if (result.error) {
      this.patchScheduledStatus(id, `error: ${result.error.slice(0, 200)}`);
      await this.sendResultCard(target, `⏰ ${row.name} — failed`, `❌ ${result.error.slice(0, 1500)}`, 0xe74c3c);
    } else {
      this.patchScheduledStatus(id, "ok");
      await this.postScheduledResult(target, row.name, result.text, row.outputType);
    }
  }

  /** Spawn a throwaway runtime, run one prompt with attachments, collect the
   *  text, forward any files the agent produced to the thread, then tear down
   *  and delete the temp session (so it doesn't clutter `/seam sessions`). */
  private async runIsolatedScheduledJob(args: {
    profile: AgentProfile;
    record: SessionRecord;
    cwd: string;
    model?: string;
    effort?: string;
    channel: ChannelRef;
    promptText: string;
    attachments: MessageAttachment[];
  }): Promise<{ text: string; error?: string }> {
    const { profile, record, cwd, model, effort, channel, promptText, attachments } = args;
    // Target = the binding thread's session (what the job belongs to);
    // outputTo = where the run reports, which may be a different channel when
    // the schedule sets an explicit target.
    const result = await this.injectTurn(record, promptText, {
      session: "isolated",
      profile,
      cwd,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      outputTo: channel,
      attachments,
      timeoutMs: this.config.TURN_TIMEOUT_SECONDS * 1000,
      // Drain trailing SerialQueue text before returning, so a scheduled job's
      // output isn't truncated (compaction already drains; #19 preserved the old
      // no-drain behavior here, but dropping trailing text is a real bug).
      awaitIdle: true,
      logContext: { scheduled: "run" },
    });
    return { text: result.text, ...(result.error ? { error: result.error } : {}) };
  }

  /** Post captured output as fresh message(s) — blue cards or plain chunked
   *  messages per `outputType`; overflow → a single file attachment. Never edits
   *  the running card (it stays as a run record). */
  private async postScheduledResult(
    channel: ChannelRef,
    name: string,
    text: string,
    outputType: "card" | "messages"
  ): Promise<void> {
    const body = text.trim();
    if (!body) {
      await this.sendResultCard(channel, `⏰ ${name}`, "✅ Done — no output.", SCHEDULED_COLOR);
      return;
    }

    if (outputType === "messages") {
      await this.postPlainChunks(
        channel,
        body,
        name,
        "scheduled",
        `⏰ **${name}** — output attached (${body.length} chars).`
      );
      return;
    }

    // card output
    const chunks = this.chunkString(body, 3900);
    if (chunks.length <= 3) {
      for (let j = 0; j < chunks.length; j++) {
        const suffix = chunks.length > 1 ? ` (${j + 1}/${chunks.length})` : "";
        await this.sendResultCard(channel, `⏰ ${name}${suffix}`, chunks[j]!, SCHEDULED_COLOR);
      }
    } else {
      await this.sendResultCard(channel, `⏰ ${name}`, `✅ Done — full output attached (${body.length} chars).`, SCHEDULED_COLOR);
      await this.sendResultFile(channel, name, body);
    }
  }

  private chunkString(s: string, max: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    return out;
  }

  /** Post `body` (assumed non-empty, already trimmed) as traditional plain
   *  messages: chunk at 1900 chars and send each as its own `sendMessage`; if it
   *  would take more than 8 messages, send a one-line note and attach the whole
   *  body as a single file instead. Shared by the scheduled "messages" output and
   *  the default plain dispatch / report-back rendering — the "messages"-style
   *  overflow path. Reuses `chunkString` + `sendResultFile` (no bespoke chunking). */
  private async postPlainChunks(
    channel: ChannelRef,
    body: string,
    fileName: string,
    filePrefix: string,
    overflowNote: string
  ): Promise<void> {
    const chunks = this.chunkString(body, 1900);
    if (chunks.length <= 8) {
      for (const c of chunks) await this.adapter.sendMessage(channel, c);
    } else {
      await this.adapter.sendMessage(channel, overflowNote);
      await this.sendResultFile(channel, fileName, body, filePrefix);
    }
  }

  /** Split attachments into those the model reads inline (text + supported
   *  images → `inline`) and the rest (PDF/Office/HEIC/binary), which are staged
   *  to a temp path the agent opens with its file tools and described in `hint`.
   *  Shared by the live-turn path and the scheduled fire runner so both handle
   *  non-inlineable files identically. Works for https CDN and data: URLs.
   *
   *  `agentHasVision` is the agent's ACP-advertised `promptCapabilities.image`.
   *  When it's explicitly `false` (e.g. the Grok CLI's `agent stdio` bridge,
   *  which reports image:false even though grok-4.5 has vision), standard images
   *  can't be sent as prompt image blocks — mapAttachmentsToBlocks would degrade
   *  them to a useless `attachment://<name>` resource link with no bytes. So we
   *  stage them like other binaries instead, giving the agent a real file path
   *  its own tools can open. When vision is present (`true`) or unknown
   *  (`undefined`, e.g. the scheduled path with no live runtime), images stay
   *  inline as before. */
  private async partitionAndStageAttachments(
    attachments: ReadonlyArray<MessageAttachment>,
    agentHasVision?: boolean
  ): Promise<{ inline: MessageAttachment[]; hint: string | null }> {
    const STAGE_MAX = 100 * 1024 * 1024; // don't fill /tmp with huge files
    const inline: MessageAttachment[] = [];
    const stagedLines: string[] = [];
    const batchId = randomUUID().slice(0, 8);
    for (const a of attachments) {
      // Voice notes are transcribed into the prompt; never stage or inline audio.
      if (isVoiceNoteAttachment(a)) continue;
      if (isInlineableForAgent(a.contentType ?? "", a.filename, agentHasVision)) {
        inline.push(a);
        continue;
      }
      if (a.size > STAGE_MAX) {
        stagedLines.push(`- \`${a.filename}\` — too large to stage (${a.size} B)`);
        continue;
      }
      try {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const dest = await stageAttachment(a.filename, buf, batchId);
        stagedLines.push(`- \`${a.filename}\` → \`${dest}\``);
      } catch (err) {
        this.logger.warn({ err, filename: a.filename }, "failed to stage attachment");
        stagedLines.push(`- \`${a.filename}\` — could not be downloaded`);
      }
    }
    if (stagedLines.length === 0) return { inline, hint: null };
    void sweepStagedAttachments();
    const one = stagedLines.length === 1;
    const hint =
      `\n\n_The following file${one ? " was" : "s were"} saved to a temporary directory ` +
      `(auto-cleaned after ~48h) — read ${one ? "it" : "them"} with your file tools, and copy ` +
      `into the workspace anything you need to keep:_\n${stagedLines.join("\n")}`;
    return { inline, hint };
  }

  private async sendResultCard(channel: ChannelRef, title: string, description: string, color: number): Promise<void> {
    const p: StructuredPanel = { color, title, description: description.slice(0, 4096), fields: [] };
    if (this.adapter.sendPanel) await this.adapter.sendPanel(channel, p);
    else await this.adapter.sendMessage(channel, `${title}\n${description}`);
  }

  private async sendResultFile(
    channel: ChannelRef,
    name: string,
    body: string,
    prefix = "scheduled"
  ): Promise<void> {
    const filename = `${prefix}-${name.replace(/[^\w.-]+/g, "_") || "output"}.md`;
    if (this.adapter.sendFile) {
      await this.adapter.sendFile(channel, { data: Buffer.from(body, "utf8"), filename, mimeType: "text/markdown" });
    } else {
      for (const c of this.chunkString(body, 1900)) await this.adapter.sendMessage(channel, c);
    }
  }

  /** Update last_run/last_status, preserving next_run (manager-owned). */
  private patchScheduledStatus(id: string, status: string): void {
    const fresh = this.store.getScheduled(id);
    if (!fresh) return;
    this.store.upsertScheduled({ ...fresh, lastStatus: status, lastRunUtc: new Date().toISOString() });
  }

  // --- /seam schedule … -----------------------------------------------------

  private async cmdSchedule(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand(true);
    switch (sub) {
      case "add": return this.cmdScheduleAdd(i);
      case "edit": return this.cmdScheduleEdit(i);
      case "list": return this.cmdScheduleList(i);
      case "remove": return this.cmdScheduleRemove(i);
      case "toggle": return this.cmdScheduleToggle(i);
      case "addfile": return this.cmdScheduleAddFile(i);
      case "removefile": return this.cmdScheduleRemoveFile(i);
      default:
        await i.reply({ content: `Unknown schedule subcommand: ${sub}`, flags: MessageFlags.Ephemeral });
    }
  }

  /** Download a Discord attachment's bytes (URL is valid now; we persist them
   *  because Discord CDN URLs expire ~24h). */
  private async downloadAttachmentBytes(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  private scheduleSummaryLine(s: ScheduledPrompt): string {
    const state = s.enabled ? "🟢" : "⏸️";
    const last = s.lastStatus ? ` · last: ${s.lastStatus}` : "";
    const next = s.enabled && s.nextRunUtc ? ` · next: <t:${Math.floor(Date.parse(s.nextRunUtc) / 1000)}:R>` : "";
    const files = s.attachments.length ? ` · 📎${s.attachments.length}` : "";
    // Model is only meaningful for isolated schedules (live uses the thread's).
    const model = s.sessionMode !== "live" && s.model ? ` · 🤖${s.model}` : "";
    const mode = s.sessionMode === "live" ? " · 🧠live" : "";
    return `${state} **${s.name}** \`${s.id}\`\n   ${describeCron(s.cron)} (${s.timezone})${mode}${model}${files}${next}${last}`;
  }

  private async cmdScheduleList(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: "Use this inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const rows = this.store.listScheduledByChannel(PLATFORM, channel.id);
    if (rows.length === 0) {
      await i.reply({ content: "No scheduled prompts for this thread. Create one with `/seam schedule add`.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply({ ...this.buildScheduleListMessage(channel), flags: MessageFlags.Ephemeral });
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });
    collector.on("collect", async (c) => {
      try {
        if (!c.isButton()) return;
        const [, action, id] = c.customId.split(":");
        const row = id ? this.store.getScheduled(id) : undefined;
        if (!row || !id || row.channelRef !== channel.id) {
          await c.reply({ content: "That schedule no longer exists.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === "run") {
          await c.deferReply({ flags: MessageFlags.Ephemeral });
          if (this.scheduledManager) await this.scheduledManager.runNow(id);
          else await this.runScheduledPrompt(id);
          const fresh = this.store.getScheduled(id);
          const status = fresh?.lastStatus ?? "unknown";
          await c.editReply(
            status === "skipped: still running"
              ? `⏸️ **${row.name}** is already running — this click was skipped.`
              : `▶️ **${row.name}** finished — last: \`${status}\`.`
          );
        } else if (action === "edit") {
          collector.stop("edit");
          await this.cmdScheduleAdd(c, row); // opens the builder card in edit mode
        } else if (action === "toggle") {
          const updated: ScheduledPrompt = { ...row, enabled: !row.enabled, updatedUtc: new Date().toISOString() };
          this.store.upsertScheduled(updated);
          if (updated.enabled) this.scheduledManager?.armFromRow(updated);
          else this.scheduledManager?.disarm(id);
          await c.update(this.buildScheduleListMessage(channel));
        } else if (action === "del") {
          this.scheduledManager?.disarm(id);
          this.store.deleteScheduled(id);
          await deleteScheduledAttachmentDir(this.config.DATA_DIR, id).catch(() => {});
          await c.update(this.buildScheduleListMessage(channel));
        }
      } catch (err) {
        this.logger.warn({ err }, "schedule-list button handler failed");
      }
    });
  }

  /** `/seam schedule list` message: a summary embed plus per-schedule
   *  Run / Edit / Enable-Disable / Delete buttons (first 5 schedules; manage
   *  the rest via the id-based `/seam schedule …` commands). Rebuilt after
   *  toggle/delete. */
  private buildScheduleListMessage(channel: ChannelRef): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const rows = this.store.listScheduledByChannel(PLATFORM, channel.id);
    const embed = new EmbedBuilder()
      .setTitle("⏰ Scheduled prompts")
      .setColor(SCHEDULED_COLOR)
      .setDescription(
        rows.length
          ? rows.map((r) => this.scheduleSummaryLine(r)).join("\n\n")
          : "_No scheduled prompts for this thread._"
      );
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const r of rows.slice(0, 5)) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`sl:run:${r.id}`).setLabel("▶️ Run now").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`sl:edit:${r.id}`).setLabel(`✏️ ${r.name}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`sl:toggle:${r.id}`).setLabel(r.enabled ? "⏸️ Disable" : "🟢 Enable").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`sl:del:${r.id}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger),
        )
      );
    }
    return { embeds: [embed], components };
  }

  private async cmdScheduleRemove(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    this.scheduledManager?.disarm(id);
    this.store.deleteScheduled(id);
    await deleteScheduledAttachmentDir(this.config.DATA_DIR, id).catch(() => {});
    await i.reply({ content: `🗑️ Deleted scheduled prompt **${row.name}** (\`${id}\`).`, flags: MessageFlags.Ephemeral });
  }

  private async cmdScheduleToggle(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const updated: ScheduledPrompt = { ...row, enabled: !row.enabled, updatedUtc: new Date().toISOString() };
    this.store.upsertScheduled(updated);
    if (updated.enabled) this.scheduledManager?.armFromRow(updated);
    else this.scheduledManager?.disarm(id);
    await i.reply({
      content: `${updated.enabled ? "🟢 Enabled" : "⏸️ Disabled"} **${row.name}** (\`${id}\`).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdScheduleAddFile(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const file = i.options.getAttachment("file", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const bytes = await this.downloadAttachmentBytes(file.url);
      const saved = await saveScheduledAttachment(this.config.DATA_DIR, id, {
        filename: file.name,
        mime: file.contentType ?? "application/octet-stream",
        bytes,
      });
      const updated: ScheduledPrompt = {
        ...row,
        attachments: [...row.attachments.filter((a) => a.filename !== saved.filename), saved],
        updatedUtc: new Date().toISOString(),
      };
      this.store.upsertScheduled(updated);
      await i.editReply(`📎 Added \`${saved.filename}\` to **${row.name}** (${updated.attachments.length} file(s)).`);
    } catch (err) {
      await i.editReply(`❌ Failed to add file: ${(err as Error).message}`);
    }
  }

  private async cmdScheduleRemoveFile(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const filename = i.options.getString("filename", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await deleteScheduledAttachment(this.config.DATA_DIR, id, filename).catch(() => {});
    const updated: ScheduledPrompt = {
      ...row,
      attachments: row.attachments.filter((a) => a.filename !== filename),
      updatedUtc: new Date().toISOString(),
    };
    this.store.upsertScheduled(updated);
    await i.reply({ content: `🗑️ Removed \`${filename}\` from **${row.name}**.`, flags: MessageFlags.Ephemeral });
  }

  private async cmdScheduleEdit(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    return this.cmdScheduleAdd(i, row);
  }

  /** Shared builder card for create (existing undefined) and edit (existing set).
   *  In edit mode the schedule's stored attachments are managed separately via
   *  addfile/removefile; the card edits prompt/schedule/model/cwd/output. */
  private async cmdScheduleAdd(i: ChatInputCommandInteraction | MessageComponentInteraction, existing?: ScheduledPrompt): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: "Use `/seam schedule add` inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Bind the thread to a session record if it isn't already (so the job has a
    // repo/agent to run under).
    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const profile = this.router.getProfile(record.agentId);
    const cfg = this.store.readConfig(record);
    const sessionModel = cfg.model ?? profile?.defaultModel ?? null;
    const models = (profile?.staticModels ?? []).slice(0, 24);

    // Capture any files supplied on the command (references held; bytes fetched
    // on Create, while the URLs are still valid).
    const pending: Array<{ name: string; url: string; mime: string }> = [];
    if (i.isChatInputCommand()) {
      for (const opt of ["file", "file2", "file3"]) {
        const a = i.options.getAttachment(opt, false);
        if (a) pending.push({ name: a.name, url: a.url, mime: a.contentType ?? "application/octet-stream" });
      }
    }

    const state = {
      name: existing?.name ?? "",
      promptText: existing?.promptText ?? "",
      cron: (existing?.cron ?? null) as string | null,
      timezone: existing?.timezone ?? SCHEDULE_DEFAULT_TZ,
      model: existing?.model ?? null, // null = use session model
      cwd: existing?.cwd ?? null, // null = thread's repoPath
      target: existing?.targetChannel ?? null, // null = this thread
      outputType: (existing?.outputType ?? "card") as "card" | "messages",
      // "isolated" = throwaway clean session (default); "live" = a real turn in
      // this thread, sharing its session context (M4/D1). In live mode
      // model/cwd/target/output are meaningless and hidden below.
      sessionMode: (existing?.sessionMode ?? "isolated") as "isolated" | "live",
      files: pending,
    };
    // Edit mode: manage the row's stored attachments live — remove via the select
    // on the card, add via `/seam schedule addfile` (Discord cards can't accept a
    // file upload). Mutable copy so Save writes the current set, not the stale
    // original spread from `existing`.
    const editFiles = existing ? [...existing.attachments] : [];

    const render = () => {
      const cronLine = state.cron
        ? `${describeCron(state.cron)} \`${state.cron}\``
        : "*(not set)*";
      const next = state.cron ? cronNextRun(state.cron, state.timezone) : null;
      const filesValue = existing
        ? (editFiles.length
            ? editFiles.map((a) => `\`${a.filename}\``).join(", ") + " · *(remove below; add via `/seam schedule addfile`)*"
            : "*(none — add via `/seam schedule addfile`)*")
        : (state.files.length ? state.files.map((f) => `\`${f.name}\``).join(", ") : "*(none)*");
      const isLive = state.sessionMode === "live";
      const embed = new EmbedBuilder()
        .setTitle(existing ? `✏️ Edit scheduled prompt \`${existing.id}\`` : "⏰ New scheduled prompt")
        .setColor(SCHEDULED_COLOR)
        .setDescription(
          isLive
            ? "This runs **in this thread**, as a real turn on this conversation's session. " +
              "It streams like a normal message, shares and remembers this thread's context, and " +
              "waits its turn if the thread is busy. Attach any files it needs (re-sent every run)."
            : "This runs **on its own, on a clean session** — it won't remember this conversation. " +
              "Write the prompt so it stands alone, and attach any files it needs (re-sent every run)."
        )
        .addFields(
          { name: "🏷️ Name", value: state.name || "*(not set)*" },
          { name: "✏️ Prompt", value: state.promptText ? "```\n" + state.promptText.slice(0, 1000) + "\n```" : "*(not set — click ✏️ Prompt & name)*" },
          { name: "🕐 Runs", value: cronLine + (next ? `\nNext: <t:${Math.floor(next.getTime() / 1000)}:F>` : ""), inline: true },
          { name: "🌍 Timezone", value: state.timezone, inline: true },
          { name: "🧠 Session", value: isLive ? "live (in this thread)" : "isolated (clean session)", inline: true },
          // model/cwd/target/output are meaningless in live mode (D1) — hide them.
          ...(isLive ? [] : [
            { name: "🤖 Model", value: state.model ? `\`${state.model}\`` : `Session default${sessionModel ? ` (\`${sessionModel}\`)` : ""}`, inline: true },
            { name: "📂 Working dir", value: state.cwd ? `\`${state.cwd}\`` : "*(this thread's repo)*", inline: true },
            { name: "📮 Output to", value: state.target ? `<#${state.target}>` : "*(this thread)*", inline: true },
            { name: "🖼️ Output as", value: state.outputType === "messages" ? "plain messages" : "status cards", inline: true },
          ]),
          { name: "📎 Files", value: filesValue }
        );
      const cadence = new StringSelectMenuBuilder()
        .setCustomId("sched:cadence")
        .setPlaceholder("🕐 How often?")
        .addOptions(SCHEDULE_PRESETS.map((p) => ({ label: p.label, value: p.value })));
      const tz = new StringSelectMenuBuilder()
        .setCustomId("sched:tz")
        .setPlaceholder("🌍 Timezone")
        .addOptions(SCHEDULE_TIMEZONES.map((z) => ({ label: z, value: z, default: z === state.timezone })));
      // Buttons row (max 5). The mode toggle takes the one previously-free slot;
      // in live mode the now-meaningless output toggle is dropped so we stay ≤5.
      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("sched:prompt").setLabel("✏️ Prompt & details").setStyle(ButtonStyle.Primary),
        ...(isLive ? [] : [
          new ButtonBuilder().setCustomId("sched:output").setLabel(state.outputType === "messages" ? "🖼️ Output: messages" : "🖼️ Output: cards").setStyle(ButtonStyle.Secondary),
        ]),
        new ButtonBuilder().setCustomId("sched:mode").setLabel(isLive ? "🧠 Session: live" : "🧵 Session: isolated").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("sched:create").setLabel(existing ? "💾 Save" : "✅ Create").setStyle(ButtonStyle.Success).setDisabled(!state.cron || !state.promptText || !state.name),
        new ButtonBuilder().setCustomId("sched:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(cadence),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(tz),
      ];
      if (models.length > 0 && !isLive) {
        const modelSelect = new StringSelectMenuBuilder()
          .setCustomId("sched:model")
          .setPlaceholder("🤖 Model")
          .addOptions(
            { label: `Session default${sessionModel ? ` (${sessionModel})` : ""}`.slice(0, 100), value: "__default__", default: state.model === null },
            ...models.map((m) => ({ label: m.name.slice(0, 100), value: m.modelId, default: m.modelId === state.model }))
          );
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect));
      }
      rows.push(buttons);
      // Edit mode with files: a select to remove one (removal persists live).
      if (existing && editFiles.length > 0) {
        const rmfile = new StringSelectMenuBuilder()
          .setCustomId("sched:rmfile")
          .setPlaceholder("🗑️ Remove a file…")
          .addOptions(editFiles.slice(0, 25).map((a) => ({ label: a.filename.slice(0, 100), value: a.filename })));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(rmfile));
      }
      return { embeds: [embed], components: rows };
    };

    await i.reply({ ...render(), flags: MessageFlags.Ephemeral });
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });

    // If the builder times out with nothing saved, clear the (now-inert) buttons
    // and say so. Otherwise the card sits there looking clickable but dead — a
    // second silent-failure path on top of the Create no-op: the user keeps
    // clicking a timed-out builder and nothing happens or persists.
    collector.on("end", async (_collected, reason) => {
      // "created"/"saved"/"cancel" already replaced the message; only handle the
      // timeout (and ignore message-deleted, where there's nothing to edit).
      if (reason !== "time") return;
      try {
        await i.editReply({
          content: "⏰ Schedule builder timed out — nothing was saved. Run the schedule builder again to start over.",
          embeds: [],
          components: [],
        });
      } catch {
        /* interaction token expired (>15 min) — nothing we can edit */
      }
    });

    collector.on("collect", async (c) => {
      try {
        if (c.isStringSelectMenu() && c.customId === "sched:tz") {
          state.timezone = c.values[0]!;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:model") {
          const v = c.values[0]!;
          state.model = v === "__default__" ? null : v;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:rmfile") {
          // Remove a stored file immediately (matches /seam schedule removefile),
          // independent of Save; keep editFiles in sync so Save writes the rest.
          const filename = c.values[0]!;
          if (existing) {
            await deleteScheduledAttachment(this.config.DATA_DIR, existing.id, filename).catch(() => {});
            const idx = editFiles.findIndex((a) => a.filename === filename);
            if (idx >= 0) editFiles.splice(idx, 1);
            this.store.upsertScheduled({ ...existing, attachments: editFiles, updatedUtc: new Date().toISOString() });
          }
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:cadence") {
          const v = c.values[0]!;
          if (v === "__custom__") {
            const modal = new ModalBuilder().setCustomId(`sched:cronmodal:${msg.id}`).setTitle("Custom schedule")
              .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("cron").setLabel("Cron expression (min hour dom mon dow)")
                  .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("0 9 * * 1-5")
              ));
            await c.showModal(modal);
            const sub = await c.awaitModalSubmit({ filter: (m) => m.customId === `sched:cronmodal:${msg.id}` && m.user.id === i.user.id, time: 120_000 }).catch(() => null);
            if (sub) {
              const cron = sub.fields.getTextInputValue("cron").trim();
              const v2 = validateCron(cron, state.timezone);
              if (!v2.ok) {
                await sub.reply({ content: `❌ Invalid cron: ${v2.error}`, flags: MessageFlags.Ephemeral });
              } else {
                state.cron = cron;
                await sub.deferUpdate();
                await i.editReply(render());
              }
            }
          } else {
            state.cron = v;
            await c.update(render());
          }
        } else if (c.isButton() && c.customId === "sched:output") {
          state.outputType = state.outputType === "messages" ? "card" : "messages";
          await c.update(render());
        } else if (c.isButton() && c.customId === "sched:mode") {
          state.sessionMode = state.sessionMode === "live" ? "isolated" : "live";
          await c.update(render());
        } else if (c.isButton() && c.customId === "sched:prompt") {
          const modalLive = state.sessionMode === "live";
          const modalRows: ActionRowBuilder<TextInputBuilder>[] = [
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("name").setLabel("Name").setStyle(TextInputStyle.Short).setRequired(true).setValue(state.name).setMaxLength(80)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("prompt")
                .setLabel(modalLive ? "Prompt (runs in this thread, with context)" : "Prompt (stands on its own — no prior context)")
                .setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(state.promptText)
                .setPlaceholder("e.g. Run `npm test`, then post any failures as file:line with a one-line fix.")
            ),
          ];
          // Live mode ignores cwd/target (D1) — drop those inputs entirely.
          if (!modalLive) {
            modalRows.push(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("cwd").setLabel("Working dir (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(state.cwd ?? "")
                  .setPlaceholder("blank = this thread's repo; or a path under REPOS_ROOT")
              ),
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("target").setLabel("Output channel/thread id (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(state.target ?? "")
                  .setPlaceholder("blank = post here; or a numeric channel/thread id")
              )
            );
          }
          const modal = new ModalBuilder().setCustomId(`sched:promptmodal:${msg.id}`).setTitle("Prompt & details").addComponents(...modalRows);
          await c.showModal(modal);
          const sub = await c.awaitModalSubmit({ filter: (m) => m.customId === `sched:promptmodal:${msg.id}` && m.user.id === i.user.id, time: 600_000 }).catch(() => null);
          if (sub) {
            state.name = sub.fields.getTextInputValue("name").trim();
            state.promptText = sub.fields.getTextInputValue("prompt").trim();
            const errors: string[] = [];
            // cwd/target only exist as modal inputs in isolated mode.
            if (!modalLive) {
              const rawCwd = sub.fields.getTextInputValue("cwd").trim();
              if (rawCwd) {
                try { state.cwd = resolveRepoPath(this.config.REPOS_ROOT, rawCwd); }
                catch (e) { errors.push(`cwd: ${(e as Error).message}`); }
              } else state.cwd = null;
              const rawTarget = sub.fields.getTextInputValue("target").trim();
              if (rawTarget) {
                if (/^\d+$/.test(rawTarget)) state.target = rawTarget;
                else errors.push("output id must be a numeric channel/thread id");
              } else state.target = null;
            }
            await sub.deferUpdate();
            await i.editReply(render());
            if (errors.length) await sub.followUp({ content: `⚠️ ${errors.join("; ")}`, flags: MessageFlags.Ephemeral });
          }
        } else if (c.isButton() && c.customId === "sched:cancel") {
          collector.stop("cancel");
          await c.update({ content: "Cancelled.", embeds: [], components: [] });
        } else if (c.isButton() && c.customId === "sched:create") {
          await c.deferUpdate();
          // Don't silently no-op on a half-filled form. Clicking Create with an
          // unset name/prompt/cadence previously just vanished (deferUpdate ack'd
          // the click, then `return`), so a schedule the user believed they had
          // created was never persisted and never ran. Tell them what's missing
          // and keep the builder open. (Single combined guard so TS narrows the
          // three fields to non-null for the row construction below.)
          if (!state.name || !state.promptText || !state.cron) {
            const missing: string[] = [];
            if (!state.name) missing.push("a name");
            if (!state.promptText) missing.push("a prompt");
            if (!state.cron) missing.push("a cadence/schedule");
            await c.followUp({
              content: `⚠️ Not created yet — still need ${missing.join(", ")}. Use **Prompt & details** to set the name + prompt and pick a cadence, then click Create.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const now = new Date().toISOString();
          const next = cronNextRun(state.cron, state.timezone);
          const live = state.sessionMode === "live";
          // In live mode model/cwd/target/output are meaningless (D1) — null them
          // (output back to "card" default) so a mode flip during editing can't
          // leave stale values behind, and isolated stays valid on flip-back.
          const persistedModel = live ? null : state.model;
          const persistedCwd = live ? null : state.cwd;
          const persistedTarget = live ? null : state.target;
          const persistedOutput: "card" | "messages" = live ? "card" : state.outputType;
          let row: ScheduledPrompt;
          if (existing) {
            // Edit: preserve id, created*, enabled, last-run. Use editFiles (the
            // live-managed set) for attachments so a file removed via the card's
            // select isn't re-added by spreading the stale `existing`.
            row = {
              ...existing,
              name: state.name, promptText: state.promptText, cron: state.cron, timezone: state.timezone,
              model: persistedModel, cwd: persistedCwd, targetChannel: persistedTarget, outputType: persistedOutput,
              sessionMode: state.sessionMode,
              attachments: editFiles,
              updatedUtc: now, nextRunUtc: next ? next.toISOString() : null,
            };
            this.store.upsertScheduled(row);
            this.scheduledManager?.reschedule(existing.id);
          } else {
            const id = `sch_${randomUUID().slice(0, 8)}`;
            const attachments = [];
            for (const f of state.files) {
              try {
                const bytes = await this.downloadAttachmentBytes(f.url);
                attachments.push(await saveScheduledAttachment(this.config.DATA_DIR, id, { filename: f.name, mime: f.mime, bytes }));
              } catch (err) {
                this.logger.warn({ err, file: f.name }, "schedule: file download failed");
              }
            }
            row = {
              id, platform: PLATFORM, channelRef: channel.id, parentRef: channel.parentId ?? null,
              name: state.name, promptText: state.promptText, cron: state.cron, timezone: state.timezone,
              model: persistedModel, cwd: persistedCwd, targetChannel: persistedTarget, outputType: persistedOutput,
              sessionMode: state.sessionMode,
              catchupSeconds: 7200, enabled: true, attachments, createdBy: i.user.id,
              createdUtc: now, updatedUtc: now, lastRunUtc: null, lastStatus: null,
              nextRunUtc: next ? next.toISOString() : null, pinnedSessionId: null,
            };
            this.store.upsertScheduled(row);
            this.scheduledManager?.armFromRow(row);
          }
          collector.stop(existing ? "saved" : "created");
          const confirm = new EmbedBuilder()
            .setTitle(existing ? "✏️ Scheduled prompt updated" : "⏰ Scheduled prompt created")
            .setColor(0x2ecc71)
            .setDescription(
              `**${state.name}** \`${row.id}\`\nRuns ${describeCron(state.cron)} (${state.timezone})` +
              `\nSession: ${live ? "🧠 live (in this thread)" : "🧵 isolated (clean session)"}` +
              (live ? "" :
                (state.model ? `\nModel: \`${state.model}\`` : "") +
                (state.cwd ? `\nWorking dir: \`${state.cwd}\`` : "") +
                (state.target ? `\nOutput to: <#${state.target}>` : "") +
                `\nOutput as: ${state.outputType === "messages" ? "plain messages" : "status cards"}`) +
              (next ? `\nNext run: <t:${Math.floor(next.getTime() / 1000)}:F>` : "") +
              (row.attachments.length ? `\n📎 ${row.attachments.length} file(s) attached` : "") +
              (existing && !row.enabled ? `\n\n⏸️ This schedule is currently disabled — enable it with \`/seam schedule toggle\`.` : "") +
              `\n\nManage it with \`/seam schedule list\`.`
            );
          await i.editReply({ embeds: [confirm], components: [] });
        }
      } catch (err) {
        this.logger.error({ err }, "schedule builder interaction failed");
      }
    });
  }

  /**
   * Create a thread under the parent channel. Invoked inside a thread → sibling
   * (adapter.createThread walks up). Shared by `/seam new` and `/seam preset thread`.
   * When `addUserId` is set, add that user to the new thread so it shows in
   * their nav; on add failure, post a bare mention as fallback (happy path is silent).
   */
  private async createChildThread(
    parentChannelId: string,
    name: string,
    addUserId?: string
  ): Promise<ChannelRef> {
    if (!this.adapter.createThread) {
      throw new Error("This platform does not support creating threads.");
    }
    const parent: ChannelRef = { platform: PLATFORM, id: parentChannelId };
    const thread = await this.adapter.createThread(parent, name);
    if (addUserId && this.adapter.addThreadMember) {
      try {
        await this.adapter.addThreadMember(thread, addUserId);
      } catch (err) {
        this.logger.warn(
          { err, thread: thread.id, userId: addUserId },
          "addThreadMember failed; falling back to mention"
        );
        try {
          await this.adapter.sendMessage(thread, `<@${addUserId}>`);
        } catch (mentionErr) {
          this.logger.warn(
            { err: mentionErr, thread: thread.id },
            "thread member mention fallback failed"
          );
        }
      }
    }
    return thread;
  }

  /** Bind a session record to a just-created thread (same path as `/seam new`). */
  private bindSessionToThread(thread: ChannelRef): SessionRecord {
    return this.router.ensureSessionRecord({
      platform: thread.platform,
      channelRef: thread.id,
      ...(thread.parentId ? { parentRef: thread.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
  }

  private async cmdNew(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.adapter.createThread) {
      await i.reply({
        content: "This platform does not support creating threads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const name = i.options.getString("name") ?? "seam";
    if (!i.channelId) {
      await i.reply({ content: "No channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const thread = await this.createChildThread(i.channelId, name, i.user.id);

    // Auto-init: bind a session to the new thread and start the setup
    // flow so the user doesn't have to /seam config init themselves.
    // Reply BEFORE the pickers — Discord interaction tokens last 15 min
    // and a full wizard (agent/cwd/model/effort) can outlive that.
    try {
      const record = this.bindSessionToThread(thread);
      await i.editReply(`Created thread <#${thread.id}> and initialized it.`);
      if (this.config.NEW_THREAD_WIZARD === "full") {
        await this.runSetupWizard(thread, record);
      } else {
        await this.sendRepoPicker(thread);
      }
    } catch (err) {
      this.logger.warn({ err, threadId: thread.id }, "auto-init after /seam new failed");
      try {
        await i.editReply(
          `Created thread <#${thread.id}>. Run \`/seam config init\` there to begin.`
        );
      } catch {
        /* already replied */
      }
    }
  }

  private async cmdRepo(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    const channel = this.channelRefFromInteraction(i);
    if (!record || !channel) {
      await i.reply({
        content: "Use `/seam config repo` from inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const scope = (i.options.getString("scope") ?? "session") as "session" | "thread" | "channel";
    const requested = i.options.getString("path");
    const reply = async (content: string, ephemeral = true) => {
      if (i.deferred || i.replied) await i.editReply(content);
      else await i.reply({ content, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    };
    if (!requested) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await i.editReply("Posting repo picker…");
      const picked = await this.promptRepoPath(channel, {
        title: "🗂️ Choose a working repo",
        includeInherit: scope !== "session",
      });
      if (!picked) {
        await i.editReply(
          "Timed out — run `/seam config repo` again, or pass `path:`."
        );
        return;
      }
      const applied = await this.applyRepoAtScope(record, channel, picked, scope, {
        id: i.user.id,
        name: i.user.username,
      });
      if (!applied.ok) {
        await i.editReply(`Could not set repo: ${applied.error}`);
        return;
      }
      await i.editReply(applied.message);
      return;
    }
    const applied = await this.applyRepoAtScope(record, channel, requested, scope, {
      id: i.user.id,
      name: i.user.username,
    });
    if (!applied.ok) {
      await reply(`Invalid path: ${applied.error}`);
      return;
    }
    await reply(applied.message);
  }

  /**
   * Write a resolved repo path to session / thread-preset / channel-preset.
   * Channel scope always targets `record.parentRef` (this thread's parent).
   * `INHERIT_VALUE` clears a thread/channel overlay.
   */
  private async applyRepoAtScope(
    record: SessionRecord,
    channel: ChannelRef,
    requested: string,
    scope: "session" | "thread" | "channel",
    actor: { id: string; name: string }
  ): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    if (requested === INHERIT_VALUE) {
      if (scope === "session") {
        return { ok: false, error: "Session scope has no inherit — pass a path." };
      }
      if (scope === "channel") {
        if (!record.parentRef) {
          return { ok: false, error: "This thread has no parent channel to pin a channel-wide repo on." };
        }
        const written = this.configMutation.applyChannelOverlay({
          channelId: record.parentRef,
          changes: { cwd: null },
          actor,
        });
        if (!written.ok) return written;
        return {
          ok: true,
          message: "Channel repo overlay cleared — threads inherit unless they have their own overlay.",
        };
      }
      const written = this.configMutation.applyThreadOverlay({
        threadId: record.channelRef,
        ...(record.parentRef ? { parentRef: record.parentRef } : {}),
        changes: { cwd: null },
        actor,
      });
      if (!written.ok) return written;
      return { ok: true, message: "Thread-preset repo overlay cleared." };
    }

    let resolved: string;
    try {
      resolved = await this.resolveRequestedRepoPath(channel, requested);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const location = resolveThreadLocation(this.config, channel.id);
    if (isLocalLocation(location) && !isWithinRoot(resolved, this.config.REPOS_ROOT)) {
      return {
        ok: false,
        error: `Repo \`${resolved}\` is outside REPOS_ROOT (\`${this.config.REPOS_ROOT}\`).`,
      };
    }

    const display = this.repoDisplay(resolved);
    if (scope === "channel") {
      if (!record.parentRef) {
        return { ok: false, error: "This thread has no parent channel to pin a channel-wide repo on." };
      }
      const written = this.configMutation.applyChannelOverlay({
        channelId: record.parentRef,
        changes: { cwd: resolved },
        actor,
      });
      if (!written.ok) return written;
      return {
        ok: true,
        message:
          `Channel repo set to \`${display}\` — every thread in this channel inherits it unless it has its own overlay. Applies on the next turn.`,
      };
    }
    if (scope === "thread") {
      const written = this.configMutation.applyThreadOverlay({
        threadId: record.channelRef,
        ...(record.parentRef ? { parentRef: record.parentRef } : {}),
        changes: { cwd: resolved },
        actor,
      });
      if (!written.ok) return written;
      return {
        ok: true,
        message: `Thread-preset repo set to \`${display}\`. Applies on the next turn.`,
      };
    }

    const applied = await this.applyPickedRepo(channel, resolved);
    if (!applied.ok) return applied;
    return {
      ok: true,
      message: `Repo set to \`${this.repoDisplay(applied.record.repoPath ?? resolved)}\`. Next message starts a fresh session.`,
    };
  }

  private async cmdModel(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const id = i.options.getString("id");
    if (!id) {
      // No id given — show an interactive picker. Eagerly start the
      // runtime if needed so we have an availableModels list (the model
      // catalog comes from the agent at session-start, not from us).
      const cfg = this.store.readConfig(record);
      const current = cfg.model ?? this.config.DEFAULT_MODEL;
      const displayCurrent = `\`${current}\``;
      if (!this.adapter.sendChoicePicker) {
        await i.reply({
          content: `Current model: ${displayCurrent}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let models: ReadonlyArray<{ modelId: string; name?: string }> = [];
      const profile = this.router.getProfile(record.agentId);
      if (profile?.staticModels && profile.staticModels.length > 0) {
        models = profile.staticModels;
      } else {
        try {
          const rt = await this.router.getOrStartRuntime(record);
          models = rt.getSessionInfo()?.availableModels ?? [];
        } catch (err) {
          this.logger.warn({ err }, "could not start runtime / enumerate models");
          await i.editReply(
            `Current model: ${displayCurrent}\nFailed to start the agent to list models: ${(err as Error).message}`
          );
          return;
        }
      }

      if (models.length === 0) {
        await i.editReply(
          `Current model: ${displayCurrent}\n_(agent did not advertise any models — pass an id manually: \`/seam config model id:<name>\`.)_`
        );
        return;
      }
      await i.editReply(`Current model: ${displayCurrent}. Posting picker…`);
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose a model",
          fields: [{ name: "Current", value: displayCurrent, inline: true }],
        },
        choices: models.map((m) => ({
          value: m.modelId,
          label: m.name ?? m.modelId,
          description: m.modelId,
        })),
        authorizedUserIds: mayConfigureUserIds(this.config),
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Model changed",
          fields: [
            { name: "Previous", value: `\`${current}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) return;
      await this.applyModelChange(channel, record, picked.value);
      return;
    }
    await this.applyModelChange(channel, record, id, i);
  }

  /**
   * Persist + (best-effort) live-apply a model id. If `interaction` is
   * supplied, reply ephemerally to it; otherwise post the result to the
   * channel (for picker-driven flows).
   */
  private async applyModelChange(
    channel: ChannelRef,
    record: SessionRecord,
    id: string,
    interaction?: ChatInputCommandInteraction
  ): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.model = id;
    // The cached usage was measured under the prior model; window/used both
    // belong to a different model now. Invalidate so the next turn starts
    // clean rather than seeding the panel with mismatched numbers.
    cfg.lastContextUsage = undefined;
    this.persistConfig(record, cfg);
    const overlay = this.configMutation.applyThreadOverlay({
      threadId: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      changes: { model: id },
      actor: interaction
        ? { id: interaction.user.id, name: interaction.user.displayName ?? interaction.user.username }
        : { id: null, name: null },
    });
    if (!overlay.ok) {
      this.logger.warn({ err: overlay.error, threadId: channel.id }, "thread model overlay write failed");
    }
    let message: string;
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.setModel(id);
        message = `🧠 Model set to \`${id}\` (live).`;
      } catch (err) {
        this.logger.warn({ err }, "live model set failed; invalidating runtime for respawn");
        // Kill the runtime so next turn spawns with the correct model in env
        // vars (ANTHROPIC_MODEL). Without this, non-Anthropic backends (Ollama
        // Cloud, Z.ai) keep running the old model since setModel() is rejected.
        await this.router.invalidate(record.id);
        message = `🧠 Model will be \`${id}\` on the next turn (session respawn).`;
      }
    } else {
      message = `🧠 Model will be \`${id}\` on the next turn.`;
    }
    if (interaction) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await this.adapter.sendMessage(channel, message);
    }
  }

  private async cmdMode(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = i.options.getString("id", true);
    const cfg = this.store.readConfig(record);
    cfg.mode = id;
    this.persistConfig(record, cfg);
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.setMode(id);
      } catch (err) {
        this.logger.warn({ err }, "live mode set failed");
      }
    }
    await i.reply({ content: `Mode set to \`${id}\`.`, flags: MessageFlags.Ephemeral });
  }

  private async cmdEffort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const level = i.options.getString("level");
    const cfg = this.store.readConfig(record);
    const current = cfg.reasoningEffort ?? "default";

    // Gate by the active agent's effort capability. Not every agent exposes a
    // settable reasoning effort: agy bakes it into the model choice; others have
    // none. Showing the picker for those would be a false "✅ changed".
    const profile = this.router.getProfile(record.agentId);
    const eff = profile?.effort;
    const supported = eff?.levels ?? [];
    if (supported.length === 0) {
      const msg =
        eff?.mechanism === "modelBaked"
          ? `Effort for \`${record.agentId}\` is part of the **model** choice — pick a high/med/low model variant with \`/seam config model\`.`
          : `The active agent (\`${record.agentId}\`) doesn't support a reasoning-effort setting.`;
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }
    const effortChoices = EFFORT_CHOICES.filter((c) => supported.includes(c.value));
    const supportedList = supported.map((l) => `\`${l}\``).join(", ");

    // No argument → interactive picker (falling back to a text report when the
    // adapter has no picker support).
    if (!level) {
      const channel = this.channelRefFromInteraction(i);
      if (!channel || !this.adapter.sendChoicePicker) {
        const body =
          cfg.reasoningEffort
            ? `Reasoning effort: \`${cfg.reasoningEffort}\`.`
            : `Reasoning effort is **unset** — the agent uses its own default. Set with \`/seam config effort level:<${supported.join("|")}>\`.`;
        await i.reply({ content: body, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await i.editReply(`Current effort: \`${current}\`. Posting picker…`);
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose reasoning effort",
          fields: [{ name: "Current", value: `\`${current}\``, inline: true }],
        },
        choices: effortChoices,
        authorizedUserIds: mayConfigureUserIds(this.config),
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Effort changed",
          fields: [
            { name: "Previous", value: `\`${current}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username} — applies on the next message`,
        }),
      });
      if (!picked) return;
      await this.applyEffortChange(record, picked.value);
      return;
    }

    // Explicit level: validate against what THIS agent supports. The slash
    // command registers the full 5-level list statically, so an agent with a
    // narrower range (e.g. Codex: low/medium/high) must reject xhigh/max here.
    if (!supported.includes(level)) {
      await i.reply({
        content: `\`${level}\` isn't supported by \`${record.agentId}\` — choose one of: ${supportedList}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.applyEffortChange(record, level);
    await i.reply({
      content: `Reasoning effort set to \`${level}\` — applies on your next message.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  /** Persist the effort and invalidate the live runtime so the next turn
   *  recreates/resumes the session with the new effort applied. */
  private async applyEffortChange(
    record: SessionRecord,
    level: string
  ): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.reasoningEffort = level;
    this.persistConfig(record, cfg);
    const overlay = this.configMutation.applyThreadOverlay({
      threadId: record.channelRef,
      ...(record.parentRef ? { parentRef: record.parentRef } : {}),
      changes: { effort: level },
      actor: { id: null, name: null },
    });
    if (!overlay.ok) {
      this.logger.warn(
        { err: overlay.error, threadId: record.channelRef },
        "thread effort overlay write failed"
      );
    }
    // Effort is applied when the session is (re)built, per the agent's
    // mechanism: Claude via `_meta.claudeCode.options.effort` (set_config_option
    // for "effort" errors there); Copilot via the `reasoning_effort` config
    // option (AgentRuntime.applyConfigOptionEffort). Invalidate so the next turn
    // rebuilds with the new effort; preserve the ACP session id for context.
    if (this.router.hasRuntime(record.id)) {
      await this.router.invalidate(record.id, { clearAcpSession: false });
    }
  }

  /**
   * Cancel this thread's turn (graceful), or escalate via options (#78):
   *   - no opts            → today's cancel (this thread, graceful)
   *   - `force:true`       → today's abort (this thread, escalate to force-kill)
   *   - `scope:all`        → today's kill (killAll, bot-wide)
   * Option bodies stay in cmdAbort / cmdKill so the handlers stay identical.
   */
  private async cmdCancel(i: ChatInputCommandInteraction): Promise<void> {
    const scope = i.options.getString("scope");
    if (scope === "all") return this.cmdKill(i);
    const force = i.options.getBoolean("force") ?? false;
    if (force) return this.cmdAbort(i);
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    // #89 D8: drop the parked row BEFORE abort so turn-end fire cannot run it.
    const parked = await this.clearParkedForChannel(record.channelRef);
    // #76: clear markers at the COMMAND layer, where user intent is
    // unambiguous. dispose()/invalidate() MUST leave them intact — SIGTERM
    // also converges on dispose, and wiping there would make resume a
    // silent no-op on every graceful reboot.
    await this.clearTurnMarkersForChannel(record.channelRef, "cancelled");
    const outcome = await this.router.abortTurn(record.id, { force: false });
    await i.editReply(
      outcome === "idle"
        ? parked
          ? this.parkedCancelMessage(parked)
          : "No active turn."
        : `🟡 Cancel sent. If the turn doesn't stop shortly, use \`/seam cancel force:true\` to force it.${
            parked ? " Also cancelled the queued prompt." : ""
          }`
    );
  }

  /** Escalating: cancel first, and if the turn is still running after a short
   *  grace period (a hung turn ignoring the cancel), force-kill the agent
   *  process. The acpSessionId is preserved so the next message resumes cleanly. */
  private async cmdAbort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.router.hasRuntime(record.id)) {
      const parked = await this.clearParkedForChannel(record.channelRef);
      await i.reply({
        content: parked ? this.parkedCancelMessage(parked) : "No active turn.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    // #89 D8: drop the parked row BEFORE abort so turn-end fire cannot run it.
    const parked = await this.clearParkedForChannel(record.channelRef);
    // #76: command-layer clear — see cmdCancel. abortTurn may invalidate →
    // dispose; markers must already be terminal before that runs.
    await this.clearTurnMarkersForChannel(record.channelRef, "cancelled");
    const outcome = await this.router.abortTurn(record.id, { force: true });
    const parkedNote = parked ? ` ${this.parkedCancelMessage(parked)}` : "";
    await i.editReply(
      outcome === "idle"
        ? parked
          ? this.parkedCancelMessage(parked)
          : "No active turn."
        : outcome === "killed"
          ? `🔪 Turn was hung — force-killed the agent. Your next message resumes the session.${parkedNote}`
          : `🛑 Active turn aborted.${parkedNote}`
    );
  }

  /** Nuclear: force-kill EVERY active agent session the bot is running,
   *  INCLUDING this thread — a slash command isn't an LLM turn, so it runs even
   *  when the current thread's turn is wedged, and that wedged turn is usually
   *  exactly what you're trying to kill. Session ids are preserved, so every
   *  killed session resumes cleanly on its next message. */
  private async cmdKill(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    // #89 D8: drop parked rows BEFORE killing so turn-end fire cannot run them.
    const parked = await this.clearAllParked();
    // #76: command-layer clear of EVERY marker (killAll → invalidate →
    // dispose). Involuntary deaths (onDead, SIGTERM) do not take this path.
    await this.clearAllTurnMarkers("cancelled");
    const killed = await this.router.killAll();
    const parkedNote =
      parked.length === 0
        ? ""
        : ` Also cleared ${parked.length} parked prompt${parked.length === 1 ? "" : "s"}.`;
    await i.editReply(
      killed === 0
        ? parked.length === 0
          ? "No active sessions to kill."
          : `📥 Cleared ${parked.length} parked prompt${parked.length === 1 ? "" : "s"} waiting for offline hosts.`
        : `🔪 Force-killed ${killed} active session(s) — including this thread. Each resumes on its next message.${parkedNote}`
    );
  }

  /**
   * Command-layer marker clear for one thread. Writes the terminal state
   * BEFORE removing the live marker / running spec (writeDone ordering).
   * Must NOT be called from dispose()/invalidate()/onDead.
   */
  private async clearTurnMarkersForChannel(
    channelRef: string,
    status: "cancelled"
  ): Promise<void> {
    const now = new Date().toISOString();
    const liveId = this.liveTurnByChannel.get(channelRef);
    if (liveId) this.liveTurnByChannel.delete(channelRef);
    const markers = await listLiveMarkers(this.config.DATA_DIR).catch(() => [] as LiveTurnMarker[]);
    for (const m of markers) {
      if (m.channelRef !== channelRef && m.id !== liveId) continue;
      await finishLiveTurn(this.config.DATA_DIR, {
        id: m.id,
        status,
        channelRef: m.channelRef,
        finishedUtc: now,
        reason: "cancelled by operator",
      }).catch((err) =>
        this.logger.warn({ err, id: m.id }, "live-turn marker cancel failed")
      );
    }
    await this.dispatchWatcher?.cancelRunning({ target: channelRef }).catch((err) =>
      this.logger.warn({ err, channelRef }, "dispatch cancelRunning failed")
    );
  }

  /** `/seam cancel scope:all` — finalize every live marker and running spec. */
  private async clearAllTurnMarkers(status: "cancelled"): Promise<void> {
    const now = new Date().toISOString();
    this.liveTurnByChannel.clear();
    const markers = await listLiveMarkers(this.config.DATA_DIR).catch(() => [] as LiveTurnMarker[]);
    for (const m of markers) {
      await finishLiveTurn(this.config.DATA_DIR, {
        id: m.id,
        status,
        channelRef: m.channelRef,
        finishedUtc: now,
        reason: "cancelled by operator (scope:all)",
      }).catch((err) =>
        this.logger.warn({ err, id: m.id }, "live-turn marker cancel-all failed")
      );
    }
    await this.dispatchWatcher?.cancelRunning().catch((err) =>
      this.logger.warn({ err }, "dispatch cancelRunning (all) failed")
    );
  }

  private async checkResumePreconditions(target: ChannelRef): Promise<ResumePrecondition> {
    if (typeof this.adapter.getThreadLiveState !== "function") return "ok";
    try {
      const state = await this.adapter.getThreadLiveState(target);
      if (state === undefined) return "deleted";
      if (state.locked) return "locked";
      if (state.archived) return "archived";
      return "ok";
    } catch {
      return "unreachable";
    }
  }

  private async postResumeNotice(channelRef: string, text: string): Promise<void> {
    try {
      await this.adapter.sendMessage?.(
        { platform: PLATFORM, id: channelRef },
        text
      );
    } catch (err) {
      this.logger.warn({ err, channelRef }, "resume notice failed");
    }
  }

  private async abandonLiveMarker(marker: LiveTurnMarker, reason: string): Promise<void> {
    const maxAge =
      this.config.SEAM_TURN_RESUME_MAX_AGE_SECONDS ?? TURN_RESUME_MAX_AGE_SECONDS;
    await finishLiveTurn(this.config.DATA_DIR, {
      id: marker.id,
      status: "abandoned",
      channelRef: marker.channelRef,
      finishedUtc: new Date().toISOString(),
      reason,
    });
    if (reason !== "thread deleted") {
      await this.postResumeNotice(marker.channelRef, abandonedNotice(reason, maxAge));
    }
    this.logger.info({ id: marker.id, reason, channel: marker.channelRef }, "live-turn abandoned");
  }

  private async abandonDispatchSpec(spec: { id: string; target: string }, reason: string): Promise<void> {
    const maxAge =
      this.config.SEAM_TURN_RESUME_MAX_AGE_SECONDS ?? TURN_RESUME_MAX_AGE_SECONDS;
    await this.dispatchWatcher?.abandonRunning(spec.id, reason);
    try {
      this.store.updateDelegationStatus(spec.id, "abandoned");
    } catch {
      /* best-effort */
    }
    if (reason !== "thread deleted") {
      await this.postResumeNotice(spec.target, abandonedNotice(reason, maxAge));
    }
    this.logger.info({ id: spec.id, reason, target: spec.target }, "dispatch resume abandoned");
  }

  /**
   * Re-fire an interrupted live human turn. Copies the live branch of
   * `runScheduledPromptInner`: synthetic IncomingMessage → queueOnChannel →
   * handleIncomingMessageInner, abort detected via channelGenerations.
   * Does NOT use handleIncomingMessage (would bump generation / pre-empt)
   * and does NOT use injectTurn (captures instead of streaming).
   */
  private async refireLiveTurn(marker: LiveTurnMarker): Promise<void> {
    const channel: ChannelRef = {
      platform: PLATFORM,
      id: marker.channelRef,
      ...(marker.parentRef ? { parentId: marker.parentRef } : {}),
    };
    try {
      await this.adapter.sendMessage?.(channel, RESUME_ANNOUNCE);
    } catch (err) {
      this.logger.warn({ err, id: marker.id }, "live-turn resume announce failed");
    }
    const synthetic: IncomingMessage = {
      channel,
      authorId: marker.authorId ?? "system",
      authorIsBot: false,
      text: CONTINUE_PROMPT,
    };
    this.pendingLiveResume.set(marker.channelRef, marker);
    try {
      await this.queueOnChannel(marker.channelRef, async () => {
        const genAtStart = this.channelGenerations.get(marker.channelRef) ?? 0;
        await this.handleIncomingMessageInner(synthetic);
        const aborted =
          (this.channelGenerations.get(marker.channelRef) ?? 0) > genAtStart;
        if (aborted) {
          this.logger.info({ id: marker.id }, "live-turn resume aborted by user");
        }
      });
    } catch (err) {
      this.pendingLiveResume.delete(marker.channelRef);
      this.logger.warn({ err, id: marker.id }, "live-turn resume failed");
    }
  }

  /**
   * Boot recovery (#76). Markers are ALWAYS reconciled (max-age / deleted
   * thread → abandon + notice). Auto-resume ("continue" + loadSession) is
   * gated by SEAM_TURN_RESUME_ENABLED — default off means unconfigured ==
   * today's behavior.
   *
   * SINGLE-INSTANCE ASSUMPTION: no other seam-acp process owns these turns.
   * Two processes on one DATA_DIR would double-resume everything.
   */
  async recoverInterruptedTurns(): Promise<void> {
    const enabled = this.config.SEAM_TURN_RESUME_ENABLED === true;
    const maxAge =
      this.config.SEAM_TURN_RESUME_MAX_AGE_SECONDS ?? TURN_RESUME_MAX_AGE_SECONDS;
    const now = new Date();

    const live = await listLiveMarkers(this.config.DATA_DIR).catch(() => [] as LiveTurnMarker[]);
    const liveJobs: Array<Promise<void>> = [];
    for (const marker of live) {
      const pre = await this.checkResumePreconditions({
        platform: PLATFORM,
        id: marker.channelRef,
        ...(marker.parentRef ? { parentId: marker.parentRef } : {}),
      });
      const decision = decideResume({
        startedUtc: marker.startedUtc,
        maxAgeSeconds: maxAge,
        now,
        precondition: pre,
        acpSessionId: marker.acpSessionId,
      });
      if (decision.action === "abandon") {
        await this.abandonLiveMarker(marker, decision.reason);
        continue;
      }
      if (decision.action === "skip") {
        this.logger.info(
          { id: marker.id, reason: decision.reason, channel: marker.channelRef },
          "live-turn resume skipped"
        );
        continue;
      }
      if (!enabled) continue;
      liveJobs.push(
        this.resumeScheduler.run(() => this.resumeOnSameHost(marker, maxAge, now))
      );
    }

    if (enabled && this.dispatchWatcher) {
      const stale = await this.dispatchWatcher.listStaleRunning();
      for (const spec of stale) {
        const pre = await this.checkResumePreconditions({
          platform: PLATFORM,
          id: spec.target,
        });
        const ledger = this.store.getDelegation(spec.id);
        const decided = decideResume({
          startedUtc: spec.createdUtc,
          maxAgeSeconds: maxAge,
          now,
          precondition: pre,
          acpSessionId: ledger?.acpSessionId,
        });
        if (decided.action === "abandon") {
          await this.abandonDispatchSpec(spec, decided.reason);
          continue;
        }
        if (decided.action === "skip") {
          this.logger.info(
            { id: spec.id, reason: decided.reason, target: spec.target },
            "dispatch resume skipped"
          );
          continue;
        }
        liveJobs.push(
          this.resumeScheduler.run(async () => {
            const loc =
              spec.location ?? resolveThreadLocation(this.config, spec.target);
            const waited = await this.waitForResumeHost(loc, spec.createdUtc, maxAge, now);
            if (waited === "abandon") {
              await this.abandonDispatchSpec(spec, "bridge not ready (past max-age)");
              return;
            }
            if (!isLocalLocation(loc)) {
              bindSessionLocation(
                this.bridgeHub,
                `discord:${spec.target}`,
                loc
              );
            }
            await this.dispatchWatcher!.requeueStale(spec.id);
          })
        );
      }
    }

    await Promise.all(liveJobs);
  }

  /** Unified interrupted/abandoned inventory for `/seam workflows`. */
  private async collectInterruptedRows(): Promise<InterruptedTurnRow[]> {
    const rows: InterruptedTurnRow[] = [];
    const seen = new Set<string>();
    for (const e of this.store.listDelegationsByStatus(["interrupted", "abandoned"])) {
      seen.add(e.id);
      rows.push({
        id: e.id,
        source: "dispatch",
        channelRef: e.targetRef ?? e.sourceRef ?? "",
        correlationId: e.correlationId,
        status: e.status === "abandoned" ? "abandoned" : "interrupted",
        startedUtc: e.updatedUtc || e.createdUtc,
        acpSessionId: e.acpSessionId,
      });
    }
    const live = await listLiveMarkers(this.config.DATA_DIR).catch(() => [] as LiveTurnMarker[]);
    for (const m of live) {
      if (seen.has(m.id)) continue;
      rows.push({
        id: m.id,
        source: "live",
        channelRef: m.channelRef,
        correlationId: null,
        status: "interrupted",
        startedUtc: m.startedUtc,
        acpSessionId: m.acpSessionId ?? null,
      });
    }
    const abandonedLive = await listAbandonedLiveTurns(this.config.DATA_DIR).catch(
      () => [] as Awaited<ReturnType<typeof listAbandonedLiveTurns>>
    );
    for (const r of abandonedLive) {
      if (seen.has(r.id)) continue;
      rows.push({
        id: r.id,
        source: "live",
        channelRef: r.channelRef,
        correlationId: null,
        status: "abandoned",
        startedUtc: r.finishedUtc,
        acpSessionId: null,
      });
    }
    return rows;
  }

  /** Operator-initiated resume from `/seam workflows` — bypasses max-age
   *  and the auto-resume flag (the operator clicked Resume). */
  async resumeTurnManually(id: string): Promise<string> {
    const live = await listLiveMarkers(this.config.DATA_DIR).catch(() => [] as LiveTurnMarker[]);
    const marker = live.find((m) => m.id === id);
    if (marker) {
      if (!marker.acpSessionId) {
        return `Cannot resume \`${id}\` — no recorded ACP session.`;
      }
      void this.resumeScheduler.run(() => this.refireLiveTurn(marker));
      return `▶️ Resuming live turn \`${id}\` in <#${marker.channelRef}>…`;
    }
    const stale = (await this.dispatchWatcher?.listStaleRunning()) ?? [];
    const spec = stale.find((s) => s.id === id);
    if (spec) {
      const ok = await this.dispatchWatcher!.requeueStale(spec.id);
      return ok
        ? `▶️ Re-queued dispatch \`${id}\` as a resume (continue + loadSession).`
        : `Could not re-queue \`${id}\`.`;
    }
    const ledger = this.store.getDelegation(id);
    if (ledger && (ledger.status === "interrupted" || ledger.status === "abandoned")) {
      const target = ledger.targetRef;
      if (!target || !ledger.acpSessionId) {
        return `Cannot resume \`${id}\` — missing target or ACP session.`;
      }
      const resumeKind = ledger.kind === "inbox" ? "handoff" : ledger.kind;
      await enqueueDispatchSpec(this.config.DATA_DIR, {
        id: `${id}-resume`,
        target,
        prompt: CONTINUE_PROMPT,
        session: "live",
        resume: true,
        kind: resumeKind,
        ...(ledger.correlationId ? { correlationId: ledger.correlationId } : {}),
        createdUtc: new Date().toISOString(),
      });
      // Point the new spec at the recorded session via a ledger row the
      // dispatcher will look up — stamp the original's session on a
      // running-shaped row so loadSession finds it. The new spec id is
      // different, so copy the pointer onto a fresh dispatched row.
      try {
        this.store.recordDelegation({
          id: `${id}-resume`,
          kind: ledger.kind,
          targetRef: target,
          correlationId: ledger.correlationId,
          acpSessionId: ledger.acpSessionId,
          status: "dispatched",
        });
      } catch {
        /* already exists */
      }
      return `▶️ Enqueued resume of \`${id}\` into the recorded session.`;
    }
    return `No interrupted/abandoned turn \`${id}\`.`;
  }

  async abandonTurnManually(id: string): Promise<string> {
    const live = await listLiveMarkers(this.config.DATA_DIR).catch(() => [] as LiveTurnMarker[]);
    const marker = live.find((m) => m.id === id);
    if (marker) {
      await this.abandonLiveMarker(marker, "abandoned by operator");
      return `🚫 Abandoned live turn \`${id}\`.`;
    }
    const stale = (await this.dispatchWatcher?.listStaleRunning()) ?? [];
    const spec = stale.find((s) => s.id === id);
    if (spec) {
      await this.abandonDispatchSpec(spec, "abandoned by operator");
      return `🚫 Abandoned dispatch \`${id}\`.`;
    }
    const ledger = this.store.getDelegation(id);
    if (ledger && (ledger.status === "interrupted" || ledger.status === "running")) {
      try {
        this.store.updateDelegationStatus(id, "abandoned");
      } catch {
        /* best-effort */
      }
      await this.dispatchWatcher?.abandonRunning(id, "abandoned by operator");
      return `🚫 Abandoned \`${id}\`.`;
    }
    return `No resumable turn \`${id}\`.`;
  }

  /** Steer a running (or idle) node: preemptively cancel its in-flight turn,
   *  then inject a FRAMED re-prompt into that thread's LIVE session so its
   *  history/session is preserved (no new session). Works cross-thread — the
   *  `thread` option names the target, which may differ from where the command
   *  was run — and on an idle node (nothing to cancel, the inject just runs).
   *
   *  Cancel uses the same mechanism as `/seam cancel`: a graceful ACP cancel via
   *  `router.abortTurn(id, { force: false })`. The inject is queued on the
   *  target's channel (`queueOnChannel`) so it takes the cancelled turn's place
   *  in line rather than overlapping its event stream. */
  /**
   * Resolve the operator's display name for a slash interaction via the same
   * speaker-identity precedence as chat messages (#57): admin override → guild
   * nickname → global name → username. Used to attribute a cooperative steer to
   * the human who issued it. `i.member` may be a full GuildMember (has
   * `displayName`) or the raw API shape (no getter) — read it defensively.
   */
  private interactionSpeakerName(i: ChatInputCommandInteraction): string {
    const member = i.member;
    const nickname =
      member && typeof member === "object" && "displayName" in member
        ? ((member as { displayName?: string | null }).displayName ?? null)
        : null;
    return resolveDiscordSpeakerName(
      {
        userId: i.user.id,
        nickname,
        globalName: i.user.globalName ?? null,
        username: i.user.username,
      },
      this.config.DISCORD_USER_NAMES
    );
  }

  private async cmdSteer(i: ChatInputCommandInteraction): Promise<void> {
    const explicit = i.options.getString("thread")?.trim();
    const here = this.channelRefFromInteraction(i);
    const threadId = explicit || here?.id;
    const prompt = i.options.getString("prompt", true);
    // #63 two-tier: `now:true` is PREEMPTIVE (cancel-and-reprompt, today's
    // behavior); `now:false` (DEFAULT) is COOPERATIVE — push into the session's
    // inbox (#61) with no cancel, delivered at the agent's next poll_inbox.
    const now = i.options.getBoolean("now") ?? false;
    if (!threadId) {
      await i.reply({
        content: "Pass `thread:` or run this inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const parentId = !explicit ? here?.parentId : undefined;
    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: threadId,
      ...(parentId ? { parentRef: parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const target: ChannelRef = {
      platform: PLATFORM,
      id: threadId,
      ...(parentId ? { parentId } : {}),
    };

    if (!now) {
      // COOPERATIVE (#63 default): queue the steer into the target's inbox — no
      // cancel, no new turn. The running (or idle) agent absorbs it on its next
      // poll_inbox. Attributed to the operator via speaker-identity (#57).
      const from = humanInboxFrom(this.interactionSpeakerName(i), i.user.id);
      const { queued } = this.pushHumanInbox(record, from, prompt);
      await i.editReply(
        `💬 Queued your steer into thread ${threadId}'s inbox — ${queued} message(s) waiting. ` +
          `The agent reads it at its next inbox poll; no turn was cancelled. ` +
          `Add \`now:true\` to cancel-and-reprompt instead.`
      );
      return;
    }

    // Preemptive cancel — identical to `/seam cancel` (graceful ACP cancel).
    const cancelOutcome = await this.router.abortTurn(record.id, { force: false });

    const framed = frameSteerPrompt(prompt);
    const result = await this.queueOnChannel(threadId, () =>
      this.injectTurn(record, framed, {
        session: "live",
        outputTo: target,
        timeoutMs: this.config.TURN_TIMEOUT_SECONDS * 1000,
        // Drain trailing text that lands after the prompt RPC resolves so the
        // posted response holds the whole answer, not a truncated one.
        awaitIdle: true,
        logContext: { steer: record.id },
      })
    );

    // Post the steered response into the target thread so it's visible there,
    // then confirm to the operator (ephemerally).
    await this.postSteerOutput(target, result.text, result.error);
    const lead =
      cancelOutcome === "cancelled"
        ? "🧭 Cancelled the running turn and steered"
        : "🧭 Steered";
    await i.editReply(
      result.error
        ? `${lead} thread ${threadId}, but it did not complete cleanly: ${result.error.slice(0, 300)}`
        : `${lead} thread ${threadId}.`
    );
  }

  /** Post a steered node's captured response into its thread. Mirrors
   *  `postDispatchOutput` (chunk to cards, overflow to a file) with a steer
   *  label. Best-effort — a posting failure must not break the steer. */
  private async postSteerOutput(
    channel: ChannelRef,
    text: string,
    error?: string
  ): Promise<void> {
    try {
      if (error) {
        await this.sendResultCard(
          channel,
          "🧭 Steer failed",
          `❌ ${error.slice(0, 1500)}`,
          0xe74c3c
        );
      }
      const body = text.trim();
      if (!body) {
        if (!error) {
          await this.sendResultCard(channel, "🧭 Steered", "✅ Done — no output.", DISPATCH_COLOR);
        }
        return;
      }
      const chunks = this.chunkString(body, 3900);
      if (chunks.length <= 3) {
        for (let j = 0; j < chunks.length; j++) {
          const suffix = chunks.length > 1 ? ` (${j + 1}/${chunks.length})` : "";
          await this.sendResultCard(channel, `🧭 Steered${suffix}`, chunks[j]!, DISPATCH_COLOR);
        }
      } else {
        await this.sendResultCard(
          channel,
          "🧭 Steered",
          `✅ Done — full output attached (${body.length} chars).`,
          DISPATCH_COLOR
        );
        await this.sendResultFile(channel, "steer", body, "steer");
      }
    } catch (err) {
      this.logger.warn({ err, channel: channel.id }, "steer: posting output to thread failed");
    }
  }

  private async cmdReset(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({
        content: "Use inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Stop the live runtime (if any) so any in-flight turn is killed.
    await this.router.invalidate(record.id);
    // Clear the persisted ACP session id so the next message creates a
    // fresh session (which picks up any new MCP servers / config).
    this.store.upsert({
      ...record,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    });
    await i.reply({
      content:
        "Session reset. Your next message will start a fresh ACP session (history is gone, but config is kept).",
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * `/seam config agent` — show or change the agent bound to this thread.
   *
   * Changing agents mid-thread is destructive: the old agent's
   * conversation history can't be replayed against a different CLI, so
   * we invalidate the live runtime and clear the stored ACP session id
   * (same as `/seam config reset`). The new agent's `defaultModel` is applied
   * to the session config so the first turn uses something sensible.
   */
  private async cmdAgent(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const id = i.options.getString("id");
    const profiles = this.router.listProfiles();
    const currentAt = currentAgentAtLocation(record.agentId, this.config, channel.id);
    const currentLabel = currentHostPrefixedLabel(
      record.agentId,
      this.config,
      channel.id,
      this.config.bridgePresets
    );

    if (!id) {
      const choices = agentLocationPickerChoices(profiles, {
        bridges: this.config.bridgePresets.values(),
        connected: this.bridgeHub?.connectedIds(),
        agentsByHost: this.bridgeHub?.installedAgentsByHost(),
      });
      // Show interactive picker — every agentId@location, host-emoji prefixed (D10).
      if (!this.adapter.sendChoicePicker || choices.length === 0) {
        const listing = choices
          .map((c) => `\`${c.value}\` — ${c.label}`)
          .join(", ");
        await i.reply({
          content: `Current agent: \`${currentAt}\`\nAvailable: ${listing || "(none)"}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await i.reply({
        content: `Current agent: \`${currentAt}\`. Posting picker…`,
        flags: MessageFlags.Ephemeral,
      });
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🤖 Choose an agent @ host",
          fields: [{ name: "Current", value: currentLabel, inline: true }],
        },
        choices,
        authorizedUserIds: mayConfigureUserIds(this.config),
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Agent changed",
          fields: [
            { name: "Previous", value: `\`${currentAt}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) return;
      await this.applyAgentChange(channel, record, picked.value);
      return;
    }

    await this.applyAgentChange(channel, record, id, i);
  }

  private async applyAgentChange(
    channel: ChannelRef,
    record: SessionRecord,
    id: string,
    interaction?: ChatInputCommandInteraction
  ): Promise<void> {
    const parsed = parseAgentAtLocation(id);
    const profile = this.router.getProfile(parsed.agentId);
    if (!profile) {
      const msg = `Unknown agent \`${parsed.agentId}\`.`;
      if (interaction) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      else await this.adapter.sendMessage(channel, msg);
      return;
    }
    const currentLocation = resolveThreadLocation(this.config, channel.id);
    const nextLocation = parsed.explicit ? parsed.location : currentLocation;
    // Spawn uses thread/channel preset over the session record. Compare the
    // EFFECTIVE agent so a shadowed session write isn't treated as a no-op.
    const effectiveAgent = this.router.describeConfig(record).agent.value;
    const sameAgent = effectiveAgent === parsed.agentId;
    const sameLocation = currentLocation === nextLocation;
    if (sameAgent && sameLocation) {
      const msg = `Agent is already \`${formatAgentAtLocation(parsed.agentId, nextLocation)}\`.`;
      if (interaction) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      else await this.adapter.sendMessage(channel, msg);
      return;
    }
    if (!sameLocation) {
      const written = this.configMutation.applyThreadLocation({
        threadId: channel.id,
        ...(channel.parentId ? { parentRef: channel.parentId } : {}),
        location: nextLocation,
        actor: interaction
          ? { id: interaction.user.id, name: interaction.user.displayName ?? interaction.user.username }
          : { id: null, name: null },
      });
      if (!written.ok) {
        const msg = written.error;
        if (interaction) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        else await this.adapter.sendMessage(channel, msg);
        return;
      }
    }
    // Kill the live runtime (ends any in-flight turn) and wipe the ACP
    // session id so the next message spawns the new agent fresh. D2: a
    // location change is a new host — never migrate the old session.
    await this.router.invalidate(record.id);
    const cfg = this.store.readConfig(record);
    if (!sameAgent) {
      cfg.model = profile.defaultModel;
      cfg.lastContextUsage = undefined;
    }
    this.persistConfig(record, cfg);
    this.store.upsert({
      ...record,
      agentId: parsed.agentId,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    });
    // Thread overlay beats a locked channel preset (school channels pin grok).
    const overlay = this.configMutation.applyThreadOverlay({
      threadId: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      changes: {
        agent: parsed.agentId,
        model: cfg.model ?? profile.defaultModel,
      },
      actor: interaction
        ? { id: interaction.user.id, name: interaction.user.displayName ?? interaction.user.username }
        : { id: null, name: null },
    });
    if (!overlay.ok) {
      this.logger.warn({ err: overlay.error, threadId: channel.id }, "thread agent overlay write failed");
    }
    bindSessionLocation(this.bridgeHub, record.id, nextLocation);
    if (!sameAgent) {
      await this.updateThreadAbbreviation(channel, record.agentId, parsed.agentId);
    }
    const at = formatAgentAtLocation(parsed.agentId, nextLocation);
    const message = `🤖 Agent switched to \`${at}\` (${profile.displayName}), model \`${cfg.model ?? profile.defaultModel}\`. Next message will start a fresh session.`;
    if (interaction) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await this.adapter.sendMessage(channel, message);
    }
  }

  private async cmdConfig(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const cfg =
      this.store.readConfig(record) ?? defaultSessionConfig(this.config.DEFAULT_MODEL);
    await i.reply({
      content: this.renderer.codeBlock(JSON.stringify(cfg, null, 2), "json"),
      flags: MessageFlags.Ephemeral,
    });
  }

  /** `/seam config edit` — visual draft-then-save hub (#90). Does not abort a live turn. */
  private async cmdConfigEdit(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel || !i.channel?.isThread()) {
      await i.reply({
        content: "Use `/seam config edit` inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const desc = this.router.describeConfig(record);
    const withoutThread = this.inheritedConfigFor(record);
    const chan = channel.parentId
      ? this.config.channelPresets.get(channel.parentId)
      : undefined;
    const now = Date.now();
    const draft: ThreadConfigDraft = {
      id: randomUUID(),
      threadId: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      userId: i.user.id,
      createdAt: now,
      updatedAt: now,
      snapshot: {
        ...snapshotFromDescribe(desc, withoutThread),
        channelPins: {
          ...(chan?.agent?.value ? { agent: chan.agent.value } : {}),
          ...(chan?.model?.value ? { model: chan.model.value } : {}),
          ...(chan?.cwd?.value ? { cwd: chan.cwd.value } : {}),
          ...(chan?.effort?.value ? { effort: chan.effort.value } : {}),
          ...(chan?.threadSlug?.value ? { threadSlug: chan.threadSlug.value } : {}),
        },
        threadSlug: (() => {
          const th = this.config.threadPresets.get(channel.id)?.threadSlug?.value;
          if (th) return { value: th, source: "thread preset" as const };
          if (chan?.threadSlug?.value) {
            return { value: chan.threadSlug.value, source: "channel preset" as const };
          }
          return { value: null, source: "default" as const };
        })(),
      },
      overlay: {},
      warnings: [],
      editScope: "thread",
    };
    const evicted = this.configEditor.put(draft);
    if (evicted?.messageId) {
      await this.editConfigEditorCard(channel, evicted.messageId, renderExpiredHub(evicted));
    }
    if (!this.adapter.sendPanel) {
      await i.reply({
        content: "This platform cannot render the config editor card.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await i.reply({
      content: "Opening thread config editor…",
      flags: MessageFlags.Ephemeral,
    });
    const panel = renderHub(draft, {
      effortDisabled: this.effortDisabledFor(draft),
      canEditChannel: Orchestrator.canEditChannelPreset(
        this.config,
        i.user.id,
        channel.parentId
      ),
    });
    const ref = await this.adapter.sendPanel(channel, panel);
    this.configEditor.touch(draft.id, { messageId: ref.id });
  }

  private inheritedConfigFor(
    record: ReturnType<SessionRouter["ensureSessionRecord"]>
  ): InheritedConfig {
    const chan = record.parentRef
      ? this.config.channelPresets.get(record.parentRef)
      : undefined;
    const cfg = this.store.readConfig(record);
    const agent = chan?.agent?.value ?? record.agentId;
    const profile = this.router.getProfile(agent);
    const chanEffort = chan?.effort?.value;
    const effortUsable = !!(
      chanEffort &&
      profile?.effort &&
      profile.effort.mechanism !== "none" &&
      profile.effort.levels.includes(chanEffort)
    );
    const permission = (cfg.permissionPolicy ??
      this.config.DEFAULT_PERMISSION_POLICY ??
      "ask") as InheritedConfig["permission"];
    return {
      location: LOCAL_LOCATION,
      agent,
      model: chan?.model?.value ?? cfg.model ?? this.config.DEFAULT_MODEL,
      effort: effortUsable ? chanEffort! : cfg.reasoningEffort ?? null,
      cwd: chan?.cwd?.value ?? record.repoPath ?? this.config.REPOS_ROOT,
      permission,
      detached: false,
      statusCardStyle:
        chan?.statusCardStyle?.value === "simple" || chan?.statusCardStyle?.value === "full"
          ? chan.statusCardStyle.value
          : "full",
      simpleCardGif: typeof chan?.simpleCardGif?.value === "boolean" ? chan.simpleCardGif.value : false,
      threadSlug: chan?.threadSlug?.value ?? null,
    };
  }

  private effortDisabledFor(draft: ThreadConfigDraft): boolean {
    const channelScope = editScopeOf(draft) === "channel";
    const agentId = channelScope
      ? draft.overlay.channelAgent === undefined
        ? draft.snapshot.channelPins?.agent ?? draft.snapshot.withoutThread.agent
        : draft.overlay.channelAgent ?? draft.snapshot.withoutThread.agent
      : draft.overlay.agent === undefined
        ? draft.snapshot.agent.value
        : draft.overlay.agent ?? draft.snapshot.withoutThread.agent;
    const profile = this.router.getProfile(agentId);
    const eff = profile?.effort;
    return !eff || eff.mechanism === "none" || (eff.levels?.length ?? 0) === 0;
  }

  private capsForAgent = (agentId: string): DraftAgentCapabilities | undefined => {
    const profile = this.router.getProfile(agentId);
    if (!profile) return undefined;
    return {
      ...(profile.staticModels
        ? { staticModels: profile.staticModels.map((m) => ({ modelId: m.modelId })) }
        : {}),
      ...(profile.effort
        ? {
            effortMechanism: profile.effort.mechanism,
            effortLevels: [...profile.effort.levels],
          }
        : {}),
    };
  };

  private async editConfigEditorCard(
    channel: ChannelRef,
    messageId: string,
    panel: ReturnType<typeof renderHub>
  ): Promise<void> {
    if (!this.adapter.editPanel) return;
    try {
      await this.adapter.editPanel({ channel, id: messageId }, panel);
    } catch (err) {
      this.logger.warn({ err, messageId }, "config editor hub edit failed");
    }
  }

  private async refreshConfigEditorHub(draft: ThreadConfigDraft): Promise<void> {
    if (!draft.messageId) return;
    const panel = renderHub(draft, {
      effortDisabled: this.effortDisabledFor(draft),
      canEditChannel: Orchestrator.canEditChannelPreset(
        this.config,
        draft.userId,
        draft.parentRef
      ),
    });
    await this.editConfigEditorCard(
      { platform: "discord", id: draft.threadId, ...(draft.parentRef ? { parentId: draft.parentRef } : {}) },
      draft.messageId,
      panel
    );
  }

  private async downloadConfigEditorRider(
    draft: ThreadConfigDraft,
    evt: ComponentEvent
  ): Promise<void> {
    const scope = editScopeOf(draft);
    const text = currentRiderText(draft);
    const noun = scope === "channel" ? "channel rider" : "thread rider";
    if (text == null || text.length === 0) {
      await evt
        .followUpEphemeral(`No ${noun} to download. Use **Upload** to set one, then Save.`)
        .catch(() => {});
      return;
    }
    if (!this.adapter.sendFile) {
      await evt.followUpEphemeral("This platform cannot send files.").catch(() => {});
      return;
    }
    await this.adapter.sendFile(evt.channel, {
      data: Buffer.from(text, "utf8"),
      filename: riderDownloadFilename(
        scope === "channel" ? (draft.parentRef ?? draft.threadId) : draft.threadId,
        scope
      ),
      mimeType: "text/markdown",
      caption: `${scope === "channel" ? "Channel" : "Thread"} rider (draft if you already edited). **Save** on the card to persist.`,
    });
  }

  /**
   * If this user has a config-editor draft waiting for a rider file in this
   * thread, consume the message (do not start/abort a turn).
   */
  private async tryConsumeConfigEditorRiderUpload(msg: IncomingMessage): Promise<boolean> {
    const draft = this.configEditor.getForUserThread(msg.authorId, msg.channel.id);
    if (!draft?.awaitingRiderUpload) return false;
    const atts = msg.attachments ?? [];
    if (atts.length === 0) {
      await this.adapter
        .sendMessage(
          msg.channel,
          "📎 Need a `.md` or `.txt` attachment for the rider (or click **Cancel** on the config card)."
        )
        .catch(() => {});
      return true;
    }
    const att = atts[0]!;
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const decoded = decodeRiderUpload(buf, att.filename);
      if (!decoded.ok) {
        await this.adapter.sendMessage(msg.channel, `📎 ${decoded.error}`).catch(() => {});
        return true;
      }
      const next = applyPickerValue(
        { ...draft, awaitingRiderUpload: false },
        "rider",
        decoded.text ?? "",
        this.capsForAgent
      );
      next.awaitingRiderUpload = false;
      this.configEditor.put(next);
      await this.refreshConfigEditorHub(next);
      await this.adapter
        .sendMessage(
          msg.channel,
          decoded.text == null
            ? `📝 Rider upload is empty — draft will **inherit/clear** the ${editScopeOf(draft) === "channel" ? "channel" : "thread"} rider. Click **Save** to apply.`
            : `📝 Rider loaded from \`${att.filename}\` (${decoded.text.length} chars). Click **Save** on the card to apply.`
        )
        .catch(() => {});
    } catch (err) {
      this.logger.warn({ err }, "config editor rider upload failed");
      await this.adapter
        .sendMessage(msg.channel, "📎 Could not read that file. Try again.")
        .catch(() => {});
    }
    return true;
  }

  private async handleConfigEditorComponent(evt: ComponentEvent): Promise<void> {
    const parsed = parseCustomId(evt.customId);
    if (!parsed) return;
    let draft = this.configEditor.get(parsed.draftId);
    const auth = authorizeDraftClick(draft, evt.userId);
    if (auth === "not-yours") {
      await evt.replyEphemeral("This editor isn't yours.");
      return;
    }
    if (auth === "expired" || !draft) {
      try {
        await evt.deferUpdate();
      } catch {
        await evt.replyEphemeral("This draft has expired.").catch(() => {});
        return;
      }
      if (evt.messageId) {
        await this.editConfigEditorCard(evt.channel, evt.messageId, {
          color: 0x99aab5,
          title: "🧩 Thread config",
          fields: [],
          footer: "draft expired",
          actions: [],
        });
      }
      return;
    }

    const action = parsed.action;
    if (draft.awaitingRiderUpload && action !== "rider-put") {
      this.configEditor.touch(draft.id, { awaitingRiderUpload: false });
      draft = this.configEditor.get(draft.id) ?? draft;
    }
    if (action === "save") {
      if (!isDirty(draft)) {
        await evt.replyEphemeral("Nothing to save.");
        return;
      }
      await evt.deferUpdate();
      await this.saveConfigEditorDraft(draft, evt);
      return;
    }
    if (action === "scope") {
      if (
        !Orchestrator.canEditChannelPreset(this.config, evt.userId, draft.parentRef)
      ) {
        await evt.replyEphemeral(
          "Channel-preset edits need a config admin (locked channels refuse non-admins)."
        );
        return;
      }
      await evt.deferUpdate();
      const nextScope = editScopeOf(draft) === "channel" ? "thread" : "channel";
      this.configEditor.touch(draft.id, {
        editScope: nextScope,
        awaitingRiderUpload: false,
      });
      const next = this.configEditor.get(draft.id) ?? { ...draft, editScope: nextScope };
      await this.refreshConfigEditorHub(next);
      return;
    }
    if (action === "cancel") {
      await evt.deferUpdate();
      this.configEditor.delete(draft.id);
      if (draft.messageId) {
        await this.editConfigEditorCard(evt.channel, draft.messageId, renderCancelledHub(draft));
      }
      return;
    }
    if (action === "rider-get") {
      await evt.deferUpdate();
      await this.downloadConfigEditorRider(draft, evt);
      return;
    }
    if (action === "rider-put") {
      await evt.deferUpdate();
      this.configEditor.touch(draft.id, { awaitingRiderUpload: true });
      const waiting = this.configEditor.get(draft.id) ?? draft;
      await this.refreshConfigEditorHub(waiting);
      await evt
        .followUpEphemeral(
          `Attach a \`.md\` or \`.txt\` file in this thread. It becomes the **draft** ${editScopeOf(draft) === "channel" ? "channel" : "thread"} rider (Save still required). Empty file = inherit/clear. Cancel the editor to abort.`
        )
        .catch(() => {});
      return;
    }
    if (action === "rider-save" || (evt.kind === "modal" && action === "rider-save")) {
      await evt.deferUpdate();
      const text = evt.fields?.rider ?? "";
      const next = applyPickerValue(
        draft,
        "rider",
        text,
        this.capsForAgent
      );
      this.configEditor.put(next);
      await this.refreshConfigEditorHub(next);
      return;
    }

    if (action === "slug-save" || (evt.kind === "modal" && action === "slug-save")) {
      await evt.deferUpdate();
      const text = evt.fields?.slug ?? "";
      const next = applyPickerValue(draft, "slug", text, this.capsForAgent);
      this.configEditor.put(next);
      await this.refreshConfigEditorHub(next);
      return;
    }

    if (action === "slug") {
      const channelScope = editScopeOf(draft);
      const current =
        channelScope
          ? (draft.overlay.channelThreadSlug === undefined
              ? draft.snapshot.channelPins?.threadSlug ?? ""
              : draft.overlay.channelThreadSlug ?? "")
          : (draft.overlay.threadSlug === undefined
              ? draft.snapshot.threadSlug.value ?? ""
              : draft.overlay.threadSlug ?? "");
      await evt.showModal({
        customId: makeCustomId(draft.id, "slug-save"),
        title: channelScope ? "Channel thread slug" : "Thread slug",
        inputs: [
          {
            id: "slug",
            label: channelScope
              ? "Slug (empty = inherit/clear)"
              : "Slug (empty = inherit)",
            style: "short",
            value: String(current).slice(0, 32) || undefined,
            maxLength: 32,
            required: false,
          },
        ],
      });
      return;
    }

    if (action === "rider") {
      if (riderTooLong(draft)) {
        await evt.deferUpdate();
        await this.pickConfigEditorField(draft, "rider", evt);
        return;
      }
      const current = currentRiderText(draft) ?? "";
      const channelScope = editScopeOf(draft) === "channel";
      await evt.showModal({
        customId: makeCustomId(draft.id, "rider-save"),
        title: channelScope ? "Channel rider" : "Thread rider",
        inputs: [
          {
            id: "rider",
            label: channelScope
              ? "Channel rider (empty = inherit)"
              : "Thread rider (empty = inherit)",
            style: "paragraph",
            value: current.slice(0, RIDER_MODAL_MAX) || undefined,
            maxLength: RIDER_MODAL_MAX,
            required: false,
          },
        ],
      });
      return;
    }

    await evt.deferUpdate();
    await this.pickConfigEditorField(draft, action, evt);
  }

  private async saveConfigEditorDraft(
    draft: ThreadConfigDraft,
    evt: ComponentEvent
  ): Promise<void> {
    const plan = buildSavePlan(draft);
    const actor = { id: evt.userId, name: evt.userName };
    const hasPreset = Object.keys(plan.threadPreset).length > 0;
    if (hasPreset) {
      const written = this.configMutation.applyThreadOverlay({
        threadId: draft.threadId,
        ...(draft.parentRef ? { parentRef: draft.parentRef } : {}),
        changes: plan.threadPreset,
        actor,
      });
      if (!written.ok) {
        await evt.followUpEphemeral(`Could not save: ${written.error}`).catch(() => {});
        return;
      }
    }
    if (plan.channelPreset && Object.keys(plan.channelPreset).length > 0) {
      if (!draft.parentRef) {
        await evt
          .followUpEphemeral(
            "Could not save: this thread has no parent channel to pin a channel-wide setting on."
          )
          .catch(() => {});
        return;
      }
      if (
        !Orchestrator.canEditChannelPreset(this.config, evt.userId, draft.parentRef)
      ) {
        await evt
          .followUpEphemeral(
            "Could not save: channel-preset edits need a config admin (locked channels refuse non-admins)."
          )
          .catch(() => {});
        return;
      }
      const written = this.configMutation.applyChannelOverlay({
        channelId: draft.parentRef,
        changes: plan.channelPreset,
        actor,
      });
      if (!written.ok) {
        await evt.followUpEphemeral(`Could not save: ${written.error}`).catch(() => {});
        return;
      }
    }
    if (plan.permission !== undefined || plan.statusCardStyle !== undefined || plan.simpleCardGif !== undefined) {
      const record = this.router.ensureSessionRecord({
        platform: "discord",
        channelRef: draft.threadId,
        ...(draft.parentRef ? { parentRef: draft.parentRef } : {}),
        cwd: this.config.REPOS_ROOT,
      });
      const cfg = this.store.readConfig(record);
      if (plan.permission !== undefined) {
        if (plan.permission === null) {
          delete cfg.permissionPolicy;
        } else {
          cfg.permissionPolicy = plan.permission;
        }
        delete cfg.autoApprovePermissions;
      }
      if (plan.statusCardStyle !== undefined) {
        if (plan.statusCardStyle === null) {
          delete cfg.statusCardStyle;
        } else {
          cfg.statusCardStyle = plan.statusCardStyle;
        }
      }
      if (plan.simpleCardGif !== undefined) {
        if (plan.simpleCardGif === null) {
          delete cfg.simpleCardGif;
        } else {
          cfg.simpleCardGif = plan.simpleCardGif;
        }
      }
      this.persistConfig(record, cfg);
    }
    // D10: do NOT abort or invalidate a live turn. Overlay applies on next spawn.
    this.configEditor.delete(draft.id);
    if (draft.messageId) {
      await this.editConfigEditorCard(evt.channel, draft.messageId, renderSavedHub(draft));
    }
  }

  private async pickConfigEditorField(
    draft: ThreadConfigDraft,
    action: string,
    evt: ComponentEvent
  ): Promise<void> {
    const channel: ChannelRef = {
      platform: "discord",
      id: draft.threadId,
      ...(draft.parentRef ? { parentId: draft.parentRef } : {}),
    };
    const owner = new Set([draft.userId]);
    const channelScope = editScopeOf(draft) === "channel";
    const inherit = {
      value: INHERIT_VALUE,
      label: "Inherit",
      description: channelScope
        ? "Clear the channel-preset pin"
        : "Clear this thread's overlay",
    };

    if (!this.adapter.sendChoicePicker && action !== "rider") {
      return;
    }

    let picked: { value: string; userId: string } | null = null;
    const field = action as Parameters<typeof applyPickerValue>[1];

    if (action === "host") {
      const hosts = listHosts({
        bridges: this.config.bridgePresets.values(),
        connected: this.bridgeHub?.connectedIds(),
      });
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🖥 Choose a host",
          fields: [{ name: "Current", value: `\`${draft.snapshot.location.value}\``, inline: true }],
        },
        choices: [
          inherit,
          ...hosts.map((h) => ({
            value: h.id,
            label: `${h.emoji} ${h.shortName}`.slice(0, 80),
            description: h.ready ? "ready" : "offline",
          })),
        ],
        authorizedUserIds: owner,
      });
    } else if (action === "agent") {
      const loc =
        draft.overlay.location === undefined
          ? draft.snapshot.location.value
          : draft.overlay.location ?? draft.snapshot.withoutThread.location;
      const all = agentLocationPickerChoices(this.router.listProfiles(), {
        bridges: this.config.bridgePresets.values(),
        connected: this.bridgeHub?.connectedIds(),
        agentsByHost: this.bridgeHub?.installedAgentsByHost(),
      });
      const filtered = all.filter((c) => {
        const at = c.value.lastIndexOf("@");
        const host = at > 0 ? c.value.slice(at + 1) : LOCAL_LOCATION;
        return host === loc;
      });
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🤖 Choose an agent",
          fields: [{ name: "Host", value: `\`${loc}\``, inline: true }],
        },
        choices: [inherit, ...(filtered.length > 0 ? filtered : all)],
        authorizedUserIds: owner,
      });
    } else if (action === "model") {
      const agentId =
        draft.overlay.agent === undefined
          ? draft.snapshot.agent.value
          : draft.overlay.agent ?? draft.snapshot.withoutThread.agent;
      const profile = this.router.getProfile(agentId);
      const models = profile?.staticModels ?? [];
      const choices = models.map((m) => ({
        value: m.modelId,
        label: m.name ?? m.modelId,
        description: m.modelId,
      }));
      if (choices.length === 0) {
        await this.adapter.sendMessage(
          channel,
          `No advertised models for \`${agentId}\` — Inherit is still available.`
        );
      }
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose a model",
          fields: [{ name: "Agent", value: `\`${agentId}\``, inline: true }],
        },
        choices: [inherit, ...choices],
        authorizedUserIds: owner,
      });
    } else if (action === "effort") {
      if (this.effortDisabledFor(draft)) return;
      const agentId =
        draft.overlay.agent === undefined
          ? draft.snapshot.agent.value
          : draft.overlay.agent ?? draft.snapshot.withoutThread.agent;
      const supported = this.router.getProfile(agentId)?.effort?.levels ?? [];
      const effortChoices = EFFORT_CHOICES.filter((c) => supported.includes(c.value));
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose reasoning effort",
          fields: [],
        },
        choices: [inherit, ...effortChoices],
        authorizedUserIds: owner,
      });
    } else if (action === "repo") {
      const loc =
        draft.overlay.location === undefined
          ? draft.snapshot.location.value
          : draft.overlay.location ?? draft.snapshot.withoutThread.location;
      picked = await this.promptRepoPath(channel, {
        title: "🗂️ Choose a working repo",
        location: loc,
        authorizedUserIds: owner,
        includeInherit: true,
      }).then((value) => (value ? { value, userId: draft.userId } : null));
    } else if (action === "approve") {
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🔐 Permission policy",
          fields: [
            { name: "Current", value: `\`${draft.snapshot.permission.value}\``, inline: true },
          ],
        },
        choices: [
          inherit,
          { value: "always", label: "always", description: "Auto-approve every request" },
          { value: "ask", label: "ask", description: "Prompt in Discord" },
          { value: "deny", label: "deny", description: "Auto-deny every request" },
        ],
        authorizedUserIds: owner,
      });
    } else if (action === "card") {
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "🃏 Channel status card" : "🃏 Status card",
          fields: [
            {
              name: "Current",
              value: `\`${draft.snapshot.statusCardStyle.value}\``,
              inline: true,
            },
          ],
        },
        choices: channelScope
          ? [
              inherit,
              {
                value: "full",
                label: "full (channel)",
                description: "Every thread inherits unless it overrides",
              },
              {
                value: "simple",
                label: "simple (channel)",
                description: "Every thread inherits unless it overrides",
              },
            ]
          : [
              inherit,
              {
                value: "full",
                label: "full (this thread)",
                description: "Repo, model, action, effort — overrides channel",
              },
              {
                value: "simple",
                label: "simple (this thread)",
                description: "State + brand icon + thought — overrides channel",
              },
            ],
        authorizedUserIds: owner,
      });
    } else if (action === "gif") {
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "🎞 Channel simple-card GIF" : "🎞 Simple-card GIF",
          fields: [
            {
              name: "Current",
              value: `\`${draft.snapshot.simpleCardGif.value ? "on" : "off"}\``,
              inline: true,
            },
          ],
        },
        choices: channelScope
          ? [
              inherit,
              {
                value: "on",
                label: "on (channel)",
                description: "Every thread inherits unless it overrides",
              },
              {
                value: "off",
                label: "off (channel)",
                description: "Every thread inherits unless it overrides",
              },
            ]
          : [
              inherit,
              {
                value: "on",
                label: "on (this thread)",
                description: "Random GIF thumbnail on the simple card",
              },
              {
                value: "off",
                label: "off (this thread)",
                description: "No GIF — overrides channel",
              },
            ],
        authorizedUserIds: owner,
      });
    } else if (action === "attach") {
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "📌 Thread attachment",
          fields: [
            {
              name: "Current",
              value: draft.snapshot.detached.value ? "`detached`" : "`attached`",
              inline: true,
            },
          ],
        },
        choices: [
          inherit,
          { value: "attached", label: "Attached", description: "Bot replies in this thread" },
          { value: "detached", label: "Detached", description: "No bot replies" },
        ],
        authorizedUserIds: owner,
      });
    } else if (action === "rider") {
      picked = await this.adapter.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "📝 Channel rider" : "📝 Thread rider",
          description:
            "This rider is too long for a Discord modal. Use **Download** / **Upload** on the hub, or Inherit/Clear here.",
          fields: [],
        },
        choices: [
          {
            value: INHERIT_VALUE,
            label: "Inherit / Clear",
            description: channelScope
              ? "Remove the channel-preset rider"
              : "Remove the thread rider",
          },
        ],
        authorizedUserIds: owner,
      });
    } else {
      return;
    }

    if (!picked) {
      await this.refreshConfigEditorHub(draft);
      return;
    }
    const next = applyPickerValue(draft, field, picked.value, this.capsForAgent);
    this.configEditor.put(next);
    await this.refreshConfigEditorHub(next);
  }

  /** `/seam workflows` — read-only view of the delegation ledger. Renders the
   *  still-in-flight rows and a correlation-grouped recent tail as an embed; no
   *  writes, no schema, purely observability. */
  private async cmdWorkflows(i: ChatInputCommandInteraction): Promise<void> {
    const limit = i.options.getInteger("limit") ?? 20;
    const now = new Date();

    // Wake cancel (#59, D6): fold into /seam workflows per #26 rather than a new
    // top-level subcommand (the /seam tree is at Discord's 25-option cap).
    const cancelWakeId = i.options.getString("cancel-wake");
    if (cancelWakeId) {
      const record = this.recordFromInteraction(i);
      const ok = record ? this.cancelWake(record, cancelWakeId) : false;
      await i.reply({
        content: ok
          ? `⏰ Cancelled wake \`${cancelWakeId}\`.`
          : `No pending wake \`${cancelWakeId}\` in this thread (already fired, cancelled, or not this thread's).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Watch cancel (#60, D7): same surface as wake cancel — the /seam tree is at
    // Discord's option cap, so watch lifecycle folds into /seam workflows too.
    const cancelLiveId = i.options.getString("cancel-live");
    if (cancelLiveId) {
      const record = this.recordFromInteraction(i);
      if (!record) {
        await i.reply({
          content: "Use `/seam workflows` inside a thread to hang up a live-help call.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const result = this.cancelLiveHelp(record, cancelLiveId, { skipAuthorGate: true });
      await i.reply({
        content: result.ok
          ? `🎙️ Hanging up live help \`${cancelLiveId}\`.`
          : result.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cancelIngestId = i.options.getString("cancel-ingest");
    if (cancelIngestId) {
      const record = this.recordFromInteraction(i);
      if (!record) {
        await i.reply({
          content: "Use `/seam workflows` inside a thread to revoke an ingest endpoint.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const result = await this.cancelIngest(record, cancelIngestId, { skipAuthorGate: true });
      await i.reply({
        content: result.ok
          ? `🌐 Revoked ingest endpoint \`${cancelIngestId}\`.`
          : result.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cancelChoiceId = i.options.getString("cancel-choice");
    if (cancelChoiceId) {
      const record = this.recordFromInteraction(i);
      if (!record) {
        await i.reply({
          content: "Use `/seam workflows` inside a thread to cancel a choice card.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const result = await this.cancelChoice(record, cancelChoiceId, { skipAuthorGate: true });
      await i.reply({
        content: result.ok
          ? `🗳️ Cancelled choice card \`${cancelChoiceId}\`.`
          : result.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cancelWatchId = i.options.getString("cancel-watch");
    if (cancelWatchId) {
      const record = this.recordFromInteraction(i);
      const ok = record ? this.cancelWatch(record, cancelWatchId) : false;
      await i.reply({
        content: ok
          ? `🔕 Cancelled watch \`${cancelWatchId}\`.`
          : `No pending watch \`${cancelWatchId}\` in this thread (already fired, cancelled, or not this thread's).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const active = this.store.listActiveDelegations();
    const view = formatWorkflowsView(
      active,
      this.store.listRecentDelegations(limit),
      now
    );

    const embed = new EmbedBuilder()
      .setTitle("🔀 Workflows")
      .setColor(WORKFLOWS_COLOR);

    if (view.empty) {
      embed.setDescription(
        "No workflows yet — nothing has been dispatched to the delegation ledger."
      );
    } else {
      if (view.active.count > 0) {
        embed.addFields({
          name: `▶️ Active (${view.active.count})`,
          value: clampFieldValue(view.active.lines),
        });
      }
      if (view.recent.count > 0) {
        embed.addFields({
          name: `🕑 Recent (${view.recent.count})`,
          value: clampFieldValue(view.recent.lines),
        });
      }

      // Additive anomaly scan (issue #26). Detection over a wider history than
      // the displayed `recent` tail so frequency spikes are actually visible;
      // union with active so a long-quiet dispatched row isn't missed if it
      // falls past the recent cutoff. Read-only — no parking, no writes.
      const scanRows = [
        ...new Map(
          [
            ...active,
            ...this.store.listRecentDelegations(Math.max(limit, 200)),
          ].map((e) => [e.id, e])
        ).values(),
      ];
      const anomalyLines = formatAnomalyLines(
        summarizeAnomalies(scanRows, now),
        now
      );
      if (anomalyLines.length > 0) {
        embed.addFields({
          name: `⚠️ Anomalies (${anomalyLines.length})`,
          value: clampFieldValue(anomalyLines),
        });
      }

      embed.setFooter({ text: `showing up to ${limit} recent rows` });
    }

    // Pending wakes for THIS thread (#59, D6): the agent's own deferred
    // follow-ups, so a user can see and cancel a timer that would otherwise burn
    // tokens invisibly. Cancel with `/seam workflows cancel-wake:<id>`.
    const record = this.recordFromInteraction(i);
    if (record) {
      const wakes = this.listWakes(record.platform, record.channelRef);
      if (wakes.length > 0) {
        const lines = wakes
          .slice(0, 10)
          .map((w) => {
            const reason = w.reason ? ` — ${w.reason}` : "";
            const depth = w.chainDepth > 0 ? ` (chain-depth ${w.chainDepth})` : "";
            return `⏰ \`${w.id}\` → ${w.fireAtUtc}${reason}${depth}`;
          });
        if (wakes.length > 10) lines.push(`…and ${wakes.length - 10} more`);
        embed.addFields({
          name: `⏰ Pending wakes (${wakes.length})`,
          value: clampFieldValue(lines),
        });
        if (view.empty) embed.setDescription(null);
      }

      // Pending watches for THIS thread (#60, D7): agent-defined condition
      // triggers, listed + cancellable via `/seam workflows cancel-watch:<id>`.
      const watches = this.listWatches(record.platform, record.channelRef);
      if (watches.length > 0) {
        const lines = watches
          .slice(0, 10)
          .map((w) => {
            const reason = w.reason ? ` — ${w.reason}` : "";
            const fires = w.mode === "each" ? ` (${w.fireCount}/${w.maxFires} fires)` : "";
            return `🔔 \`${w.id}\` → ${w.kind}:${w.spec} every ${w.intervalSeconds}s, expires ${w.expiresAtUtc}${fires}${reason}`;
          });
        if (watches.length > 10) lines.push(`…and ${watches.length - 10} more`);
        embed.addFields({
          name: `🔔 Pending watches (${watches.length})`,
          value: clampFieldValue(lines),
        });
        if (view.empty) embed.setDescription(null);
      }

      const liveCalls = this.liveHelpManager?.listForThread(record.platform, record.channelRef) ?? [];
      const liveActive = liveCalls.filter((s) => s.status === "starting" || s.status === "live");
      if (liveActive.length > 0) {
        const lines = liveActive.slice(0, 10).map((s) => {
          const ch = s.channelName ? `**${s.channelName}**` : s.voiceChannelId;
          return `🎙️ \`${s.id}\` ${ch} · ${s.status}`;
        });
        if (liveActive.length > 10) lines.push(`…and ${liveActive.length - 10} more`);
        embed.addFields({
          name: `🎙️ Live help (${liveActive.length})`,
          value: clampFieldValue(lines),
        });
        if (view.empty) embed.setDescription(null);
      }

      const endpoints = this.store.listOpenIngestEndpoints(record.platform, record.channelRef);
      if (endpoints.length > 0) {
        const lines = endpoints.slice(0, 10).map((e) => {
          const uniq = e.uniqueStudent ? " · unique-student" : "";
          const notify = e.notifyThread ? ` · notify ${e.notifyThread}` : "";
          const preset = e.preset ? ` · preset ${e.preset}` : "";
          const model = e.model ? ` · ${e.model}` : "";
          return `🌐 \`${e.id}\` ${e.name}${preset}${model}${uniq}${notify}`;
        });
        if (endpoints.length > 10) lines.push(`…and ${endpoints.length - 10} more`);
        embed.addFields({
          name: `🌐 Ingest endpoints (${endpoints.length})`,
          value: clampFieldValue(lines),
        });
        if (view.empty) embed.setDescription(null);
      }

      const choices = this.store.listOpenChoiceCards(record.platform, record.channelRef);
      if (choices.length > 0) {
        const lines = choices.slice(0, 10).map((c) => {
          const last = c.lastClickerName ? ` · last ${c.lastClickerName}` : "";
          return `🗳️ \`${c.id}\` ${c.title} (${c.clickCount}/${c.maxClicks})${last}`;
        });
        if (choices.length > 10) lines.push(`…and ${choices.length - 10} more`);
        embed.addFields({
          name: `🗳️ Open choice cards (${choices.length})`,
          value: clampFieldValue(lines),
        });
        if (view.empty) embed.setDescription(null);
      }
    }

    const interrupted = await this.collectInterruptedRows();
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (interrupted.length > 0) {
      embed.addFields({
        name: `⚠️ Interrupted / abandoned (${interrupted.length})`,
        value: clampFieldValue(formatInterruptedLines(interrupted, now)),
      });
      if (view.empty) embed.setDescription(null);
      // Per-entry Resume / Abandon — same pattern as schedule-list cards.
      // Zero extra command slots. First 5 rows (Discord's 5-row cap).
      for (const row of interrupted.slice(0, 5)) {
        components.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`wf:resume:${row.id}`)
              .setLabel(`▶️ Resume ${row.source}`.slice(0, 80))
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`wf:abandon:${row.id}`)
              .setLabel("🚫 Abandon")
              .setStyle(ButtonStyle.Danger)
          )
        );
      }
    }

    await i.reply({
      embeds: [embed],
      ...(components.length ? { components } : {}),
      flags: MessageFlags.Ephemeral,
    });
    if (components.length === 0) return;
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });
    collector.on("collect", async (c) => {
      try {
        if (!c.isButton()) return;
        const [, action, ...rest] = c.customId.split(":");
        const id = rest.join(":");
        if (!id || (action !== "resume" && action !== "abandon")) return;
        const result =
          action === "resume"
            ? await this.resumeTurnManually(id)
            : await this.abandonTurnManually(id);
        await c.reply({ content: result, flags: MessageFlags.Ephemeral });
      } catch (err) {
        this.logger.warn({ err }, "workflows resume/abandon button failed");
      }
    });
  }

  /** `/seam config audit` — read the immutable config-mutation trail (#70).
   *  Every applied config change already writes a `config_audit` row; this is
   *  the missing read surface. Purely observability: no writes, no schema, and
   *  intentionally slash-command-only (the trail spans every channel, so it is
   *  never exposed as a cross-thread MCP read). With `entry:<id>` it renders the
   *  before→after diff for a single row; long rider payloads are truncated
   *  (`config-audit-view.ts`) so they can't break the render. Ephemeral. */
  private async cmdConfigAudit(i: ChatInputCommandInteraction): Promise<void> {
    const limit = i.options.getInteger("limit") ?? 20;
    const now = new Date();
    // Pull one page; a requested detail id must resolve within it, matching the
    // "recent tail" framing of the view (older rows aren't a lookup surface).
    const entries = this.store.listConfigMutations(limit);

    const entryId = i.options.getString("entry");
    if (entryId) {
      const match = findAuditEntry(entries, entryId);
      if (!match) {
        await i.reply({
          content:
            `No config-audit entry \`${entryId}\` in the last ${limit} mutations. ` +
            `Raise \`limit\` or copy an id from \`/seam config audit\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const detail = formatConfigAuditDetail(match, now);
      const embed = new EmbedBuilder()
        .setTitle("📜 Config mutation")
        .setColor(CONFIG_AUDIT_COLOR)
        .setDescription(detail.entry.summary);
      for (const m of detail.meta) {
        // Same 1024 field-value clamp the confirm card uses (adapter.ts).
        embed.addFields({ name: m.label, value: m.value.slice(0, 1024) });
      }
      embed.addFields(
        { name: "before", value: this.renderer.codeBlock(detail.before, "json").slice(0, 1024) },
        { name: "after", value: this.renderer.codeBlock(detail.after, "json").slice(0, 1024) }
      );
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const view = formatConfigAuditView(entries, now);
    const embed = new EmbedBuilder()
      .setTitle("📜 Config audit")
      .setColor(CONFIG_AUDIT_COLOR);
    if (view.empty) {
      embed.setDescription(
        "No config mutations recorded yet — nothing has been applied via `config_propose`."
      );
    } else {
      // `clampFieldValue` keeps the list under Discord's 1024 field cap with an
      // `…and N more` tail (shared with `/seam workflows`).
      embed.addFields({
        name: `🕑 Recent (${view.lines.length})`,
        value: clampFieldValue(view.lines),
      });
      embed.setFooter({
        text: `newest first · up to ${limit} rows · inspect one with entry:<id>`,
      });
    }
    await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  private async cmdSessions(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }

    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      await i.reply({ content: `Agent profile "${record.agentId}" not found.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const manager = profile.sessionManager;
    if (!manager) {
      await i.reply({
        content: `Agent profile \`${record.agentId}\` (${profile.displayName}) does not support session management.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const cwd = record.repoPath ?? this.config.REPOS_ROOT;
    let sessions: SessionSummary[];
    try {
      sessions = await manager.listSessions(cwd);
    } catch (err: any) {
      await i.editReply({
        content: `Failed to list sessions: ${err.message}`,
      });
      return;
    }

    if (sessions.length === 0) {
      // Empty state logic handled inside makeSessionMessageOptions instead of returning early
    }

    // Open on this thread's active session (if it has one and it's in the list),
    // so the first thing shown — and the default compaction target — is the
    // session the user almost always means. Falls back to most-recent.
    let currentIndex = 0;
    if (record.acpSessionId) {
      const activeIdx = sessions.findIndex((s) => s.sessionId === record.acpSessionId);
      if (activeIdx !== -1) currentIndex = activeIdx;
    }

    const formatLine = (line: SessionSummaryLine) => {
      const prefix = line.sender === "human" ? "👤" : "🤖";
      const cleaned = cleanTextForPreview(line.text);
      if (!cleaned) return null;
      const truncatedText = cleaned.length > 80 ? cleaned.substring(0, 77) + "..." : cleaned;
      return `${prefix} ${truncatedText}`;
    };

    const makeSessionMessageOptions = (idx: number, list: SessionSummary[], activeId: string, mgr: ISessionManager) => {
      const isOrphaned = !list.some((s) => s.sessionId === activeId);

      if (list.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle(`Browse & Manage Sessions — ${profile.displayName}`)
          .setDescription(
            `⚠️ **Warning:** The current Discord thread is completely disconnected from any known backend session.\n\n` +
            `*There are no sessions in the database for this workspace.*`
          )
          .setColor(0xe74c3c);

        const rebuildBtn = new ButtonBuilder()
          .setCustomId("sessions:rebuild")
          .setLabel("🏗️ Rebuild from Thread")
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(rebuildBtn);

        return {
          content: "",
          embeds: [embed],
          components: [row],
        };
      }

      const session = list[idx];
      if (!session) return { content: "No sessions found.", embeds: [], components: [] };

      const formatted = session.previewLines.map(formatLine).filter(Boolean) as string[];
      const previewText = formatted.length > 0
        ? formatted.join("\n")
        : "*No meaningful messages in this session.*";

      const embed = new EmbedBuilder()
        .setTitle(`Browse & Manage Sessions — ${profile.displayName}`)
        .setDescription(
          (isOrphaned ? `⚠️ **Warning:** The current Discord thread is completely disconnected from any known backend session.\n\n` : "") +
          `**Session ID:** \`${session.sessionId}\`\n` +
          `**Created:** ${session.createdAt ? `<t:${Math.floor(session.createdAt / 1000)}:f>` : "Unknown"}\n` +
          `**Last Activity:** ${session.lastActivityAt ? `<t:${Math.floor(session.lastActivityAt / 1000)}:R>` : "Unknown"}\n` +
          `**Status:** ${activeId === session.sessionId ? "🟢 **Active Session in this channel**" : "⚪ Inactive"}\n\n` +
          `**Preview (Heuristic):**\n` +
          previewText
        )
        .setColor(activeId === session.sessionId ? 0x2ecc71 : (isOrphaned ? 0xe74c3c : 0x3498db));

      let footerText = `Session ${idx + 1} of ${list.length}`;
      if (session.estimatedTokens !== undefined) {
        footerText += session.tokensFromUsage
          ? ` • Context: ${session.estimatedTokens.toLocaleString()} tokens`
          : ` • Context: ~${session.estimatedTokens.toLocaleString()} tokens (estimate, refines after next turn)`;
      }
      embed.setFooter({ text: footerText });

      const prevBtn = new ButtonBuilder()
        .setCustomId("sessions:prev")
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(idx === 0);

      const nextBtn = new ButtonBuilder()
        .setCustomId("sessions:next")
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(idx === list.length - 1);

      const closeBtn = new ButtonBuilder()
        .setCustomId("sessions:close")
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger);

      const attachBtn = new ButtonBuilder()
        .setCustomId("sessions:attach")
        .setLabel("Attach")
        .setStyle(ButtonStyle.Success)
        .setDisabled(activeId === session.sessionId);

      const cloneBtn = new ButtonBuilder()
        .setCustomId("sessions:clone")
        .setLabel("Clone")
        .setStyle(ButtonStyle.Primary);

      const cloneAttachBtn = new ButtonBuilder()
        .setCustomId("sessions:clone_attach")
        .setLabel("Clone & Attach")
        .setStyle(ButtonStyle.Success);

      const deleteBtn = new ButtonBuilder()
        .setCustomId("sessions:delete")
        .setLabel("Delete")
        .setStyle(ButtonStyle.Danger);

      const summaryBtn = new ButtonBuilder()
        .setCustomId("sessions:summary")
        .setLabel("🪄 AI Summary")
        .setStyle(ButtonStyle.Primary);

      // "Can compact" now means: there's a configured summarizer model for this
      // agent. (The write-back is a seedNewSession turn, which any agent with a
      // runtime supports — no special manager method required.)
      const canCompact = this.compactionModelFor(record.agentId) !== "";
      // Any agent with a session manager can receive a migrated session (the
      // summary is seeded into a fresh session under that agent).
      const targetProfiles = this.router.listProfiles().filter(p =>
        p.id !== record.agentId && !!p.sessionManager
      );

      const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn, closeBtn);
      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(attachBtn, cloneBtn, cloneAttachBtn, deleteBtn);

      const row3Buttons = [summaryBtn];

      if (canCompact) {
        row3Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:compact")
            .setLabel("🗳️ Compact")
            .setStyle(ButtonStyle.Success)
        );
      }

      if (typeof mgr.repairSession === "function") {
        row3Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:repair")
            .setLabel("Repair")
            .setStyle(ButtonStyle.Danger)
        );
      }

      if (targetProfiles.length > 0) {
        row3Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:migrate")
            .setLabel("Migrate Agent")
            .setStyle(ButtonStyle.Primary)
        );
      }

      const rebuildBtn = new ButtonBuilder()
        .setCustomId("sessions:rebuild")
        .setLabel("🏗️ Rebuild from Thread")
        .setStyle(ButtonStyle.Primary);

      row3Buttons.push(rebuildBtn);

      const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(row3Buttons);

      const row4Buttons: ButtonBuilder[] = [];
      if (canCompact) {
        row4Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:import_to_cwd")
            .setLabel("📤 Import to Cwd")
            .setStyle(ButtonStyle.Primary)
        );
      }
      // Premium (session JSONL based) — needs a raw-history reader (Claude/agy).
      if (canCompact && typeof mgr.getHistoryPath === "function") {
        row4Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:premium")
            .setLabel("✨ Premium Compact (Session)")
            .setStyle(ButtonStyle.Success)
        );
      }
      // Premium (Discord thread based) — works for any compactable agent.
      if (canCompact) {
        row4Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:premium_discord")
            .setLabel("✨ Premium Compact (Discord)")
            .setStyle(ButtonStyle.Success)
        );
      }
      const components: ActionRowBuilder<ButtonBuilder>[] = [row1, row2, row3];
      if (row4Buttons.length > 0) {
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(row4Buttons));
      }

      return {
        content: "",
        embeds: [embed],
        components,
      };
    };

    // Render first session in the list
    const msg = await i.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));

    const collector = msg.createMessageComponentCollector({
      filter: (btnInteraction) => btnInteraction.user.id === i.user.id,
      time: 600_000, // 10 minutes
    });

    collector.on("collect", async (btnInteraction) => {
      const customId = btnInteraction.customId;

      if (customId === "sessions:prev") {
        await btnInteraction.deferUpdate();
        if (currentIndex > 0) {
          currentIndex--;
          await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
        }
      } else if (customId === "sessions:next") {
        await btnInteraction.deferUpdate();
        if (currentIndex < sessions.length - 1) {
          currentIndex++;
          await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
        }
      } else if (customId === "sessions:close") {
        await btnInteraction.deferUpdate();
        await btnInteraction.deleteReply().catch(() => {});
        await i.deleteReply().catch(() => {});
        collector.stop("user_closed");
      } else if (customId === "sessions:attach") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          await this.router.invalidate(record.id);
          this.store.upsert({
            ...record,
            acpSessionId: session.sessionId,
            updatedUtc: new Date().toISOString(),
          });
          const fresh = this.store.get(record.id);
          if (fresh) {
            record.acpSessionId = fresh.acpSessionId;
          }
          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("Session Attached")
                .setDescription(`🟢 Session \`${session.sessionId}\` has been attached to this channel. Next message will run in this session.`)
                .setColor(0x2ecc71)
            ],
            components: [],
          });
          collector.stop();
        }
      } else if (customId === "sessions:clone") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const newSessionId = randomUUID();
          try {
            await manager.cloneSession(cwd, session.sessionId, newSessionId);
            sessions = await manager.listSessions(cwd);
            const newIndex = sessions.findIndex(s => s.sessionId === newSessionId);
            if (newIndex !== -1) {
              currentIndex = newIndex;
            }
            const opts = makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager);
            const embed = opts.embeds?.[0];
            if (embed) {
              embed.setDescription(
                `✨ **Cloned successfully as** \`${newSessionId}\`!\n\n` +
                (embed.data.description ?? "")
              );
            }
            await btnInteraction.editReply(opts);
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to clone session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:clone_attach") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const newSessionId = randomUUID();
          try {
            await manager.cloneSession(cwd, session.sessionId, newSessionId);
            sessions = await manager.listSessions(cwd);

            await this.router.invalidate(record.id);
            this.store.upsert({
              ...record,
              acpSessionId: newSessionId,
              updatedUtc: new Date().toISOString(),
            });
            const fresh = this.store.get(record.id);
            if (fresh) {
              record.acpSessionId = fresh.acpSessionId;
            }

            await btnInteraction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("Session Cloned & Attached")
                  .setDescription(
                    `✨ **Cloned successfully as** \`${newSessionId}\`!\n\n` +
                    `🟢 **This new session has been attached to this channel.** Next message will run in this session.`
                  )
                  .setColor(0x2ecc71)
              ],
              components: [],
            });
            collector.stop();
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to clone and attach session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:delete") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const confirmEmbed = new EmbedBuilder()
            .setTitle("⚠️ Delete Session?")
            .setDescription(`Are you sure you want to permanently delete session \`${session.sessionId}\`? This action cannot be undone.`)
            .setColor(0xe74c3c);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("sessions:delete_confirm")
              .setLabel("Yes, Delete")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("sessions:delete_cancel")
              .setLabel("No, Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          await btnInteraction.editReply({
            embeds: [confirmEmbed],
            components: [row],
          });
        }
      } else if (customId === "sessions:delete_cancel") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      } else if (customId === "sessions:delete_confirm") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          try {
            await manager.deleteSession(cwd, session.sessionId);
            if (record.acpSessionId === session.sessionId) {
              await this.router.invalidate(record.id, { clearAcpSession: true });
              const fresh = this.store.get(record.id);
              if (fresh) {
                record.acpSessionId = fresh.acpSessionId;
              } else {
                record.acpSessionId = "";
              }
            }
            sessions = await manager.listSessions(cwd);
            if (sessions.length === 0) {
              await btnInteraction.editReply({
                embeds: [
                  new EmbedBuilder()
                    .setTitle("No Sessions")
                    .setDescription("All sessions have been deleted.")
                    .setColor(0x7f8c8d)
                ],
                components: [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setCustomId("sessions:close")
                      .setLabel("Close")
                      .setStyle(ButtonStyle.Secondary)
                  )
                ],
              });
            } else {
              currentIndex = 0;
              await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
            }
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to delete session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:repair") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const confirmEmbed = new EmbedBuilder()
            .setTitle("⚠️ Repair Session?")
            .setDescription(`This will attempt to repair session \`${session.sessionId}\` by rolling back to the last clean user state. Proceed?`)
            .setColor(0xe74c3c);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("sessions:repair_confirm")
              .setLabel("Yes, Repair")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("sessions:repair_cancel")
              .setLabel("No, Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          await btnInteraction.editReply({
            embeds: [confirmEmbed],
            components: [row],
          });
        }
      } else if (customId === "sessions:repair_cancel") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      } else if (customId === "sessions:repair_confirm") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session && typeof manager.repairSession === "function") {
          try {
            await manager.repairSession(cwd, session.sessionId);
            if (record.acpSessionId === session.sessionId) {
              await this.router.invalidate(record.id);
            }
            sessions = await manager.listSessions(cwd);
            const opts = makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager);
            const embed = opts.embeds?.[0];
            if (embed) {
              embed.setDescription(
                `✨ **Session repaired successfully!**\n\n` +
                (embed.data.description ?? "")
              );
            }
            await btnInteraction.editReply(opts);
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to repair session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:rebuild") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("🏗️ Rebuilding Session...")
              .setDescription(`Fetching historical messages from this Discord thread to reconstruct a premium summary...`)
              .setColor(0xe67e22)
          ],
          components: [],
        });

        void (async () => {
          let tempRuntime: AgentRuntime | undefined;
          try {
            const channelRef = { platform: "discord", id: i.channelId };
            if (typeof this.adapter.fetchThreadMessages !== "function") {
              throw new Error("Chat adapter does not support fetching thread messages.");
            }

            const rawMessages = await this.adapter.fetchThreadMessages(channelRef);
            if (rawMessages.length === 0) {
              throw new Error("No messages found in this Discord thread to reconstruct.");
            }

            const transcript = rawMessages.map(m => {
              // Attribute human turns by name where present (#57 M3).
              const role = m.authorIsBot ? "Agent" : "Human";
              const label = !m.authorIsBot && m.authorName ? `${role} (${m.authorName})` : role;
              return `${label}: ${m.text}`;
            }).join("\n");

            let sanitizedTranscript = transcript
              .split("\n")
              .map((line) => {
                if (line.length > 2000) {
                  return line.substring(0, 2000) + " ... [Line truncated]";
                }
                return line;
              })
              .join("\n");

            const compactionModel = this.compactionModelFor(record.agentId);
            if (!compactionModel) {
              throw new Error(`Rebuild is not supported for agent profile \`${record.agentId}\``);
            }
            const promptTemplate = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
            // Add a rebuild-specific addendum: the compact.md template was designed
            // for mid-session compaction. For full thread reconstruction we need the
            // model to cover the entire conversation — especially the end.
            const rebuildAddendum =
              "\n\nIMPORTANT: This is a full thread reconstruction from Discord history. " +
              "The transcript below contains the ENTIRE conversation. You MUST cover " +
              "the full conversation from start to finish in your summary. Give " +
              "special emphasis to the most RECENT work (the last ~30% of the " +
              "transcript) — that is the current state the user needs to resume from. " +
              "Do NOT spend excessive detail on early/introductory messages at the " +
              "expense of recent ones. If the analysis section is getting very long, " +
              "abbreviate the early parts and expand on the latest work.\n";
            const fullTemplate = promptTemplate + rebuildAddendum;
            const templateOverhead = fullTemplate.length + "\n\nConversation Transcript:\n".length;
            sanitizedTranscript = fitTranscriptToWindow(
              sanitizedTranscript,
              templateOverhead,
              compactionWindowFor(compactionModel)
            );
            this.logger.info(
              { channelId: i.channelId, msgCount: rawMessages.length,
                transcriptChars: sanitizedTranscript.length, model: compactionModel },
              "rebuild: transcript assembled",
            );

            // Write transcript to a temp file rather than inlining it in the
            // prompt. The AGY CLI (Gemini) truncates stdin prompts larger than
            // ~150KB, but the model can read arbitrarily large files via its
            // file-reading tools without any truncation.
            const transcriptFile = path.join(
              cwd, `.rebuild-transcript-${i.channelId}-${Date.now()}.txt`,
            );
            await fsp.writeFile(transcriptFile, sanitizedTranscript, "utf8");

            const compactionPrompt =
              `${fullTemplate}\n\n` +
              `The conversation transcript has been saved to the file: ${transcriptFile}\n` +
              `Read that file NOW and then produce your summary. ` +
              `The file contains ${rawMessages.length} messages (${sanitizedTranscript.length} chars). ` +
              `You MUST read the ENTIRE file before summarizing — do not stop partway through.`;

            tempRuntime = new AgentRuntime({
              profile,
              logger: this.logger.child({ session: `temp-rebuild-${i.channelId}` }),
              mcpServers: [],
            });

            await tempRuntime.start();

            await tempRuntime.newSession({
              cwd,
              model: compactionModel,
              meta: { reasoningEffort: "low" },
            });

            let summaryText = "";
            tempRuntime.onEvent((event) => {
              if (event.kind === "agent-text") {
                summaryText += event.text;
              }
            });

            try {
              const outcome = await tempRuntime.prompt(compactionPrompt);
            } finally {
              // Clean up the temp transcript file
              await fsp.unlink(transcriptFile).catch(() => {});
            }

            if (!summaryText.trim()) {
              throw new Error("Agent completed but returned an empty summary.");
            }

            // Seed a NEW resumable session with the rebuilt summary (instead of a
            // synthetic compactSession overwrite, which won't resume).
            const rbCfg = this.store.readConfig(record);
            const newSessionId = await this.seedNewSession({
              profile, cwd,
              ...(rbCfg.model ? { model: rbCfg.model } : {}),
              ...(rbCfg.reasoningEffort ? { effort: rbCfg.reasoningEffort } : {}),
              summary: summaryText,
            });

            // Update active session record
            await this.router.invalidate(record.id);
            this.store.upsert({
              ...record,
              acpSessionId: newSessionId,
              updatedUtc: new Date().toISOString(),
            });

            // Update thread name
            await this.renameThreadForSetup(channelRef, record);

            // Refresh sessions list
            sessions = await manager.listSessions(cwd);
            const newIndex = sessions.findIndex(s => s.sessionId === newSessionId);
            if (newIndex !== -1) {
              currentIndex = newIndex;
            }

            const successEmbed = new EmbedBuilder()
              .setTitle("🏗️ Session Rebuilt Successfully!")
              .setDescription(`Thread has been reconstructed from Discord history.\n\n**New Session ID:** \`${newSessionId}\`\n\n**Summary:**\n${summaryText.substring(0, 1500)}${summaryText.length > 1500 ? "..." : ""}`)
              .setColor(0x2ecc71);

            await btnInteraction.editReply({
              embeds: [successEmbed],
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId("sessions:close")
                    .setLabel("Close")
                    .setStyle(ButtonStyle.Secondary)
                ),
              ],
            });
          } catch (err: any) {
            this.logger.error({ err, channelId: i.channelId }, "failed to rebuild session");

            const errorEmbed = new EmbedBuilder()
              .setTitle("❌ Rebuild Failed")
              .setDescription(`An error occurred while reconstructing the session:\n\`\`\`\n${err.message}\n\`\`\``)
              .setColor(0xe74c3c);

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("sessions:summary_back")
                .setLabel("⬅ Back to Manage")
                .setStyle(ButtonStyle.Secondary)
            );

            await btnInteraction.editReply({
              embeds: [errorEmbed],
              components: [row],
            });
          } finally {
            if (tempRuntime) {
              const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
              await tempRuntime.dispose().catch(() => {});
              if (tempSessionId) {
                await manager.deleteSession(cwd, tempSessionId).catch((err) => {
                  this.logger.warn({ err, sessionId: tempSessionId }, "failed to clean up temporary summary session");
                });
              }
            }
          }
        })();
      } else if (customId === "sessions:summary") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🪄 Generating AI Summary...")
                .setDescription(`Analyzing transcript logs for session \`${session.sessionId}\`...`)
                .setColor(0xe67e22)
            ],
            components: [],
          });

          void (async () => {
            let tempRuntime: AgentRuntime | undefined;
            try {
              const transcript = await manager.getTranscript(cwd, session.sessionId);
              if (!transcript.trim()) {
                throw new Error("The session transcript is empty.");
              }

              let sanitizedTranscript = transcript
                .split("\n")
                .map((line) => {
                  if (line.length > 1000) {
                    return line.substring(0, 1000) + " ... [Line truncated]";
                  }
                  return line;
                })
                .join("\n");

              let maxTranscriptLength = 50000;
              if (record.agentId === "agy") {
                maxTranscriptLength = 8000;
              }
              if (sanitizedTranscript.length > maxTranscriptLength) {
                const keepHead = Math.floor(maxTranscriptLength * 0.3);
                const keepTail = Math.floor(maxTranscriptLength * 0.6);
                sanitizedTranscript =
                  sanitizedTranscript.substring(0, keepHead) +
                  "\n\n... [Transcript truncated due to length limits] ...\n\n" +
                  sanitizedTranscript.substring(sanitizedTranscript.length - keepTail);
              }

              let summaryModel = "";
              if (record.agentId === "copilot" || record.agentId.startsWith("copilot-")) {
                summaryModel = "gpt-5-mini";
              } else if (record.agentId === "remote") {
                summaryModel = "gpt-5-mini";
              } else if (record.agentId === "claude" || record.agentId.startsWith("claude-")) {
                summaryModel = "haiku";
              } else if (record.agentId === "agy") {
                summaryModel = "gemini-3-flash";
              } else {
                throw new Error(`AI Summary is not supported for agent profile \`${record.agentId}\``);
              }

              tempRuntime = new AgentRuntime({
                profile,
                logger: this.logger.child({ session: `temp-summary-${session.sessionId}` }),
                mcpServers: [],
              });

              await tempRuntime.start();

              await tempRuntime.newSession({
                cwd,
                model: summaryModel,
                meta: { reasoningEffort: "low" },
              });

              let summaryText = "";
              tempRuntime.onEvent((event) => {
                if (event.kind === "agent-text") {
                  summaryText += event.text;
                }
              });

              const summaryPrompt =
                `Please summarize the following conversation session. Highlight:\n` +
                `1. The primary goal of the session.\n` +
                `2. What key changes, debugging steps, or features were implemented.\n` +
                `3. The current status or remaining tasks.\n\n` +
                `Conversation Transcript:\n` +
                `${sanitizedTranscript}`;

              const outcome = await tempRuntime.prompt(summaryPrompt);

              if (!summaryText.trim()) {
                throw new Error("Agent completed but returned an empty summary.");
              }

              const displaySummary = summaryText.length > 4000 ? summaryText.substring(0, 3997) + "..." : summaryText;

              const summaryEmbed = new EmbedBuilder()
                .setTitle(`🪄 AI Summary — ${profile.displayName}`)
                .setDescription(
                  `**Session ID:** \`${session.sessionId}\`\n\n` +
                  `${displaySummary}`
                )
                .setColor(0x9b59b6);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:summary_back")
                  .setLabel("⬅ Back to Manage")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [summaryEmbed],
                components: [row],
              });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "failed to generate AI summary");

              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ AI Summary Failed")
                .setDescription(`An error occurred while generating the summary:\n\`\`\`\n${err.message}\n\`\`\``)
                .setColor(0xe74c3c);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:summary_back")
                  .setLabel("⬅ Back to Manage")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [errorEmbed],
                components: [row],
              });
            } finally {
              if (tempRuntime) {
                const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
                await tempRuntime.dispose().catch(() => {});
                if (tempSessionId) {
                  await manager.deleteSession(cwd, tempSessionId).catch((err) => {
                    this.logger.warn({ err, sessionId: tempSessionId }, "failed to clean up temporary summary session");
                  });
                }
              }
            }
          })();
        }
      } else if (customId === "sessions:compact") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🗳️ Compacting Session...")
                .setDescription(`Generating compaction summary for session \`${session.sessionId}\` (summary + verbatim recent window + pinned facts)...`)
                .setColor(0xe67e22)
            ],
            components: [],
          });

          const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sessions:summary_back").setLabel("⬅ Back to Manage").setStyle(ButtonStyle.Secondary)
          );

          void (async () => {
            try {
              if (!this.compactionModelFor(record.agentId)) {
                throw new Error(`Compaction is not supported for agent profile \`${record.agentId}\` (no summarizer model).`);
              }
              const built = await this.buildDefaultCompactionSeed({
                profile,
                manager,
                agentId: record.agentId,
                cwd,
                sessionId: session.sessionId,
              });
              if (!built) throw new Error("Nothing to compact (empty transcript or no summarizer model).");

              // Non-destructive: seed a NEW session with the summary (resumable),
              // bind the thread to it if this was its active session, and leave
              // the original intact.
              const cfg = this.store.readConfig(record);
              const newId = await this.seedNewSession({
                profile, cwd,
                ...(cfg.model ? { model: cfg.model } : {}),
                ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
                summary: built.seed,
              });
              const wasActive = session.sessionId === record.acpSessionId;
              if (wasActive) {
                this.store.upsert({ ...record, acpSessionId: newId, updatedUtc: new Date().toISOString() });
                await this.router.invalidate(record.id, { clearAcpSession: false });
              }

              sessions = await manager.listSessions(cwd);
              const newIndex = sessions.findIndex(s => s.sessionId === newId);
              if (newIndex !== -1) currentIndex = newIndex;

              const successEmbed = new EmbedBuilder()
                .setTitle("🗳️ Session Compacted")
                .setDescription(
                  `Compacted into a **new session** \`${newId}\` (summarized ${built.summarizedTurns} older turn(s), kept ${built.keptTurns} verbatim, pinned ${built.pinnedCount} fact(s)).` +
                  (wasActive ? `\nThis thread is now bound to it.` : ``) +
                  `\n\nThe original \`${session.sessionId}\` is **preserved** — find it in this list to review or delete.`
                )
                .setColor(0x2ecc71);
              await btnInteraction.editReply({ embeds: [successEmbed], components: [backRow] });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "failed to compact session");
              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Compaction Failed")
                .setDescription(`An error occurred during compaction:\n\`\`\`\n${(err?.message ?? String(err)).slice(0, 1500)}\n\`\`\``)
                .setColor(0xe74c3c);
              await btnInteraction.editReply({ embeds: [errorEmbed], components: [backRow] });
            }
          })();
        }
      } else if (customId === "sessions:premium") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const channelRef = this.channelRefFromInteraction(i);
          const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sessions:summary_back").setLabel("⬅ Back to Manage").setStyle(ButtonStyle.Secondary)
          );
          const progressEmbed = new EmbedBuilder()
            .setTitle("✨ Premium Compaction")
            .setDescription(`Running multi-agent compaction on \`${session.sessionId}\`…\nThis can take several minutes (fan-out → reduce → deep-dive → synthesize → verify).`)
            .setColor(0x9b59b6);
          await btnInteraction.editReply({ embeds: [progressEmbed], components: [] });

          void (async () => {
            // Throttle progress edits so we don't hit Discord's rate limit.
            let lastEdit = 0;
            let editing = false;
            const lines: string[] = [];
            const pushProgress = (m: string) => {
              lines.push(m);
              const now = Date.now();
              if (editing || now - lastEdit < 2500) return;
              editing = true;
              lastEdit = now;
              const tail = lines.slice(-8).map((l) => `• ${l}`).join("\n");
              btnInteraction.editReply({
                embeds: [EmbedBuilder.from(progressEmbed).setDescription(`Compacting \`${session.sessionId}\`…\n\n${tail}`)],
                components: [],
              }).catch(() => {}).finally(() => { editing = false; });
            };

            try {
              // Delegate the run+seed+swap to the shared primitive (identical
              // behavior, non-destructive); this handler keeps its card rendering.
              const res = await this.compactThread(record, {
                sessionId: session.sessionId,
                ...(channelRef ? { channel: channelRef } : {}),
                onProgress: pushProgress,
              });
              const newId = res.newSessionId;
              const wasActive = res.wasActive;
              sessions = await manager.listSessions(cwd);
              const newIndex = sessions.findIndex((s) => s.sessionId === newId);
              if (newIndex !== -1) currentIndex = newIndex;

              const reportPath = path.join(os.tmpdir(), `premium-compaction-${session.sessionId}.md`);
              await fsp.writeFile(reportPath, res.reportMarkdown, "utf8").catch(() => {});

              const successEmbed = new EmbedBuilder()
                .setTitle("✨ Premium Compaction Complete")
                .setDescription(
                  `Compacted into a **new session** \`${newId}\` with the multi-agent pipeline.` +
                  (wasActive ? ` This thread is now bound to it.` : ``) +
                  `\nOriginal \`${session.sessionId}\` is **preserved** (review or delete it from this list).`
                )
                .addFields(
                  { name: "Chunks", value: String(res.stats.chunks), inline: true },
                )
                .setColor(0x2ecc71);

              await btnInteraction.editReply({
                embeds: [successEmbed],
                components: [backRow],
                files: [new AttachmentBuilder(reportPath, { name: `premium-compaction-${session.sessionId}.md` })],
              }).catch(async () => {
                await btnInteraction.editReply({ embeds: [successEmbed], components: [backRow] }).catch(() => {});
              });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "premium compaction failed");
              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Premium Compaction Failed")
                .setDescription(`\`\`\`\n${(err?.message ?? String(err)).slice(0, 1500)}\n\`\`\``)
                .setColor(0xe74c3c);
              await btnInteraction.editReply({ embeds: [errorEmbed], components: [backRow] }).catch(() => {});
            }
          })();
        }
      } else if (customId === "sessions:premium_discord") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const channelRef = this.channelRefFromInteraction(i);
          const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sessions:summary_back").setLabel("⬅ Back to Manage").setStyle(ButtonStyle.Secondary)
          );
          const progressEmbed = new EmbedBuilder()
            .setTitle("✨ Premium Compaction (Discord)")
            .setDescription(`Running multi-agent compaction on full Discord history…\nThis can take several minutes (fan-out → reduce → deep-dive → synthesize → verify).`)
            .setColor(0x9b59b6);
          await btnInteraction.editReply({ embeds: [progressEmbed], components: [] });

          void (async () => {
            let lastEdit = 0;
            let editing = false;
            const lines: string[] = [];
            const pushProgress = (m: string) => {
              lines.push(m);
              const now = Date.now();
              if (editing || now - lastEdit < 2500) return;
              editing = true;
              lastEdit = now;
              const tail = lines.slice(-8).map((l) => `• ${l}`).join("\n");
              btnInteraction.editReply({
                embeds: [EmbedBuilder.from(progressEmbed).setDescription(`Compacting from Discord history…\n\n${tail}`)],
                components: [],
              }).catch(() => {}).finally(() => { editing = false; });
            };

            try {
              // Delegate the run+seed+swap to the shared primitive with the
              // full-Discord source; this handler keeps its card rendering.
              const res = await this.compactThread(record, {
                source: "discord",
                sessionId: session.sessionId,
                ...(channelRef ? { channel: channelRef } : {}),
                onProgress: pushProgress,
              });
              const newId = res.newSessionId;
              const wasActive = res.wasActive;
              sessions = await manager.listSessions(cwd);
              const newIndex = sessions.findIndex((s) => s.sessionId === newId);
              if (newIndex !== -1) currentIndex = newIndex;

              const reportPath = path.join(os.tmpdir(), `premium-compaction-discord-${session.sessionId}.md`);
              await fsp.writeFile(reportPath, res.reportMarkdown, "utf8").catch(() => {});

              const successEmbed = new EmbedBuilder()
                .setTitle("✨ Premium Compaction (Discord) Complete")
                .setDescription(
                  `Compacted from Discord thread history into a **new session** \`${newId}\` with the multi-agent pipeline.` +
                  (wasActive ? ` This thread is now bound to it.` : ``) +
                  `\nOriginal \`${session.sessionId}\` is **preserved** (review or delete it from this list).`
                )
                .addFields(
                  { name: "Chunks", value: String(res.stats.chunks), inline: true },
                )
                .setColor(0x2ecc71);

              await btnInteraction.editReply({
                embeds: [successEmbed],
                components: [backRow],
                files: [new AttachmentBuilder(reportPath, { name: `premium-compaction-discord-${session.sessionId}.md` })],
              }).catch(async () => {
                await btnInteraction.editReply({ embeds: [successEmbed], components: [backRow] }).catch(() => {});
              });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "premium compaction (Discord) failed");
              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Premium Compaction Failed")
                .setDescription(`\`\`\`\n${(err?.message ?? String(err)).slice(0, 1500)}\n\`\`\``)
                .setColor(0xe74c3c);
              await btnInteraction.editReply({ embeds: [errorEmbed], components: [backRow] }).catch(() => {});
            }
          })();
        }
      } else if (customId === "sessions:import_to_cwd") {
        const session = sessions[currentIndex];
        if (!session) return;
        const compactionModel = this.compactionModelFor(record.agentId);
        if (!compactionModel) {
          await btnInteraction.reply({
            content: `❌ Import is not supported for this agent.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`sessions:import_cwd_modal:${session.sessionId}`)
          .setTitle("Import Session to New Cwd")
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("target_cwd")
                .setLabel("Target cwd (absolute or under REPOS_ROOT)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder("/home/ubuntu/Projects/some-repo")
            )
          );

        await btnInteraction.showModal(modal);

        const submission = await btnInteraction.awaitModalSubmit({
          filter: (mi) =>
            mi.customId === `sessions:import_cwd_modal:${session.sessionId}` &&
            mi.user.id === btnInteraction.user.id,
          time: 120_000,
        }).catch(() => null);

        if (!submission) return;

        const rawCwd = submission.fields.getTextInputValue("target_cwd").trim();
        let targetCwd: string;
        try {
          targetCwd = resolveRepoPath(this.config.REPOS_ROOT, rawCwd);
        } catch (err) {
          await submission.reply({
            content: `❌ Invalid cwd: ${(err as Error).message}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await submission.deferUpdate();
        await submission.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("📤 Importing Session…")
              .setDescription(
                `Summarizing session \`${session.sessionId}\` and creating a new session under \`${this.repoDisplay(targetCwd)}\`…`
              )
              .setColor(0xe67e22),
          ],
          components: [],
        });

        void (async () => {
          let tempRuntime: AgentRuntime | undefined;
          try {
            const transcript = await manager.getTranscript(cwd, session.sessionId);
            if (!transcript.trim()) {
              throw new Error("The session transcript is empty.");
            }

            let sanitizedTranscript = transcript
              .split("\n")
              .map((line) =>
                line.length > 1000
                  ? line.substring(0, 1000) + " ... [Line truncated]"
                  : line
              )
              .join("\n");

            const promptTemplate = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
            const templateOverhead = promptTemplate.length + "\n\nConversation Transcript:\n".length;
            sanitizedTranscript = fitTranscriptToWindow(
              sanitizedTranscript,
              templateOverhead,
              compactionWindowFor(compactionModel)
            );
            const compactionPrompt = `${promptTemplate}\n\nConversation Transcript:\n${sanitizedTranscript}`;

            tempRuntime = new AgentRuntime({
              profile,
              logger: this.logger.child({ session: `temp-import-${session.sessionId}` }),
              mcpServers: [],
            });

            await tempRuntime.start();
            await tempRuntime.newSession({
              cwd: targetCwd,
              model: compactionModel,
              meta: { reasoningEffort: "low" },
            });

            let summaryText = "";
            tempRuntime.onEvent((event) => {
              if (event.kind === "agent-text") summaryText += event.text;
            });

            await tempRuntime.prompt(compactionPrompt);

            if (!summaryText.trim()) {
              throw new Error("Agent completed but returned an empty summary.");
            }

            // Seed a NEW resumable session (in the target cwd) with the summary.
            const imCfg = this.store.readConfig(record);
            const newSessionId = await this.seedNewSession({
              profile, cwd: targetCwd,
              ...(imCfg.model ? { model: imCfg.model } : {}),
              ...(imCfg.reasoningEffort ? { effort: imCfg.reasoningEffort } : {}),
              summary: summaryText,
            });

            // Re-anchor the current thread to the new cwd + new session.
            await this.router.invalidate(record.id);
            this.store.upsert({
              ...record,
              repoPath: targetCwd,
              acpSessionId: newSessionId,
              updatedUtc: new Date().toISOString(),
            });

            const successEmbed = new EmbedBuilder()
              .setTitle("📤 Session Imported Successfully!")
              .setDescription(
                `Summary of \`${session.sessionId}\` was seeded into a fresh session.\n\n` +
                `**New Cwd:** \`${this.repoDisplay(targetCwd)}\`\n` +
                `**New Session ID:** \`${newSessionId}\``
              )
              .setColor(0x2ecc71);

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("sessions:summary_back")
                .setLabel("⬅ Back to Manage")
                .setStyle(ButtonStyle.Secondary)
            );

            await submission.editReply({ embeds: [successEmbed], components: [row] });
          } catch (err: any) {
            this.logger.error({ err, sessionId: session.sessionId }, "failed to import session");
            const errorEmbed = new EmbedBuilder()
              .setTitle("❌ Import Failed")
              .setDescription(`An error occurred during import:\n\`\`\`\n${err.message}\n\`\`\``)
              .setColor(0xe74c3c);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("sessions:summary_back")
                .setLabel("⬅ Back to Manage")
                .setStyle(ButtonStyle.Secondary)
            );
            await submission.editReply({ embeds: [errorEmbed], components: [row] });
          } finally {
            if (tempRuntime) {
              const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
              await tempRuntime.dispose().catch(() => {});
              if (tempSessionId) {
                await manager.deleteSession(targetCwd, tempSessionId).catch((cleanupErr) => {
                  this.logger.warn(
                    { err: cleanupErr, sessionId: tempSessionId },
                    "failed to clean up temporary import session"
                  );
                });
              }
            }
          }
        })();
      } else if (customId === "sessions:migrate") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const targetProfiles = this.router.listProfiles().filter(p =>
            p.id !== record.agentId &&
            !!p.sessionManager
          );

          const embed = new EmbedBuilder()
            .setTitle(`Migrate Session — ${profile.displayName}`)
            .setDescription(
              `Migrate session \`${session.sessionId}\` to a different agent.\n\n` +
              `This will generate a premium AI compaction summary of the current session and initialize a brand-new session under the selected target agent.`
            )
            .setColor(0xf1c40f);

          const select = new StringSelectMenuBuilder()
            .setCustomId("sessions:migrate_target")
            .setPlaceholder("Select target agent...")
            .addOptions(
              targetProfiles.map(p => ({
                label: p.displayName,
                value: p.id,
                description: `Migrate to ${p.displayName} agent`
              }))
            );

          const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("sessions:migrate_cancel")
              .setLabel("⬅ Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          await btnInteraction.editReply({
            embeds: [embed],
            components: [
              new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
              cancelRow
            ],
          });
        }
      } else if (customId === "sessions:migrate_cancel") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      } else if (btnInteraction.isStringSelectMenu() && customId === "sessions:migrate_target") {
        await btnInteraction.deferUpdate();
        const targetAgentId = btnInteraction.values[0];
        const session = sessions[currentIndex];
        if (session && targetAgentId) {
          const targetProfile = this.router.getProfile(targetAgentId);
          const targetManager = targetProfile?.sessionManager;
          if (!targetProfile || !targetManager) {
            await btnInteraction.followUp({
              content: `❌ Target agent \`${targetAgentId}\` is not compatible or does not support session management.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🗳️ Migrating Session...")
                .setDescription(`Generating premium AI compaction summary and initializing new session under agent \`${targetProfile.displayName}\`...`)
                .setColor(0xe67e22)
            ],
            components: [],
          });

          void (async () => {
            let tempRuntime: AgentRuntime | undefined;
            try {
              const transcript = await manager.getTranscript(cwd, session.sessionId);
              if (!transcript.trim()) {
                throw new Error("The session transcript is empty.");
              }

              let sanitizedTranscript = transcript
                .split("\n")
                .map((line) => {
                  if (line.length > 1000) {
                    return line.substring(0, 1000) + " ... [Line truncated]";
                  }
                  return line;
                })
                .join("\n");

              const compactionModel = this.compactionModelFor(record.agentId);
              if (!compactionModel) {
                throw new Error(`Migration compaction is not supported for source agent profile \`${record.agentId}\``);
              }
              const promptTemplate = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
              const templateOverhead = promptTemplate.length + "\n\nConversation Transcript:\n".length;
              sanitizedTranscript = fitTranscriptToWindow(
                sanitizedTranscript,
                templateOverhead,
                compactionWindowFor(compactionModel)
              );
              const compactionPrompt = `${promptTemplate}\n\nConversation Transcript:\n${sanitizedTranscript}`;

              tempRuntime = new AgentRuntime({
                profile,
                logger: this.logger.child({ session: `temp-migrate-${session.sessionId}` }),
                mcpServers: [],
              });

              await tempRuntime.start();

              await tempRuntime.newSession({
                cwd,
                model: compactionModel,
                meta: { reasoningEffort: "low" },
              });

              let summaryText = "";
              tempRuntime.onEvent((event) => {
                if (event.kind === "agent-text") {
                  summaryText += event.text;
                }
              });

              const outcome = await tempRuntime.prompt(compactionPrompt);

              if (!summaryText.trim()) {
                throw new Error("Agent completed but returned an empty summary.");
              }

              // Seed a NEW resumable session under the TARGET agent (its own
              // default model/effort) with the summary.
              const newSessionId = await this.seedNewSession({
                profile: targetProfile,
                cwd,
                summary: summaryText,
              });

              // Update active session record
              await this.router.invalidate(record.id);
              this.store.upsert({
                ...record,
                agentId: targetAgentId,
                acpSessionId: newSessionId,
                updatedUtc: new Date().toISOString(),
              });

              const fresh = this.store.get(record.id);
              if (fresh) {
                record.agentId = fresh.agentId;
                record.acpSessionId = fresh.acpSessionId;
              }

              const channel = {
                platform: record.platform,
                id: record.channelRef,
                parentId: record.parentRef || undefined,
              };
              await this.updateThreadAbbreviation(channel, record.agentId, targetAgentId);

              const successEmbed = new EmbedBuilder()
                .setTitle("🎉 Session Migrated Successfully!")
                .setDescription(
                  `Successfully migrated to agent **${targetProfile.displayName}**.\n\n` +
                  `**New Session ID:** \`${newSessionId}\`\n\n` +
                  `🟢 **This new session is now active and attached to this channel.** Any future messages will run in this session.`
                )
                .setColor(0x2ecc71);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:close")
                  .setLabel("Close")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [successEmbed],
                components: [row],
              });

              collector.stop();
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "failed to migrate session");

              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Migration Failed")
                .setDescription(`An error occurred during migration:\n\`\`\`\n${err.message}\n\`\`\``)
                .setColor(0xe74c3c);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:summary_back")
                  .setLabel("⬅ Back to Manage")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [errorEmbed],
                components: [row],
              });
            } finally {
              if (tempRuntime) {
                const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
                await tempRuntime.dispose().catch(() => {});
                if (tempSessionId) {
                  await manager.deleteSession(cwd, tempSessionId).catch((err) => {
                    this.logger.warn({ err, sessionId: tempSessionId }, "failed to clean up temporary summary session");
                  });
                }
              }
            }
          })();
        }
      } else if (customId === "sessions:summary_back") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      }
    });

    collector.on("end", async (collected, reason) => {
      if (reason === "user_closed") {
        return;
      }
      try {
        const fresh = this.store.get(record.id);
        const activeId = fresh ? fresh.acpSessionId : record.acpSessionId;
        const currentSession = sessions[currentIndex];
        if (currentSession) {
          const embed = new EmbedBuilder()
            .setTitle(`Browse Sessions — ${profile.displayName} (Closed)`)
            .setDescription(
              `**Session ID:** \`${currentSession.sessionId}\`\n` +
              `**Created:** ${currentSession.createdAt ? `<t:${Math.floor(currentSession.createdAt / 1000)}:f>` : "Unknown"}\n` +
              `**Last Activity:** ${currentSession.lastActivityAt ? `<t:${Math.floor(currentSession.lastActivityAt / 1000)}:R>` : "Unknown"}\n` +
              `**Status:** ${activeId === currentSession.sessionId ? "🟢 **Active Session in this channel**" : "⚪ Inactive"}\n\n` +
              `**Preview (Heuristic):**\n` +
              (currentSession.previewLines.length > 0
                ? currentSession.previewLines.map(formatLine).filter(Boolean).join("\n") || "*No meaningful messages in this session.*"
                : "*No messages in this session yet.*")
            )
            .setColor(activeId === currentSession.sessionId ? 0x2ecc71 : 0x7f8c8d)
            .setFooter({ text: `Session ${currentIndex + 1} of ${sessions.length} (Menu Timed Out)` });

          await i.editReply({
            embeds: [embed],
            components: [],
          });
        }
      } catch {
        // ignore errors on end
      }
    });
  }

  private async cmdTools(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const action = i.options.getString("action", true);
    const list = parseCsv(i.options.getString("list") ?? "");
    const cfg = this.store.readConfig(record);
    if (action === "allow") cfg.availableTools = list;
    else if (action === "exclude") cfg.excludedTools = list;
    this.persistConfig(record, cfg);
    await this.router.invalidate(record.id);
    await i.reply({
      content: `Tool ${action} list: ${list.length === 0 ? "(cleared)" : "`" + list.join(", ") + "`"}. Next turn starts a fresh runtime.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdConfigSet(
    i: ChatInputCommandInteraction
  ): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const json = i.options.getString("json", true);
    let cfg: SessionConfigState;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      cfg = parsed as SessionConfigState;
    } catch (err) {
      await i.reply({
        content: `Invalid JSON: ${(err as Error).message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!cfg.model) cfg.model = this.config.DEFAULT_MODEL;
    this.persistConfig(record, cfg);
    await this.router.invalidate(record.id);
    await i.reply({
      content: "Config replaced; next turn starts a fresh runtime.",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdRepos(i: ChatInputCommandInteraction): Promise<void> {
    const threadId = i.channel?.isThread() ? i.channelId : undefined;
    const dirs = await this.listHostWorkspacePaths(threadId);
    const location = resolveThreadLocation(this.config, threadId);
    if (!dirs) {
      await i.reply({
        content: isLocalLocation(location)
          ? `REPOS_ROOT not found: \`${this.config.REPOS_ROOT}\``
          : `Host \`${location}\` did not report a workspace root.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (dirs.length === 0) {
      await i.reply({
        content: `No workspaces on \`${location}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = dirs.slice(0, 50).map((d) => `- ${path.basename(d)}`);
    await i.reply({
      content: `**Repos @ ${location}**\n${this.renderer.codeBlock(lines.join("\n"))}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * `/seam config detach state:detached|attached` (#80). Marks THIS thread so
   * it behaves like a plain Discord thread: allowlisted users can chat, the
   * bot does not reply and does not bind a session. Persistence is a raw
   * boolean on the thread preset (`threads.<id>.detached`). Does NOT create a
   * session row (D10: key the write on channelId). Does NOT delete an existing
   * session row or clear acp_session_id (D6). Not lock-exempt and not
   * participant-allowed (D5) — admin immunity is what lets Jesse run this in
   * a locked school channel.
   *
   * v1 inbound hole: schedules / wakes / watches / handoffs / steer still
   * fire; this command only flips the message-gate flag.
   */
  private async cmdDetach(i: ChatInputCommandInteraction): Promise<void> {
    if (!i.channel?.isThread()) {
      await i.reply({
        content: "Run this inside the thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const state = i.options.getString("state", true);
    const detached = state === "detached";
    const threadId = i.channelId;
    const parentRef = i.channel.parentId ?? undefined;

    // D10 route (a): persist keyed only on channelId, no ensureSessionRecord.
    // Write + hot-reload FIRST (D7) so a racing message cannot start a new turn.
    const result = this.configMutation.applyThreadDetached({
      threadId,
      parentRef,
      detached,
      actor: { id: i.user.id, name: i.user.displayName ?? i.user.username },
    });
    if (!result.ok) {
      await i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }

    // D7: abort any in-flight turn AFTER the flag is visible. Lookup only —
    // never upsert a session just to cancel one that doesn't exist.
    if (detached) {
      const record = this.store.get(makeSessionId(PLATFORM, threadId));
      if (record) {
        await this.router.abortTurn(record.id, { force: true });
      }
    }

    await i.reply({
      content: detached
        ? "This thread is detached — the bot will not reply here. Re-attach with `/seam config detach state:attached`."
        : "This thread is attached — the next allowlisted message will start (or resume) a session.",
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * `/seam config tts` with no options opens the settings card.
   * Passing state/voice/pace/style applies immediately (no card).
   */
  private async cmdTts(i: ChatInputCommandInteraction): Promise<void> {
    if (!i.channel?.isThread()) {
      await i.reply({
        content: "Run this inside the thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const stateRaw = i.options.getString("state");
    const voiceRaw = i.options.getString("voice")?.trim();
    const paceRaw = i.options.getString("pace");
    const styleRaw = i.options.getString("style");
    if (!stateRaw && !voiceRaw && !paceRaw && !styleRaw) {
      await this.openTtsEditor(i);
      return;
    }

    let voiceName: string | undefined;
    if (voiceRaw) {
      const known = findGeminiTtsVoice(voiceRaw);
      if (!known) {
        await i.reply({
          content: `Unknown voice \`${voiceRaw}\`. Pick from the autocomplete list, or open \`/seam config tts\` and use Voice… for an in-thread sample.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      voiceName = known.name;
    }
    if (paceRaw && !isTtsPace(paceRaw)) {
      await i.reply({ content: `Unknown pace \`${paceRaw}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (styleRaw && !isTtsStyle(styleRaw)) {
      await i.reply({ content: `Unknown style \`${styleRaw}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const threadId = i.channelId;
    const parentRef = i.channel.parentId ?? undefined;
    const result = this.configMutation.applyThreadOverlay({
      threadId,
      parentRef,
      changes: {
        ...(stateRaw ? { tts: stateRaw === "on" } : {}),
        ...(voiceName ? { ttsVoice: voiceName } : {}),
        ...(paceRaw && isTtsPace(paceRaw) ? { ttsPace: paceRaw } : {}),
        ...(styleRaw && isTtsStyle(styleRaw) ? { ttsStyle: styleRaw } : {}),
      },
      actor: { id: i.user.id, name: i.user.displayName ?? i.user.username },
    });
    if (!result.ok) {
      await i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }
    const resolvedVoice =
      voiceName ??
      resolveThreadTtsVoice(this.config, threadId) ??
      this.config.SEAM_GEMINI_TTS_VOICE;
    const voiceStyle = findGeminiTtsVoice(resolvedVoice)?.style;
    const voiceLabel = voiceStyle ? `${resolvedVoice} (${voiceStyle})` : resolvedVoice;
    const pace = resolveThreadTtsPace(this.config, threadId);
    const style = resolveThreadTtsStyle(this.config, threadId);
    const on = isThreadTtsEnabled(this.config, threadId);
    await i.reply({
      content:
        `TTS **${on ? "on" : "off"}** — voice **${voiceLabel}**, pace \`${pace}\`, style \`${style}\`.\n` +
        `Host Gemini key; you do not sign into Google. Card: \`/seam config tts\` (no options).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async openTtsEditor(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel || !i.channel?.isThread()) return;
    if (!this.adapter.sendPanel) {
      await i.reply({
        content: "This platform cannot render the TTS settings card.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const threadId = i.channelId;
    const voice =
      resolveThreadTtsVoice(this.config, threadId) ?? this.config.SEAM_GEMINI_TTS_VOICE;
    const now = Date.now();
    const draft: TtsEditorDraft = {
      id: randomUUID(),
      threadId,
      ...(i.channel.parentId ? { parentRef: i.channel.parentId } : {}),
      userId: i.user.id,
      createdAt: now,
      updatedAt: now,
      snapshot: {
        tts: isThreadTtsEnabled(this.config, threadId),
        voice,
        pace: resolveThreadTtsPace(this.config, threadId),
        style: resolveThreadTtsStyle(this.config, threadId),
      },
      overlay: {},
      view: "hub",
      voiceIndex: voiceIndexFor(voice),
    };
    const evicted = this.ttsEditor.put(draft);
    if (evicted?.messageId) {
      await this.editTtsEditorCard(channel, evicted.messageId, renderTtsCancelled(evicted));
    }
    await i.reply({ content: "Opening TTS settings…", flags: MessageFlags.Ephemeral });
    const ref = await this.adapter.sendPanel(channel, renderTtsHub(draft));
    this.ttsEditor.touch(draft.id, { messageId: ref.id });
  }

  private async editTtsEditorCard(
    channel: ChannelRef,
    messageId: string,
    panel: ReturnType<typeof renderTtsHub>
  ): Promise<void> {
    if (!this.adapter.editPanel) return;
    try {
      await this.adapter.editPanel({ channel, id: messageId }, panel);
    } catch (err) {
      this.logger.warn({ err, messageId }, "tts editor card edit failed");
    }
  }

  private async refreshTtsEditor(draft: TtsEditorDraft, sample?: Buffer): Promise<void> {
    if (!draft.messageId) return;
    const channel: ChannelRef = {
      platform: "discord",
      id: draft.threadId,
      ...(draft.parentRef ? { parentId: draft.parentRef } : {}),
    };
    const panel =
      draft.view === "voice" ? renderTtsVoiceStep(draft) : renderTtsHub(draft);
    if (draft.view === "voice" && sample) {
      const idx = Math.min(Math.max(0, draft.voiceIndex), GEMINI_TTS_VOICES.length - 1);
      const name = GEMINI_TTS_VOICES[idx]?.name ?? "voice";
      panel.files = [{ data: sample, filename: `${name}-sample.ogg` }];
    }
    await this.editTtsEditorCard(channel, draft.messageId, panel);
  }

  private async loadTtsVoiceSample(draft: TtsEditorDraft): Promise<Buffer | undefined> {
    const idx = Math.min(Math.max(0, draft.voiceIndex), GEMINI_TTS_VOICES.length - 1);
    const voice = GEMINI_TTS_VOICES[idx];
    if (!voice) return undefined;
    this.ttsEditor.touch(draft.id, { sampleStatus: "loading", sampleError: undefined });
    const loading = this.ttsEditor.get(draft.id) ?? draft;
    await this.refreshTtsEditor(loading);
    const sample = await getOrCreateTtsSample({
      dataDir: this.config.DATA_DIR,
      apiKey: this.config.SEAM_GEMINI_API_KEY,
      voice: voice.name,
      model: this.config.SEAM_GEMINI_TTS_MODEL,
    });
    if (!sample.ok) {
      this.logger.warn(
        { err: sample.error, voice: voice.name, threadId: draft.threadId },
        "tts voice sample failed"
      );
      this.ttsEditor.touch(draft.id, { sampleStatus: "error", sampleError: sample.error });
      const failed = this.ttsEditor.get(draft.id) ?? draft;
      await this.refreshTtsEditor(failed);
      return undefined;
    }
    this.ttsEditor.touch(draft.id, { sampleStatus: "ready", sampleError: undefined });
    const ready = this.ttsEditor.get(draft.id) ?? draft;
    await this.refreshTtsEditor(ready, sample.ogg);
    return sample.ogg;
  }

  private async handleTtsEditorComponent(evt: ComponentEvent): Promise<void> {
    const parsed = parseTtsCustomId(evt.customId);
    if (!parsed) return;
    let draft = this.ttsEditor.get(parsed.draftId);
    const auth = authorizeTtsDraftClick(draft, evt.userId);
    if (auth === "not-yours") {
      await evt.replyEphemeral("This TTS card isn't yours.");
      return;
    }
    if (auth === "expired" || !draft) {
      try {
        await evt.deferUpdate();
      } catch {
        await evt.replyEphemeral("This draft has expired.").catch(() => {});
        return;
      }
      if (evt.messageId) {
        await this.editTtsEditorCard(evt.channel, evt.messageId, {
          color: 0x99aab5,
          title: "🔊 Thread TTS",
          fields: [],
          footer: "draft expired",
          files: [],
          actions: [],
        });
      }
      return;
    }

    const action = parsed.action;
    try {
      await evt.deferUpdate();
    } catch (err) {
      this.logger.warn({ err, customId: evt.customId }, "tts editor deferUpdate failed");
      return;
    }

    if (action === "cancel") {
      this.ttsEditor.delete(draft.id);
      if (draft.messageId) {
        await this.editTtsEditorCard(evt.channel, draft.messageId, renderTtsCancelled(draft));
      }
      return;
    }
    if (action === "save") {
      const changes = ttsDirtyChanges(draft);
      if (Object.keys(changes).length === 0) return;
      const result = this.configMutation.applyThreadOverlay({
        threadId: draft.threadId,
        parentRef: draft.parentRef,
        changes,
        actor: { id: evt.userId, name: evt.userName },
      });
      if (!result.ok) {
        await evt.followUpEphemeral(result.error).catch(() => {});
        return;
      }
      const saved = renderTtsSaved(draft);
      this.ttsEditor.delete(draft.id);
      if (draft.messageId) {
        await this.editTtsEditorCard(evt.channel, draft.messageId, saved);
      }
      return;
    }
    if (action === "toggle") {
      const e = effectiveTts(draft);
      draft = this.ttsEditor.touch(draft.id, { overlay: { ...draft.overlay, tts: !e.tts } }) ?? draft;
      await this.refreshTtsEditor(draft);
      return;
    }
    if (action === "pace") {
      const e = effectiveTts(draft);
      draft = this.ttsEditor.touch(draft.id, {
        overlay: { ...draft.overlay, pace: cyclePace(e.pace) },
      }) ?? draft;
      await this.refreshTtsEditor(draft);
      return;
    }
    if (action === "style") {
      const e = effectiveTts(draft);
      draft = this.ttsEditor.touch(draft.id, {
        overlay: { ...draft.overlay, style: cycleStyle(e.style) },
      }) ?? draft;
      await this.refreshTtsEditor(draft);
      return;
    }
    if (action === "voice") {
      const e = effectiveTts(draft);
      draft =
        this.ttsEditor.touch(draft.id, {
          view: "voice",
          voiceIndex: voiceIndexFor(e.voice),
          sampleStatus: "loading",
        }) ?? draft;
      warmTtsSamples({
        dataDir: this.config.DATA_DIR,
        apiKey: this.config.SEAM_GEMINI_API_KEY,
        model: this.config.SEAM_GEMINI_TTS_MODEL,
      });
      await this.loadTtsVoiceSample(draft);
      return;
    }
    if (action === "vback") {
      draft = this.ttsEditor.touch(draft.id, { view: "hub", sampleStatus: undefined }) ?? draft;
      await this.refreshTtsEditor(draft);
      return;
    }
    if (action === "vprev" || action === "vnext") {
      const delta = action === "vnext" ? 1 : -1;
      const nextIdx = Math.min(
        GEMINI_TTS_VOICES.length - 1,
        Math.max(0, draft.voiceIndex + delta)
      );
      draft =
        this.ttsEditor.touch(draft.id, {
          voiceIndex: nextIdx,
          sampleStatus: "loading",
        }) ?? draft;
      await this.loadTtsVoiceSample(draft);
      return;
    }
    if (action === "vpick") {
      const voice = GEMINI_TTS_VOICES[draft.voiceIndex];
      if (!voice) return;
      draft =
        this.ttsEditor.touch(draft.id, {
          overlay: { ...draft.overlay, voice: voice.name },
          view: "hub",
          sampleStatus: undefined,
        }) ?? draft;
      await this.refreshTtsEditor(draft);
    }
  }

  private async cmdInit(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam config init` inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // #80 D8: refuse while detached — do not silently clear the flag or bind.
    if (Orchestrator.isInitRefusedWhileDetached(this.config, channel.id)) {
      await i.reply({
        content:
          "This thread is detached — run `/seam config detach state:attached` first.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    await i.reply({
      content:
        this.config.NEW_THREAD_WIZARD === "full"
          ? "Session ready. Starting setup…"
          : "Session ready. Pick a repo to begin:",
      flags: MessageFlags.Ephemeral,
    });
    if (this.config.NEW_THREAD_WIZARD === "full") {
      await this.runSetupWizard(channel, record);
    } else {
      await this.sendRepoPicker(channel);
    }
  }

  private async cmdApprove(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const policy = i.options.getString("policy", true) as
      | "always"
      | "ask"
      | "deny";
    const cfg = this.store.readConfig(record);
    cfg.permissionPolicy = policy;
    // Drop the deprecated field so it can never override the new value.
    delete cfg.autoApprovePermissions;
    this.persistConfig(record, cfg);
    const messages: Record<typeof policy, string> = {
      always:
        "Approval policy set to `always`. ⚠️ The agent will auto-approve every permission request (shell exec, file writes, network, etc.).",
      ask:
        "Approval policy set to `ask`. The bot will post a Discord prompt for each permission request and auto-deny after 5 minutes.",
      deny:
        "Approval policy set to `deny`. The agent will be auto-denied every permission request — useful for read-only sessions.",
    };
    await i.reply({ content: messages[policy], flags: MessageFlags.Ephemeral });
  }

  private async cmdStatusCard(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const resolved = this.router.describeConfig(record).statusCardStyle;
    const style = i.options.getString("style");
    const scope = (i.options.getString("scope") ?? "session") as "session" | "thread" | "channel";
    if (!style) {
      await i.reply({
        content:
          `Status card: \`${resolved.value}\` (from ${resolved.source}). ` +
          `Set with \`/seam config card style:full|simple [scope:session|thread|channel]\`.` +
          (resolved.value === "simple"
            ? " Simple cards drop repo/model/action/effort and show the agent brand icon."
            : ""),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (style !== "full" && style !== "simple") {
      await i.reply({
        content: "Style must be `full` or `simple`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const actor = { id: i.user.id, name: i.user.username };
    if (scope === "channel") {
      if (!record.parentRef) {
        await i.reply({
          content: "This thread has no parent channel to pin a channel-wide card style on.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const written = this.configMutation.applyChannelOverlay({
        channelId: record.parentRef,
        changes: { statusCardStyle: style },
        actor,
      });
      if (!written.ok) {
        await i.reply({ content: written.error, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply({
        content:
          `Channel status card set to \`${style}\` — every thread in this channel inherits it unless it has its own overlay. Applies on the next turn.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (scope === "thread") {
      const written = this.configMutation.applyThreadOverlay({
        threadId: record.channelRef,
        ...(record.parentRef ? { parentRef: record.parentRef } : {}),
        changes: { statusCardStyle: style },
        actor,
      });
      if (!written.ok) {
        await i.reply({ content: written.error, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply({
        content: `Thread-preset status card set to \`${style}\`. Applies on the next turn.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const cfg = this.store.readConfig(record);
    cfg.statusCardStyle = style;
    this.persistConfig(record, cfg);
    await i.reply({
      content:
        style === "simple"
          ? "Status card set to `simple` for this thread (overrides channel/thread presets). Applies on the next turn."
          : "Status card set to `full` for this thread (overrides channel/thread presets). Applies on the next turn.",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdSimpleCardGif(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const resolved = this.router.describeConfig(record).simpleCardGif;
    const state = i.options.getString("state");
    const scope = (i.options.getString("scope") ?? "session") as "session" | "thread" | "channel";
    const onLabel = resolved.value ? "on" : "off";
    if (!state) {
      await i.reply({
        content:
          `Simple-card GIF: \`${onLabel}\` (from ${resolved.source}). ` +
          `Set with \`/seam config gif state:on|off [scope:session|thread|channel]\`. ` +
          `Only the simple status card shows a thumbnail.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (state !== "on" && state !== "off") {
      await i.reply({
        content: "State must be `on` or `off`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const on = state === "on";
    const actor = { id: i.user.id, name: i.user.username };
    if (scope === "channel") {
      if (!record.parentRef) {
        await i.reply({
          content: "This thread has no parent channel to pin a channel-wide GIF toggle on.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const written = this.configMutation.applyChannelOverlay({
        channelId: record.parentRef,
        changes: { simpleCardGif: on },
        actor,
      });
      if (!written.ok) {
        await i.reply({ content: written.error, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply({
        content:
          `Channel simple-card GIF set to \`${state}\` — every thread in this channel inherits it unless it has its own overlay. Applies on the next turn.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (scope === "thread") {
      const written = this.configMutation.applyThreadOverlay({
        threadId: record.channelRef,
        ...(record.parentRef ? { parentRef: record.parentRef } : {}),
        changes: { simpleCardGif: on },
        actor,
      });
      if (!written.ok) {
        await i.reply({ content: written.error, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply({
        content: `Thread-preset simple-card GIF set to \`${state}\`. Applies on the next turn.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const cfg = this.store.readConfig(record);
    cfg.simpleCardGif = on;
    this.persistConfig(record, cfg);
    await i.reply({
      content: `Simple-card GIF set to \`${state}\` for this thread (overrides channel/thread presets). Applies on the next turn.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * Read a file from the host machine and post it to the channel as a
   * Discord attachment. The path must resolve under REPOS_ROOT or one
   * of the configured ATTACH_ROOTS — symlinks are followed and the
   * realpath is re-checked.
   */
  /**
   * Resolve a user/agent-supplied path to an existing file under one of
   * the allowed roots (REPOS_ROOT + ATTACH_ROOTS). Returns null on any
   * failure (not found, not a regular file, escapes roots, etc.).
   * Symlinks are followed and the realpath is re-checked.
   */
  private async resolveAllowedHostFile(
    requested: string,
    opts: { preferredRoot?: string | null } = {}
  ): Promise<{ realPath: string; size: number } | null> {
    const cleaned = requested.trim().replace(/^"|"$/g, "");
    if (!cleaned) return null;

    const allowedRoots = [
      this.config.REPOS_ROOT,
      ...this.config.ATTACH_ROOTS,
    ].map((p) => path.resolve(p));

    // For relative paths, try each candidate base in order until one
    // resolves to an existing regular file inside an allowed root:
    //   1. The session's repoPath (the thread's current repo) if any.
    //   2. Each allowed root in order.
    // For absolute paths, resolve directly.
    const candidates: string[] = [];
    if (path.isAbsolute(cleaned)) {
      candidates.push(path.resolve(cleaned));
    } else {
      const bases: string[] = [];
      if (opts.preferredRoot) bases.push(path.resolve(opts.preferredRoot));
      for (const r of allowedRoots) {
        if (!bases.includes(r)) bases.push(r);
      }
      for (const base of bases) candidates.push(path.resolve(base, cleaned));
    }

    for (const candidate of candidates) {
      let real: string;
      let stat: fs.Stats;
      try {
        real = await fsp.realpath(candidate);
        stat = await fsp.stat(real);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // Confine to allowed roots unless the operator has opted into any-path
      // attachment (single-user trusted instances). The realpath check above
      // still resolves symlinks, so the gate (when on) can't be tricked.
      if (
        !this.config.ATTACH_ALLOW_ANY_PATH &&
        !allowedRoots.some((r) => isWithinRoot(real, r))
      ) {
        continue;
      }
      return { realPath: real, size: stat.size };
    }
    return null;
  }

  private static readonly DISCORD_UPLOAD_MAX = 25 * 1024 * 1024;

  /** `/seam upload pull` — admin-only, no root jail. Relative = process cwd. */
  private async cmdUploadPull(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam upload pull` from inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.adapter.sendFile) {
      await i.reply({
        content: "This platform does not support file uploads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requested = i.options.getString("path", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    let abs: string;
    try {
      abs = resolveHostPath(requested);
    } catch (err) {
      await i.editReply((err as Error).message);
      return;
    }

    let st: import("node:fs").Stats;
    try {
      st = await fsp.stat(abs);
    } catch {
      await i.editReply(`Not found: \`${abs}\``);
      return;
    }
    if (!st.isFile()) {
      await i.editReply(`Not a regular file: \`${abs}\``);
      return;
    }

    const MAX = Orchestrator.DISCORD_UPLOAD_MAX;
    let data: Buffer;
    let filename = path.basename(abs);
    let mimeType = mimeTypeForFilename(filename);
    let zipped = false;
    try {
      if (st.size <= MAX) {
        data = await fsp.readFile(abs);
      } else {
        data = await zipOneFile(abs);
        zipped = true;
        filename = `${filename}.zip`;
        mimeType = "application/zip";
        if (data.byteLength > MAX) {
          await i.editReply(
            `File is ${st.size} B and zipped size is still ${data.byteLength} B — over Discord's ${MAX} B cap.`
          );
          return;
        }
      }
    } catch (err) {
      await i.editReply(`Read/zip failed: ${(err as Error).message}`);
      return;
    }

    try {
      await this.adapter.sendFile(channel, { data, filename, mimeType });
      await i.editReply(
        zipped
          ? `📎 Posted \`${filename}\` (${data.byteLength} B, zipped from ${st.size} B).`
          : `📎 Posted \`${filename}\` (${data.byteLength} B).`
      );
    } catch (err) {
      this.logger.warn({ err, filename }, "/seam upload pull failed");
      await i.editReply(`Upload failed: ${(err as Error).message}`);
    }
  }

  /** `/seam upload push` — write a Discord attachment to a host path. */
  private async cmdUploadPush(i: ChatInputCommandInteraction): Promise<void> {
    const destIn = i.options.getString("path", true);
    const file = i.options.getAttachment("file", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    let dest: string;
    try {
      dest = resolveHostPath(destIn);
    } catch (err) {
      await i.editReply((err as Error).message);
      return;
    }

    let destStat: import("node:fs").Stats | null = null;
    try {
      destStat = await fsp.stat(dest);
    } catch {
      destStat = null;
    }
    if (destStat?.isDirectory()) {
      await i.editReply(`Destination is a directory: \`${dest}\``);
      return;
    }
    const parent = path.dirname(dest);
    try {
      const pst = await fsp.stat(parent);
      if (!pst.isDirectory()) {
        await i.editReply(`Parent is not a directory: \`${parent}\``);
        return;
      }
    } catch {
      await i.editReply(`Parent directory does not exist: \`${parent}\``);
      return;
    }

    let bytes: Buffer;
    try {
      bytes = await this.downloadAttachmentBytes(file.url);
    } catch (err) {
      await i.editReply(`Download failed: ${(err as Error).message}`);
      return;
    }

    try {
      await fsp.writeFile(dest, bytes);
    } catch (err) {
      await i.editReply(`Write failed: ${(err as Error).message}`);
      return;
    }
    await i.editReply(`Wrote \`${file.name ?? "file"}\` → \`${dest}\` (${bytes.byteLength} B).`);
  }

  /** `/seam upload secret` — modal for name+value; one-shot file, path-only. */
  private async cmdUploadSecret(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam upload secret` from inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`upload:secret:${i.id}`)
      .setTitle("One-shot secret")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("name")
            .setLabel("Name (A–Z a–z 0–9 . _ -)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(64)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("value")
            .setLabel("Value (never posted to the channel)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        )
      );
    await i.showModal(modal);
    const sub = await i
      .awaitModalSubmit({
        filter: (m) => m.customId === `upload:secret:${i.id}` && m.user.id === i.user.id,
        time: 300_000,
      })
      .catch(() => null);
    if (!sub) return;
    const name = sub.fields.getTextInputValue("name");
    const value = sub.fields.getTextInputValue("value");
    try {
      const written = await writeThreadSecret(this.config.DATA_DIR, channel.id, name, value);
      await sub.reply({
        content:
          `🔐 Secret \`${written.name}\` stored for this thread at \`${written.absPath}\`.\n` +
          `The next agent turn will see the path (not the value). It is deleted when that turn ends, or after 1 hour.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await sub.reply({
        content: `Could not store secret: ${(err as Error).message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async cmdWhoami(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.editReply({ content: "Use inside a thread." });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      await i.editReply({
        content: `Agent \`${record.agentId}\` is not registered on this bot.`,
      });
      return;
    }
    if (!profile.whoami) {
      await i.editReply({
        content: `Agent \`${profile.id}\` (${profile.displayName}) does not expose account info.`,
      });
      return;
    }
    const id = await profile.whoami();
    if (!id) {
      await i.editReply({
        content:
          `Agent \`${profile.id}\` (${profile.displayName}) — no logged-in account found. ` +
          `Run \`copilot login\` (set \`COPILOT_HOME\` for non-default profiles) on the host.`,
      });
      return;
    }
    const hostNote = id.host ? ` (${id.host})` : "";
    await i.editReply({
      content: `Agent \`${profile.id}\` (${profile.displayName}) is signed in as **${id.login}**${hostNote}.`,
    });
  }

  private async cmdUsage(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.editReply({ content: "Use inside a thread." });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const isAgy = record.agentId === "agy";
    const isClaude = record.agentId === "claude" || record.agentId.startsWith("claude-");
    const isCopilot =
      record.agentId === "copilot" || record.agentId.startsWith("copilot-");
    const isGrok = record.agentId === "grok" || record.agentId.startsWith("grok-");
    if (!isAgy && !isClaude && !isCopilot && !isGrok) {
      await i.editReply({
        content: `\`/seam usage\` is only available for the \`agy\`, \`claude\`, \`copilot\`, and \`grok\` agents. This thread uses \`${record.agentId}\`.`,
      });
      return;
    }
    try {
      const profile = this.router.getProfile(record.agentId);
      const configDir = profile?.configDir;
      if (isAgy) {
        const { fetchAgyUserStatus } = await import("@seam/adapters");
        const data = await fetchAgyUserStatus(this.config.AGY_CLI_PATH);
        await i.editReply({ content: formatAgyUsage(data) });
      } else if (isClaude) {
        const { fetchClaudeUsage } = await import("@seam/adapters");
        const data = await fetchClaudeUsage(configDir);
        await i.editReply({ content: formatClaudeUsage(data) });
      } else if (isGrok) {
        const {
          fetchGrokUsage,
          fetchGrokUsageFromConnection,
        } = await import("@seam/adapters");
        const live = this.router.getRuntime(record.id);
        const data = live
          ? await fetchGrokUsageFromConnection((method, params) => live.request(method, params))
          : await fetchGrokUsage(this.config.GROK_CLI_PATH);
        await i.editReply({ content: formatGrokUsage(data) });
      } else {
        const { fetchCopilotUsage } = await import("@seam/adapters");
        const data = await fetchCopilotUsage(configDir);
        await i.editReply({ content: formatCopilotUsage(data) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err }, "/seam usage failed");
      await i.editReply({ content: `Couldn't fetch usage: ${msg}` });
    }
  }

  private async cmdAvatar(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const adapter = this.adapter as unknown as DiscordAdapter;
      const avatarOk = await adapter.pushAvatar();
      let bannerOk = false;
      let bannerErr: string | undefined;
      try {
        bannerOk = await adapter.pushBanner();
      } catch (err: unknown) {
        bannerErr = err instanceof Error ? err.message : String(err);
      }
      const parts: string[] = [];
      parts.push(
        avatarOk
          ? "✅ Bot avatar updated."
          : "⚠️ Avatar file not found (`assets/seam-acp-avatar.png`)."
      );
      if (bannerErr) {
        parts.push(`⚠️ Banner update failed: ${bannerErr}`);
      } else {
        parts.push(
          bannerOk
            ? "✅ Bot banner updated."
            : "⚠️ Banner file not found (`assets/seam-acp-banner.png`)."
        );
      }
      await i.editReply({ content: parts.join("\n") });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await i.editReply({ content: `❌ Failed to update avatar: ${msg}` });
    }
  }

  private async cmdHelp(i: ChatInputCommandInteraction): Promise<void> {
    const lines = [
      "**seam-acp** — control the agent in this thread.",
      "",
      "**Top-level**",
      "`/seam new [name]` — create a new agent thread",
      "`/seam cancel` — gracefully cancel this thread's turn",
      "`/seam cancel force:true` — escalate if the turn ignores cancel (old abort)",
      "`/seam cancel scope:all` — force-kill every active session (old kill)",
      "`/seam steer [thread] <prompt> [now]` — steer a node (thread defaults to here)",
      "`/seam queue <prompt>` — queue the next live turn (waits; does not abort)",
      "`/seam workflows` — delegation ledger + pending wakes/watches/live-help",
      "",
      "**`/seam upload`** (admin only)",
      "`/seam upload pull <path>` — post a host file here (zips if over 25 MB)",
      "`/seam upload push <file> <path>` — write an uploaded file to the host",
      "`/seam upload secret` — one-shot secret for this thread (deleted after the next turn)",
      "",
      "**`/seam config`**",
      "`/seam config model [id]` — get / set agent model",
      "`/seam config effort [level]` — reasoning effort",
      "`/seam config agent [id]` — get / set agent@location (resets session)",
      "`/seam config mode <id>` — set agent operational mode",
      "`/seam config repo [path] [scope:session|thread|channel]` — working repo (picker if omitted)",
      "`/seam config tools <allow|exclude> [list]` — tool filters",
      "`/seam config approve <always|ask|deny>` — permission policy",
      "`/seam config card [full|simple] [scope:session|thread|channel]` — status-card layout (channel = inherit live)",
      "`/seam config gif [on|off] [scope:session|thread|channel]` — random GIF on the simple status card",
      "`/seam config reset` — end this thread's ACP session; next message starts fresh",
      "`/seam config init` — bind this thread + start setup (repo picker, or full wizard)",
      "`/seam config detach <detached|attached>` — keep this thread session-less (no bot replies; does not delete history)",
      "`/seam config tts` — TTS settings card (toggle, voice stepper, pace, style)",
      "`/seam config tts [on|off] [voice] [pace] [style]` — set immediately without the card",
      "`/seam config show` — show session config JSON",
      "`/seam config set <json>` — replace session config",
      "`/seam config audit` — recent config mutations (who/what/when)",
      "",
      "**`/seam info`**",
      "`/seam info whoami` — show the account this thread's agent is signed in as",
      "`/seam info usage` — show usage / credits (agy, claude, copilot, grok)",
      "`/seam info avatar` — re-push bot avatar to Discord",
      "`/seam info help` — this list",
      "`/seam info sessions` — list known sessions",
      "`/seam info repos` — list repos under REPOS_ROOT",
      "",
      "**Groups** — `/seam schedule`, `/seam preset`, `/seam project`, `/seam upload`, `/seam bridge`",
      "",
      "Free-form messages in a thread are sent to the agent.",
    ];
    await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }

  // --- agent file uploads (Phase 2) ---

  /**
   * Upload a file produced by the agent (image / audio / embedded resource)
   * to the Discord thread. Falls back to inline text if the adapter doesn't
   * implement sendFile or the file is over Discord's free-tier 25 MB limit.
   */
  private async sendAgentFile(
    channel: ChannelRef,
    event: {
      filename: string;
      mimeType: string;
      data: string;
      base64: boolean;
      uri?: string;
    }
  ): Promise<void> {
    const buf = event.base64
      ? Buffer.from(event.data, "base64")
      : Buffer.from(event.data, "utf8");

    if (!this.adapter.sendFile) {
      await this.adapter.sendMessage(
        channel,
        `_Agent produced \`${event.filename}\` (${event.mimeType}, ${buf.byteLength} B) but this platform doesn't support file uploads._`
      );
      return;
    }

    const MAX_DISCORD_BYTES = 25 * 1024 * 1024;
    if (buf.byteLength > MAX_DISCORD_BYTES) {
      await this.adapter.sendMessage(
        channel,
        `_Agent produced \`${event.filename}\` (${buf.byteLength} B) — too large for Discord (25 MB limit)._${
          event.uri ? ` Source: ${event.uri}` : ""
        }`
      );
      return;
    }

    await this.adapter.sendFile(channel, {
      data: buf,
      filename: event.filename,
      mimeType: event.mimeType,
    });
  }

  /**
   * After a completed live turn, optionally attach one Gemini TTS ogg of the
   * user-visible prose. Fail-visible on synthesis error; never fails the turn.
   */
  private async maybeSpeakTurn(opts: {
    channel: ChannelRef;
    threadId: string;
    prose: string;
    alreadyHadAudio: boolean;
  }): Promise<void> {
    const enabled = isThreadTtsEnabled(this.config, opts.threadId);
    const clip = clipSpokenText(opts.prose);
    const decision = shouldSpeakReply({
      enabled,
      apiKey: this.config.SEAM_GEMINI_API_KEY,
      prose: clip.text,
      alreadyHadAudio: opts.alreadyHadAudio,
      turnOk: true,
    });
    if (!decision.speak) {
      if (enabled) {
        this.logger.info(
          { reason: decision.reason, threadId: opts.threadId, chars: opts.prose.trim().length },
          "tts skip"
        );
      }
      return;
    }
    if (!this.adapter.sendFile) return;
    if (clip.clipped) {
      this.logger.info(
        { threadId: opts.threadId, chars: opts.prose.trim().length, spoken: decision.text.length },
        "tts clipped long reply"
      );
    }
    try {
      const spoken = await speakReplyToOgg({
        apiKey: this.config.SEAM_GEMINI_API_KEY,
        text: decision.text,
        model: this.config.SEAM_GEMINI_TTS_MODEL,
        voice:
          resolveThreadTtsVoice(this.config, opts.threadId) ??
          this.config.SEAM_GEMINI_TTS_VOICE,
        pace: resolveThreadTtsPace(this.config, opts.threadId),
        style: resolveThreadTtsStyle(this.config, opts.threadId),
      });
      if (!spoken.ok) {
        this.logger.warn(
          { err: spoken.error, threadId: opts.threadId, chars: decision.text.length },
          "outbound TTS failed"
        );
        await this.adapter.sendMessage(
          opts.channel,
          `_Couldn't speak this reply:_ ${spoken.error}`
        );
        return;
      }
      await this.adapter.sendFile(opts.channel, {
        data: Buffer.from(spoken.ogg),
        filename: spoken.filename,
        mimeType: spoken.mimeType,
      });
    } catch (err) {
      this.logger.warn({ err, threadId: opts.threadId }, "outbound TTS threw");
      await this.adapter.sendMessage(
        opts.channel,
        `_Couldn't speak this reply:_ unexpected error`
      ).catch(() => {});
    }
  }

  /**
   * Render a closed fence to the chat thread. Routes between an inline
   * markdown message and a file attachment based on the rendered inline
   * size; bare-filename fences that resolve to a real host file under
   * the allowed roots are uploaded as the actual file.
   *
   * Failures are logged, never thrown.
   */
  private async emitClosedFence(
    channel: ChannelRef,
    fence: CompletedFence,
    counter: number,
    opts: { notice?: string; preferredRoot?: string | null } = {}
  ): Promise<void> {
    // Explicit file-attach signal: a fence tagged `seam-attach` whose body is a
    // workspace file path. Upload the real file (resolved against the thread's
    // repo) and suppress the block — it's a directive, not content to render.
    // Replaces the old existence-based "bare filename" auto-attach, which would
    // attach ANY fenced path that happened to exist — a footgun when an agent
    // merely references files while narrating its work.
    if (fence.lang === ATTACH_FENCE_LANG) {
      await this.emitAttachFence(channel, fence, opts);
      return;
    }

    // Agent-scheduled wake fence (#59): the MCP-less fallback (agy). Parse the
    // JSON body, arm the wake, replace the block with a short confirmation. Same
    // path as the `schedule_wake` MCP tool — the tool is just sugar over this.
    if (fence.lang === WAKE_FENCE_LANG) {
      await this.emitWakeFence(channel, fence);
      return;
    }

    // Agent-defined watch fence (#60): the MCP-less fallback (agy). Parse the
    // JSON body, register the watch for THIS thread, replace the block with a
    // confirmation. Same path as the `watch_create` MCP tool.
    if (fence.lang === WATCH_FENCE_LANG) {
      await this.emitWatchFence(channel, fence);
      return;
    }

    if (fence.lang === CHOICE_FENCE_LANG) {
      await this.emitChoiceFence(channel, fence);
      return;
    }

    if (fence.lang === RESULT_FENCE_LANG) {
      await this.emitResultFence(channel, fence);
      return;
    }

    // Typeset latex/math/tex/katex fences as a PNG (issue #79). Before the
    // inline/attachment size fork so the source fence is never shown.
    if (isMathFenceLang(fence.lang)) {
      await this.emitMathFence(channel, fence, counter, opts);
      return;
    }

    // Inline-rendered total size = ```lang\n<content>\n``` plus optional
    // trailing notice on its own paragraph.
    const inlineMessageLen =
      3 + fence.lang.length + 1 + fence.content.length + 1 + 3 +
      (opts.notice ? 2 + opts.notice.length : 0);
    const fitsInline = inlineMessageLen <= ORCH_INLINE_FENCE_MAX;

    if (fitsInline || !this.adapter.sendFile) {
      await this.emitFenceInline(channel, fence, opts);
      return;
    }
    await this.emitFenceAttachment(channel, fence, counter, opts);
  }

  /**
   * Typeset a latex/math/tex/katex fence as a PNG and upload it. Empty body
   * emits nothing. On render failure, fail-open: post the original source
   * fence plus a one-line italic notice (preserving any watchdog notice).
   */
  private async emitMathFence(
    channel: ChannelRef,
    fence: CompletedFence,
    counter: number,
    opts: { notice?: string } = {}
  ): Promise<void> {
    const body = fence.content.trim();
    if (!body) {
      this.logger.info({ lang: fence.lang }, "empty math fence; emitting nothing");
      return;
    }
    if (!this.adapter.sendFile) {
      await this.emitFenceInline(channel, fence, opts);
      return;
    }
    try {
      const png = await renderMathPng(fence.content);
      await this.adapter.sendFile(channel, {
        data: png,
        filename: `math-${counter}.png`,
        mimeType: "image/png",
      });
      if (opts.notice) {
        await this.adapter.sendMessage(channel, opts.notice).catch((err) => {
          this.logger.warn({ err }, "math fence notice send failed");
        });
      }
      this.logger.info(
        { chars: body.length, bytes: png.byteLength },
        "math fence → rendered PNG"
      );
    } catch (err) {
      this.logger.warn({ err, chars: body.length }, "math fence render failed; emitting source");
      const notice = opts.notice
        ? `${opts.notice}\n_(couldn't render latex)_`
        : "_(couldn't render latex)_";
      await this.emitFenceInline(channel, fence, { notice });
    }
  }

  /**
   * Upload a workspace file the agent requested via a `seam-attach` fence. The
   * first non-empty line of the fence body is the path; it is resolved against
   * the thread's repo first, then the allowed roots (the realpath within-root
   * check blocks `..` escapes). On any failure we post a short note rather than
   * silently rendering the directive as a raw code block.
   */
  private async emitAttachFence(
    channel: ChannelRef,
    fence: CompletedFence,
    opts: { notice?: string; preferredRoot?: string | null }
  ): Promise<void> {
    const note = opts.notice ? `\n\n${opts.notice}` : "";
    if (!this.adapter.sendFile) {
      await this.adapter
        .sendMessage(channel, `_(Agent requested a file attachment, but this platform can't upload files.)_${note}`)
        .catch(() => {});
      return;
    }
    const reqPath = (fence.content.split("\n").find((l) => l.trim()) ?? "").trim();
    if (!reqPath) return;
    const record = this.store.getByChannel(PLATFORM, channel.id);
    if (record && this.bridgeHub) {
      try {
        const ferried = await this.bridgeHub.readAttachmentForSession(
          record.id,
          opts.preferredRoot ?? record.repoPath ?? this.config.REPOS_ROOT,
          reqPath
        );
        if (ferried) {
          const MAX = 25 * 1024 * 1024;
          if (ferried.size > MAX) {
            await this.adapter
              .sendMessage(channel, `_(Can't attach \`${ferried.filename}\` — ${ferried.size} B exceeds the 25 MB limit.)_${note}`)
              .catch(() => {});
            return;
          }
          await this.adapter.sendFile(channel, {
            data: ferried.bytes,
            filename: ferried.filename,
            mimeType: mimeTypeForFilename(ferried.filename),
          });
          return;
        }
      } catch (err) {
        this.logger.warn({ err, reqPath, session: record.id }, "remote seam-attach ferry failed");
        await this.adapter
          .sendMessage(channel, `_(couldn't read the file from the host: \`${reqPath}\`)_${note}`)
          .catch(() => {});
        return;
      }
    }
    const resolved = await this.resolveAllowedHostFile(reqPath, {
      preferredRoot: opts.preferredRoot ?? null,
    });
    if (!resolved) {
      await this.adapter
        .sendMessage(channel, `_(Couldn't attach \`${reqPath}\` — not found relative to the repo or an allowed root, or outside REPOS_ROOT / ATTACH_ROOTS.)_${note}`)
        .catch(() => {});
      return;
    }
    const MAX = 25 * 1024 * 1024;
    if (resolved.size > MAX) {
      await this.adapter
        .sendMessage(channel, `_(Can't attach \`${path.basename(resolved.realPath)}\` — ${resolved.size} B exceeds the 25 MB limit.)_${note}`)
        .catch(() => {});
      return;
    }
    try {
      const data = await fsp.readFile(resolved.realPath);
      const filename = path.basename(resolved.realPath);
      await this.adapter.sendFile(channel, {
        data,
        filename,
        mimeType: mimeTypeForFilename(filename),
      });
      if (opts.notice) {
        await this.adapter.sendMessage(channel, opts.notice).catch(() => {});
      }
      this.logger.info(
        { realPath: resolved.realPath, bytes: data.byteLength },
        "seam-attach fence → uploaded workspace file"
      );
    } catch (err) {
      this.logger.warn({ err, realPath: resolved.realPath }, "seam-attach read/upload failed");
      await this.adapter
        .sendMessage(channel, `_(Failed to read \`${reqPath}\` for attachment.)_${note}`)
        .catch(() => {});
    }
  }

  /**
   * Handle a `seam-wake` fence (#59): the MCP-less fallback for agents like agy.
   * The body is JSON `{ delaySeconds, reason, prompt }`; arm the wake for THIS
   * thread (self-scope, mirroring the MCP tool), then replace the block with a
   * one-line confirmation so the thread shows the wake was set. On any parse or
   * validation failure, post a short note rather than rendering raw JSON.
   */
  private async emitWakeFence(channel: ChannelRef, fence: CompletedFence): Promise<void> {
    const record = this.store.getByChannel(PLATFORM, channel.id);
    if (!record) {
      await this.adapter
        .sendMessage(channel, "_(Couldn't schedule a wake — this thread has no bound session.)_")
        .catch(() => {});
      return;
    }
    let parsed: { delaySeconds?: unknown; reason?: unknown; prompt?: unknown };
    try {
      parsed = JSON.parse(fence.content.trim()) as typeof parsed;
    } catch {
      await this.adapter
        .sendMessage(channel, "_(Couldn't schedule a wake — the `seam-wake` block must be JSON `{ delaySeconds, reason, prompt }`.)_")
        .catch(() => {});
      return;
    }
    const result = this.scheduleWake(record, {
      delaySeconds: Number(parsed.delaySeconds),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
    });
    if (!result.ok) {
      await this.adapter.sendMessage(channel, `_(Wake not scheduled: ${result.error})_`).catch(() => {});
      return;
    }
    await this.sendResultCard(
      channel,
      "⏰ Wake scheduled",
      `Will resume this thread at ${result.fireAtUtc} (id \`${result.wakeId}\`). Cancel with \`/seam wakes\`.`,
      WAKE_COLOR
    ).catch(() => {});
    this.logger.info(
      { wakeId: result.wakeId, channel: channel.id },
      "wake: scheduled via seam-wake fence"
    );
  }

  /**
   * Discord author of the current *user* turn on a thread (#91 D9).
   * Independent of SPEAKER_IDENTITY_ENABLED. Null for injected turns.
   */
  currentAuthorId(channelRef: string): string | undefined {
    return this.currentAuthorIds.get(channelRef);
  }

  /**
   * Publish a frozen choice card (#91). Shared by MCP `create_choice` and the
   * `seam-choice` fence. Participant authors are refused (injected turns allowed).
   */
  async createChoice(
    record: SessionRecord,
    specInput: unknown
  ): Promise<
    | {
        ok: true;
        choiceId: string;
        messageId: string;
        ingestToken?: string;
        ingestUrl?: string;
      }
    | { ok: false; error: string }
  > {
    const authorId = this.currentAuthorId(record.channelRef);
    if (
      isChoiceAuthoringRefused(
        authorId,
        this.config.SEAM_PARTICIPANT_USER_IDS,
        this.config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return { ok: false, error: "Restricted participants cannot publish choice cards." };
    }
    const parsed = parseChoiceSpec(specInput);
    if (!parsed.ok) return parsed;
    return this.publishChoiceCard(record, parsed.spec);
  }

  async cancelChoice(
    record: SessionRecord,
    choiceId: string,
    opts?: { authorId?: string | null; skipAuthorGate?: boolean }
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const authorId = opts?.skipAuthorGate
      ? null
      : opts?.authorId !== undefined
        ? opts.authorId
        : this.currentAuthorId(record.channelRef);
    if (
      isChoiceAuthoringRefused(
        authorId,
        this.config.SEAM_PARTICIPANT_USER_IDS,
        this.config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return { ok: false, error: "Restricted participants cannot cancel choice cards." };
    }
    const card = this.store.getChoiceCard(choiceId);
    if (!card || card.channelRef !== record.channelRef) {
      return { ok: false, error: "No open choice card with that id in this thread." };
    }
    const cancelled = this.store.cancelChoiceCard(choiceId, record.channelRef);
    if (!cancelled) {
      return { ok: false, error: "That card is already closed." };
    }
    const updated = this.store.getChoiceCard(choiceId);
    if (updated) await this.refreshChoiceCard(updated);
    return { ok: true };
  }

  async createLiveHelp(
    record: SessionRecord,
    specInput: unknown
  ): Promise<
    | { ok: true; liveId: string; guildId: string; channelName: string }
    | { ok: false; error: string }
  > {
    const authorId = this.currentAuthorId(record.channelRef);
    if (
      isChoiceAuthoringRefused(
        authorId,
        this.config.SEAM_PARTICIPANT_USER_IDS,
        this.config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return { ok: false, error: "Restricted participants cannot mint live-help calls." };
    }
    if (!this.liveHelpManager) {
      return { ok: false, error: "Live help is not wired on this deployment." };
    }
    return this.liveHelpManager.mint(record, specInput, authorId ?? record.id);
  }

  cancelLiveHelp(
    record: SessionRecord,
    liveId: string,
    opts?: { skipAuthorGate?: boolean }
  ): { ok: true } | { ok: false; error: string } {
    const authorId = opts?.skipAuthorGate ? null : this.currentAuthorId(record.channelRef);
    if (
      isChoiceAuthoringRefused(
        authorId,
        this.config.SEAM_PARTICIPANT_USER_IDS,
        this.config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return { ok: false, error: "Restricted participants cannot hang up live-help calls." };
    }
    if (!this.liveHelpManager) {
      return { ok: false, error: "Live help is not wired on this deployment." };
    }
    return this.liveHelpManager.cancel(liveId, { authoringChannelRef: record.channelRef });
  }

  resolveIngestJob(sessionId: string): SessionRecord | undefined {
    return this.ingestJobs.get(sessionId);
  }

  async createIngest(
    record: SessionRecord,
    specInput: unknown
  ): Promise<
    | { ok: true; ingestId: string; ingestToken: string; ingestUrl: string }
    | { ok: false; error: string }
  > {
    const authorId = this.currentAuthorId(record.channelRef);
    if (
      isChoiceAuthoringRefused(
        authorId,
        this.config.SEAM_PARTICIPANT_USER_IDS,
        this.config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return { ok: false, error: "Restricted participants cannot create ingest endpoints." };
    }
    const parsed = parseIngestEndpointSpec(specInput);
    if (!parsed.ok) return parsed;
    const spec = parsed.spec;
    const cfg = this.store.readConfig(record);
    let agentId: string | null = spec.agent ?? record.agentId ?? this.config.DEFAULT_AGENT;
    let cwd: string | null = spec.cwd ?? record.repoPath ?? null;
    let model: string | null = ingestMintStoredModel(spec.model);
    let effort: string | null = spec.effort ?? cfg.reasoningEffort ?? null;
    if (spec.preset) {
      const preset = this.store.getPresetByNameScoped(spec.preset, record.parentRef);
      if (!preset) {
        return { ok: false, error: `Unknown preset "${spec.preset}" in this project.` };
      }
      agentId = null;
      cwd = null;
      model = null;
      effort = null;
    } else if (!this.router.getProfile(agentId)) {
      return { ok: false, error: `Unknown agent "${agentId}".` };
    } else {
      const modelErr = refuseIsolatedClaudeModel(agentId, model);
      if (modelErr) return { ok: false, error: modelErr };
    }
    const ingestToken = mintBridgeToken();
    const row: IngestEndpoint = {
      id: newIngestEndpointId(),
      tokenHash: hashBridgeToken(ingestToken),
      name: spec.name,
      cwd,
      agentId,
      model,
      effort,
      wrapper: spec.wrapper?.trim() ? spec.wrapper : null,
      resultSchema: spec.resultSchema ?? null,
      corsOrigins: spec.corsOrigins ?? null,
      uniqueStudent: spec.uniqueStudent === true,
      notifyThread: spec.notifyThread ?? null,
      preset: spec.preset ?? null,
      status: "open",
      createdBy: record.id,
      createdUtc: new Date().toISOString(),
      authoringChannelRef: record.channelRef,
      authoringParentRef: record.parentRef,
      platform: record.platform,
    };
    this.store.insertIngestEndpoint(row);
    const ingestUrl = this.ingestUrl ? this.ingestUrl() : "/ingest";
    this.logger.info(
      { ingestId: row.id, thread: record.channelRef },
      "ingest endpoint minted"
    );
    return { ok: true, ingestId: row.id, ingestToken, ingestUrl };
  }

  async cancelIngest(
    record: SessionRecord,
    ingestId: string,
    opts?: { authorId?: string | null; skipAuthorGate?: boolean }
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const authorId = opts?.skipAuthorGate
      ? null
      : opts?.authorId !== undefined
        ? opts.authorId
        : this.currentAuthorId(record.channelRef);
    if (
      isChoiceAuthoringRefused(
        authorId,
        this.config.SEAM_PARTICIPANT_USER_IDS,
        this.config.SEAM_CONFIG_ADMIN_USER_IDS
      )
    ) {
      return { ok: false, error: "Restricted participants cannot revoke ingest endpoints." };
    }
    const ep = this.store.getIngestEndpoint(ingestId);
    if (!ep || ep.authoringChannelRef !== record.channelRef) {
      return { ok: false, error: "No open ingest endpoint with that id in this thread." };
    }
    const revoked = this.store.revokeIngestEndpoint(ingestId, record.channelRef);
    if (!revoked) {
      return { ok: false, error: "That endpoint is already revoked." };
    }
    return { ok: true };
  }

  private async publishChoiceCard(
    record: SessionRecord,
    spec: ChoiceSpec
  ): Promise<
    | {
        ok: true;
        choiceId: string;
        messageId: string;
        ingestToken?: string;
        ingestUrl?: string;
      }
    | { ok: false; error: string }
  > {
    if (!this.adapter.sendChoiceCard) {
      return { ok: false, error: "This platform cannot post choice cards." };
    }
    const ingress = normalizeIngress(spec);
    let ingestToken: string | undefined;
    let ingestHash: string | null = null;
    let ingestOptionIndex: number | null = null;
    if (ingress) {
      ingestToken = mintBridgeToken();
      ingestHash = hashBridgeToken(ingestToken);
      ingestOptionIndex = resolveIngestOptionIndex(spec.options, ingress.optionIndex);
    }
    const card: ChoiceCard = {
      id: newChoiceId(),
      platform: record.platform,
      channelRef: record.channelRef,
      parentRef: record.parentRef,
      messageId: null,
      title: spec.title,
      body: spec.body?.trim() ? spec.body : null,
      maxClicks: defaultMaxClicks(spec),
      targetUserId: spec.targetUserId ?? null,
      defaultTarget: spec.defaultTarget ?? { type: "live" },
      options: spec.options,
      clickCount: 0,
      status: "open",
      lastClickerId: null,
      lastClickerName: null,
      lastOptionIndex: null,
      createdBy: record.id,
      createdUtc: new Date().toISOString(),
      ingestTokenHash: ingestHash,
      ingestOptionIndex,
      resultSchema: ingress?.resultSchema ?? null,
      ingestWrapper: ingress?.wrapper?.trim() ? ingress.wrapper : null,
      ingestCors: ingress?.corsOrigins ?? null,
      ...(spec.select ? { select: clampChoiceSelect(spec.select, spec.options.length) } : {}),
    };
    this.store.insertChoiceCard(card);
    const channel: ChannelRef = {
      platform: PLATFORM,
      id: record.channelRef,
      ...(record.parentRef ? { parentId: record.parentRef } : {}),
    };
    try {
      const ref = await this.adapter.sendChoiceCard(channel, {
        panel: renderChoicePanel(card),
        choiceId: card.id,
        options: card.options.map((o) => ({ label: o.label, kind: o.kind })),
        ...(card.select ? { select: card.select } : {}),
      });
      this.store.setChoiceMessageId(card.id, ref.id);
      const ingestUrl = ingestToken && this.ingestUrl ? this.ingestUrl() : undefined;
      return {
        ok: true,
        choiceId: card.id,
        messageId: ref.id,
        ...(ingestToken ? { ingestToken } : {}),
        ...(ingestUrl ? { ingestUrl } : {}),
      };
    } catch (err) {
      this.store.cancelChoiceCard(card.id, record.channelRef);
      return { ok: false, error: `Failed to post card: ${(err as Error).message}` };
    }
  }

  private async emitChoiceFence(channel: ChannelRef, fence: CompletedFence): Promise<void> {
    const record = this.store.getByChannel(PLATFORM, channel.id);
    if (!record) {
      await this.adapter
        .sendMessage(channel, "_(Couldn't publish a choice card — this thread has no bound session.)_")
        .catch(() => {});
      return;
    }
    const parsed = parseChoiceFence(fence.content);
    if (!parsed.ok) {
      await this.adapter
        .sendMessage(channel, `_(Choice card not published: ${parsed.error})_`)
        .catch(() => {});
      return;
    }
    // Do not mint an ingest token from a fence — it would be posted in the
    // authoring thread. HTTP ingest is minted only via create_choice so the
    // token stays in the tool result.
    const wantedIngress = Boolean(parsed.spec.ingress);
    const specForPublish = wantedIngress ? { ...parsed.spec, ingress: undefined } : parsed.spec;
    const result = await this.createChoice(record, specForPublish);
    if (!result.ok) {
      await this.adapter.sendMessage(channel, `_(Choice card not published: ${result.error})_`).catch(() => {});
      return;
    }
    this.logger.info({ choiceId: result.choiceId, channel: channel.id }, "choice: published via seam-choice fence");
    if (wantedIngress) {
      await this.adapter
        .sendMessage(
          channel,
          "_HTTP ingest was requested. The site token is not posted in Discord — call `create_choice` with `ingress` so the token stays in the tool result. This card was published without ingest._"
        )
        .catch(() => {});
    }
  }

  private async emitResultFence(channel: ChannelRef, fence: CompletedFence): Promise<void> {
    const parsed = parseResultFence(fence.content);
    if (!parsed.ok) {
      await this.adapter.sendMessage(channel, `_(seam-result ignored: ${parsed.error})_`).catch(() => {});
      return;
    }
    if (!this.choiceResults) {
      await this.adapter
        .sendMessage(channel, "_(seam-result ignored: no ingest waiter for this turn.)_")
        .catch(() => {});
      return;
    }
    const record = this.store.getByChannel(PLATFORM, channel.id);
    const submitted = record
      ? this.choiceResults.submitFromSession(record.id, parsed.value)
      : { ok: false as const, error: "no session" };
    const result = submitted.ok
      ? submitted
      : this.choiceResults.submitFromChannel(channel.id, parsed.value);
    if (!result.ok) {
      await this.adapter.sendMessage(channel, `_(seam-result rejected: ${result.error})_`).catch(() => {});
    }
  }

  private async refreshChoiceCard(
    card: ChoiceCard,
    opts?: { pendingSelection?: number[] }
  ): Promise<void> {
    if (!card.messageId || !this.adapter.editChoiceCard) return;
    try {
      await this.adapter.editChoiceCard(
        { channel: { platform: PLATFORM, id: card.channelRef }, id: card.messageId },
        {
          panel: renderChoicePanel(card),
          choiceId: card.id,
          options: card.options.map((o) => ({ label: o.label, kind: o.kind })),
          disabled: card.status !== "open",
          hideButtons: choiceCardHideButtons(card),
          ...(card.select ? { select: card.select } : {}),
          ...(opts?.pendingSelection ? { pendingSelection: opts.pendingSelection } : {}),
        }
      );
    } catch (err) {
      this.logger.warn({ err, choiceId: card.id }, "choice: card edit failed");
    }
  }

  private async handleChoiceCardInteraction(evt: ChoiceInteraction): Promise<void> {
    const parsed = parseChoiceCustomId(evt.customId);
    if (!parsed) return;
    const card = this.store.getChoiceCard(parsed.choiceId);
    if (!card) {
      await evt.replyEphemeral("This card is no longer available.");
      return;
    }
    const auth = choiceClickRefusal(evt.userId, card, this.config.DISCORD_ALLOWED_USER_IDS);
    if (auth === "not-allowed") {
      await evt.replyEphemeral("This bot is not available to you.");
      return;
    }
    if (auth === "not-target") {
      await evt.replyEphemeral("This card isn't for you.");
      return;
    }
    if (auth === "closed") {
      await evt.replyEphemeral("This card is closed.");
      return;
    }

    if (isChoiceMultiSelect(card) && card.select) {
      await this.handleMultiSelectChoice(evt, card, parsed);
      return;
    }

    let optionIndex = parsed.optionIndex;
    if (parsed.kind === "select") {
      const v = evt.values?.[0];
      optionIndex = v !== undefined ? Number.parseInt(v, 10) : undefined;
    }
    if (optionIndex === undefined) {
      await evt.replyEphemeral("Unknown option.");
      return;
    }
    const option = card.options[optionIndex];
    if (!option) {
      await evt.replyEphemeral("Unknown option.");
      return;
    }

    if (option.kind === "custom" && parsed.kind !== "modal") {
      await evt.showModal({
        customId: makeChoiceModalId(card.id, optionIndex),
        title: option.label.slice(0, 45),
        label: "Your response",
        maxLength: CHOICE_CUSTOM_TEXT_MAX,
      });
      return;
    }

    const payload =
      option.kind === "custom"
        ? (evt.fields?.payload ?? "").slice(0, CHOICE_CUSTOM_TEXT_MAX)
        : (option.payload ?? "");
    if (option.kind === "custom" && !payload.trim()) {
      await evt.replyEphemeral("Type something before submitting.");
      return;
    }

    const destLive = await this.choiceDestLive(card, optionIndex);
    const planned = await this.planAndCheckChoice(card, optionIndex, {
      id: evt.userId,
      name: evt.userName,
    }, payload, destLive);
    if (!planned.ok) {
      await evt.replyEphemeral(planned.error);
      return;
    }

    await evt.deferUpdate();
    const claimed = this.store.claimChoiceClick({
      choiceId: card.id,
      userId: evt.userId,
      userName: evt.userName,
      optionIndex,
    });
    if (!claimed.ok) {
      const msg =
        claimed.reason === "already-clicked"
          ? "You already used this card."
          : claimed.reason === "exhausted"
            ? "This card is already taken."
            : "This card is closed.";
      await evt.followUpEphemeral(msg).catch(() => {});
      return;
    }
    try {
      const emitted = await emitChoice({
        card: claimed.card,
        optionIndex,
        actor: { id: evt.userId, name: evt.userName },
        payload,
        enqueue: (spec) => enqueueDispatchSpec(this.config.DATA_DIR, spec),
        authoringSession: this.store.getByChannel(PLATFORM, card.channelRef),
        destLive,
        defaultModel: this.config.DEFAULT_MODEL,
      });
      if (emitted.ok) {
        this.store.setChoiceClickDelivery(card.id, evt.userId, emitted.dispatchId);
      } else {
        this.logger.warn({ err: emitted.error, choiceId: card.id }, "choice: emit failed after claim");
      }
    } catch (err) {
      this.logger.warn({ err, choiceId: card.id }, "choice: enqueue failed after claim");
    }
    const fresh = this.store.getChoiceCard(card.id) ?? claimed.card;
    await this.refreshChoiceCard(fresh);
  }

  /**
   * Multi-select (#94): SELECT stores a pending pick (no emit) and re-renders
   * the same message; CONFIRM emits one combined prompt and freezes.
   */
  private async handleMultiSelectChoice(
    evt: ChoiceInteraction,
    card: ChoiceCard,
    parsed: { choiceId: string; optionIndex?: number; kind: "option" | "select" | "modal" | "confirm" }
  ): Promise<void> {
    const select = card.select!;
    if (parsed.kind === "select") {
      const indices = parseChoiceSelectValues(evt.values, card.options.length);
      this.choicePending.set(choicePendingKey(card.id, evt.userId), indices);
      await evt.deferUpdate();
      await this.refreshChoiceCard(card, { pendingSelection: indices });
      return;
    }
    if (parsed.kind !== "confirm") {
      await evt.replyEphemeral("Unknown option.");
      return;
    }
    const indices = this.choicePending.get(choicePendingKey(card.id, evt.userId)) ?? [];
    if (!choiceSelectionInRange(indices.length, select)) {
      await evt.replyEphemeral(choiceConfirmNudge(select));
      return;
    }
    const destLive = await this.choiceTargetLive(card, card.defaultTarget ?? { type: "live" });
    const planned = planChoiceMultiDispatch({
      card,
      optionIndices: indices,
      actor: { id: evt.userId, name: evt.userName },
      enqueue: async () => {},
      authoringSession: this.store.getByChannel(PLATFORM, card.channelRef),
      destLive,
      defaultModel: this.config.DEFAULT_MODEL,
    });
    if (!planned.ok) {
      await evt.replyEphemeral(planned.error);
      return;
    }
    const target = card.defaultTarget ?? { type: "live" };
    if (target.type === "thread" && target.threadId) {
      const dest = this.store.getByChannel(PLATFORM, target.threadId);
      if (!dest) {
        await evt.replyEphemeral("Unknown destination thread.");
        return;
      }
    }
    await evt.deferUpdate();
    const claimed = this.store.claimChoiceClick({
      choiceId: card.id,
      userId: evt.userId,
      userName: evt.userName,
      optionIndex: indices[0]!,
      optionIndices: indices,
    });
    if (!claimed.ok) {
      const msg =
        claimed.reason === "already-clicked"
          ? "You already used this card."
          : claimed.reason === "exhausted"
            ? "This card is already taken."
            : "This card is closed.";
      await evt.followUpEphemeral(msg).catch(() => {});
      return;
    }
    this.choicePending.delete(choicePendingKey(card.id, evt.userId));
    try {
      const emitted = await emitChoiceMulti({
        card: claimed.card,
        optionIndices: indices,
        actor: { id: evt.userId, name: evt.userName },
        enqueue: (spec) => enqueueDispatchSpec(this.config.DATA_DIR, spec),
        authoringSession: this.store.getByChannel(PLATFORM, card.channelRef),
        destLive,
        defaultModel: this.config.DEFAULT_MODEL,
      });
      if (emitted.ok) {
        this.store.setChoiceClickDelivery(card.id, evt.userId, emitted.dispatchId);
      } else {
        this.logger.warn({ err: emitted.error, choiceId: card.id }, "choice: multi emit failed after claim");
      }
    } catch (err) {
      this.logger.warn({ err, choiceId: card.id }, "choice: multi enqueue failed after claim");
    }
    const fresh = this.store.getChoiceCard(card.id) ?? claimed.card;
    await this.refreshChoiceCard(fresh);
  }

  private async planAndCheckChoice(
    card: ChoiceCard,
    optionIndex: number,
    actor: { id: string; name: string },
    payload: string,
    destLive: "ok" | "gone" | "archived"
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const planned = planChoiceDispatch({
      card,
      optionIndex,
      actor,
      payload,
      enqueue: async () => {},
      authoringSession: this.store.getByChannel(PLATFORM, card.channelRef),
      destLive,
      defaultModel: this.config.DEFAULT_MODEL,
    });
    if (!planned.ok) return { ok: false, error: planned.error };
    const option = card.options[optionIndex]!;
    const target = resolveOptionTarget(card, option);
    if (target.type === "thread" && target.threadId) {
      const dest = this.store.getByChannel(PLATFORM, target.threadId);
      if (!dest) return { ok: false, error: "Unknown destination thread." };
    }
    return { ok: true };
  }

  private async choiceDestLive(
    card: ChoiceCard,
    optionIndex: number
  ): Promise<"ok" | "gone" | "archived"> {
    const option = card.options[optionIndex];
    if (!option) return "gone";
    return this.choiceTargetLive(card, resolveOptionTarget(card, option));
  }

  private async choiceTargetLive(
    card: ChoiceCard,
    target: { type: "live" | "isolated" | "thread"; threadId?: string }
  ): Promise<"ok" | "gone" | "archived"> {
    const destId = target.type === "thread" && target.threadId ? target.threadId : card.channelRef;
    if (!this.adapter.getThreadLiveState) return "ok";
    try {
      const live = await this.adapter.getThreadLiveState({ platform: PLATFORM, id: destId });
      if (live === undefined) return "gone";
      if (live.archived) return "archived";
      return "ok";
    } catch {
      return "ok";
    }
  }

  /**
   * Handle a `seam-watch` fence (#60): the MCP-less fallback for agents like agy.
   * The body is JSON `{ kind, spec, intervalSeconds, prompt, expiresInSeconds,
   * match?, reason?, mode?, maxFires? }`; register the watch for THIS thread
   * (self-scope, mirroring the MCP tool), then replace the block with a one-line
   * confirmation. Same guards as `watch_create` (including the command gate). On
   * any parse/validation failure, post a short note rather than raw JSON.
   */
  private async emitWatchFence(channel: ChannelRef, fence: CompletedFence): Promise<void> {
    const record = this.store.getByChannel(PLATFORM, channel.id);
    if (!record) {
      await this.adapter
        .sendMessage(channel, "_(Couldn't register a watch — this thread has no bound session.)_")
        .catch(() => {});
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fence.content.trim()) as Record<string, unknown>;
    } catch {
      await this.adapter
        .sendMessage(
          channel,
          "_(Couldn't register a watch — the `seam-watch` block must be JSON `{ kind, spec, intervalSeconds, prompt, expiresInSeconds }`.)_"
        )
        .catch(() => {});
      return;
    }
    const result = this.createWatch(record, {
      kind: parsed.kind as WatchKind,
      spec: typeof parsed.spec === "string" ? parsed.spec : "",
      match: typeof parsed.match === "string" ? parsed.match : undefined,
      intervalSeconds: Number(parsed.intervalSeconds),
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      mode: parsed.mode === "each" ? "each" : "once",
      maxFires: parsed.maxFires === undefined ? undefined : Number(parsed.maxFires),
      expiresInSeconds: Number(parsed.expiresInSeconds),
    });
    if (!result.ok) {
      await this.adapter.sendMessage(channel, `_(Watch not registered: ${result.error})_`).catch(() => {});
      return;
    }
    await this.sendResultCard(
      channel,
      "🔔 Watch registered",
      `Checking every ${result.intervalSeconds}s until ${result.expiresAtUtc} (id \`${result.watchId}\`). Cancel with \`/seam workflows\`.`,
      WATCH_COLOR
    ).catch(() => {});
    this.logger.info(
      { watchId: result.watchId, channel: channel.id },
      "watch: registered via seam-watch fence"
    );
  }

  /**
   * Render a fence as an inline ```lang\n...\n``` Discord message,
   * with an optional trailing notice paragraph.
   */
  private async emitFenceInline(
    channel: ChannelRef,
    fence: CompletedFence,
    opts: { notice?: string } = {}
  ): Promise<void> {
    const body = `\`\`\`${fence.lang}\n${fence.content}\n\`\`\``;
    const text = opts.notice ? `${body}\n\n${opts.notice}` : body;
    try {
      await this.adapter.sendMessage(channel, text);
    } catch (err) {
      this.logger.warn({ err }, "fence inline send failed");
    }
  }

  /**
   * Upload a fence as a Discord file attachment. Falls back to inline
   * rendering if the adapter doesn't support file uploads or the
   * content exceeds Discord's 25 MB limit.
   */
  private async emitFenceAttachment(
    channel: ChannelRef,
    fence: CompletedFence,
    counter: number,
    opts: { notice?: string } = {}
  ): Promise<void> {
    if (!this.adapter.sendFile) {
      await this.emitFenceInline(channel, fence, opts);
      return;
    }
    const filename =
      fence.ext === "Dockerfile"
        ? counter === 1
          ? "Dockerfile"
          : `Dockerfile.${counter}`
        : `snippet-${counter}.${fence.ext}`;
    try {
      const buf = Buffer.from(fence.content, "utf8");
      const MAX = 25 * 1024 * 1024;
      if (buf.byteLength > MAX) {
        await this.adapter.sendMessage(
          channel,
          `_Code block too large to upload (${buf.byteLength} B, Discord 25 MB limit)._${
            opts.notice ? `\n\n${opts.notice}` : ""
          }`
        );
        return;
      }
      await this.adapter.sendFile(channel, {
        data: buf,
        filename,
        mimeType: fence.mimeType,
      });
      if (opts.notice) {
        try {
          await this.adapter.sendMessage(channel, opts.notice);
        } catch (err) {
          this.logger.warn({ err }, "fence attachment notice send failed");
        }
      }
    } catch (err) {
      this.logger.warn({ err, filename }, "fence upload failed");
    }
  }

  // --- repo picker ---

  /**
   * Resolve user input to a repo path on the thread's bound host. Absolute
   * paths pass through (caller still sandboxes with isWithinRoot on local);
   * relative names join under REPOS_ROOT locally, or match a listed workspace
   * by basename on a remote host.
   */
  private async resolveRequestedRepoPath(
    channel: ChannelRef,
    requested: string
  ): Promise<string> {
    const location = resolveThreadLocation(this.config, channel.id);
    if (isLocalLocation(location)) {
      return resolveRepoPath(this.config.REPOS_ROOT, requested);
    }
    if (requested.startsWith("/")) return requested;
    return (
      (await this.listHostWorkspacePaths(channel.id))?.find(
        (p) => path.basename(p) === requested || p === requested
      ) ?? requested
    );
  }

  private async applyPickedRepo(
    channel: ChannelRef,
    requested: string
  ): Promise<{ ok: true; record: SessionRecord } | { ok: false; error: string }> {
    let resolved: string;
    try {
      resolved = await this.resolveRequestedRepoPath(channel, requested);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const location = resolveThreadLocation(this.config, channel.id);
    if (isLocalLocation(location) && !isWithinRoot(resolved, this.config.REPOS_ROOT)) {
      return {
        ok: false,
        error: `Repo \`${resolved}\` is outside REPOS_ROOT (\`${this.config.REPOS_ROOT}\`).`,
      };
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    this.store.upsert({
      ...record,
      repoPath: resolved,
      updatedUtc: new Date().toISOString(),
    });
    await this.router.invalidate(record.id);
    return { ok: true, record: this.store.get(record.id) ?? { ...record, repoPath: resolved } };
  }

  /**
   * Interactive CWD picker for the thread's bound host. Paginates past
   * Discord's 25-option select cap and offers a "Type a path…" modal.
   * Returns the picked (or typed) path, or null on timeout / missing root.
   */
  private async promptRepoPath(
    channel: ChannelRef,
    opts?: {
      title?: string;
      location?: string;
      authorizedUserIds?: ReadonlySet<string>;
      includeInherit?: boolean;
    }
  ): Promise<string | null> {
    const location = opts?.location ?? resolveThreadLocation(this.config, channel.id);
    const dirs = await this.listHostWorkspacePaths(channel.id, location);
    if (dirs === undefined) {
      await this.adapter.sendMessage(
        channel,
        isLocalLocation(location)
          ? `❌ REPOS_ROOT not found: \`${this.config.REPOS_ROOT}\``
          : `❌ Host \`${location}\` did not report workspaces.`
      );
      return null;
    }

    if (!this.adapter.sendChoicePicker) {
      const lines = dirs
        .slice(0, 20)
        .map((p) => `• ${path.basename(p)}`)
        .join("\n");
      await this.adapter.sendMessage(
        channel,
        `🗂️ **Available repos** on \`${location}\`\n${this.renderer.codeBlock(lines)}\nUse \`/seam config repo path:<name>\`.`
      );
      return null;
    }

    const inheritChoice = opts?.includeInherit
      ? [{ value: INHERIT_VALUE, label: "Inherit", description: "Clear this thread's repo overlay" }]
      : [];

    const result = await this.adapter.sendChoicePicker(channel, {
      panel: {
        color: 0x5865f2,
        title: opts?.title ?? "🗂️ Select a project",
        description:
          dirs.length === 0
            ? `No listed folders on \`${location}\`. Type a custom path.`
            : `Host: \`${location}\`. ${dirs.length} folder${dirs.length === 1 ? "" : "s"}.`,
        fields: [],
      },
      choices: [
        ...inheritChoice,
        ...dirs.map((p) => ({
          value: p,
          label: path.basename(p),
          description: p,
        })),
      ],
      authorizedUserIds: opts?.authorizedUserIds ?? mayConfigureUserIds(this.config),
      allowCustom: {
        buttonLabel: "Type a path…",
        modalTitle: "Custom repo path",
        inputLabel: "Path",
        placeholder: "Folder name or absolute path",
      },
      validate: async (value) => {
        if (value === INHERIT_VALUE) return null;
        try {
          const resolved = await this.resolveRequestedRepoPath(channel, value);
          if (
            isLocalLocation(location) &&
            !isWithinRoot(resolved, this.config.REPOS_ROOT)
          ) {
            return `Path is outside REPOS_ROOT (\`${this.config.REPOS_ROOT}\`).`;
          }
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      },
      successPanel: (pickedChoice, username) => ({
        color: 0x57f287,
        title: "✅ Project selected",
        fields: [
          { name: "Project", value: `\`${pickedChoice.label}\``, inline: true },
        ],
        footer: `Selected by ${username}`,
      }),
    });

    return result?.value ?? null;
  }

  private async sendRepoPicker(channel: ChannelRef): Promise<void> {
    const picked = await this.promptRepoPath(channel, {
      title: "🗂️ Select a project to begin",
    });
    if (!picked) return;
    const applied = await this.applyPickedRepo(channel, picked);
    if (!applied.ok) {
      await this.adapter.sendMessage(channel, `🛡️ ${applied.error}`);
      return;
    }
    await this.renameThreadForSetup(channel, applied.record);
    await this.adapter.sendMessage(
      channel,
      `📌 Repo set to \`${this.repoDisplay(applied.record.repoPath ?? picked)}\`. Send a message to begin.`
    );
  }

  /**
   * D11: enumerate workspaces on the bound host. Remote → rpc listWorkspaces
   * (absolute host paths, no cwd rewrite). Local → loopback scan of REPOS_ROOT.
   */
  private async listHostWorkspacePaths(
    threadId?: string,
    locationOverride?: string
  ): Promise<string[] | undefined> {
    const location = locationOverride ?? resolveThreadLocation(this.config, threadId);
    if (this.bridgeHub) {
      try {
        const ws = await this.bridgeHub.listWorkspaces(location);
        return ws.map((w) => w.path);
      } catch (err) {
        this.logger.warn({ err, location }, "listWorkspaces on host failed");
        if (!isLocalLocation(location)) return [];
      }
    }
    return this.listRepoDirs();
  }

  private listRepoDirs(): string[] | undefined {
    const root = this.config.REPOS_ROOT;
    if (!fs.existsSync(root)) return undefined;
    return scanWorkspaces(root).map((w) => w.path);
  }

  /**
   * Full new-thread wizard: Agent → CWD → Model → Effort (if the agent
   * exposes settable levels). Agent is first so the CWD list is the bound
   * host's workspaces. Each step can be skipped (one option, timeout, or
   * no picker); a runtime start failure for the model picker is a notice.
   */
  private async runSetupWizard(
    channel: ChannelRef,
    record: SessionRecord
  ): Promise<void> {
    let currentRecord = record;

    // Step 1: Agent @ host (skip when there's only one choice). Timeout
    // keeps the default agent so CWD still lists that host.
    const profiles = this.router.listProfiles();
    const agentChoices = agentLocationPickerChoices(profiles, {
      bridges: this.config.bridgePresets.values(),
      connected: this.bridgeHub?.connectedIds(),
      agentsByHost: this.bridgeHub?.installedAgentsByHost(),
    });
    if (agentChoices.length > 1 && this.adapter.sendChoicePicker) {
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🤖 Choose an agent",
          fields: [{ name: "Default", value: `\`${currentRecord.agentId}\``, inline: true }],
        },
        choices: agentChoices,
        authorizedUserIds: mayConfigureUserIds(this.config),
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Agent changed",
          fields: [
            { name: "Default", value: `\`${currentRecord.agentId}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (
        picked &&
        picked.value !==
          currentAgentAtLocation(currentRecord.agentId, this.config, channel.id)
      ) {
        await this.applyAgentChange(channel, currentRecord, picked.value);
        currentRecord = this.store.get(currentRecord.id) ?? currentRecord;
      }
    }

    // Step 2: CWD on the (now bound) host.
    const repoPicked = await this.promptRepoPath(channel, {
      title: "🗂️ Select a working directory",
    });
    if (repoPicked) {
      const applied = await this.applyPickedRepo(channel, repoPicked);
      if (applied.ok) {
        currentRecord = applied.record;
      } else {
        await this.adapter.sendMessage(channel, `🛡️ ${applied.error}`);
      }
    }

    await this.renameThreadForSetup(channel, currentRecord);

    // Step 3: Model
    if (this.adapter.sendChoicePicker) {
      try {
        let models: ReadonlyArray<{ modelId: string; name?: string }> = [];
        const profile = this.router.getProfile(currentRecord.agentId);

        if (profile?.staticModels && profile.staticModels.length > 0) {
          models = profile.staticModels;
        } else {
          const rt = await this.router.getOrStartRuntime(currentRecord);
          models = rt.getSessionInfo()?.availableModels ?? [];
        }

        this.logger.info(
          { agentId: currentRecord.agentId, modelsLength: models.length },
          "Setup wizard checking models for picker"
        );

        if (models.length > 1) {
          const cfg = this.store.readConfig(currentRecord);
          const current = cfg.model ?? this.config.DEFAULT_MODEL;
          const picked = await this.adapter.sendChoicePicker(channel, {
            panel: {
              color: 0x5865f2,
              title: "🧠 Choose a model",
              fields: [{ name: "Default", value: `\`${current}\``, inline: true }],
            },
            choices: models.map((m) => ({
              value: m.modelId,
              label: m.name ?? m.modelId,
              description:
                m.modelId === current ? `${m.modelId} (current)` : m.modelId,
            })),
            authorizedUserIds: mayConfigureUserIds(this.config),
            successPanel: (pickedChoice, username) => ({
              color: 0x57f287,
              title: "✅ Model changed",
              fields: [
                { name: "Default", value: `\`${current}\``, inline: true },
                { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
              ],
              footer: `Changed by ${username}`
            }),
          });
          if (picked && picked.value !== current) {
            await this.applyModelChange(channel, currentRecord, picked.value);
          }
        }
      } catch (err) {
        this.logger.warn(
          { err },
          "wizard: could not start runtime for model picker"
        );
        await this.adapter.sendMessage(
          channel,
          `_Could not list models: ${(err as Error).message}. Use \`/seam config model\` later._`
        );
      }
    }

    // Step 4: Effort, only when this agent exposes settable levels.
    const effortProfile = this.router.getProfile(currentRecord.agentId);
    const supported = effortProfile?.effort?.levels ?? [];
    if (supported.length > 0 && this.adapter.sendChoicePicker) {
      const cfg = this.store.readConfig(currentRecord);
      const current = cfg.reasoningEffort ?? "default";
      const effortChoices = EFFORT_CHOICES.filter((c) =>
        supported.includes(c.value)
      );
      if (effortChoices.length > 0) {
        const picked = await this.adapter.sendChoicePicker(channel, {
          panel: {
            color: 0x5865f2,
            title: "⚡ Choose reasoning effort",
            fields: [{ name: "Default", value: `\`${current}\``, inline: true }],
          },
          choices: effortChoices,
          authorizedUserIds: mayConfigureUserIds(this.config),
          successPanel: (pickedChoice, username) => ({
            color: 0x57f287,
            title: "✅ Effort changed",
            fields: [
              { name: "Default", value: `\`${current}\``, inline: true },
              { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
            ],
            footer: `Changed by ${username} — applies on the next message`,
          }),
        });
        if (picked && picked.value !== current) {
          await this.applyEffortChange(currentRecord, picked.value);
        }
      }
    }

    await this.adapter.sendMessage(
      channel,
      `✅ Setup complete. Send a message to begin.`
    );
  }

  /** DB preset slug, else this thread's overlay, else the parent channel. */
  private effectiveThreadSlug(opts: {
    preset?: { threadSlug?: string | null } | null;
    threadId?: string;
    parentId?: string;
  }): string | undefined {
    return resolveEffectiveSlug({
      presetSlug: opts.preset?.threadSlug,
      threadSlug: opts.threadId
        ? this.config.threadPresets.get(opts.threadId)?.threadSlug?.value
        : undefined,
      channelSlug: opts.parentId
        ? this.config.channelPresets.get(opts.parentId)?.threadSlug?.value
        : undefined,
    });
  }

  /** Names of seam-bound sibling threads (same source as MCP `threads()`). */
  private async listSiblingThreadNames(
    parentRef: string,
    excludeChannelRef?: string
  ): Promise<string[]> {
    const siblings = this.store.listSessionsByParent(PLATFORM, parentRef);
    const names: string[] = [];
    for (const s of siblings) {
      if (excludeChannelRef && s.channelRef === excludeChannelRef) continue;
      try {
        const name = await this.adapter.getThreadName?.({
          platform: s.platform,
          id: s.channelRef,
        });
        if (name) names.push(name);
      } catch {
        /* skip a failed lookup */
      }
    }
    return names;
  }

  /**
   * After applying a preset, auto-number this thread from the effective slug.
   * Keeps an existing `[slug] [n]` number; allocates only for empty/default
   * names; never clobbers a custom title.
   */
  private async maybeRenameThreadForSlug(
    channel: ChannelRef,
    record: SessionRecord,
    preset: Preset
  ): Promise<string | undefined> {
    if (!this.adapter.renameThread) return undefined;
    if (!channel.parentId) return undefined;
    const slug = this.effectiveThreadSlug({
      preset,
      threadId: channel.id,
      parentId: channel.parentId,
    });
    if (!slug) return undefined;
    const abbr = this.router.getProfile(record.agentId)?.threadAbbr;
    let current: string | undefined;
    try {
      current = await this.adapter.getThreadName?.(channel);
    } catch {
      current = undefined;
    }
    if (current && isSlugNumberedName(current, slug)) {
      const n = parseSlugThreadNumber(current, slug);
      if (n === null) return undefined;
      const next = buildThreadName(abbr, slug, n);
      if (next !== current) {
        try {
          await this.adapter.renameThread(channel, next);
        } catch (err) {
          this.logger.warn({ err }, "slug rename failed");
        }
      }
      return undefined;
    }
    if (!isEmptyOrDefaultThreadName(current, abbr)) return undefined;
    const siblingNames = await this.listSiblingThreadNames(channel.parentId, channel.id);
    const n = nextThreadNumber(siblingNames, slug);
    if (n === null) {
      return `⚠️ Couldn't auto-name this thread — ${THREAD_LIMIT_MESSAGE}`;
    }
    const next = buildThreadName(abbr, slug, n);
    try {
      await this.adapter.renameThread(channel, next);
    } catch (err) {
      this.logger.warn({ err }, "slug rename failed");
    }
    return undefined;
  }

  /**
   * Rename a thread to "<repo-basename> [<agent-abbr>]" after setup.
   * Best-effort: silently skipped if the adapter, channel, or profile doesn't
   * support it.
   */
  private async renameThreadForSetup(
    channel: ChannelRef,
    record: SessionRecord
  ): Promise<void> {
    if (!this.adapter.renameThread) return;
    if (!channel.parentId) return; // not a thread
    const repoPath = record.repoPath;
    if (!repoPath) return;
    const profile = this.router.getProfile(record.agentId);
    const abbr = profile?.threadAbbr;
    if (!abbr) return;
    // Only rename if the thread still has the default "seam" name; skip if
    // the user already gave it a custom name when running /seam new.
    let current: string | undefined;
    if (this.adapter.getThreadName) {
      // Adapter strips obfuscated `___hidden___` names (#52); undefined ≠ a
      // custom title, so we still try the wizard rename.
      current = await this.adapter.getThreadName(channel);
      if (current !== undefined && current !== "seam") return;
    }
    const repoDisplayStr = this.repoDisplay(repoPath);
    const newName = `${repoDisplayStr} ${abbr}`;
    this.logger.info({ channelId: channel.id, oldName: current, newName }, "Renaming thread");
    try {
      await this.adapter.renameThread(channel, newName);
    } catch (err) {
      this.logger.warn({ err }, "wizard: renameThread failed");
    }
  }

  /**
   * Update the thread name abbreviation when migrating or switching agents.
   * Replaces any known agent abbreviations in brackets (e.g. [agy]) with the new target agent's abbreviation.
   */
  private async updateThreadAbbreviation(
    channel: ChannelRef,
    oldAgentId: string,
    newAgentId: string
  ): Promise<void> {
    if (!this.adapter.getThreadName || !this.adapter.renameThread || !channel.parentId) {
      return;
    }
    try {
      const currentName = await this.adapter.getThreadName(channel);
      if (!currentName) return;

      const targetProfile = this.router.getProfile(newAgentId);
      const targetAbbr = targetProfile?.threadAbbr;
      if (!targetAbbr) return;

      const allAbbrs = this.router.listProfiles()
        .map((p) => p.threadAbbr)
        .filter((abbr): abbr is string => typeof abbr === "string" && abbr.length > 0)
        .filter((abbr) => abbr.toLowerCase() !== targetAbbr.toLowerCase());

      let newName = currentName;
      let replaced = false;

      for (const abbr of allAbbrs) {
        // Case-insensitive replace so a thread named "… [AGY]" still matches the
        // "agy" abbreviation. Escape the abbr for the RegExp; a single .replace
        // pass also avoids the old indexOf-loop's infinite loop when a target
        // abbreviation contains the one being replaced.
        const re = new RegExp(abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const next = newName.replace(re, targetAbbr);
        if (next !== newName) {
          newName = next;
          replaced = true;
        }
      }

      if (replaced && newName !== currentName) {
        await this.adapter.renameThread(channel, newName);
        this.logger.info(
          { channelId: channel.id, oldName: currentName, newName },
          "Updated thread name abbreviation on agent transition"
        );
      }
    } catch (err) {
      this.logger.warn(
        { err, channelId: channel.id },
        "Failed to update thread name abbreviation"
      );
    }
  }

  // --- /seam preset … -------------------------------------------------------

  private async cmdPreset(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand(true);
    switch (sub) {
      case "list": return this.cmdPresetList(i);
      case "create": return this.cmdPresetCreate(i);
      case "apply": return this.cmdPresetApply(i);
      case "delete": return this.cmdPresetDelete(i);
      case "show": return this.cmdPresetShow(i);
      case "edit": return this.cmdPresetEdit(i);
      case "thread": return this.cmdPresetThread(i);
      default:
        await i.reply({
          content: `Unknown preset subcommand: ${sub}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  // --- projects: DB-backed channel activation (#22) -------------------------

  private async cmdProject(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand(true);
    switch (sub) {
      case "new": return this.cmdProjectNew(i);
      case "list": return this.cmdProjectList(i);
      case "remove": return this.cmdProjectRemove(i);
      default:
        await i.reply({
          content: `Unknown project subcommand: ${sub}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  /**
   * The channel id to activate/deactivate. This must match what the incoming-
   * message gate checks — a thread's *parent* channel (`DISCORD_ALLOWED_CHANNEL_IDS`
   * is keyed on parents). Run in a thread → the parent; run in a plain channel →
   * the channel itself. Mirrors the scope resolution in handleSlashInteraction.
   */
  private projectScopeId(
    i: ChatInputCommandInteraction | MessageComponentInteraction | AutocompleteInteraction
  ): string | undefined {
    const ch = i.channel;
    return ch?.isThread() ? (ch.parentId ?? undefined) : i.channelId ?? undefined;
  }

  private projectDescription(p: ActiveProject): string | null {
    if (!p.configJson) return null;
    try {
      const parsed = JSON.parse(p.configJson) as { description?: string };
      return parsed.description ?? null;
    } catch {
      return null;
    }
  }

  private async cmdProjectNew(i: ChatInputCommandInteraction): Promise<void> {
    const channelRef = this.projectScopeId(i);
    if (!channelRef) {
      await i.reply({
        content: "Use `/seam project new` inside a server channel or thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const description = i.options.getString("description") ?? null;
    const existing = this.store.getActiveProject(channelRef);
    const now = new Date().toISOString();
    // Preserve an earlier description if none is supplied on re-activation.
    const configJson = description
      ? JSON.stringify({ description })
      : existing?.configJson ?? null;
    this.store.upsertActiveProject({
      channelRef,
      enabled: true,
      configJson,
      createdUtc: existing?.createdUtc ?? now,
      updatedUtc: now,
    });
    const wasActive = existing?.enabled === true;
    await i.reply({
      content:
        `${wasActive ? "🔁 Re-activated" : "✅ Activated"} <#${channelRef}> for seam-acp.` +
        (description ? `\n📝 ${description}` : "") +
        `\nThreads here now respond even without an env allowlist entry.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdProjectList(i: ChatInputCommandInteraction): Promise<void> {
    const projects = this.store.listActiveProjects();
    if (projects.length === 0) {
      await i.reply({
        content: "No active projects yet. Activate one with `/seam project new`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = projects.map((p) => {
      const desc = this.projectDescription(p);
      const state = p.enabled ? "🟢" : "⚪";
      return `${state} <#${p.channelRef}>${desc ? ` — ${desc}` : ""}`;
    });
    await i.reply({
      content: `**Active projects** (${projects.length})\n${lines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdProjectRemove(i: ChatInputCommandInteraction): Promise<void> {
    const channelRef = this.projectScopeId(i);
    if (!channelRef) {
      await i.reply({
        content: "Use `/seam project remove` inside a server channel or thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const existing = this.store.getActiveProject(channelRef);
    if (!existing) {
      await i.reply({
        content: `<#${channelRef}> is not an active project.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.store.removeActiveProject(channelRef);
    await i.reply({
      content: `🗑️ Deactivated <#${channelRef}>. It now relies on the env allowlist only.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private presetSummaryLine(p: Preset): string {
    const parts: string[] = [];
    if (p.agentId) parts.push(`Agent: ${p.agentId}`);
    if (p.model) parts.push(`Model: ${p.model}`);
    if (p.effort) parts.push(`Effort: ${p.effort}`);
    if (p.repoPath) parts.push(`Repo: ${this.repoDisplay(p.repoPath)}`);
    if (p.threadSlug) parts.push(`Slug: ${p.threadSlug}`);
    if (p.permission) parts.push(`Policy: ${p.permission}`);
    if (p.statusCardStyle) parts.push(`Card: ${p.statusCardStyle}`);
    if (p.toolsAllow?.length) parts.push(`Allow: ${p.toolsAllow.join(", ")}`);
    if (p.toolsExclude?.length) parts.push(`Exclude: ${p.toolsExclude.join(", ")}`);
    if (p.instructions) parts.push("📝 Has instructions");
    const scope = p.projectRef ? "📁" : "🌐";
    const desc = p.description ? ` — ${p.description}` : "";
    const config = parts.length > 0 ? `\n   ${parts.join(" · ")}` : "";
    return `${scope} **${p.name}**${desc}${config}`;
  }

  private buildPresetListMessage(
    projectRef: string | null,
    page = 0
  ): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const presets = this.store.listPresetsForProject(projectRef);
    const slice = paginatePresetList(presets, page);
    const caption = choicePickerPageCaption(
      presets.length,
      slice.page,
      PRESET_LIST_PAGE_SIZE
    );
    const body = slice.items.length
      ? slice.items.map((p) => this.presetSummaryLine(p)).join("\n\n")
      : "_No presets in this project yet._";
    const embed = new EmbedBuilder()
      .setTitle("🎛️ Presets")
      .setColor(PRESET_COLOR)
      .setDescription(
        [body, caption, "_📁 this project · 🌐 global_"].filter(Boolean).join("\n\n")
      );
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    // Discord caps a message at 5 action rows. Four preset rows leave room
    // for Prev / Page X/Y / Next when there is more than one page.
    for (const p of slice.items) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`pr:apply:${p.id}`)
            .setLabel(`▶️ ${p.name}`.slice(0, 80))
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`pr:edit:${p.id}`)
            .setLabel("✏️ Edit")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`pr:del:${p.id}`)
            .setLabel("🗑️ Delete")
            .setStyle(ButtonStyle.Danger)
        )
      );
    }
    if (slice.pageCount > 1) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`pr:page:${slice.page - 1}`)
            .setLabel("◀ Prev")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(slice.page === 0),
          new ButtonBuilder()
            .setCustomId(`pr:page:${slice.page}`)
            .setLabel(`Page ${slice.page + 1}/${slice.pageCount}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`pr:page:${slice.page + 1}`)
            .setLabel("Next ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(slice.page >= slice.pageCount - 1)
        )
      );
    }
    return { embeds: [embed], components };
  }

  private async cmdPresetList(i: ChatInputCommandInteraction): Promise<void> {
    const projectRef = this.projectScopeId(i) ?? null;
    const presets = this.store.listPresetsForProject(projectRef);
    if (presets.length === 0) {
      await i.reply({
        content: "No presets here yet. Create one with `/seam preset create`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    let page = 0;
    await i.reply({
      ...this.buildPresetListMessage(projectRef, page),
      flags: MessageFlags.Ephemeral,
    });
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });
    collector.on("end", async (_collected, reason) => {
      if (reason !== "time") return;
      try {
        await i.editReply({
          content: "⏰ Preset list timed out. Run `/seam preset list` again.",
          embeds: [],
          components: [],
        });
      } catch { /* token expired */ }
    });
    collector.on("collect", async (c) => {
      try {
        if (!c.isButton()) return;
        const [, action, id] = c.customId.split(":");
        if (!id) return;
        if (action === "page") {
          const requested = Number(id);
          if (!Number.isFinite(requested)) return;
          const remaining = this.store.listPresetsForProject(projectRef);
          page = paginatePresetList(remaining, requested).page;
          await c.update(this.buildPresetListMessage(projectRef, page));
          return;
        }
        const preset = this.store.getPreset(id);
        if (!preset) {
          await c.reply({
            content: "That preset no longer exists.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (action === "apply") {
          const channel = this.channelRefFromInteraction(c);
          if (!channel) {
            await c.reply({
              content: "Use inside a thread to apply a preset.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const record = this.router.ensureSessionRecord({
            platform: channel.platform,
            channelRef: channel.id,
            ...(channel.parentId ? { parentRef: channel.parentId } : {}),
            cwd: this.config.REPOS_ROOT,
          });
          const summary = await this.applyPresetToSession(channel, record, preset);
          await c.reply({
            content: `✅ Applied preset **${preset.name}**.\n${summary}`,
            flags: MessageFlags.Ephemeral,
          });
        } else if (action === "edit") {
          collector.stop("edit");
          await this.cmdPresetBuilder(c, preset);
        } else if (action === "del") {
          this.store.deletePreset(id);
          const remaining = this.store.listPresetsForProject(projectRef);
          page = paginatePresetList(remaining, page).page;
          await c.update(this.buildPresetListMessage(projectRef, page));
        }
      } catch (err) {
        this.logger.warn({ err }, "preset-list button handler failed");
      }
    });
  }

  private async cmdPresetCreate(i: ChatInputCommandInteraction): Promise<void> {
    // A new preset is stamped with the current project by default; `--global`
    // makes it a global preset visible in every project.
    const global = i.options.getBoolean("global") ?? false;
    const createScope = global ? null : this.projectScopeId(i) ?? null;
    const seedSlug = i.options.getString("slug");
    await this.cmdPresetBuilder(i, undefined, createScope, seedSlug);
  }

  private async cmdPresetEdit(i: ChatInputCommandInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.store.getPresetByNameScoped(name, this.projectScopeId(i) ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await this.cmdPresetBuilder(i, preset);
  }

  /**
   * Interactive preset builder card: selects for agent/model/effort, modals for
   * the free-text fields, and a save button. Shared by `create` and `edit`.
   */
  private async cmdPresetBuilder(
    i: ChatInputCommandInteraction | MessageComponentInteraction,
    existing?: Preset,
    createScope?: string | null,
    seedSlug?: string | null
  ): Promise<void> {
    const profiles = this.router.listProfiles();

    // Scope is fixed at creation: editing preserves the preset's scope, while a
    // new preset takes `createScope` (the current project, or null for global).
    const projectRef: string | null = existing
      ? existing.projectRef ?? null
      : createScope ?? null;

    const state: {
      name: string;
      description: string;
      agentId: string | null;
      model: string | null;
      effort: string | null;
      repoPath: string | null;
      permission: PermissionPolicyMode | null;
      toolsAllow: string[] | null;
      toolsExclude: string[] | null;
      instructions: string | null;
      statusCardStyle: StatusCardStyle | null;
      threadSlug: string | null;
    } = {
      name: existing?.name ?? "",
      description: existing?.description ?? "",
      agentId: existing?.agentId ?? null,
      model: existing?.model ?? null,
      effort: existing?.effort ?? null,
      repoPath: existing?.repoPath ?? null,
      permission: existing?.permission ?? null,
      toolsAllow: existing?.toolsAllow ?? null,
      toolsExclude: existing?.toolsExclude ?? null,
      instructions: existing?.instructions ?? null,
      statusCardStyle: existing?.statusCardStyle ?? null,
      threadSlug: existing?.threadSlug ?? normalizeThreadSlug(seedSlug ?? "") ?? null,
    };

    // Do not start an ACP session in this builder. staticModels first; agy
    // (and anyone else with listPickerModels) can fill from a cached catalog.
    const loadModels = async (
      agentId: string | null
    ): Promise<ReadonlyArray<{ modelId: string; name: string }>> => {
      if (!agentId) return [];
      return pickerModelsForProfile(this.router.getProfile(agentId), 24);
    };
    let models = await loadModels(state.agentId);
    const repoDirs = (await this.listHostWorkspacePaths(i.channelId)) ?? [];

    const render = () => {
      const agentDisplay = state.agentId ? `\`${state.agentId}\`` : "*(default)*";
      const modelDisplay = state.model ? `\`${state.model}\`` : "*(default)*";
      const effortDisplay = state.effort ?? "*(default)*";
      const repoDisplay = state.repoPath
        ? `\`${this.repoDisplay(state.repoPath)}\``
        : "*(default)*";
      const permDisplay = state.permission ?? "*(default)*";
      const cardDisplay = state.statusCardStyle ? `\`${state.statusCardStyle}\`` : "*(default)*";
      const toolsDisplay = (() => {
        const parts: string[] = [];
        if (state.toolsAllow?.length) parts.push(`Allow: ${state.toolsAllow.join(", ")}`);
        if (state.toolsExclude?.length) parts.push(`Exclude: ${state.toolsExclude.join(", ")}`);
        return parts.length > 0 ? parts.join("\n") : "*(default)*";
      })();
      const instrDisplay = state.instructions
        ? "```\n" + state.instructions.slice(0, 500) + "\n```"
        : "*(none)*";

      const embed = new EmbedBuilder()
        .setTitle(existing ? `✏️ Edit preset \`${existing.name}\`` : "🎛️ New preset")
        .setColor(PRESET_COLOR)
        .setDescription(
          "A preset is a reusable bundle of session settings. " +
          "When applied, it overrides only the fields it specifies — everything else keeps its default."
        )
        .addFields(
          { name: "🏷️ Name", value: state.name || "*(not set)*" },
          { name: "🗂️ Scope", value: projectRef ? `<#${projectRef}>` : "🌐 Global" },
          { name: "📝 Description", value: state.description || "*(none)*" },
          { name: "🤖 Agent", value: agentDisplay, inline: true },
          { name: "🧠 Model", value: modelDisplay, inline: true },
          { name: "⚡ Effort", value: effortDisplay, inline: true },
          { name: "📂 Repo", value: repoDisplay, inline: true },
          { name: "🔤 Slug", value: state.threadSlug ? `\`${state.threadSlug}\`` : "*(none)*", inline: true },
          { name: "🔒 Permission", value: permDisplay, inline: true },
          { name: "🃏 Status card", value: cardDisplay, inline: true },
          { name: "🔧 Tools", value: toolsDisplay },
          { name: "📋 Instructions", value: instrDisplay }
        );

      const agentSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:agent")
        .setPlaceholder("🤖 Agent")
        .addOptions(
          { label: "Default", value: "__default__", default: state.agentId === null },
          ...profiles.slice(0, 24).map((p) => ({
            label: p.displayName.slice(0, 100),
            value: p.id,
            description: p.id.slice(0, 100),
            default: p.id === state.agentId,
          }))
        );

      const modelSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:model")
        .setPlaceholder("🧠 Model");
      if (models.length > 0) {
        modelSelect.addOptions(
          { label: "Default", value: "__default__", default: state.model === null },
          ...models.map((m) => ({
            label: m.name.slice(0, 100),
            value: m.modelId,
            default: m.modelId === state.model,
          }))
        );
      } else {
        modelSelect.addOptions({
          label: state.agentId
            ? "Default (no models advertised for this agent)"
            : "Default (select an agent first for model list)",
          value: "__default__",
          default: true,
        });
      }

      const effortSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:effort")
        .setPlaceholder("⚡ Effort")
        .addOptions(
          { label: "Default", value: "__default__", default: state.effort === null },
          ...EFFORT_CHOICES.map((e) => ({
            label: e.label,
            value: e.value,
            description: e.description,
            default: e.value === state.effort,
          }))
        );

      const repoSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:repo")
        .setPlaceholder("📂 Repo");
      const repoOpts: Array<{
        label: string;
        value: string;
        description?: string;
        default?: boolean;
      }> = [
        {
          label: "Inherit / clear (no pin)",
          value: "__default__",
          description: "Don't pin a repo on this preset",
          default: state.repoPath === null,
        },
      ];
      const fit = repoDirs.filter((p) => p.length <= 100);
      for (const p of fit.slice(0, 23)) {
        repoOpts.push({
          label: path.basename(p).slice(0, 100) || p.slice(0, 100),
          value: p,
          description: p.slice(0, 100),
          default: p === state.repoPath,
        });
      }
      if (
        state.repoPath &&
        state.repoPath.length <= 100 &&
        !repoOpts.some((o) => o.value === state.repoPath)
      ) {
        repoOpts.splice(1, 0, {
          label: path.basename(state.repoPath).slice(0, 100),
          value: state.repoPath,
          description: state.repoPath.slice(0, 100),
          default: true,
        });
      }
      if (fit.length > 23 || fit.length < repoDirs.length) {
        repoOpts.push({
          label: "More… (full picker)",
          value: "__more__",
          description: "Open the paginated repo picker",
        });
      }
      repoSelect.addOptions(repoOpts);

      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("preset:details")
          .setLabel("✏️ Name & details")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("preset:tools")
          .setLabel("🔧 Tools")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("preset:card")
          .setLabel(state.statusCardStyle ? `🃏 ${state.statusCardStyle}` : "🃏 Card")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("preset:save")
          .setLabel(existing ? "💾 Save" : "✅ Create")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!state.name),
        new ButtonBuilder()
          .setCustomId("preset:cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      );

      return {
        embeds: [embed],
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(agentSelect),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortSelect),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(repoSelect),
          buttons,
        ],
      };
    };

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await i.editReply(render());
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });

    collector.on("end", async (_collected, reason) => {
      if (reason !== "time") return;
      try {
        await i.editReply({
          content: "⏰ Preset builder timed out — nothing was saved. Run the command again.",
          embeds: [],
          components: [],
        });
      } catch { /* token expired */ }
    });

    collector.on("collect", async (c) => {
      try {
        if (c.isStringSelectMenu() && c.customId === "preset:agent") {
          const v = c.values[0]!;
          state.agentId = v === "__default__" ? null : v;
          // Model ids are agent-specific; a stale pick would be invalid.
          state.model = null;
          await c.deferUpdate();
          models = await loadModels(state.agentId);
          await c.editReply(render());
        } else if (c.isStringSelectMenu() && c.customId === "preset:model") {
          const v = c.values[0]!;
          state.model = v === "__default__" ? null : v;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "preset:effort") {
          const v = c.values[0]!;
          state.effort = v === "__default__" ? null : v;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "preset:repo") {
          const v = c.values[0]!;
          if (v === "__more__") {
            await c.deferUpdate();
            const channel = this.channelRefFromInteraction(c);
            if (!channel) return;
            const picked = await this.promptRepoPath(channel, {
              title: "📂 Preset repo",
              includeInherit: true,
              authorizedUserIds: new Set([i.user.id]),
            });
            if (picked === INHERIT_VALUE) {
              state.repoPath = null;
            } else if (picked) {
              try {
                state.repoPath = await this.resolveRequestedRepoPath(channel, picked);
              } catch {
                state.repoPath = picked;
              }
            }
            await i.editReply(render());
          } else {
            state.repoPath = v === "__default__" ? null : v;
            await c.update(render());
          }
        } else if (c.isButton() && c.customId === "preset:card") {
          state.statusCardStyle =
            state.statusCardStyle === null
              ? "full"
              : state.statusCardStyle === "full"
                ? "simple"
                : null;
          await c.update(render());
        } else if (c.isButton() && c.customId === "preset:details") {
          const modal = new ModalBuilder()
            .setCustomId("preset:details-modal")
            .setTitle("Preset details");
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("name")
                .setLabel("Name (required)")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(80)
                .setValue(state.name)
                .setRequired(true)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("desc")
                .setLabel("Description")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(200)
                .setValue(state.description)
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("permission")
                .setLabel("Permission: always / ask / deny")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(10)
                .setValue(state.permission ?? "")
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("instr")
                .setLabel("Instructions (worker identity)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(4000)
                .setValue(state.instructions ?? "")
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("slug")
                .setLabel("Thread slug (auto-numbered names)")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(32)
                .setValue(state.threadSlug ?? "")
                .setRequired(false)
            )
          );
          await c.showModal(modal);
          try {
            const submit = await c.awaitModalSubmit({
              time: 300_000,
              filter: (m) => m.customId === "preset:details-modal",
            });
            state.name = submit.fields.getTextInputValue("name").trim();
            state.description = submit.fields.getTextInputValue("desc").trim();
            state.threadSlug = normalizeThreadSlug(submit.fields.getTextInputValue("slug"));
            const permVal = submit.fields
              .getTextInputValue("permission")
              .trim()
              .toLowerCase();
            state.permission =
              permVal === "always" || permVal === "ask" || permVal === "deny"
                ? permVal
                : null;
            const instrVal = submit.fields.getTextInputValue("instr").trim();
            state.instructions = instrVal || null;
            await submit.deferUpdate();
            await i.editReply(render());
          } catch { /* modal timeout */ }
        } else if (c.isButton() && c.customId === "preset:tools") {
          const modal = new ModalBuilder()
            .setCustomId("preset:tools-modal")
            .setTitle("Tool lists");
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("allow")
                .setLabel("Allow list (comma-separated, blank = all)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setValue(state.toolsAllow?.join(", ") ?? "")
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("exclude")
                .setLabel("Exclude list (comma-separated)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setValue(state.toolsExclude?.join(", ") ?? "")
                .setRequired(false)
            )
          );
          await c.showModal(modal);
          try {
            const submit = await c.awaitModalSubmit({
              time: 300_000,
              filter: (m) => m.customId === "preset:tools-modal",
            });
            const allow = parseCsv(submit.fields.getTextInputValue("allow"));
            const exclude = parseCsv(submit.fields.getTextInputValue("exclude"));
            state.toolsAllow = allow.length > 0 ? allow : null;
            state.toolsExclude = exclude.length > 0 ? exclude : null;
            await submit.deferUpdate();
            await i.editReply(render());
          } catch { /* modal timeout */ }
        } else if (c.isButton() && c.customId === "preset:instr") {
          const modal = new ModalBuilder()
            .setCustomId("preset:instr-modal")
            .setTitle("Custom instructions");
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("instr")
                .setLabel("Instructions (worker identity)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(4000)
                .setValue(state.instructions ?? "")
                .setRequired(false)
            )
          );
          await c.showModal(modal);
          try {
            const submit = await c.awaitModalSubmit({
              time: 300_000,
              filter: (m) => m.customId === "preset:instr-modal",
            });
            const val = submit.fields.getTextInputValue("instr").trim();
            state.instructions = val || null;
            await submit.deferUpdate();
            await i.editReply(render());
          } catch { /* modal timeout */ }
        } else if (c.isButton() && c.customId === "preset:save") {
          if (!state.name) {
            await c.reply({ content: "Name is required.", flags: MessageFlags.Ephemeral });
            return;
          }
          // Names are matched case-insensitively, so guard against a collision
          // that differs only in case — but only WITHIN the same scope, so a
          // project preset may reuse a name that exists globally or elsewhere.
          if (!existing || existing.name.toLowerCase() !== state.name.toLowerCase()) {
            const found = this.store.getPresetByNameScoped(state.name, projectRef);
            const collision = found && (found.projectRef ?? null) === projectRef;
            if (collision) {
              await c.reply({
                content:
                  `A ${projectRef ? "project" : "global"} preset named ` +
                  `\`${state.name}\` already exists.`,
                flags: MessageFlags.Ephemeral,
              });
              return;
            }
          }
          const now = new Date().toISOString();
          const preset: Preset = {
            id: existing?.id ?? `pre_${randomUUID().slice(0, 8)}`,
            name: state.name,
            projectRef,
            description: state.description || null,
            agentId: state.agentId,
            model: state.model,
            effort: state.effort,
            repoPath: state.repoPath,
            permission: state.permission,
            toolsAllow: state.toolsAllow,
            toolsExclude: state.toolsExclude,
            instructions: state.instructions,
            statusCardStyle: state.statusCardStyle,
            threadSlug: state.threadSlug,
            createdBy: existing?.createdBy ?? i.user.id,
            createdUtc: existing?.createdUtc ?? now,
            updatedUtc: now,
          };
          this.store.upsertPreset(preset);
          collector.stop(existing ? "saved" : "created");
          await c.update({
            content: `${existing ? "💾 Updated" : "✅ Created"} preset **${preset.name}** (\`${preset.id}\`).`,
            embeds: [],
            components: [],
          });
        } else if (c.isButton() && c.customId === "preset:cancel") {
          collector.stop("cancel");
          await c.update({ content: "Cancelled.", embeds: [], components: [] });
        }
      } catch (err) {
        this.logger.warn({ err }, "preset builder interaction failed");
      }
    });
  }

  private async cmdPresetApply(i: ChatInputCommandInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.store.getPresetByNameScoped(name, this.projectScopeId(i) ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam preset apply` inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const summary = await this.applyPresetToSession(channel, record, preset);
    await i.editReply(`✅ Applied preset **${preset.name}**.\n${summary}`);
  }

  /**
   * `/seam preset thread` (#93): create NEW thread(s) under the parent channel
   * (sibling if invoked inside a thread — same path as `/seam new`) and bind
   * the picked preset's full config onto each session. `quantity` > 1 allocates
   * sequential slug numbers without colliding in-loop and never exceeds 9.
   */
  private async cmdPresetThread(i: ChatInputCommandInteraction): Promise<void> {
    const rawName = i.options.getString("name") ?? "";
    const presetName = (i.options.getString("preset", true) ?? "").trim();
    if (!presetName) {
      await i.reply({
        content: "Pick a preset from the list — that field can't be blank.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const preset = this.store.getPresetByNameScoped(
      presetName,
      this.projectScopeId(i) ?? null
    );
    if (!preset) {
      await i.reply({
        content:
          `No preset named \`${presetName}\` in this project. Use \`/seam preset list\` to see what's available.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.adapter.createThread) {
      await i.reply({
        content: "This platform does not support creating threads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!i.channelId) {
      await i.reply({ content: "No channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    const quantityRaw = i.options.getInteger("quantity");
    const quantity =
      typeof quantityRaw === "number" && Number.isInteger(quantityRaw)
        ? Math.min(THREAD_NUMBER_MAX, Math.max(1, quantityRaw))
        : 1;
    // `name` is only honored for a single spawn.
    const name = quantity === 1 ? rawName.trim() : "";
    const parentId =
      i.channel && "isThread" in i.channel && typeof i.channel.isThread === "function" && i.channel.isThread()
        ? (typeof i.channel.parentId === "string" ? i.channel.parentId : i.channelId)
        : i.channelId;
    // New thread has no overlay yet — DB preset slug, else the parent channel's.
    const slug = this.effectiveThreadSlug({
      preset,
      parentId,
    });
    const abbr = preset.agentId
      ? this.router.getProfile(preset.agentId)?.threadAbbr
      : undefined;

    if (quantity > 1 && !slug) {
      await i.reply({
        content: "Multiple threads need a preset slug.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const plannedNames: string[] = [];
    if (name) {
      plannedNames.push(prefixThreadNameWithAgentEmoji(name, abbr));
    } else if (slug) {
      const used = await this.listSiblingThreadNames(parentId);
      for (let k = 0; k < quantity; k++) {
        const n = nextThreadNumber(used, slug);
        if (n === null) break;
        const threadName = buildThreadName(abbr, slug, n);
        used.push(threadName);
        plannedNames.push(threadName);
      }
      if (plannedNames.length === 0) {
        await i.reply({
          content:
            quantity === 1
              ? `Couldn't create the thread — ${THREAD_LIMIT_MESSAGE}`
              : `Created 0 of ${quantity} — the limit (9) for this kind of thread was reached.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } else {
      await i.reply({
        content: "Give the new thread a name.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const created: ChannelRef[] = [];
    let lastSummary = "";
    try {
      for (const threadName of plannedNames) {
        const thread = await this.createChildThread(i.channelId, threadName, i.user.id);
        const record = this.bindSessionToThread(thread);
        lastSummary = await this.applyPresetToSession(thread, record, preset);
        this.startPresetOpeningTurn(thread, record, preset, i.user.id);
        created.push(thread);
      }
      const hitLimit = plannedNames.length < quantity;
      if (created.length === 1 && quantity === 1) {
        await i.editReply(
          `🧵 Created <#${created[0]!.id}> from preset **${preset.name}**.\n${lastSummary}`
        );
        return;
      }
      const links = created.map((t) => `• <#${t.id}>`).join("\n");
      const header = hitLimit
        ? `🧵 Created ${created.length} of ${quantity} from preset **${preset.name}** — the limit (9) for this kind of thread was reached.`
        : `🧵 Created ${created.length} threads from preset **${preset.name}**:`;
      await i.editReply(links ? `${header}\n${links}` : header);
    } catch (err) {
      this.logger.warn({ err }, "/seam preset thread failed");
      try {
        const links = created.map((t) => `• <#${t.id}>`).join("\n");
        const prefix = created.length
          ? `Created ${created.length} of ${quantity} before failing: ${(err as Error).message}`
          : `Could not create the thread: ${(err as Error).message}`;
        await i.editReply(links ? `${prefix}\n${links}` : prefix);
      } catch {
        /* already replied */
      }
    }
  }

  /**
   * After `/seam preset thread` spawn + apply: if the preset has instructions,
   * kick off a real first turn in the NEW thread. Raw `injectTurn(session:"live")`
   * captures text and does not stream a status card; the synthetic IncomingMessage
   * path is the equivalent user-turn pipeline (panel, streaming, permissions).
   * Fire-and-forget so the slash reply is not held for the whole agent turn.
   * Not used by `/seam preset apply`.
   */
  private startPresetOpeningTurn(
    thread: ChannelRef,
    _record: SessionRecord,
    preset: Preset,
    authorId: string
  ): void {
    const prompt = (preset.instructions ?? "").trim();
    if (!prompt) return;
    const synthetic: IncomingMessage = {
      channel: thread,
      authorId,
      authorIsBot: false,
      text: prompt,
    };
    void this.queueOnChannel(thread.id, () => this.handleIncomingMessageInner(synthetic)).catch(
      (err) => {
        this.logger.warn({ err, thread: thread.id }, "preset thread: opening turn failed");
      }
    );
  }

  /**
   * Apply a preset's settings to a session. Returns a human-readable summary of
   * what changed (and what was skipped).
   *
   * Ordering matters: an agent switch resets the config and drops the ACP
   * session binding, so it runs first and the record is re-read afterwards.
   * All remaining edits — config fields and repo path — are then written in a
   * SINGLE upsert; writing them separately would let a later `upsert(...record)`
   * clobber the `configJson` an earlier write had just persisted.
   */
  private async applyPresetToSession(
    channel: ChannelRef,
    record: SessionRecord,
    preset: Preset
  ): Promise<string> {
    const changes: string[] = [];
    const notes: string[] = [];

    // Agent change first — mirrors applyAgentChange(): kill the runtime, reset
    // the model to the new agent's default, and clear the ACP session id so the
    // next message starts fresh against the new backend.
    if (preset.agentId && preset.agentId !== record.agentId) {
      const profile = this.router.getProfile(preset.agentId);
      if (!profile) {
        notes.push(`⚠️ Unknown agent \`${preset.agentId}\` — agent left unchanged.`);
      } else {
        const previousAgentId = record.agentId;
        await this.router.invalidate(record.id);
        const cfg = this.store.readConfig(record);
        cfg.model = profile.defaultModel;
        // Different agent → different context window; cached usage is invalid.
        cfg.lastContextUsage = undefined;
        this.store.upsert({
          ...record,
          agentId: preset.agentId,
          acpSessionId: "",
          configJson: this.store.writeConfig(cfg),
          updatedUtc: new Date().toISOString(),
        });
        record = this.store.get(record.id) ?? record;
        await this.updateThreadAbbreviation(channel, previousAgentId, preset.agentId);
        changes.push(`Agent → \`${preset.agentId}\` (model \`${profile.defaultModel}\`)`);
      }
    }

    const cfg = this.store.readConfig(record);

    if (preset.model) {
      cfg.model = preset.model;
      // Usage was measured under the previous model — don't seed the panel with
      // mismatched numbers. The runtime invalidation below makes the new model
      // take effect on respawn (covers backends where setModel() is rejected).
      cfg.lastContextUsage = undefined;
      changes.push(`Model → \`${preset.model}\``);
    }

    if (preset.effort) {
      // Gate on the *effective* agent's capability, exactly like /seam effort —
      // otherwise the summary would claim a change that silently does nothing.
      const profile = this.router.getProfile(record.agentId);
      const supported = profile?.effort?.levels ?? [];
      if (supported.includes(preset.effort)) {
        cfg.reasoningEffort = preset.effort;
        changes.push(`Effort → ${preset.effort}`);
      } else if (profile?.effort?.mechanism === "modelBaked") {
        notes.push(
          `⚠️ Effort \`${preset.effort}\` skipped — \`${record.agentId}\` bakes effort into the model choice.`
        );
      } else {
        notes.push(
          `⚠️ Effort \`${preset.effort}\` skipped — \`${record.agentId}\` has no settable reasoning effort.`
        );
      }
    }

    if (preset.permission) {
      cfg.permissionPolicy = preset.permission;
      // Drop the deprecated flag so it can't win the legacy fallback.
      delete cfg.autoApprovePermissions;
      changes.push(`Permission → ${preset.permission}`);
    }
    if (preset.toolsAllow) {
      cfg.availableTools = preset.toolsAllow;
      changes.push(`Tools allow → ${preset.toolsAllow.join(", ")}`);
    }
    if (preset.toolsExclude) {
      cfg.excludedTools = preset.toolsExclude;
      changes.push(`Tools exclude → ${preset.toolsExclude.join(", ")}`);
    }
    if (preset.statusCardStyle === "full" || preset.statusCardStyle === "simple") {
      if (preset.statusCardStyle === "full") {
        delete cfg.statusCardStyle;
      } else {
        cfg.statusCardStyle = "simple";
      }
      changes.push(`Status card → ${preset.statusCardStyle}`);
    }

    // One write for config + repo. `acp_session_id` is assigned out-of-band, so
    // re-read the authoritative value rather than trusting the in-memory record
    // (see persistConfig) — unless the agent switch above deliberately cleared it.
    const live = this.store.get(record.id)?.acpSessionId;
    this.store.upsert({
      ...record,
      ...(live ? { acpSessionId: live } : {}),
      ...(preset.repoPath ? { repoPath: preset.repoPath } : {}),
      configJson: this.store.writeConfig(cfg),
      updatedUtc: new Date().toISOString(),
    });
    if (preset.repoPath) {
      changes.push(`Repo → \`${this.repoDisplay(preset.repoPath)}\``);
    }

    if (preset.instructions) {
      notes.push(
        "ℹ️ Instructions are injected as the worker's `<seam-worker-identity>` when this preset " +
          "runs as a handoff/dispatch worker."
      );
    }

    // Drop the runtime so the next message picks up every change above.
    await this.router.invalidate(record.id);

    const liveAfter = this.store.get(record.id) ?? record;
    const renameNote = await this.maybeRenameThreadForSlug(channel, liveAfter, preset);
    if (renameNote) notes.push(renameNote);

    const body =
      changes.length > 0
        ? changes.map((c) => `• ${c}`).join("\n")
        : "_(no overrides — all fields use defaults)_";
    return notes.length > 0 ? `${body}\n${notes.join("\n")}` : body;
  }

  private async cmdPresetShow(i: ChatInputCommandInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.store.getPresetByNameScoped(name, this.projectScopeId(i) ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle(`🎛️ Preset: ${preset.name}`)
      .setColor(PRESET_COLOR)
      .setDescription(preset.description || "*(no description)*")
      .addFields(
        { name: "🗂️ Scope", value: preset.projectRef ? `<#${preset.projectRef}>` : "🌐 Global", inline: true },
        { name: "🤖 Agent", value: preset.agentId ? `\`${preset.agentId}\`` : "*(default)*", inline: true },
        { name: "🧠 Model", value: preset.model ? `\`${preset.model}\`` : "*(default)*", inline: true },
        { name: "⚡ Effort", value: preset.effort ?? "*(default)*", inline: true },
        { name: "📂 Repo", value: preset.repoPath ? `\`${this.repoDisplay(preset.repoPath)}\`` : "*(default)*", inline: true },
        { name: "🔤 Slug", value: preset.threadSlug ? `\`${preset.threadSlug}\`` : "*(none)*", inline: true },
        { name: "🔒 Permission", value: preset.permission ?? "*(default)*", inline: true },
        { name: "🃏 Status card", value: preset.statusCardStyle ?? "*(default)*", inline: true },
        { name: "🔧 Tools allow", value: preset.toolsAllow?.join(", ") || "*(all)*" },
        { name: "🔧 Tools exclude", value: preset.toolsExclude?.join(", ") || "*(none)*" },
        {
          name: "📋 Instructions",
          value: preset.instructions
            ? "```\n" + preset.instructions.slice(0, 1000) + "\n```"
            : "*(none)*",
        }
      )
      .setFooter({
        text: `ID: ${preset.id} · Created by ${preset.createdBy} · ${preset.createdUtc}`,
      });
    await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  private async cmdPresetDelete(i: ChatInputCommandInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.store.getPresetByNameScoped(name, this.projectScopeId(i) ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    this.store.deletePreset(preset.id);
    await i.reply({
      content: `🗑️ Deleted preset **${preset.name}** (\`${preset.id}\`).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- helpers ---

  private channelRefFromInteraction(
    i: ChatInputCommandInteraction | MessageComponentInteraction
  ): ChannelRef | undefined {
    if (!i.channelId) return undefined;
    const ch = i.channel;
    const parentId =
      ch && "parentId" in ch && typeof ch.parentId === "string"
        ? ch.parentId
        : undefined;
    return {
      platform: PLATFORM,
      id: i.channelId,
      ...(parentId ? { parentId } : {}),
    };
  }

  private recordFromInteraction(
    i: ChatInputCommandInteraction
  ): ReturnType<SessionRouter["ensureSessionRecord"]> | undefined {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) return undefined;
    return this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
  }

  private persistConfig(
    record: ReturnType<SessionRouter["ensureSessionRecord"]>,
    cfg: ReturnType<SessionStore["readConfig"]>
  ): void {
    // acp_session_id is assigned out-of-band (getOrStartRuntime / compaction),
    // so the caller's in-memory record can lag the DB. A config write must NEVER
    // clobber the live session binding — take the authoritative id from the DB
    // when present (defense-in-depth on top of keeping the record in sync).
    const live = this.store.get(record.id)?.acpSessionId;
    this.store.upsert({
      ...record,
      ...(live ? { acpSessionId: live } : {}),
      configJson: this.store.writeConfig(cfg),
      updatedUtc: new Date().toISOString(),
    });
  }

  private repoDisplay(repoPath: string | null): string {
    if (!repoPath) return "(unset)";
    const root = path.resolve(this.config.REPOS_ROOT);
    const abs = path.resolve(repoPath);
    
    let displayName = abs;
    if (abs === root) {
      displayName = "/";
    } else if (abs.startsWith(root + path.sep)) {
      displayName = abs.slice(root.length + 1);
    }

    if (displayName !== "/" && displayName !== "(unset)" && displayName !== abs) {
      const rootFolder = displayName.split(path.sep)[0] ?? "";
      const emoji = this.config.REPO_EMOJIS.get(rootFolder) || this.config.REPO_EMOJIS.get(displayName);
      if (emoji) {
        return `${emoji} ${displayName}`;
      }
    }

    return displayName;
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseCsv(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function usageBar(pct: number): string {
  const filled = Math.min(20, Math.round(pct / 5));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function usageLine(pct: number | null, label: string): string {
  const bar = pct !== null ? usageBar(pct) : "░░░░░░░░░░░░░░░░░░░░";
  const pctStr = pct !== null ? `${Math.round(pct)}%`.padStart(4) : "  — ";
  return `\`${bar}\`  ${pctStr}  ${label}`;
}

/** Hardcoded context windows for the models we use as compaction summarizers.
 *  Hardcoded rather than discovered because the call sites need the window
 *  BEFORE spawning the temp runtime that would learn it from usage_update. */
const COMPACTION_MODEL_WINDOWS: Record<string, number> = {
  default: 1_000_000, // resolves to latest Opus @ 1M on this account
  "opus[1m]": 1_000_000,
  "gpt-5.5": 400_000,
  "Gemini 3.1 Pro (High)": 1_000_000,
  "Claude Opus 4.6 (Thinking)": 250_000,
  "glm-5.2": 1_000_000,
  "qwen3-coder:480b-cloud": 256_000,
  "glm-5.2:cloud": 976_000,
};

function compactionWindowFor(modelId: string): number {
  return COMPACTION_MODEL_WINDOWS[modelId] ?? 200_000;
}

/** Trim a sanitized transcript so that `template + transcript` fits within
 *  ~80% of the summarizer model's window (leaving headroom for the response).
 *  Drops middle content with a marker; keeps 30% head + 60% tail of the
 *  budget. ~4 chars/token is conservative — real tokenizers pack denser. */
function fitTranscriptToWindow(
  transcript: string,
  templateOverhead: number,
  modelWindowTokens: number
): string {
  const maxChars = Math.floor(modelWindowTokens * 4 * 0.8);
  const targetLen = Math.max(0, maxChars - templateOverhead);
  if (transcript.length <= targetLen) return transcript;
  const keepHead = Math.floor(targetLen * 0.3);
  const keepTail = Math.floor(targetLen * 0.6);
  return (
    transcript.substring(0, keepHead) +
    "\n\n... [Transcript truncated to fit context window] ...\n\n" +
    transcript.substring(transcript.length - keepTail)
  );
}

function formatAgyUsage(d: import("@seam/adapters").AgyUsage): string {
  const lines: string[] = [];
  const who = [d.name, d.email].filter(Boolean).join(" · ");
  lines.push(`**Antigravity usage**${who ? ` — ${who}` : ""}`);
  const fmt = (n?: number): string =>
    typeof n === "number" ? n.toLocaleString("en-US") : "—";
  if (d.monthlyPromptCredits !== undefined || d.availablePromptCredits !== undefined) {
    const avail = d.availablePromptCredits ?? 0;
    const total = d.monthlyPromptCredits ?? 0;
    const pct = total > 0 ? ((total - avail) / total) * 100 : 0;
    lines.push(usageLine(pct, `Prompt credits — ${fmt(avail)} / ${fmt(total)} remaining`));
  }
  if (d.monthlyFlowCredits !== undefined || d.availableFlowCredits !== undefined) {
    const avail = d.availableFlowCredits ?? 0;
    const total = d.monthlyFlowCredits ?? 0;
    const pct = total > 0 ? ((total - avail) / total) * 100 : 0;
    lines.push(usageLine(pct, `Flow credits — ${fmt(avail)} / ${fmt(total)} remaining`));
  }
  const modelsWithQuota = d.models.filter(
    (m) => typeof m.remainingFraction === "number" || m.resetTime,
  );
  if (modelsWithQuota.length > 0) {
    lines.push("", "**Per-model quotas**");
    for (const m of modelsWithQuota) {
      if (typeof m.remainingFraction !== "number") continue;
      const pct = (1 - m.remainingFraction) * 100;
      const reset = m.resetTime ? ` · resets ${formatResetTime(m.resetTime)}` : "";
      lines.push(usageLine(pct, `${m.label}${reset}`));
    }
  }
  return lines.join("\n");
}

function formatCopilotUsage(
  d: import("@seam/adapters").CopilotUsageData
): string {
  const lines: string[] = [];
  const who = [d.login, d.org ? `(${d.org})` : null].filter(Boolean).join(" ");
  lines.push(`**GitHub Copilot usage**${who ? ` — ${who}` : ""}`);
  if (d.plan) lines.push(`Plan: \`${d.plan}\``);
  const fmtQuota = (
    label: string,
    q: import("@seam/adapters").CopilotQuotaSnapshot | null
  ): string | null => {
    if (!q) return null;
    if (q.unlimited) return `${label}: unlimited`;
    const used = q.entitlement - q.remaining;
    const pct = q.entitlement > 0 ? (used / q.entitlement) * 100 : 0;
    const over = q.overageCount > 0 ? ` (+${q.overageCount} overage)` : "";
    return usageLine(pct, `${label} — ${used} / ${q.entitlement}${over}`);
  };
  const quotas = [
    fmtQuota("Premium interactions", d.premiumInteractions),
    fmtQuota("Chat", d.chat),
    fmtQuota("Completions", d.completions),
  ].filter((s): s is string => s !== null);
  if (quotas.length > 0) {
    lines.push("", "**Quotas**", ...quotas);
    if (d.quotaResetAt) lines.push(`Resets ${formatResetTime(d.quotaResetAt)}`);
  }
  return lines.join("\n");
}

function formatGrokUsage(
  d: import("@seam/adapters").GrokUsageData
): string {
  const lines: string[] = [];
  lines.push(`**Grok usage**${d.subscriptionTier ? ` — ${d.subscriptionTier}` : ""}`);
  const period = d.periodType ? d.periodType : "period";
  const reset = d.periodEnd ? ` · resets ${formatResetTime(d.periodEnd)}` : "";
  if (d.creditUsagePercent !== null) {
    lines.push(
      "",
      `**${period.charAt(0).toUpperCase() + period.slice(1)} allowance**`,
      usageLine(d.creditUsagePercent, `used${reset}`)
    );
  } else {
    lines.push("No billing data available.");
  }
  return lines.join("\n");
}

function formatClaudeUsage(
  d: import("@seam/adapters").ClaudeUsageData
): string {
  const lines: string[] = [];
  lines.push(`**Claude Code usage**${d.login ? ` — ${d.login}` : ""}`);
  if (d.subscriptionType) {
    const tier = d.rateLimitTier ? ` (${d.rateLimitTier})` : "";
    lines.push(`Subscription: \`${d.subscriptionType}${tier}\``);
  }
  const fmtBucket = (
    label: string,
    b: import("@seam/adapters").ClaudeUsageBucket | null
  ): string | null => {
    if (!b) return null;
    const reset = b.resetsAt ? ` · resets ${formatResetTime(b.resetsAt)}` : "";
    return usageLine(b.utilization, `${label}${reset}`);
  };
  const buckets = [
    fmtBucket("Current 5h session", d.fiveHour),
    fmtBucket("Current week (all models)", d.sevenDay),
    fmtBucket("Current week (Sonnet)", d.sevenDaySonnet),
    fmtBucket("Current week (Opus)", d.sevenDayOpus),
  ].filter((s): s is string => s !== null);
  if (buckets.length > 0) {
    lines.push("", "**Rate-limit utilization**", ...buckets);
  }
  if (d.extraUsage && d.extraUsage.enabled) {
    const dollars = (n: number): string => `$${(n / 100).toFixed(2)}`;
    const pct = d.extraUsage.utilization;
    lines.push(
      "",
      "**Usage credits**",
      usageLine(d.extraUsage.utilization, `${dollars(d.extraUsage.used)} / ${dollars(d.extraUsage.limit)}`),
    );
  }
  return lines.join("\n");
}

function formatResetTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const secs = Math.round((d.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "now";
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86400)}d`;
}

// Re-export for convenience.
export type { EmbedBuilder };

