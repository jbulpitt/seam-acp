import {
  StreamingSpeechSegmenter,
  type SpeechTextKind,
} from "../audio/streaming-speech-segmenter.js";
import { assertVoiceConsoleAuthorityId } from "./types.js";
import {
  voiceConsoleSpeechBindingKeyPrefix,
  voiceConsoleSpeechSourceKey,
} from "./speech-types.js";
import type {
  VoiceConsoleBindingStateConflict,
  VoiceConsoleBindingStateSyncResult,
  VoiceConsoleChunkDisposition,
  VoiceConsolePlaybackStream,
  VoiceConsolePlaybackResult,
  VoiceConsoleSpeechBindingSnapshot,
  VoiceConsoleSpeechChunk,
  VoiceConsoleSpeechFailure,
  VoiceConsoleSpeechPlayback,
  VoiceConsoleSpeechProfile,
  VoiceConsoleSpeechSchedulerSnapshot,
  VoiceConsoleSpeechStateChange,
  VoiceConsoleSpeechStateChangeReason,
  VoiceConsoleSpeechSourceRef,
  VoiceConsoleSpeechStats,
  VoiceConsoleSynthesisRequest,
  VoiceConsoleSynthesisResult,
} from "./speech-types.js";

const DEFAULT_MAX_CHUNKS_PER_SLICE = 2;
const DEFAULT_MAX_AUDIO_MS_PER_SLICE = 25_000;
const MAX_RECENT_FAILURE_ERROR_CHARS = 500;

type BindingState = {
  bindingId: string;
  profile: VoiceConsoleSpeechProfile;
  outputEnabled: boolean;
  generation: number;
  stateConflict: VoiceConsoleBindingStateConflict | null;
  recentFailure: VoiceConsoleSpeechFailure | null;
  stats: VoiceConsoleSpeechStats;
  drainWaiters: Array<(stats: VoiceConsoleSpeechStats) => void>;
};

type SourceState = {
  ref: VoiceConsoleSpeechSourceRef;
  segmenter: StreamingSpeechSegmenter;
  pending: VoiceConsoleSpeechChunk[];
  lastOrdinal: number;
  finished: boolean;
  cancelled: boolean;
  endIndicatorPending: boolean;
  warned: boolean;
  stats: VoiceConsoleSpeechStats;
  drainWaiters: Array<(stats: VoiceConsoleSpeechStats) => void>;
};

type CurrentWork = {
  kind: "speech" | "end-indicator";
  sourceKey: string;
  chunk: VoiceConsoleSpeechChunk;
  controller: AbortController;
  phase: "synthesis" | "playback";
  settled: boolean;
};

type WorkOutcome =
  | { kind: "played"; durationMs: number }
  | { kind: "failed"; phase: "synthesis" | "playback"; error: string; durationMs?: number }
  | { kind: "dropped"; durationMs?: number };

export type VoiceConsoleSpeechSchedulerOptions = {
  consoleId: string;
  synthesize: (request: VoiceConsoleSynthesisRequest) => Promise<VoiceConsoleSynthesisResult>;
  playback: VoiceConsoleSpeechPlayback;
  onFailure?: (failure: VoiceConsoleSpeechFailure) => void;
  /** Advisory, coalesced state delivery for serialized card/status refreshes. */
  onStateChange?: (change: VoiceConsoleSpeechStateChange) => void | Promise<void>;
  maxChunksPerSlice?: number;
  maxAudioMsPerSlice?: number;
};

/**
 * One-console speech scheduler.
 *
 * It owns source segmenters, one logical synthesis slot, and one injected
 * playback path. Output-off resets source segmenters as well as queued work so
 * re-enable can never speak a partial sentence accumulated while disabled.
 */
export class VoiceConsoleSpeechScheduler {
  private readonly consoleId: string;
  private readonly synthesize: VoiceConsoleSpeechSchedulerOptions["synthesize"];
  private readonly playback: VoiceConsoleSpeechPlayback;
  private readonly onFailure: (failure: VoiceConsoleSpeechFailure) => void;
  private readonly onStateChange?: VoiceConsoleSpeechSchedulerOptions["onStateChange"];
  private readonly maxChunksPerSlice: number;
  private readonly maxAudioMsPerSlice: number;
  private readonly bindings = new Map<string, BindingState>();
  private readonly sources = new Map<string, SourceState>();
  private readonly completedSources = new Map<string, VoiceConsoleSpeechStats>();
  private sourceOrder: string[] = [];
  private currentWork: CurrentWork | undefined;
  private sliceSourceKey: string | undefined;
  private sliceChunks = 0;
  private sliceAudioMs = 0;
  private running = false;
  private destroyed = false;
  private stateChangeScheduled = false;
  private stateChangeInFlight = false;
  private pendingStateChangeSnapshot: VoiceConsoleSpeechSchedulerSnapshot | undefined;
  private readonly pendingStateChangeReasons = new Set<VoiceConsoleSpeechStateChangeReason>();

  constructor(opts: VoiceConsoleSpeechSchedulerOptions) {
    if (!opts.consoleId.trim()) throw new Error("Voice Console speech requires a console id");
    this.consoleId = opts.consoleId;
    this.synthesize = opts.synthesize;
    this.playback = opts.playback;
    this.onFailure = opts.onFailure ?? (() => {});
    this.onStateChange = opts.onStateChange;
    this.maxChunksPerSlice = positiveInteger(
      opts.maxChunksPerSlice,
      DEFAULT_MAX_CHUNKS_PER_SLICE
    );
    this.maxAudioMsPerSlice = positiveInteger(
      opts.maxAudioMsPerSlice,
      DEFAULT_MAX_AUDIO_MS_PER_SLICE
    );
  }

  registerBinding(opts: {
    bindingId: string;
    profile: VoiceConsoleSpeechProfile;
    outputEnabled: boolean;
    generation?: number;
  }): void {
    this.assertLive();
    const bindingId = opts.bindingId.trim();
    if (!bindingId) throw new Error("Voice Console speech requires a binding id");
    // #171: composite source keys are `<bindingId><delimiter><turnId>`, so the
    // key space is only unambiguous while binding ids exclude the delimiter.
    // Callers already pass authority ids; enforce it here so the invariant is
    // guaranteed at the boundary rather than assumed from upstream.
    assertVoiceConsoleAuthorityId(bindingId, "Voice Console speech binding id");
    if (this.bindings.has(bindingId)) {
      throw new Error(`Voice Console speech binding already registered: ${bindingId}`);
    }
    const generation = opts.generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("Voice Console speech generation must be a non-negative safe integer");
    }
    this.bindings.set(bindingId, {
      bindingId,
      profile: normalizeProfile(opts.profile),
      outputEnabled: opts.outputEnabled,
      generation,
      stateConflict: null,
      recentFailure: null,
      stats: emptyStats(),
      drainWaiters: [],
    });
    this.queueStateChange("binding-registered");
  }

  /**
   * Permanently remove one binding while keeping the console player and other
   * bindings alive. Existing drain waiters receive final stats before the
   * binding state is discarded.
   */
  unregisterBinding(bindingId: string): boolean {
    const binding = this.bindings.get(bindingId);
    if (!binding) return false;

    binding.outputEnabled = false;
    const removedSourceKeys = new Set<string>();
    const work = this.currentBindingId() === bindingId ? this.currentWork : undefined;
    if (work) {
      work.controller.abort();
      if (!work.settled) {
        this.settle(work, { kind: "dropped" });
        work.settled = true;
      }
      if (this.currentWork === work) this.currentWork = undefined;
    }

    for (const [key, source] of this.sources) {
      if (source.ref.bindingId !== bindingId) continue;
      source.cancelled = true;
      source.finished = true;
      source.segmenter = new StreamingSpeechSegmenter();
      this.dropPending(source);
      this.completeSource(key, source, false);
      this.sources.delete(key);
      removedSourceKeys.add(key);
    }
    this.sourceOrder = this.sourceOrder.filter((key) => !removedSourceKeys.has(key));
    if (this.sliceSourceKey && removedSourceKeys.has(this.sliceSourceKey)) {
      this.sliceSourceKey = undefined;
      this.sliceChunks = 0;
      this.sliceAudioMs = 0;
    }

    const keyPrefix = voiceConsoleSpeechBindingKeyPrefix(bindingId);
    for (const key of this.completedSources.keys()) {
      if (key.startsWith(keyPrefix)) this.completedSources.delete(key);
    }
    this.resolveBindingWaiters(binding);
    this.bindings.delete(bindingId);
    this.kick();
    this.queueStateChange("binding-unregistered");
    return true;
  }

  updateBindingProfile(bindingId: string, profile: VoiceConsoleSpeechProfile): void {
    const binding = this.binding(bindingId);
    const normalized = normalizeProfile(profile);
    if (sameProfile(binding.profile, normalized)) return;
    binding.profile = normalized;
    this.queueStateChange("profile-updated");
  }

  /**
   * Apply Package A's authoritative durable output state without inventing a
   * local generation. A newer generation is an invalidation boundary even when
   * the enabled value is unchanged. Rollback is ignored; an equal-generation
   * conflict fails closed because neither side can safely win.
   */
  syncBindingState(
    bindingId: string,
    state: { outputEnabled: boolean; generation: number }
  ): VoiceConsoleBindingStateSyncResult {
    const binding = this.binding(bindingId);
    validateGeneration(state.generation);
    if (state.generation < binding.generation) return "stale";
    if (state.generation === binding.generation) {
      if (binding.stateConflict) {
        throw bindingStateConflictError(bindingId, binding.stateConflict);
      }
      if (state.outputEnabled !== binding.outputEnabled) {
        const conflict: VoiceConsoleBindingStateConflict = {
          generation: state.generation,
          localOutputEnabled: binding.outputEnabled,
          receivedOutputEnabled: state.outputEnabled,
        };
        binding.stateConflict = conflict;
        binding.outputEnabled = false;
        this.clearBindingFailure(binding);
        this.invalidateBindingWork(bindingId);
        this.queueStateChange("binding-conflict");
        throw bindingStateConflictError(bindingId, conflict);
      }
      return "unchanged";
    }

    const clearedConflict = binding.stateConflict !== null;
    binding.outputEnabled = state.outputEnabled;
    binding.generation = state.generation;
    binding.stateConflict = null;
    this.clearBindingFailure(binding);
    this.invalidateBindingWork(bindingId);
    if (clearedConflict) this.queueStateChange("binding-conflict-cleared");
    this.queueStateChange("binding-synced");
    return "applied";
  }

  registerSource(ref: VoiceConsoleSpeechSourceRef): void {
    this.assertLive();
    this.assertConsole(ref.consoleId);
    // Same #171 invariant, checked before the binding lookup so an ill-formed id
    // reports the actual problem instead of "binding is not registered".
    assertVoiceConsoleAuthorityId(ref.bindingId, "Voice Console speech binding id");
    this.binding(ref.bindingId);
    // Turn ids are intentionally unconstrained beyond non-empty: real ones carry
    // colons (`dispatch:<id>`, `scheduled:<id>:<ts>`). They are the LAST key
    // component, so they cannot make the key ambiguous.
    if (!ref.turnId.trim()) throw new Error("Voice Console speech requires a turn id");
    const key = voiceConsoleSpeechSourceKey(ref);
    if (this.sources.has(key) || this.completedSources.has(key)) {
      throw new Error(`Voice Console speech source already registered: ${ref.turnId}`);
    }
    this.sources.set(key, {
      ref: { ...ref },
      segmenter: new StreamingSpeechSegmenter(),
      pending: [],
      lastOrdinal: 0,
      finished: false,
      cancelled: false,
      endIndicatorPending: false,
      warned: false,
      stats: emptyStats(),
      drainWaiters: [],
    });
    this.sourceOrder.push(key);
    this.clearBindingFailure(this.binding(ref.bindingId));
    this.queueStateChange("source-registered");
  }

  /** Feed visible prose; returns the number of complete chunks accepted. */
  feedSourceText(
    ref: VoiceConsoleSpeechSourceRef,
    text: string,
    kind: SpeechTextKind = "prose"
  ): number {
    const source = this.source(ref);
    if (source.finished || source.cancelled || !text) return 0;
    const binding = this.binding(ref.bindingId);
    if (!binding.outputEnabled) return 0;
    let accepted = 0;
    for (const chunkText of source.segmenter.feed(text, kind)) {
      const chunk = this.nextChunk(source, chunkText, binding.generation);
      if (this.enqueueChunkInternal(source, binding, chunk) === "accepted") accepted += 1;
    }
    return accepted;
  }

  enqueueChunk(chunk: VoiceConsoleSpeechChunk): VoiceConsoleChunkDisposition {
    this.assertConsole(chunk.consoleId);
    const source = this.source(chunk);
    const binding = this.binding(chunk.bindingId);
    this.validateChunkOrder(source, chunk);
    return this.enqueueChunkInternal(source, binding, { ...chunk, text: chunk.text.trim() });
  }

  finishSource(ref: VoiceConsoleSpeechSourceRef): Promise<VoiceConsoleSpeechStats> {
    const source = this.source(ref);
    if (!source.finished && !source.cancelled) {
      const binding = this.binding(ref.bindingId);
      if (binding.outputEnabled) {
        for (const text of source.segmenter.flush()) {
          const chunk = this.nextChunk(source, text, binding.generation);
          this.enqueueChunkInternal(source, binding, chunk);
        }
      }
      source.finished = true;
      source.endIndicatorPending =
        binding.outputEnabled && source.stats.accepted > 0;
      this.cleanupSourceIfDrained(voiceConsoleSpeechSourceKey(ref));
      this.notifyBindingDrain(ref.bindingId);
      this.kick();
    }
    return this.waitForSourceDrain(ref);
  }

  cancelSource(ref: VoiceConsoleSpeechSourceRef): void {
    const key = voiceConsoleSpeechSourceKey(ref);
    const source = this.sources.get(key);
    if (!source || source.cancelled) return;
    source.cancelled = true;
    source.finished = true;
    source.endIndicatorPending = false;
    source.segmenter = new StreamingSpeechSegmenter();
    this.dropPending(source);
    if (this.currentWork?.sourceKey === key) this.currentWork.controller.abort();
    this.cleanupSourceIfDrained(key);
    this.notifyBindingDrain(ref.bindingId);
    this.kick();
    this.queueStateChange("source-cancelled");
  }

  /** Cancel current/queued speech without changing authoritative durable state. */
  invalidateBindingSpeech(bindingId: string): number {
    const binding = this.binding(bindingId);
    this.clearBindingFailure(binding);
    this.invalidateBindingWork(bindingId);
    this.queueStateChange("binding-invalidated");
    return binding.generation;
  }

  setOutputEnabled(bindingId: string, enabled: boolean): number {
    const binding = this.binding(bindingId);
    if (binding.stateConflict) {
      if (enabled) throw bindingStateConflictError(bindingId, binding.stateConflict);
      return binding.generation;
    }
    if (binding.outputEnabled === enabled) return binding.generation;
    binding.outputEnabled = enabled;
    this.clearBindingFailure(binding);
    if (!enabled) {
      // Backward-convenience API: authoritative integrations use
      // syncBindingState() and supply the exact durable generation.
      binding.generation += 1;
      this.invalidateBindingWork(bindingId);
      this.queueStateChange("binding-synced");
      return binding.generation;
    }
    this.kick();
    this.queueStateChange("binding-synced");
    return binding.generation;
  }

  setAllOutputs(enabled: boolean): Map<string, number> {
    const generations = new Map<string, number>();
    for (const bindingId of this.bindings.keys()) {
      generations.set(bindingId, this.setOutputEnabled(bindingId, enabled));
    }
    return generations;
  }

  bindingGeneration(bindingId: string): number {
    return this.binding(bindingId).generation;
  }

  waitForBindingDrain(bindingId: string): Promise<VoiceConsoleSpeechStats> {
    const binding = this.binding(bindingId);
    if (this.isBindingDrained(bindingId)) return Promise.resolve(copyStats(binding.stats));
    return new Promise((resolve) => binding.drainWaiters.push(resolve));
  }

  waitForSourceDrain(ref: VoiceConsoleSpeechSourceRef): Promise<VoiceConsoleSpeechStats> {
    const key = voiceConsoleSpeechSourceKey(ref);
    const completed = this.completedSources.get(key);
    if (completed) return Promise.resolve(copyStats(completed));
    const source = this.sources.get(key);
    if (!source) return Promise.resolve(emptyStats());
    if (this.isSourceDrained(key)) return Promise.resolve(copyStats(source.stats));
    return new Promise((resolve) => source.drainWaiters.push(resolve));
  }

  /**
   * Release completed-source bookkeeping after its settlement has been handed
   * to the owner. Safe to repeat and a no-op while the source is still active.
   */
  forgetSource(ref: VoiceConsoleSpeechSourceRef): boolean {
    this.assertConsole(ref.consoleId);
    return this.completedSources.delete(voiceConsoleSpeechSourceKey(ref));
  }

  snapshot(): VoiceConsoleSpeechSchedulerSnapshot {
    const bindings: VoiceConsoleSpeechBindingSnapshot[] = [];
    let queueDepth = 0;
    for (const binding of this.bindings.values()) {
      const bindingSources = [...this.sources.values()].filter(
        (source) => source.ref.bindingId === binding.bindingId
      );
      const queuedChunks = bindingSources.reduce((sum, source) => sum + source.pending.length, 0);
      queueDepth += queuedChunks;
      bindings.push({
        bindingId: binding.bindingId,
        outputEnabled: binding.outputEnabled,
        generation: binding.generation,
        profile: { ...binding.profile },
        queuedChunks,
        activeSources: bindingSources.length,
        stateConflict: binding.stateConflict ? { ...binding.stateConflict } : null,
        recentFailure: binding.recentFailure ? copyFailure(binding.recentFailure) : null,
        stats: copyStats(binding.stats),
      });
    }
    return {
      consoleId: this.consoleId,
      currentSource: this.currentWork
        ? {
            consoleId: this.currentWork.chunk.consoleId,
            bindingId: this.currentWork.chunk.bindingId,
            turnId: this.currentWork.chunk.turnId,
          }
        : null,
      currentPhase: this.currentWork?.phase ?? null,
      queueDepth,
      bindings,
      destroyed: this.destroyed,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const work = this.currentWork;
    if (work) {
      work.controller.abort();
      if (!work.settled) {
        this.settle(work, { kind: "dropped" });
        work.settled = true;
      }
    }
    this.currentWork = undefined;
    for (const [key, source] of this.sources) {
      source.cancelled = true;
      source.finished = true;
      this.dropPending(source);
      this.completeSource(key, source, false);
    }
    this.sources.clear();
    this.sourceOrder = [];
    this.completedSources.clear();
    this.playback.destroy();
    for (const binding of this.bindings.values()) this.resolveBindingWaiters(binding);
    this.queueStateChange("destroyed");
  }

  private nextChunk(
    source: SourceState,
    text: string,
    generation: number
  ): VoiceConsoleSpeechChunk {
    const chunk: VoiceConsoleSpeechChunk = {
      ...source.ref,
      ordinal: source.lastOrdinal + 1,
      text: text.trim(),
      generation,
    };
    this.validateChunkOrder(source, chunk);
    return chunk;
  }

  private enqueueChunkInternal(
    source: SourceState,
    binding: BindingState,
    chunk: VoiceConsoleSpeechChunk
  ): VoiceConsoleChunkDisposition {
    if (
      this.destroyed ||
      source.cancelled ||
      source.finished ||
      !binding.outputEnabled ||
      chunk.generation !== binding.generation ||
      !chunk.text
    ) {
      this.recordSettlement(source, binding, "dropped", 0);
      return "dropped";
    }
    source.pending.push(chunk);
    source.stats.accepted += 1;
    binding.stats.accepted += 1;
    this.queueStateChange("queue-changed");
    this.kick();
    return "accepted";
  }

  private validateChunkOrder(source: SourceState, chunk: VoiceConsoleSpeechChunk): void {
    if (
      chunk.bindingId !== source.ref.bindingId ||
      chunk.turnId !== source.ref.turnId ||
      chunk.consoleId !== source.ref.consoleId
    ) {
      throw new Error("Voice Console speech chunk does not match its source");
    }
    if (!Number.isSafeInteger(chunk.ordinal) || chunk.ordinal <= source.lastOrdinal) {
      throw new Error("Voice Console speech ordinals must increase within a source");
    }
    source.lastOrdinal = chunk.ordinal;
  }

  private kick(): void {
    if (this.destroyed || this.running) return;
    this.running = true;
    queueMicrotask(() => {
      void this.run().finally(() => {
        this.running = false;
        if (!this.destroyed && this.hasReadySource()) this.kick();
      });
    });
  }

  private async run(): Promise<void> {
    while (!this.destroyed) {
      const selected = this.selectSource();
      if (!selected) return;
      const [sourceKey, source] = selected;
      const chunk = source.pending.shift();
      if (!chunk) {
        if (!source.endIndicatorPending) continue;
        const binding = this.bindings.get(source.ref.bindingId);
        source.endIndicatorPending = false;
        if (!binding) continue;
        const work: CurrentWork = {
          kind: "end-indicator",
          sourceKey,
          chunk: {
            ...source.ref,
            ordinal: source.lastOrdinal + 1,
            text: "",
            generation: binding.generation,
          },
          controller: new AbortController(),
          phase: "playback",
          // Indicators never affect chunk settlement or fairness statistics.
          settled: true,
        };
        this.currentWork = work;
        this.queueStateChange("work-started");
        await this.processEndIndicator(work);
        if (this.currentWork === work) this.currentWork = undefined;
        this.cleanupSourceIfDrained(sourceKey);
        this.notifyBindingDrain(source.ref.bindingId);
        this.queueStateChange("work-settled");
        continue;
      }
      const work: CurrentWork = {
        kind: "speech",
        sourceKey,
        chunk,
        controller: new AbortController(),
        phase: "synthesis",
        settled: false,
      };
      this.currentWork = work;
      this.queueStateChange("work-started");
      const outcome = await this.process(work);
      if (!work.settled) {
        this.settle(work, outcome);
        work.settled = true;
      }
      if (this.currentWork === work) this.currentWork = undefined;
      this.cleanupSourceIfDrained(sourceKey);
      this.notifyBindingDrain(chunk.bindingId);
      this.queueStateChange("work-settled");
    }
  }

  private async process(work: CurrentWork): Promise<WorkOutcome> {
    const source = this.sources.get(work.sourceKey);
    const binding = this.bindings.get(work.chunk.bindingId);
    if (!source || !binding || !this.isWorkValid(work, source, binding)) {
      return { kind: "dropped" };
    }

    let streamingPlayback: VoiceConsolePlaybackStream | undefined;
    let streamedAudioAccepted = false;
    try {
      // Keep the global synthesis slot until the provider promise actually
      // settles. Abort suppresses its output, but an abort-ignoring provider
      // must not allow a second request to overlap it.
      const synthesized = await Promise.resolve(
        this.synthesize({
          chunk: work.chunk,
          profile: { ...binding.profile },
          signal: work.controller.signal,
          onAudioDelta: async (audio) => {
            if (!this.isWorkValid(work, source, binding)) throw abortError();
            if (!this.playback.beginStream) {
              throw new Error("Voice Console playback does not support streaming audio");
            }
            streamingPlayback ??= this.playback.beginStream({
              chunk: work.chunk,
              signal: work.controller.signal,
            });
            streamedAudioAccepted = true;
            work.phase = "playback";
            this.queueStateChange("work-phase-changed");
            await streamingPlayback.enqueue(audio);
          },
        })
      );
      if (work.controller.signal.aborted) {
        streamingPlayback?.cancel();
        const stopped = await streamingPlayback?.finish();
        return { kind: "dropped", durationMs: playbackDuration(stopped) };
      }
      if (!synthesized.ok) {
        const stopped = streamingPlayback ? await streamingPlayback.finish() : undefined;
        return {
          kind: "failed",
          phase: "synthesis",
          error: synthesized.error,
          durationMs: playbackDuration(stopped),
        };
      }
      if (!this.isWorkValid(work, source, binding)) {
        streamingPlayback?.cancel();
        const stopped = await streamingPlayback?.finish();
        return { kind: "dropped", durationMs: playbackDuration(stopped) };
      }

      if ("streamed" in synthesized && synthesized.streamed) {
        if (!streamingPlayback || !streamedAudioAccepted) {
          return {
            kind: "failed",
            phase: "synthesis",
            error: "Voice Console TTS stream completed without accepted audio",
          };
        }
        const played = await streamingPlayback.finish();
        return this.playbackOutcome(work, source, binding, played);
      }

      // Defensive provider fence: if a provider emitted deltas and also returns
      // unary audio, never replay the chunk. The accepted stream owns playback.
      if (streamingPlayback) {
        const played = await streamingPlayback.finish();
        return this.playbackOutcome(work, source, binding, played);
      }
      if (!("audio" in synthesized)) {
        return { kind: "failed", phase: "synthesis", error: "TTS response had no audio" };
      }

      work.phase = "playback";
      this.queueStateChange("work-phase-changed");
      const playback = abortable(
        Promise.resolve(
          this.playback.play({
            chunk: work.chunk,
            audio: synthesized.audio,
            signal: work.controller.signal,
          })
        ),
        work.controller.signal
      );
      const playbackResult = await playback;
      if (playbackResult.aborted) {
        return {
          kind: "dropped",
          durationMs: this.playback.currentConsumedAudioMs?.() ?? 0,
        };
      }
      return this.playbackOutcome(work, source, binding, playbackResult.value);
    } catch (error) {
      streamingPlayback?.cancel();
      const stopped = await streamingPlayback?.finish().catch(() => undefined);
      if (work.controller.signal.aborted) {
        return { kind: "dropped", durationMs: playbackDuration(stopped) };
      }
      return {
        kind: "failed",
        phase: work.phase,
        error: error instanceof Error ? error.message : String(error),
        durationMs: playbackDuration(stopped),
      };
    }
  }

  private async processEndIndicator(work: CurrentWork): Promise<void> {
    const source = this.sources.get(work.sourceKey);
    const binding = this.bindings.get(work.chunk.bindingId);
    if (
      !source ||
      !binding ||
      !this.playback.playEndIndicator ||
      !this.isWorkValid(work, source, binding)
    ) {
      return;
    }
    try {
      await this.playback.playEndIndicator({
        chunk: work.chunk,
        signal: work.controller.signal,
      });
    } catch {
      // The local end marker is advisory. It cannot turn successful text or
      // speech into a visible failure, or stall another source.
    }
  }

  private playbackOutcome(
    work: CurrentWork,
    source: SourceState,
    binding: BindingState,
    played: VoiceConsolePlaybackResult
  ): WorkOutcome {
    if (played.status === "failed") {
      return {
        kind: "failed",
        phase: "playback",
        error: played.error,
        durationMs: nonNegativeDuration(played),
      };
    }
    if (played.status === "cancelled" || !this.isWorkValid(work, source, binding)) {
      return { kind: "dropped", durationMs: nonNegativeDuration(played) };
    }
    return { kind: "played", durationMs: nonNegativeDuration(played) };
  }

  private settle(work: CurrentWork, outcome: WorkOutcome): void {
    const source = this.sources.get(work.sourceKey);
    const binding = this.bindings.get(work.chunk.bindingId);
    if (!source || !binding) return;
    if (outcome.kind === "played") {
      this.recordSettlement(source, binding, "played", outcome.durationMs);
      this.clearBindingFailure(binding);
      this.recordFairness(work.sourceKey, outcome.durationMs);
      return;
    }
    if (outcome.kind === "failed") {
      this.recordSettlement(source, binding, "failed", 0);
      binding.recentFailure = {
        source: { ...source.ref },
        ordinal: work.chunk.ordinal,
        phase: outcome.phase,
        error: outcome.error.slice(0, MAX_RECENT_FAILURE_ERROR_CHARS),
      };
      this.queueStateChange("failure");
      this.recordFairness(work.sourceKey, outcome.durationMs ?? 0);
      if (!source.warned) {
        source.warned = true;
        try {
          this.onFailure({
            source: { ...source.ref },
            ordinal: work.chunk.ordinal,
            phase: outcome.phase,
            error: outcome.error,
          });
        } catch {
          // Warning delivery is advisory and cannot own scheduler progress.
        }
      }
      return;
    }
    this.recordSettlement(source, binding, "dropped", 0);
    if ((outcome.durationMs ?? 0) > 0) {
      this.recordFairness(work.sourceKey, outcome.durationMs ?? 0);
    }
  }

  private recordSettlement(
    source: SourceState,
    binding: BindingState,
    kind: "played" | "failed" | "dropped",
    durationMs: number
  ): void {
    source.stats[kind] += 1;
    binding.stats[kind] += 1;
    if (kind === "played") {
      source.stats.playedAudioMs += durationMs;
      binding.stats.playedAudioMs += durationMs;
    }
    this.queueStateChange("queue-changed");
  }

  private recordFairness(sourceKey: string, durationMs: number): void {
    if (this.sliceSourceKey !== sourceKey) {
      this.sliceSourceKey = sourceKey;
      this.sliceChunks = 0;
      this.sliceAudioMs = 0;
    }
    this.sliceChunks += 1;
    this.sliceAudioMs += durationMs;
  }

  private selectSource(): [string, SourceState] | undefined {
    const ready = this.sourceOrder.filter((key) => this.isSourceReady(key));
    if (ready.length === 0) {
      this.sliceSourceKey = undefined;
      this.sliceChunks = 0;
      this.sliceAudioMs = 0;
      return undefined;
    }

    const currentReady = this.sliceSourceKey
      ? ready.includes(this.sliceSourceKey)
      : false;
    let selectedKey: string;
    if (currentReady) {
      const anotherReady = ready.some((key) => key !== this.sliceSourceKey);
      const currentSource = this.sources.get(this.sliceSourceKey!);
      const finishingCurrent = Boolean(
        currentSource?.endIndicatorPending && currentSource.pending.length === 0
      );
      const quotaReached =
        this.sliceChunks >= this.maxChunksPerSlice ||
        this.sliceAudioMs >= this.maxAudioMsPerSlice;
      selectedKey = anotherReady && quotaReached && !finishingCurrent
        ? this.nextReadyAfter(this.sliceSourceKey!, ready)
        : this.sliceSourceKey!;
    } else {
      selectedKey = this.nextReadyAfter(this.sliceSourceKey, ready);
    }

    if (selectedKey !== this.sliceSourceKey) {
      this.sliceSourceKey = selectedKey;
      this.sliceChunks = 0;
      this.sliceAudioMs = 0;
    }
    const source = this.sources.get(selectedKey);
    return source ? [selectedKey, source] : undefined;
  }

  private nextReadyAfter(current: string | undefined, ready: string[]): string {
    if (!current) return ready[0]!;
    const start = this.sourceOrder.indexOf(current);
    for (let offset = 1; offset <= this.sourceOrder.length; offset++) {
      const index = (Math.max(start, -1) + offset) % this.sourceOrder.length;
      const key = this.sourceOrder[index];
      if (key && ready.includes(key)) return key;
    }
    return ready[0]!;
  }

  private hasReadySource(): boolean {
    return this.sourceOrder.some((key) => this.isSourceReady(key));
  }

  private isSourceReady(key: string): boolean {
    const source = this.sources.get(key);
    if (
      !source ||
      (source.pending.length === 0 && !source.endIndicatorPending) ||
      source.cancelled
    ) return false;
    const binding = this.bindings.get(source.ref.bindingId);
    return Boolean(binding?.outputEnabled);
  }

  private isWorkValid(
    work: CurrentWork,
    source: SourceState,
    binding: BindingState
  ): boolean {
    return (
      !this.destroyed &&
      !work.controller.signal.aborted &&
      !source.cancelled &&
      binding.outputEnabled &&
      binding.generation === work.chunk.generation
    );
  }

  private dropPending(source: SourceState): void {
    source.endIndicatorPending = false;
    const binding = this.bindings.get(source.ref.bindingId);
    if (!binding) {
      source.pending = [];
      return;
    }
    const dropped = source.pending.splice(0, source.pending.length).length;
    source.stats.dropped += dropped;
    binding.stats.dropped += dropped;
  }

  private cleanupSourceIfDrained(key: string): void {
    const source = this.sources.get(key);
    if (!source || !this.isSourceDrained(key)) return;
    this.completeSource(key, source);
    this.sources.delete(key);
    this.sourceOrder = this.sourceOrder.filter((candidate) => candidate !== key);
    this.queueStateChange("source-settled");
  }

  private completeSource(key: string, source: SourceState, retain = true): void {
    const stats = copyStats(source.stats);
    if (retain) this.completedSources.set(key, stats);
    const waiters = source.drainWaiters.splice(0, source.drainWaiters.length);
    for (const resolve of waiters) resolve(copyStats(stats));
  }

  private isSourceDrained(key: string): boolean {
    const source = this.sources.get(key);
    if (!source || (!source.finished && !source.cancelled)) return false;
    return !source.endIndicatorPending &&
      source.pending.length === 0 && this.currentWork?.sourceKey !== key;
  }

  private isBindingDrained(bindingId: string): boolean {
    if (this.destroyed) return true;
    for (const [key, source] of this.sources) {
      if (source.ref.bindingId !== bindingId) continue;
      if (!this.isSourceDrained(key)) return false;
    }
    return this.currentBindingId() !== bindingId;
  }

  private notifyBindingDrain(bindingId: string): void {
    const binding = this.bindings.get(bindingId);
    if (binding && this.isBindingDrained(bindingId)) this.resolveBindingWaiters(binding);
  }

  private resolveBindingWaiters(binding: BindingState): void {
    const stats = copyStats(binding.stats);
    const waiters = binding.drainWaiters.splice(0, binding.drainWaiters.length);
    for (const resolve of waiters) resolve(copyStats(stats));
  }

  private currentBindingId(): string | undefined {
    return this.currentWork?.chunk.bindingId;
  }

  private invalidateBindingWork(bindingId: string): void {
    for (const [key, source] of this.sources) {
      if (source.ref.bindingId !== bindingId) continue;
      source.segmenter = new StreamingSpeechSegmenter();
      this.dropPending(source);
      this.cleanupSourceIfDrained(key);
    }
    if (this.currentBindingId() === bindingId) this.currentWork?.controller.abort();
    this.notifyBindingDrain(bindingId);
    this.kick();
    this.queueStateChange("queue-changed");
  }

  private clearBindingFailure(binding: BindingState): void {
    if (!binding.recentFailure) return;
    binding.recentFailure = null;
    this.queueStateChange("recovered");
  }

  private queueStateChange(reason: VoiceConsoleSpeechStateChangeReason): void {
    if (!this.onStateChange) return;
    this.pendingStateChangeReasons.add(reason);
    this.pendingStateChangeSnapshot = this.snapshot();
    this.scheduleStateChangeDelivery();
  }

  private scheduleStateChangeDelivery(): void {
    if (
      !this.onStateChange ||
      this.stateChangeInFlight ||
      this.stateChangeScheduled ||
      !this.pendingStateChangeSnapshot
    ) {
      return;
    }
    this.stateChangeScheduled = true;
    queueMicrotask(() => {
      this.stateChangeScheduled = false;
      this.deliverStateChange();
    });
  }

  private deliverStateChange(): void {
    if (
      !this.onStateChange ||
      this.stateChangeInFlight ||
      !this.pendingStateChangeSnapshot
    ) {
      return;
    }
    const snapshot = this.pendingStateChangeSnapshot;
    this.pendingStateChangeSnapshot = undefined;
    const reasons = [...this.pendingStateChangeReasons];
    this.pendingStateChangeReasons.clear();
    this.stateChangeInFlight = true;
    void Promise.resolve()
      .then(() => this.onStateChange!({ reasons, snapshot }))
      .catch(() => {
        // Card/status refresh is advisory and cannot own scheduler progress.
      })
      .then(() => {
        this.stateChangeInFlight = false;
        this.scheduleStateChangeDelivery();
      });
  }

  private source(ref: VoiceConsoleSpeechSourceRef): SourceState {
    this.assertConsole(ref.consoleId);
    const source = this.sources.get(voiceConsoleSpeechSourceKey(ref));
    if (!source) throw new Error(`Voice Console speech source is not registered: ${ref.turnId}`);
    return source;
  }

  private binding(bindingId: string): BindingState {
    const binding = this.bindings.get(bindingId);
    if (!binding) throw new Error(`Voice Console speech binding is not registered: ${bindingId}`);
    return binding;
  }

  private assertConsole(consoleId: string): void {
    if (consoleId !== this.consoleId) {
      throw new Error("Voice Console speech source belongs to a different console");
    }
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error("Voice Console speech scheduler has ended");
  }
}

function emptyStats(): VoiceConsoleSpeechStats {
  return { accepted: 0, played: 0, failed: 0, dropped: 0, playedAudioMs: 0 };
}

function copyStats(stats: VoiceConsoleSpeechStats): VoiceConsoleSpeechStats {
  return { ...stats };
}

function normalizeProfile(profile: VoiceConsoleSpeechProfile): VoiceConsoleSpeechProfile {
  const voice = profile.voice.trim();
  if (!voice) throw new Error("Voice Console speech profile requires a voice");
  return { voice, pace: profile.pace, style: profile.style };
}

function sameProfile(a: VoiceConsoleSpeechProfile, b: VoiceConsoleSpeechProfile): boolean {
  return a.voice === b.voice && a.pace === b.pace && a.style === b.style;
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Voice Console speech generation must be a non-negative safe integer");
  }
}

function copyFailure(failure: VoiceConsoleSpeechFailure): VoiceConsoleSpeechFailure {
  return { ...failure, source: { ...failure.source } };
}

function bindingStateConflictError(
  bindingId: string,
  conflict: VoiceConsoleBindingStateConflict
): Error {
  return new Error(
    `Voice Console speech binding state conflicts at generation ${conflict.generation}: ${bindingId}; ` +
    "a strictly newer authoritative generation is required"
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function nonNegativeDuration(result: VoiceConsolePlaybackResult): number {
  return Number.isFinite(result.durationMs) && result.durationMs > 0
    ? Math.round(result.durationMs)
    : 0;
}

function playbackDuration(result: VoiceConsolePlaybackResult | undefined): number {
  return result ? nonNegativeDuration(result) : 0;
}

function abortError(): Error {
  const error = new Error("Voice Console speech work was cancelled");
  error.name = "AbortError";
  return error;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve({ aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
