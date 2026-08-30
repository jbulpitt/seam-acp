import type { Logger } from "../../lib/logger.js";
import type { SessionStore } from "../../core/session-store.js";
import {
  VoiceConsoleManager,
} from "../../core/voice-console/manager.js";
import {
  newVoiceConsoleBindingId,
  newVoiceConsoleId,
  type ThreadVoiceBinding,
  type VoiceConsoleRuntimeHost,
  type VoiceConsoleSession,
} from "../../core/voice-console/types.js";
import type {
  VoiceConsoleCaptureCommit,
  VoiceConsoleCaptureDrop,
  VoiceConsoleCapturePersistencePort,
  VoiceConsoleCaptureSnapshotDraft,
} from "../../core/voice-console/capture-router.js";
import { VoiceConsoleSpeechScheduler } from "../../core/voice-console/speech-scheduler.js";
import type {
  VoiceConsoleSpeechProfile,
  VoiceConsoleSpeechSourceRef,
} from "../../core/voice-console/speech-types.js";
import {
  GEMINI_TTS_VOICES,
  isTtsPace,
  isTtsStyle,
  streamSpeechWithGemini,
  type TtsPace,
  type TtsStyle,
} from "../../core/audio/gemini-tts.js";
import type { MessageRef } from "../chat-adapter.js";
import type {
  VoiceConsoleOrchestratorPort,
  VoiceConsoleVisibleTurnHandle,
} from "./orchestrator.js";
import type {
  DiscordAdapter,
  DiscordVoiceConsoleTransport,
  VoiceConsoleStartInspection,
} from "./adapter.js";
import {
  inertVoiceConsoleAlias,
  parseVoiceConsoleAlias,
} from "./voice-console-components.js";
import {
  constrainVoiceConsolePanel,
  renderVoiceConsolePanel,
  renderVoiceConsoleStatusPages,
  voiceConsolePermissionError,
  type VoiceConsoleBindingPresentation,
  type VoiceConsoleDiagnosticState,
  type VoiceConsolePanelSpec,
  type VoiceConsolePanelState,
  type VoiceConsoleSpeakerLanePresentation,
} from "./voice-console-panel.js";

const OWNER_DISCONNECT_GRACE_MS = 10_000;

type PendingStart = {
  inspection: VoiceConsoleStartInspection;
  card: MessageRef;
};

type SourceState = {
  ref: VoiceConsoleSpeechSourceRef;
  lastEventOrdinal: number;
};

type ConsoleRuntime = {
  consoleId: string;
  transport: DiscordVoiceConsoleTransport;
  scheduler: VoiceConsoleSpeechScheduler;
  sources: Map<string, SourceState>;
  startedAt: number;
  forwardedBytes: number;
  unauthorizedListenerCount: number;
  cardQueue: Promise<void>;
  cardTimer?: ReturnType<typeof setTimeout>;
  ownerGrace?: ReturnType<typeof setTimeout>;
  stopOwnerWatch?: () => void;
};

export interface StartVoiceConsoleRequest {
  guildId: string;
  channelRef: string;
  parentRef: string | null;
  ownerUserId: string;
  ownerName: string;
  alias: string;
  ttsVoice: string;
  ttsPace: TtsPace;
  ttsStyle: TtsStyle;
}

export interface AddVoiceConsoleBindingRequest {
  consoleId: string;
  channelRef: string;
  parentRef: string | null;
  alias: string;
  claim: boolean;
  ttsVoice: string;
  ttsPace: TtsPace;
  ttsStyle: TtsStyle;
  interactionId?: string;
}

/**
 * Serialized Package E integration boundary. Persistence mutations remain in
 * Package A, capture policy in B, scheduling in C, and presentation in D.
 */
export class VoiceConsoleController
  implements VoiceConsoleRuntimeHost, VoiceConsoleOrchestratorPort {
  private readonly store: SessionStore;
  private readonly adapter: DiscordAdapter;
  private readonly logger: Logger;
  private readonly apiKey: () => string;
  private readonly ttsModel: () => string;
  private readonly isAllowedUser: (userId: string) => boolean;
  private readonly isBindingBusy: (channelRef: string) => boolean;
  private readonly cardRetryDelaysMs: readonly number[];
  private readonly runtimes = new Map<string, ConsoleRuntime>();
  private readonly pendingStarts = new Map<string, PendingStart>();
  private readonly cardFailures = new Set<string>();
  private manager?: VoiceConsoleManager;

  constructor(opts: {
    store: SessionStore;
    adapter: DiscordAdapter;
    logger: Logger;
    apiKey: () => string;
    ttsModel: () => string;
    isAllowedUser: (userId: string) => boolean;
    isBindingBusy: (channelRef: string) => boolean;
    cardRetryDelaysMs?: readonly number[];
  }) {
    this.store = opts.store;
    this.adapter = opts.adapter;
    this.logger = opts.logger.child({ comp: "voice-console-controller" });
    this.apiKey = opts.apiKey;
    this.ttsModel = opts.ttsModel;
    this.isAllowedUser = opts.isAllowedUser;
    this.isBindingBusy = opts.isBindingBusy;
    this.cardRetryDelaysMs = opts.cardRetryDelaysMs ?? [0, 250, 750];
  }

  setManager(manager: VoiceConsoleManager): void {
    this.manager = manager;
  }

  async start(request: StartVoiceConsoleRequest) {
    const manager = this.requireManager();
    const parsedAlias = parseVoiceConsoleAlias(request.alias);
    if (!parsedAlias.ok) return { ok: false as const, error: parsedAlias.error };
    const inspection = await this.adapter.inspectVoiceConsoleStart(
      request.ownerUserId,
      request.guildId
    );
    if (!inspection.ok) return { ok: false as const, error: inspection.reason };
    if (!inspection.visible) {
      return { ok: false as const, error: "Voice Console requires a visible voice channel." };
    }
    if (inspection.missingPermissions.length > 0) {
      return {
        ok: false as const,
        error: voiceConsolePermissionError({
          voiceChannelId: inspection.voiceChannelId,
          missing: inspection.missingPermissions,
        }).message,
      };
    }
    if (!inspection.selfMuted) {
      return { ok: false as const, error: "Self-mute before starting Voice Console." };
    }
    const occupied = this.store.getActiveVoiceConsoleForGuild(request.guildId);
    if (occupied) {
      return {
        ok: false as const,
        error: occupied.ownerUserId === request.ownerUserId
          ? `Voice Console ${occupied.id} is already active; use /seam voice add.`
          : `Voice Console ${occupied.id} already owns this guild voice lease.`,
      };
    }

    const now = new Date().toISOString();
    const consoleId = newVoiceConsoleId();
    const bindingId = newVoiceConsoleBindingId();
    const provisionalConsole: VoiceConsoleSession = {
      id: consoleId,
      platform: "discord",
      guildId: request.guildId,
      voiceChannelId: inspection.voiceChannelId,
      ownerUserId: request.ownerUserId,
      ownerName: request.ownerName,
      status: "starting",
      cardChannelId: inspection.voiceChannelId,
      cardMessageId: null,
      cardPage: 0,
      revision: 1,
      fanoutArmed: false,
      forwardedAudioBytes: 0,
      forwardedAudioMs: 0,
      utteranceCount: 0,
      liveFinalCount: 0,
      unaryFallbackCount: 0,
      droppedCount: 0,
      sttFailureCount: 0,
      createdUtc: now,
      updatedUtc: now,
      endedUtc: null,
      endReason: null,
    };
    const binding = makeBinding({
      id: bindingId,
      console: provisionalConsole,
      channelRef: request.channelRef,
      parentRef: request.parentRef,
      alias: parsedAlias.alias,
      voice: request.ttsVoice,
      pace: request.ttsPace,
      style: request.ttsStyle,
      now,
    });

    // The canonical card is verified and posted before the durable row, lease,
    // or Discord voice connection exists.
    const card = await this.adapter.sendVoiceConsolePanel(
      inspection.voiceChannelId,
      renderVoiceConsolePanel(this.panelState(provisionalConsole, [binding], inspection))
    );
    provisionalConsole.cardMessageId = card.id;
    this.pendingStarts.set(consoleId, { inspection, card });
    const result = await manager.start({
      console: provisionalConsole,
      binding,
      selectBinding: true,
    });
    this.pendingStarts.delete(consoleId);
    if (!result.ok) {
      await this.adapter.editVoiceConsolePanel(card, terminalPanel(provisionalConsole, binding, result.error))
        .catch(() => undefined);
      return result;
    }
    await this.ensureBindingNotice(result.console, result.binding).catch((err) =>
      this.logger.warn(
        { err, consoleId, bindingId: result.binding.id },
        "voice console binding notice post failed"
      )
    );
    await this.refreshCard(consoleId, true);
    return {
      ok: true as const,
      console: this.store.getVoiceConsole(consoleId) ?? result.console,
      binding: this.store.getVoiceConsoleBinding(bindingId) ?? result.binding,
    };
  }

  async addBindingCommand(request: AddVoiceConsoleBindingRequest) {
    const manager = this.requireManager();
    const parsedAlias = parseVoiceConsoleAlias(request.alias);
    if (!parsedAlias.ok) {
      return { ok: false as const, reason: "invalid-targets" as const, error: parsedAlias.error };
    }
    const console = this.store.getVoiceConsole(request.consoleId);
    if (!console) return { ok: false as const, reason: "not-found" as const, error: "Voice Console does not exist." };
    const bindings = this.store.listVoiceConsoleBindings(console.id);
    const profileFrom = bindings[0];
    const usedVoices = new Set(bindings.map((binding) => binding.ttsVoice));
    const unusedVoice = GEMINI_TTS_VOICES.find((voice) => !usedVoices.has(voice.name))?.name;
    const now = new Date().toISOString();
    const binding = makeBinding({
      id: newVoiceConsoleBindingId(),
      console,
      channelRef: request.channelRef,
      parentRef: request.parentRef,
      alias: parsedAlias.alias,
      voice: !usedVoices.has(request.ttsVoice)
        ? request.ttsVoice
        : unusedVoice ?? request.ttsVoice ?? profileFrom?.ttsVoice ?? "Kore",
      pace: request.ttsPace,
      style: request.ttsStyle,
      now,
    });
    const result = await manager.addBinding({
      binding,
      claim: request.claim,
      expectedRevision: console.revision,
      ...(request.interactionId ? { interactionId: request.interactionId } : {}),
    });
    if (result.ok) {
      const active = this.store.getVoiceConsole(console.id);
      const added = this.store.getVoiceConsoleBinding(binding.id);
      if (active && added) {
        await this.ensureBindingNotice(active, added).catch((err) =>
          this.logger.warn(
            { err, consoleId: console.id, bindingId: binding.id },
            "voice console binding notice post failed"
          )
        );
      }
    }
    await this.refreshCard(console.id, true);
    return result;
  }

  async startConsole(
    console: VoiceConsoleSession,
    bindings: readonly ThreadVoiceBinding[]
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const pending = this.pendingStarts.get(console.id);
    if (!pending) return { ok: false, reason: "Voice Console startup preflight expired." };
    return this.installRuntime(console, bindings, pending.inspection);
  }

  async reconcileConsole(
    console: VoiceConsoleSession,
    bindings: readonly ThreadVoiceBinding[]
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const inspected = await this.adapter.inspectVoiceConsoleChannel(console.voiceChannelId);
    if (!inspected.ok) return { ok: false, reason: inspected.reason };
    if (inspected.guildId !== console.guildId) {
      return { ok: false, reason: "Voice Console voice channel changed guild." };
    }
    if (inspected.missingPermissions.length > 0) {
      return {
        ok: false,
        reason: `Voice Console VC-chat permissions missing: ${inspected.missingPermissions.join(", ")}.`,
      };
    }
    let cardMessageId = console.cardMessageId;
    if (!cardMessageId || !(await this.adapter.voiceConsoleMessageExists(console.voiceChannelId, cardMessageId))) {
      const sent = await this.adapter.sendVoiceConsolePanel(
        console.voiceChannelId,
        renderVoiceConsolePanel(this.panelState(console, bindings, inspected))
      );
      const updated = this.store.updateVoiceConsoleCard(console.id, {
        expectedRevision: console.revision,
        cardMessageId: sent.id,
      });
      if (!updated.ok) {
        await this.adapter.editVoiceConsolePanel(
          sent,
          disabledPanel(
            renderVoiceConsolePanel(this.panelState(console, bindings, inspected)),
            "Recovery failed; this card is not authoritative."
          )
        ).catch(() => undefined);
        return { ok: false, reason: updated.error };
      }
      cardMessageId = sent.id;
      console = updated.value.console;
    }
    for (const binding of bindings) {
      await this.ensureBindingNotice(console, binding)
        .catch((err) => this.logger.warn(
          { err, bindingId: binding.id },
          "voice console binding notice recovery failed"
        ));
      console = this.store.getVoiceConsole(console.id) ?? console;
    }
    const installed = await this.installRuntime(console, bindings, {
      ok: true,
      guildId: inspected.guildId,
      voiceChannelId: console.voiceChannelId,
      channelName: null,
      selfMuted: true,
      visible: true,
      missingPermissions: [],
      initialSpeakers: inspected.initialSpeakers,
    });
    if (installed.ok) await this.refreshCard(console.id, true);
    return installed;
  }

  async addBinding(console: VoiceConsoleSession, binding: ThreadVoiceBinding) {
    const runtime = this.runtimes.get(console.id);
    if (!runtime) return { ok: false as const, reason: "Voice Console runtime is not active." };
    try {
      runtime.scheduler.registerBinding({
        bindingId: binding.id,
        profile: speechProfile(binding),
        outputEnabled: binding.outputEnabled,
        generation: binding.outputGeneration,
      });
      await this.refreshCard(console.id, true);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, reason: errorMessage(err) };
    }
  }

  async stopBinding(bindingId: string): Promise<void> {
    const binding = this.store.getVoiceConsoleBinding(bindingId);
    if (!binding) return;
    this.runtimes.get(binding.consoleId)?.scheduler.unregisterBinding(bindingId);
    await this.refreshCard(binding.consoleId, true);
  }

  async stopConsole(consoleId: string, _reason: string): Promise<void> {
    const runtime = this.runtimes.get(consoleId);
    if (!runtime) return;
    this.runtimes.delete(consoleId);
    if (runtime.ownerGrace) clearTimeout(runtime.ownerGrace);
    if (runtime.cardTimer) clearTimeout(runtime.cardTimer);
    runtime.stopOwnerWatch?.();
    await runtime.cardQueue.catch(() => undefined);
    await runtime.transport.captureHost.destroy().catch((err) =>
      this.logger.warn({ err, consoleId }, "voice console capture shutdown failed")
    );
    runtime.scheduler.destroy();
    runtime.transport.destroyConnection();
  }

  async waitForBindingSpeechIdle(bindingId: string): Promise<void> {
    const binding = this.store.getVoiceConsoleBinding(bindingId);
    if (!binding) return;
    const runtime = this.runtimes.get(binding.consoleId);
    if (!runtime) return;
    await runtime.scheduler.waitForBindingDrain(bindingId);
  }

  beginVisibleTurn(channelRef: string, turnId: string): VoiceConsoleVisibleTurnHandle | null {
    const binding = this.store.getActiveVoiceConsoleBindingForThread("discord", channelRef);
    if (!binding) return null;
    const runtime = this.runtimes.get(binding.consoleId);
    if (!runtime) return null;
    const ref = { consoleId: binding.consoleId, bindingId: binding.id, turnId };
    try {
      runtime.scheduler.registerSource(ref);
    } catch (err) {
      this.logger.warn({ err, ...ref }, "voice console speech source registration failed");
      return null;
    }
    runtime.sources.set(sourceKey(ref), { ref, lastEventOrdinal: 0 });
    void this.refreshCard(binding.consoleId);
    return ref;
  }

  acceptVisibleAgentText(
    handle: VoiceConsoleVisibleTurnHandle,
    ordinal: number,
    text: string
  ): void {
    const runtime = this.runtimes.get(handle.consoleId);
    const state = runtime?.sources.get(sourceKey(handle));
    if (!runtime || !state || ordinal <= state.lastEventOrdinal) return;
    state.lastEventOrdinal = ordinal;
    runtime.scheduler.feedSourceText(state.ref, text, "prose");
  }

  async finishVisibleTurn(handle: VoiceConsoleVisibleTurnHandle): Promise<void> {
    const runtime = this.runtimes.get(handle.consoleId);
    const state = runtime?.sources.get(sourceKey(handle));
    if (!runtime || !state) return;
    try {
      await runtime.scheduler.finishSource(state.ref);
    } finally {
      runtime.scheduler.forgetSource(state.ref);
      runtime.sources.delete(sourceKey(handle));
      await this.refreshCard(handle.consoleId);
    }
  }

  async cancelVisibleTurn(handle: VoiceConsoleVisibleTurnHandle): Promise<void> {
    const runtime = this.runtimes.get(handle.consoleId);
    const state = runtime?.sources.get(sourceKey(handle));
    if (!runtime || !state) return;
    runtime.scheduler.cancelSource(state.ref);
    await runtime.scheduler.waitForSourceDrain(state.ref);
    runtime.scheduler.forgetSource(state.ref);
    runtime.sources.delete(sourceKey(handle));
    await this.refreshCard(handle.consoleId);
  }

  hasActiveBinding(channelRef: string): boolean {
    return this.store.getActiveVoiceConsoleBindingForThread("discord", channelRef) !== null;
  }

  async markBindingActivitySettled(channelRef: string): Promise<void> {
    const binding = this.store.getActiveVoiceConsoleBindingForThread("discord", channelRef);
    if (binding) await this.manager?.markBindingActivitySettled(binding.id);
  }

  async setInputTargets(
    consoleId: string,
    bindingIds: readonly string[],
    fanoutArmed: boolean,
    expectedRevision: number,
    interactionId?: string
  ) {
    const result = this.store.replaceVoiceConsoleInputTargets(consoleId, {
      bindingIds,
      fanoutArmed,
      expectedRevision,
      ...(interactionId ? { interactionId } : {}),
    });
    if (result.ok && result.value.applied) {
      await this.runtimes.get(consoleId)?.transport.captureHost.setInputEnabled(bindingIds.length > 0);
      await this.refreshCard(consoleId, true);
    }
    return result;
  }

  async setOutputBindings(
    consoleId: string,
    enabledBindingIds: readonly string[],
    expectedRevision: number,
    interactionId?: string
  ) {
    const result = this.store.setVoiceConsoleOutputBindings(consoleId, {
      enabledBindingIds,
      expectedRevision,
      ...(interactionId ? { interactionId } : {}),
    });
    if (result.ok && result.value.applied) {
      const runtime = this.runtimes.get(consoleId);
      for (const binding of result.value.bindings) {
        if (!runtime) continue;
        runtime.scheduler.syncBindingState(binding.id, {
          outputEnabled: binding.outputEnabled,
          generation: binding.outputGeneration,
        });
      }
      await this.refreshCard(consoleId, true);
    }
    return result;
  }

  async updateBindingProfile(bindingId: string, input: {
    expectedRevision: number;
    alias?: string;
    voice?: string;
    pace?: TtsPace;
    style?: TtsStyle;
    interactionId?: string;
  }) {
    const parsedAlias = input.alias !== undefined ? parseVoiceConsoleAlias(input.alias) : null;
    if (parsedAlias && !parsedAlias.ok) {
      return { ok: false as const, reason: "invalid-targets" as const, error: parsedAlias.error };
    }
    const result = this.store.updateVoiceConsoleBinding(bindingId, {
      expectedRevision: input.expectedRevision,
      ...(parsedAlias?.ok ? { alias: parsedAlias.alias } : {}),
      ...(input.voice !== undefined ? { ttsVoice: input.voice } : {}),
      ...(input.pace !== undefined ? { ttsPace: input.pace } : {}),
      ...(input.style !== undefined ? { ttsStyle: input.style } : {}),
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    });
    if (result.ok && result.value.applied) {
      const binding = this.store.getVoiceConsoleBinding(bindingId);
      if (binding) {
        this.runtimes.get(binding.consoleId)?.scheduler.updateBindingProfile(binding.id, speechProfile(binding));
        await this.refreshCard(binding.consoleId, true);
      }
    }
    return result;
  }

  async repostCard(consoleId: string): Promise<MessageRef> {
    const console = this.store.getVoiceConsole(consoleId);
    if (!console) throw new Error("Voice Console does not exist.");
    const inspected = await this.adapter.inspectVoiceConsoleChannel(console.voiceChannelId);
    if (!inspected.ok) throw new Error(inspected.reason);
    if (inspected.missingPermissions.length > 0) {
      throw new Error(voiceConsolePermissionError({
        voiceChannelId: console.voiceChannelId,
        missing: inspected.missingPermissions,
      }).message);
    }
    const oldRef = console.cardMessageId
      ? { channel: { platform: "discord" as const, id: console.voiceChannelId }, id: console.cardMessageId }
      : null;
    const oldPanel = disabledPanel(
      renderVoiceConsolePanel(this.currentPanelState(console)),
      "This card was replaced. Use the newer canonical VC-chat card."
    );
    const sent = await this.adapter.sendVoiceConsolePanel(
      console.voiceChannelId,
      renderVoiceConsolePanel(this.currentPanelState(console))
    );
    const updated = this.store.updateVoiceConsoleCard(console.id, {
      expectedRevision: console.revision,
      cardMessageId: sent.id,
    });
    if (!updated.ok) {
      await this.adapter.editVoiceConsolePanel(
        sent,
        disabledPanel(oldPanel, "Repost failed; this card is not authoritative.")
      ).catch(() => undefined);
      throw new Error(updated.error);
    }
    if (oldRef && oldRef.id !== sent.id) {
      await this.adapter.editVoiceConsolePanel(oldRef, oldPanel).catch((err) =>
        this.logger.warn({ err, consoleId, oldMessageId: oldRef.id }, "old Voice Console card terminalization failed")
      );
    }
    await this.refreshCard(console.id, true);
    return sent;
  }

  statusPages(consoleId: string): VoiceConsolePanelSpec[] {
    const console = this.store.getVoiceConsole(consoleId);
    if (!console) throw new Error("Voice Console does not exist.");
    return renderVoiceConsoleStatusPages(this.diagnosticState(console)).map((panel) =>
      constrainVoiceConsolePanel({
        ...panel,
        fields: [
          ...panel.fields.slice(0, 4),
          {
            name: "STT outcomes",
            value:
              `${console.utteranceCount} utterance${console.utteranceCount === 1 ? "" : "s"} · ` +
              `${console.liveFinalCount} live · ${console.unaryFallbackCount} fallback · ` +
              `${console.droppedCount} dropped · ${console.sttFailureCount} failed`,
          },
          ...panel.fields.slice(4),
        ],
      })
    );
  }

  async refreshCard(consoleId: string, immediate = false): Promise<void> {
    const runtime = this.runtimes.get(consoleId);
    const console = this.store.getVoiceConsole(consoleId);
    if (!console?.cardMessageId) return;
    const ref: MessageRef = {
      channel: { platform: "discord", id: console.voiceChannelId },
      id: console.cardMessageId,
    };
    if (runtime && !immediate) {
      if (runtime.cardTimer) return;
      runtime.cardTimer = setTimeout(() => {
        runtime.cardTimer = undefined;
        void this.refreshCard(consoleId, true);
      }, 1_000);
      return;
    }
    if (runtime?.cardTimer) {
      clearTimeout(runtime.cardTimer);
      runtime.cardTimer = undefined;
    }
    const render = async (): Promise<void> => {
      const fresh = this.store.getVoiceConsole(consoleId);
      if (!fresh) return;
      const inspected = await this.adapter.inspectVoiceConsoleChannel(fresh.voiceChannelId);
      if (!inspected.ok) throw new Error(inspected.reason);
      if (inspected.missingPermissions.length > 0) {
        throw new Error(`VC-chat permissions revoked: ${inspected.missingPermissions.join(", ")}`);
      }
      if (!(await this.canonicalCardExistsWithRetry(fresh.voiceChannelId, ref.id))) {
        throw new Error("canonical VC-chat card was deleted");
      }
      if (runtime) {
        runtime.unauthorizedListenerCount = inspected.initialSpeakers.filter(
          (speaker) => !this.isAllowedUser(speaker.userId)
        ).length;
      }
      await this.editCanonicalCardWithRetry(
        ref,
        renderVoiceConsolePanel(this.currentPanelState(fresh))
      );
    };
    if (!runtime) {
      await render();
      return;
    }
    const run = runtime.cardQueue.then(render);
    runtime.cardQueue = run.catch((err) => {
      this.logger.warn({ err, consoleId }, "voice console canonical card edit failed");
      void this.failClosedCard(consoleId, errorMessage(err));
    });
    if (immediate) await run;
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stopConsole(id, "shutdown")));
  }

  async cancelBindingSpeech(channelRef: string): Promise<void> {
    const binding = this.store.getActiveVoiceConsoleBindingForThread("discord", channelRef);
    if (!binding) return;
    const runtime = this.runtimes.get(binding.consoleId);
    if (!runtime) return;
    runtime.scheduler.invalidateBindingSpeech(binding.id);
    await runtime.scheduler.waitForBindingDrain(binding.id);
    await this.refreshCard(binding.consoleId);
  }

  async stopAllForGlobalCancel(reason: string): Promise<void> {
    const manager = this.requireManager();
    for (const console of this.store.listActiveVoiceConsoles()) {
      await manager.stopConsole(console.id, {
        expectedRevision: console.revision,
        reason,
      });
      await this.refreshCard(console.id, true).catch(() => undefined);
    }
  }

  private async installRuntime(
    console: VoiceConsoleSession,
    bindings: readonly ThreadVoiceBinding[],
    inspection: VoiceConsoleStartInspection
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.runtimes.has(console.id)) return { ok: true };
    let scheduler: VoiceConsoleSpeechScheduler | undefined;
    let forwardedBytes = console.forwardedAudioBytes;
    try {
      const persistence = this.capturePersistence(console.id);
      const transport = await this.adapter.createVoiceConsoleTransport({
        consoleId: console.id,
        guildId: console.guildId,
        voiceChannelId: console.voiceChannelId,
        initialSpeakers: inspection.initialSpeakers,
        persistence,
        isAllowedUser: this.isAllowedUser,
        inputActive: this.store.listVoiceConsoleInputTargets(console.id).length > 0,
        callbacks: {
          onCaptureFinalizing: (capture) => {
            this.store.markVoiceConsoleCaptureFinalizing(capture.captureId);
            void this.refreshCard(console.id);
          },
          onSettled: () => void this.refreshCard(console.id),
          onInterim: () => void this.refreshCard(console.id),
          onForwardedBytes: (event) => {
            forwardedBytes += event.bytes;
            const active = this.runtimes.get(console.id);
            if (active) active.forwardedBytes = forwardedBytes;
            void this.refreshCard(console.id);
          },
          onError: (err, context) =>
            this.logger.warn({ err, context, consoleId: console.id }, "voice console capture callback failed"),
          onConnectionLost: (reason) => this.onConnectionLost(console.id, reason),
        },
      });
      scheduler = new VoiceConsoleSpeechScheduler({
        consoleId: console.id,
        playback: transport.playback,
        synthesize: async ({ chunk, profile, signal, onAudioDelta }) => streamSpeechWithGemini({
          apiKey: this.apiKey(),
          model: this.ttsModel(),
          text: chunk.text,
          voice: profile.voice,
          pace: profile.pace,
          style: profile.style,
          signal,
          onAudioDelta,
        }),
        onFailure: (failure) => {
          this.logger.warn({ consoleId: console.id, failure }, "voice console speech source failed");
          const failedBinding = this.store.getVoiceConsoleBinding(failure.source.bindingId);
          if (failedBinding) {
            void this.adapter.sendMessage({
              platform: "discord",
              id: failedBinding.channelRef,
              ...(failedBinding.parentRef ? { parentId: failedBinding.parentRef } : {}),
            }, "⚠️ VC speech failed for this turn; the text response is still available.")
              .catch((err) => this.logger.warn(
                { err, consoleId: console.id, bindingId: failedBinding.id },
                "voice console speech warning post failed"
              ));
          }
          void this.refreshCard(console.id);
        },
        onStateChange: () => void this.refreshCard(console.id),
      });
      for (const binding of bindings) {
        scheduler.registerBinding({
          bindingId: binding.id,
          profile: speechProfile(binding),
          outputEnabled: binding.outputEnabled,
          generation: binding.outputGeneration,
        });
      }
      const runtime: ConsoleRuntime = {
        consoleId: console.id,
        transport,
        scheduler,
        sources: new Map(),
        startedAt: Date.now(),
        forwardedBytes,
        unauthorizedListenerCount: inspection.initialSpeakers.filter(
          (speaker) => !this.isAllowedUser(speaker.userId)
        ).length,
        cardQueue: Promise.resolve(),
      };
      this.runtimes.set(console.id, runtime);
      runtime.stopOwnerWatch = this.adapter.watchVoiceConsoleOwnerPresence?.(
        console.voiceChannelId,
        console.ownerUserId,
        (present) => this.onOwnerPresence(console.id, present)
      );
      return { ok: true };
    } catch (err) {
      scheduler?.destroy();
      return { ok: false, reason: errorMessage(err) };
    }
  }

  private capturePersistence(consoleId: string): VoiceConsoleCapturePersistencePort {
    return {
      snapshotCapture: async (input): Promise<VoiceConsoleCaptureSnapshotDraft | null> => {
        const allocated = this.requireManager().allocateCapture({ consoleId, ...input });
        if (!allocated) return null;
        return {
          consoleId: allocated.consoleId,
          captureId: allocated.captureId,
          fanoutGroupId: allocated.fanoutGroupId,
          consoleRevision: allocated.consoleRevision,
          speakerId: allocated.speakerId,
          speakerName: allocated.speakerName,
          capturedStartedUtc: allocated.capturedStartedUtc,
          targets: allocated.assignments.map(({ bindingId, sequence }) => ({ bindingId, sequence })),
        };
      },
      commitCapture: async (input: VoiceConsoleCaptureCommit) => {
        const committed = this.requireManager().commitCapture({
          captureId: input.captureId,
          consoleId: input.snapshot.consoleId,
          speakerId: input.snapshot.speakerId,
          capturedStartedUtc: input.snapshot.capturedStartedUtc,
          targets: input.snapshot.targets,
          speakerName: input.snapshot.speakerName,
          transcript: input.transcript,
          audioMs: input.audioMs,
          forwardedAudioMs: input.forwardedBytes / 32,
          capturedEndedUtc: input.capturedEndedUtc,
          speakerAuthorized: this.isAllowedUser(input.snapshot.speakerId),
          resultSource: input.source,
        });
        if (!committed.duplicate) {
          for (const segment of committed.committed) {
            const binding = this.store.getVoiceConsoleBinding(segment.bindingId);
            if (!binding) continue;
            for (const text of transcriptEchoChunks(segment.authorName, segment.transcript)) {
              await this.adapter.sendMessage(
                { platform: "discord", id: binding.channelRef, ...(binding.parentRef ? { parentId: binding.parentRef } : {}) },
                text
              ).catch((err) => this.logger.warn(
                { err, bindingId: binding.id },
                "voice console transcript echo failed"
              ));
            }
          }
        }
        await this.refreshCard(consoleId);
        return [
          ...committed.committed.map((row) => ({
            bindingId: row.bindingId,
            sequence: row.sequence,
            status: "committed" as const,
            segmentId: row.id,
          })),
          ...committed.dropped.map((row) => ({
            bindingId: row.bindingId,
            sequence: row.sequence,
            status: "dropped" as const,
            segmentId: row.id,
          })),
          ...committed.failures.map((failure) => ({
            bindingId: failure.bindingId,
            sequence: input.snapshot.targets.find((target) => target.bindingId === failure.bindingId)?.sequence ?? 0,
            status: "failed" as const,
            error: failure.error,
          })),
        ];
      },
      dropCapture: async (input: VoiceConsoleCaptureDrop) => {
        this.requireManager().dropCapture({
          captureId: input.captureId,
          consoleId: input.snapshot.consoleId,
          speakerId: input.snapshot.speakerId,
          capturedStartedUtc: input.snapshot.capturedStartedUtc,
          targets: input.snapshot.targets,
          reason: input.error ?? input.reason,
          audioMs: input.audioMs,
          forwardedAudioMs: input.forwardedBytes / 32,
          capturedEndedUtc: input.capturedEndedUtc,
          outcome: input.reason === "transcribe_failed" || input.error ? "failed" : "dropped",
          ...(input.source ? { resultSource: input.source } : {}),
        });
        await this.refreshCard(consoleId);
      },
    };
  }

  private panelState(
    console: VoiceConsoleSession,
    bindings: readonly ThreadVoiceBinding[],
    inspection?: Pick<VoiceConsoleStartInspection, "initialSpeakers">
  ): VoiceConsolePanelState {
    const runtime = this.runtimes.get(console.id);
    const targets = new Set(this.store.getVoiceConsole(console.id)
      ? this.store.listVoiceConsoleInputTargets(console.id).map((row) => row.bindingId)
      : bindings.slice(0, 1).map((row) => row.id));
    const lanes = runtime?.transport.captureHost.router.listLanes();
    const initial = inspection?.initialSpeakers ?? [];
    const speakers: VoiceConsoleSpeakerLanePresentation[] = (lanes ?? initial
      .filter((speaker) => this.isAllowedUser(speaker.userId))
      .map((speaker) => ({
        userId: speaker.userId,
        speakerName: speaker.speakerName,
        selfMuted: speaker.selfMuted,
        state: speaker.selfMuted ? "ready" as const : "awaiting_safe_mute" as const,
        transportEpoch: 0,
      }))).map((lane) => ({
        userId: lane.userId,
        displayName: lane.speakerName,
        state: laneState(lane.state),
      }));
    return {
      consoleId: console.id,
      revision: console.revision,
      ownerUserId: console.ownerUserId,
      ownerName: console.ownerName,
      voiceChannelId: console.voiceChannelId,
      cardChannelId: console.cardChannelId,
      lifecycle: console.status,
      runtimeState: runtime ? "running" : console.status,
      connectionState: runtime ? String(runtime.transport.connection.state.status) : "not connected",
      forwardedAudioMs: runtime
        ? Math.max(console.forwardedAudioMs, runtime.forwardedBytes / 32)
        : console.forwardedAudioMs,
      fanoutArmed: console.fanoutArmed,
      selectedBindingIds: [...targets],
      bindings: bindings.map((binding) => this.bindingPresentation(binding, runtime)),
      speakers,
      unauthorizedListenerCount: runtime?.unauthorizedListenerCount ??
        initial.filter((speaker) => !this.isAllowedUser(speaker.userId)).length,
      page: console.cardPage,
      currentSpeaking: currentSpeaking(runtime, bindings),
      lastUpdatedUtc: console.updatedUtc,
    };
  }

  private currentPanelState(console: VoiceConsoleSession): VoiceConsolePanelState {
    return this.panelState(console, this.store.listVoiceConsoleBindings(console.id));
  }

  private diagnosticState(console: VoiceConsoleSession): VoiceConsoleDiagnosticState {
    const panel = this.currentPanelState(console);
    const runtime = this.runtimes.get(console.id);
    const snapshot = runtime?.scheduler.snapshot();
    const current = snapshot?.currentSource
      ? this.store.getVoiceConsoleBinding(snapshot.currentSource.bindingId)
      : null;
    return {
      ...panel,
      uptimeMs: runtime ? Date.now() - runtime.startedAt : 0,
      transmittedAudioBytes: runtime?.forwardedBytes ?? console.forwardedAudioBytes,
      activeLaneCount: runtime?.transport.captureHost.router.activeLaneCount ?? 0,
      schedulerQueueDepth: snapshot?.queueDepth ?? 0,
      schedulerSource: current ? { alias: current.alias, voice: current.ttsVoice } : null,
      leaseHolder: { kind: "thread_voice", sessionId: console.id },
      cardJumpUrl: console.cardMessageId
        ? `https://discord.com/channels/${console.guildId}/${console.voiceChannelId}/${console.cardMessageId}`
        : null,
    };
  }

  private bindingPresentation(
    binding: ThreadVoiceBinding,
    runtime?: ConsoleRuntime
  ): VoiceConsoleBindingPresentation {
    const pending = this.store.getThreadVoicePendingStats(binding.platform, binding.channelRef);
    const speech = runtime?.scheduler.snapshot().bindings.find((row) => row.bindingId === binding.id);
    return {
      bindingId: binding.id,
      alias: binding.alias,
      threadId: binding.channelRef,
      voice: binding.ttsVoice,
      outputEnabled: binding.outputEnabled,
      pace: normalizedPace(binding.ttsPace),
      style: normalizedStyle(binding.ttsStyle),
      acpState: this.isBindingBusy(binding.channelRef) ? "working" : "idle",
      pendingSegments: pending.segmentCount,
      pendingCharacters: pending.characterCount,
      speechState: !binding.outputEnabled
        ? "disabled"
        : speech && (speech.queuedChunks > 0 || speech.activeSources > 0)
          ? snapshotSpeaking(runtime, binding.id) ? "speaking" : "queued"
          : "idle",
    };
  }

  private onOwnerPresence(consoleId: string, present: boolean): void {
    const runtime = this.runtimes.get(consoleId);
    if (!runtime) return;
    if (present) {
      if (runtime.ownerGrace) clearTimeout(runtime.ownerGrace);
      runtime.ownerGrace = undefined;
      return;
    }
    if (runtime.ownerGrace) return;
    runtime.ownerGrace = setTimeout(() => {
      runtime.ownerGrace = undefined;
      const console = this.store.getVoiceConsole(consoleId);
      if (!console || console.status !== "ready") return;
      void this.requireManager().stopConsole(consoleId, {
        expectedRevision: console.revision,
        reason: "owner left voice channel",
      }).then(() => this.refreshCard(consoleId, true));
    }, OWNER_DISCONNECT_GRACE_MS);
  }

  private onConnectionLost(consoleId: string, reason: string): void {
    const console = this.store.getVoiceConsole(consoleId);
    if (!console || (console.status !== "ready" && console.status !== "starting")) return;
    void this.requireManager().stopConsole(consoleId, {
      expectedRevision: console.revision,
      reason,
    }).then(() => this.refreshCard(consoleId, true).catch(() => undefined));
  }

  private async failClosedCard(consoleId: string, reason: string): Promise<void> {
    if (this.cardFailures.has(consoleId)) return;
    const console = this.store.getVoiceConsole(consoleId);
    if (!console || (console.status !== "ready" && console.status !== "starting")) return;
    this.cardFailures.add(consoleId);
    try {
      await this.requireManager().stopConsole(consoleId, {
        expectedRevision: console.revision,
        reason: `canonical VC-chat card unavailable: ${reason}`,
      });
    } finally {
      this.cardFailures.delete(consoleId);
    }
  }

  private async editCanonicalCardWithRetry(
    ref: MessageRef,
    panel: VoiceConsolePanelSpec
  ): Promise<void> {
    let lastError: unknown = new Error("canonical Voice Console card edit failed");
    for (const delayMs of this.cardRetryDelaysMs) {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      try {
        await this.adapter.editVoiceConsolePanel(ref, panel);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async canonicalCardExistsWithRetry(
    voiceChannelId: string,
    messageId: string
  ): Promise<boolean> {
    let lastError: unknown = new Error("canonical Voice Console card lookup failed");
    for (const delayMs of this.cardRetryDelaysMs) {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      try {
        return await this.adapter.voiceConsoleMessageExists(voiceChannelId, messageId);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async ensureBindingNotice(
    console: VoiceConsoleSession,
    binding: ThreadVoiceBinding
  ): Promise<void> {
    if (!console.cardMessageId) throw new Error("Voice Console canonical card is missing.");
    const channel: MessageRef["channel"] = {
      platform: "discord",
      id: binding.channelRef,
      ...(binding.parentRef ? { parentId: binding.parentRef } : {}),
    };
    const cardUrl = `https://discord.com/channels/${console.guildId}/${console.voiceChannelId}/${console.cardMessageId}`;
    const text =
      `🎛️ **Shared Voice Console · ${inertVoiceConsoleAlias(binding.alias)}**\n` +
      `State: ${console.status} · [Open canonical controls](${cardUrl})`;
    if (binding.noticeMessageId) {
      await this.adapter.editMessage({ channel, id: binding.noticeMessageId }, text);
      return;
    }
    const sent = await this.adapter.sendMessage(channel, text);
    const fresh = this.store.getVoiceConsole(console.id);
    if (!fresh) throw new Error("Voice Console disappeared while posting its binding notice.");
    const updated = this.store.updateVoiceConsoleBinding(binding.id, {
      expectedRevision: fresh.revision,
      noticeMessageId: sent.id,
    });
    if (!updated.ok) {
      await this.adapter.editMessage(sent, "🎛️ Voice Console notice unavailable; use `/seam voice console`.")
        .catch(() => undefined);
      throw new Error(updated.error);
    }
  }

  private requireManager(): VoiceConsoleManager {
    if (!this.manager) throw new Error("Voice Console manager is not wired.");
    return this.manager;
  }
}

function disabledPanel(panel: VoiceConsolePanelSpec, footer: string): VoiceConsolePanelSpec {
  return {
    ...panel,
    footer,
    components: panel.components.map((row) => ({
      components: row.components.map((component) => ({ ...component, disabled: true })),
    })),
  };
}

function transcriptEchoChunks(authorName: string, transcript: string): string[] {
  const firstPrefix = `🎙️ **${authorName}:** `;
  const continuationPrefix = "🎙️ *(continued)* ";
  const chunks: string[] = [];
  let remaining = transcript;
  let prefix = firstPrefix;
  while (remaining.length > 0 || chunks.length === 0) {
    const limit = Math.max(1, 1_900 - prefix.length);
    let end = Math.min(limit, remaining.length);
    if (
      end > 0 &&
      end < remaining.length &&
      /[\uD800-\uDBFF]/.test(remaining[end - 1]!) &&
      /[\uDC00-\uDFFF]/.test(remaining[end]!)
    ) {
      end--;
    }
    const body = remaining.slice(0, end);
    chunks.push(`${prefix}${body}`);
    remaining = remaining.slice(end);
    prefix = continuationPrefix;
  }
  return chunks;
}

function makeBinding(input: {
  id: string;
  console: VoiceConsoleSession;
  channelRef: string;
  parentRef: string | null;
  alias: string;
  voice: string;
  pace: TtsPace;
  style: TtsStyle;
  now: string;
}): ThreadVoiceBinding {
  return {
    id: input.id,
    consoleId: input.console.id,
    platform: "discord",
    channelRef: input.channelRef,
    parentRef: input.parentRef,
    guildId: input.console.guildId,
    voiceChannelId: input.console.voiceChannelId,
    ownerUserId: input.console.ownerUserId,
    ownerName: input.console.ownerName,
    status: "adding",
    noticeMessageId: null,
    alias: input.alias,
    aliasNormalized: input.alias.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
    ttsVoice: input.voice,
    ttsPace: input.pace,
    ttsStyle: input.style,
    profileUpdatedUtc: input.now,
    outputEnabled: true,
    outputGeneration: 0,
    createdUtc: input.now,
    updatedUtc: input.now,
    endedUtc: null,
    endReason: null,
  };
}

function speechProfile(binding: ThreadVoiceBinding): VoiceConsoleSpeechProfile {
  return {
    voice: binding.ttsVoice,
    pace: normalizedPace(binding.ttsPace),
    style: normalizedStyle(binding.ttsStyle),
  };
}

function normalizedPace(value: string | null | undefined): TtsPace {
  return value && isTtsPace(value) ? value : "natural";
}

function normalizedStyle(value: string | null | undefined): TtsStyle {
  return value && isTtsStyle(value) ? value : "neutral";
}

function sourceKey(ref: VoiceConsoleSpeechSourceRef): string {
  return `${ref.bindingId}\u0000${ref.turnId}`;
}

function laneState(
  value: "ready" | "awaiting_safe_mute" | "arming" | "capturing" | "finalizing"
): VoiceConsoleSpeakerLanePresentation["state"] {
  if (value === "ready") return "muted-ready";
  if (value === "awaiting_safe_mute") return "awaiting-safe-mute";
  if (value === "arming") return "armed";
  if (value === "capturing") return "capturing";
  return "transcribing";
}

function snapshotSpeaking(runtime: ConsoleRuntime | undefined, bindingId: string): boolean {
  return runtime?.scheduler.snapshot().currentSource?.bindingId === bindingId;
}

function currentSpeaking(
  runtime: ConsoleRuntime | undefined,
  bindings: readonly ThreadVoiceBinding[]
): { alias: string; voice: string } | null {
  const id = runtime?.scheduler.snapshot().currentSource?.bindingId;
  const binding = id ? bindings.find((candidate) => candidate.id === id) : undefined;
  return binding ? { alias: binding.alias, voice: binding.ttsVoice } : null;
}

function terminalPanel(
  console: VoiceConsoleSession,
  binding: ThreadVoiceBinding,
  reason: string
): VoiceConsolePanelSpec {
  return renderVoiceConsolePanel({
    consoleId: console.id,
    revision: console.revision,
    ownerUserId: console.ownerUserId,
    ownerName: console.ownerName,
    voiceChannelId: console.voiceChannelId,
    cardChannelId: console.cardChannelId,
    lifecycle: "failed",
    runtimeState: reason,
    connectionState: "not connected",
    forwardedAudioMs: 0,
    fanoutArmed: false,
    selectedBindingIds: [binding.id],
    bindings: [{
      bindingId: binding.id,
      alias: binding.alias,
      threadId: binding.channelRef,
      voice: binding.ttsVoice,
      outputEnabled: binding.outputEnabled,
      pace: normalizedPace(binding.ttsPace),
      style: normalizedStyle(binding.ttsStyle),
      acpState: "idle",
      pendingSegments: 0,
      pendingCharacters: 0,
      speechState: "idle",
    }],
    speakers: [],
    unauthorizedListenerCount: 0,
    page: 0,
    currentSpeaking: null,
    lastUpdatedUtc: new Date().toISOString(),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
