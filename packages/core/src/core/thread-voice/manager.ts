import type { Logger } from "../../lib/logger.js";
import type { SessionStore } from "../session-store.js";
import { VoiceLeaseManager, type VoiceLease } from "../voice-lease.js";
import {
  type DroppedVoiceSegment,
  newThreadVoiceSegmentId,
  newThreadVoiceSessionId,
  type FinalVoiceSegment,
  type OwnerVoiceState,
  type ThreadVoiceBatch,
  type ThreadVoiceDispatchArtifactState,
  type ThreadVoiceDispatchRequest,
  type ThreadVoiceNotification,
  type ThreadVoiceRuntimeState,
  type ThreadVoiceSegment,
  type ThreadVoiceSession,
  type ThreadVoiceStartRequest,
  type TtsPcm,
} from "./types.js";

export interface ThreadVoiceHost {
  inspectOwnerVoiceState(userId: string, guildId: string): Promise<OwnerVoiceState>;
  runSession(opts: {
    row: ThreadVoiceSession;
    signal: AbortSignal;
    /** Capture sequence is allocated at the unmute edge by the media host. */
    nextSequence: () => number;
    onState: (state: ThreadVoiceRuntimeState) => void;
    onInterim: (sequence: number, text: string) => void;
    onFinal: (segment: FinalVoiceSegment) => void;
    /** Settle a reserved capture sequence that produced no durable final. */
    onDropped: (segment: DroppedVoiceSegment) => void;
    onAudioSent: (durationMs: number) => void;
  }): Promise<{ reason: string }>;
  speak(sessionId: string, pcm: TtsPcm): Promise<void>;
  waitForPlaybackIdle(sessionId: string): Promise<void>;
  notify(threadId: string, event: ThreadVoiceNotification): Promise<void>;
}

export interface ThreadVoiceDispatchHost {
  isHomeThreadBusy(session: ThreadVoiceSession): boolean | Promise<boolean>;
  inspectArtifact(dispatchId: string): Promise<ThreadVoiceDispatchArtifactState>;
  enqueue(request: ThreadVoiceDispatchRequest): Promise<void>;
}

export type ThreadVoiceStartResult =
  | { ok: true; session: ThreadVoiceSession }
  | { ok: false; error: string };

export interface ThreadVoiceRecoveryResult {
  reconnected: number;
  ended: number;
  dispatchesEnqueued: number;
  dispatchesFound: number;
  failures: number;
}

type RunningSession = {
  abort: AbortController;
  lease: VoiceLease;
  /** Resolves only after runSession cleanup + lease release finish. */
  done: Promise<void>;
};

export class ThreadVoiceManager {
  private readonly store: SessionStore;
  private readonly logger: Logger;
  private readonly host: ThreadVoiceHost;
  private readonly dispatch: ThreadVoiceDispatchHost;
  private readonly leases: VoiceLeaseManager;
  private readonly now: () => string;
  private readonly running = new Map<string, RunningSession>();
  private readonly runtimeStates = new Map<string, ThreadVoiceRuntimeState>();
  private readonly releaseRuns = new Map<string, Promise<boolean>>();
  /** Coalesce callbacks without losing a final that lands during an idle check. */
  private readonly releaseRequested = new Set<string>();
  /** Cleared only by markDispatchSettled, after ACP + speech playback drain. */
  private readonly activeDispatchByThread = new Map<string, string>();
  private readonly requestedStopReasons = new Map<string, string>();
  /** Sequences allocated at unmute but not yet finalized/dropped. */
  private readonly outstandingSequences = new Map<string, Set<number>>();
  private shuttingDown = false;

  constructor(opts: {
    store: SessionStore;
    logger: Logger;
    host: ThreadVoiceHost;
    dispatch: ThreadVoiceDispatchHost;
    leases: VoiceLeaseManager;
    now?: () => string;
  }) {
    this.store = opts.store;
    this.logger = opts.logger.child({ comp: "thread-voice" });
    this.host = opts.host;
    this.dispatch = opts.dispatch;
    this.leases = opts.leases;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async start(request: ThreadVoiceStartRequest): Promise<ThreadVoiceStartResult> {
    const inspected = await this.host.inspectOwnerVoiceState(
      request.ownerUserId,
      request.guildId
    );
    if (!inspected.ok) return { ok: false, error: inspected.reason };
    if (inspected.guildId !== request.guildId) {
      return { ok: false, error: "You must be in a voice channel in this thread's guild." };
    }
    if (!inspected.visible) {
      return { ok: false, error: "Your current voice channel is not visible to Seam." };
    }
    if (!inspected.selfMuted) {
      return {
        ok: false,
        error: "Mute yourself in Discord before starting Thread Voice, then try again.",
      };
    }
    const activeThread = this.store.getActiveThreadVoiceForThread(
      request.platform,
      request.channelRef
    );
    if (activeThread) {
      return {
        ok: false,
        error: `This thread already has an active Thread Voice session (\`${activeThread.id}\`).`,
      };
    }
    const activeGuild = this.store.getActiveThreadVoiceForGuild(request.guildId);
    if (activeGuild) {
      return {
        ok: false,
        error: `This guild already has an active Thread Voice session (\`${activeGuild.id}\`).`,
      };
    }

    const now = this.now();
    const row: ThreadVoiceSession = {
      id: newThreadVoiceSessionId(),
      platform: request.platform,
      channelRef: request.channelRef,
      parentRef: request.parentRef,
      guildId: request.guildId,
      voiceChannelId: inspected.voiceChannelId,
      ownerUserId: request.ownerUserId,
      ownerName: request.ownerName,
      status: "starting",
      noticeMessageId: null,
      transmittedAudioMs: 0,
      createdUtc: now,
      updatedUtc: now,
      endedUtc: null,
      endReason: null,
    };
    const acquired = this.leases.acquire({
      kind: "thread_voice",
      sessionId: row.id,
      guildId: row.guildId,
      voiceChannelId: row.voiceChannelId,
    });
    if (!acquired.ok) return { ok: false, error: acquired.error };

    try {
      this.store.insertThreadVoiceSession(row);
    } catch (err) {
      this.leases.release(acquired.lease);
      const code = (err as { code?: string }).code;
      if (code?.startsWith("SQLITE_CONSTRAINT")) {
        return { ok: false, error: "This thread or guild already has an active Thread Voice session." };
      }
      throw err;
    }
    this.logger.info(
      {
        threadVoiceId: row.id,
        thread: row.channelRef,
        guild: row.guildId,
        vc: row.voiceChannelId,
        ownerId: row.ownerUserId,
      },
      "thread voice starting"
    );
    this.launch(row, acquired.lease);
    return { ok: true, session: row };
  }

  /**
   * Reconnect durable active rows only when the owner is still in the same VC,
   * visible, and muted. Callers coordinate this pass with Live Help so both
   * products inspect durable rows before either reconnects.
   */
  async reconcileOnBoot(): Promise<Pick<ThreadVoiceRecoveryResult, "reconnected" | "ended" | "failures">> {
    let reconnected = 0;
    let ended = 0;
    let failures = 0;
    for (const row of this.store.listActiveThreadVoiceSessions()) {
      if (row.status === "stopping") {
        this.finishPersistedSession(row.id, "ended", "process restarted while stopping");
        ended++;
        continue;
      }
      try {
        const voice = await this.host.inspectOwnerVoiceState(row.ownerUserId, row.guildId);
        if (
          !voice.ok ||
          voice.guildId !== row.guildId ||
          voice.voiceChannelId !== row.voiceChannelId ||
          !voice.visible ||
          !voice.selfMuted
        ) {
          const reason = voice.ok
            ? "owner was not present, visible, and muted in the bound voice channel after restart"
            : voice.reason;
          this.finishPersistedSession(row.id, "ended", reason);
          ended++;
          continue;
        }
        const acquired = this.leases.acquire({
          kind: "thread_voice",
          sessionId: row.id,
          guildId: row.guildId,
          voiceChannelId: row.voiceChannelId,
        });
        if (!acquired.ok) {
          this.finishPersistedSession(row.id, "failed", acquired.error);
          failures++;
          continue;
        }
        this.store.updateThreadVoiceSession(row.id, {
          status: "starting",
          endedUtc: null,
          endReason: null,
          updatedUtc: this.now(),
        });
        this.launch({ ...row, status: "starting", endedUtc: null, endReason: null }, acquired.lease);
        reconnected++;
      } catch (err) {
        failures++;
        this.finishPersistedSession(row.id, "failed", errorMessage(err));
      }
    }
    return { reconnected, ended, failures };
  }

  async recoverDispatches(): Promise<Pick<ThreadVoiceRecoveryResult, "dispatchesEnqueued" | "dispatchesFound" | "failures">> {
    let dispatchesEnqueued = 0;
    let dispatchesFound = 0;
    let failures = 0;

    const reconciled = new Set<string>();
    for (const batch of this.store.listRecoverableThreadVoiceBatches()) {
      reconciled.add(batch.dispatchId);
      try {
        const artifact = await this.dispatch.inspectArtifact(batch.dispatchId);
        if (artifact === "missing") {
          await this.dispatch.enqueue(this.toDispatchRequest(batch));
          dispatchesEnqueued++;
          this.activeDispatchByThread.set(threadKey(batch.session), batch.dispatchId);
        } else {
          dispatchesFound++;
          if (artifact === "pending" || artifact === "running") {
            this.activeDispatchByThread.set(threadKey(batch.session), batch.dispatchId);
          }
        }
        this.store.markThreadVoiceBatchDispatched(batch.dispatchId, this.now());
      } catch (err) {
        failures++;
        this.store.markThreadVoiceBatchError(batch.dispatchId, errorMessage(err), this.now());
        this.logger.warn(
          { err, dispatchId: batch.dispatchId, threadVoiceId: batch.session.id },
          "thread voice batch recovery failed"
        );
      }
    }

    for (const batch of this.store.listThreadVoiceBatchesByState("dispatched")) {
      if (reconciled.has(batch.dispatchId)) continue;
      try {
        const artifact = await this.dispatch.inspectArtifact(batch.dispatchId);
        if (artifact === "pending" || artifact === "running") {
          this.activeDispatchByThread.set(threadKey(batch.session), batch.dispatchId);
          dispatchesFound++;
        }
      } catch (err) {
        failures++;
        this.logger.warn(
          { err, dispatchId: batch.dispatchId, threadVoiceId: batch.session.id },
          "thread voice dispatched-artifact inspection failed"
        );
      }
    }

    for (const session of this.store.listThreadVoiceSessionsWithBufferedSegments()) {
      if (!this.activeDispatchByThread.has(threadKey(session))) {
        void this.releaseIfIdle(session.id);
      }
    }
    return { dispatchesEnqueued, dispatchesFound, failures };
  }

  commitFinalSegment(sessionId: string, final: FinalVoiceSegment): ThreadVoiceSegment | null {
    this.settleSequence(sessionId, final.sequence);
    const session = this.store.getThreadVoiceSession(sessionId);
    if (!session) return null;
    const transcript = final.transcript.trim();
    if (!transcript) return null;
    if (final.authorId !== session.ownerUserId) {
      this.logger.warn(
        { threadVoiceId: sessionId, authorId: final.authorId },
        "thread voice final rejected: author does not match owner"
      );
      return null;
    }
    const now = this.now();
    const inserted = this.store.appendThreadVoiceSegment({
      id: newThreadVoiceSegmentId(),
      sessionId,
      sequence: final.sequence,
      authorId: final.authorId,
      transcript,
      state: "pending",
      audioMs: Math.max(0, Math.trunc(final.audioMs)),
      dispatchId: null,
      capturedStartedUtc: final.capturedStartedUtc,
      capturedEndedUtc: final.capturedEndedUtc,
      createdUtc: now,
      updatedUtc: now,
      error: null,
    });
    if (!inserted.inserted) return inserted.segment;
    this.logger.info(
      {
        threadVoiceId: sessionId,
        sequence: inserted.segment.sequence,
        chars: inserted.segment.transcript.length,
        audioMs: inserted.segment.audioMs,
      },
      "thread voice final committed"
    );
    this.safeNotify(session, { kind: "final", sessionId, segment: inserted.segment });
    void this.releaseIfIdle(sessionId);
    return inserted.segment;
  }

  releaseIfIdle(sessionId: string): Promise<boolean> {
    const existing = this.releaseRuns.get(sessionId);
    if (existing) {
      this.releaseRequested.add(sessionId);
      return existing;
    }
    const run = this.releaseIfIdleInner(sessionId).finally(() => {
      this.releaseRuns.delete(sessionId);
      if (this.releaseRequested.delete(sessionId)) {
        void this.releaseIfIdle(sessionId);
      }
    });
    this.releaseRuns.set(sessionId, run);
    return run;
  }

  private async releaseIfIdleInner(sessionId: string): Promise<boolean> {
    const session = this.store.getThreadVoiceSession(sessionId);
    if (!session) return false;
    const key = threadKey(session);
    if (this.activeDispatchByThread.has(key)) return false;
    if (await this.dispatch.isHomeThreadBusy(session)) return false;
    await this.host.waitForPlaybackIdle(sessionId);
    if (this.activeDispatchByThread.has(key)) return false;
    if (await this.dispatch.isHomeThreadBusy(session)) return false;

    // A later API final must never leapfrog an earlier capture that is still
    // finalizing. A newer active capture does not block already-finalized text.
    const pending = this.store.listThreadVoiceSegments(sessionId, ["pending"]);
    const maxPendingSequence = pending.at(-1)?.sequence;
    if (
      maxPendingSequence !== undefined &&
      [...(this.outstandingSequences.get(sessionId) ?? [])].some(
        (sequence) => sequence < maxPendingSequence
      )
    ) {
      return false;
    }

    const batch = this.store.claimPendingThreadVoiceBatch(sessionId);
    if (!batch) return false;
    try {
      const artifact = await this.dispatch.inspectArtifact(batch.dispatchId);
      if (artifact === "missing") {
        await this.dispatch.enqueue(this.toDispatchRequest(batch));
      }
      this.store.markThreadVoiceBatchDispatched(batch.dispatchId, this.now());
      if (artifact !== "done") {
        this.activeDispatchByThread.set(key, batch.dispatchId);
      }
      this.logger.info(
        {
          threadVoiceId: session.id,
          dispatchId: batch.dispatchId,
          pendingSegmentCount: batch.segments.length,
        },
        "thread voice batch dispatched"
      );
      return true;
    } catch (err) {
      this.store.markThreadVoiceBatchError(batch.dispatchId, errorMessage(err), this.now());
      this.logger.warn(
        { err, threadVoiceId: session.id, dispatchId: batch.dispatchId },
        "thread voice dispatch enqueue failed; batch left for recovery"
      );
      return false;
    }
  }

  /** Called by integration only after the ACP turn and its playback both drain. */
  async markDispatchSettled(sessionId: string, dispatchId: string): Promise<void> {
    const session = this.store.getThreadVoiceSession(sessionId);
    if (!session) return;
    await this.host.waitForPlaybackIdle(sessionId).catch((err) => {
      this.logger.warn({ err, threadVoiceId: sessionId }, "thread voice playback drain failed");
    });
    const key = threadKey(session);
    if (this.activeDispatchByThread.get(key) === dispatchId) {
      this.activeDispatchByThread.delete(key);
    }
    await this.releaseIfIdle(sessionId);
  }

  async stop(
    sessionId: string,
    opts: { discardPending?: boolean; reason?: string } = {}
  ): Promise<{ ok: true; discarded: number } | { ok: false; error: string }> {
    const session = this.store.getThreadVoiceSession(sessionId);
    if (!session) return { ok: false, error: "No Thread Voice session with that id." };
    if (session.status === "ended" || session.status === "failed") {
      return { ok: false, error: "That Thread Voice session has already ended." };
    }
    const reason = opts.reason ?? "stopped";
    const discarded = opts.discardPending
      ? this.store.discardPendingThreadVoiceSegments(sessionId, this.now())
      : 0;
    this.requestedStopReasons.set(sessionId, reason);
    this.store.updateThreadVoiceSession(sessionId, {
      status: "stopping",
      updatedUtc: this.now(),
      endReason: reason,
    });
    this.setRuntimeState(session, "stopping");
    const running = this.running.get(sessionId);
    if (running) {
      running.abort.abort();
      await running.done;
    } else {
      this.finishPersistedSession(sessionId, "ended", reason);
      this.releaseLease(session);
      if (!opts.discardPending) void this.releaseIfIdle(sessionId);
    }
    return { ok: true, discarded };
  }

  async stopAll(reason = "global stop"): Promise<void> {
    await Promise.all(
      this.store.listActiveThreadVoiceSessions().map((session) =>
        this.stop(session.id, { reason }).then(() => undefined)
      )
    );
  }

  /** Process shutdown preserves active rows for the boot reconnect decision. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const [sessionId, running] of this.running) {
      running.abort.abort();
      this.leases.release(running.lease);
      this.logger.info({ threadVoiceId: sessionId }, "thread voice released for shutdown");
    }
    this.running.clear();
    this.runtimeStates.clear();
  }

  async speak(sessionId: string, pcm: TtsPcm): Promise<void> {
    await this.host.speak(sessionId, pcm);
  }

  getRuntimeState(sessionId: string): ThreadVoiceRuntimeState | undefined {
    return this.runtimeStates.get(sessionId);
  }

  getActiveDispatchId(session: Pick<ThreadVoiceSession, "platform" | "channelRef">): string | undefined {
    return this.activeDispatchByThread.get(threadKey(session));
  }

  private launch(row: ThreadVoiceSession, lease: VoiceLease): void {
    const abort = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.running.set(row.id, { abort, lease, done });
    this.setRuntimeState(row, "starting");
    let nextSequence = this.store.nextThreadVoiceSequence(row.id);
    this.outstandingSequences.set(row.id, new Set());
    const runOpts: Parameters<ThreadVoiceHost["runSession"]>[0] = {
        row,
        signal: abort.signal,
        nextSequence: () => {
          const sequence = nextSequence++;
          this.outstandingSequences.get(row.id)?.add(sequence);
          return sequence;
        },
        onState: (state) => {
          if (this.shuttingDown) return;
          if (state === "ready") {
            this.store.updateThreadVoiceSession(row.id, {
              status: "ready",
              updatedUtc: this.now(),
            });
          }
          this.setRuntimeState(row, state);
        },
        onInterim: (sequence, text) => {
          if (!this.shuttingDown) {
            this.safeNotify(row, { kind: "interim", sessionId: row.id, sequence, text });
          }
        },
        onFinal: (segment) => {
          if (!this.shuttingDown) this.commitFinalSegment(row.id, segment);
        },
        onDropped: (segment) => {
          if (this.shuttingDown) return;
          this.commitDroppedSegment(row.id, segment);
          this.logger.info(
            {
              threadVoiceId: row.id,
              sequence: segment.sequence,
              state: segment.state,
              ...(segment.error ? { error: segment.error } : {}),
            },
            "thread voice capture settled without final text"
          );
        },
        onAudioSent: (durationMs) => {
          if (!this.shuttingDown && durationMs > 0) {
            this.store.addThreadVoiceTransmittedAudio(row.id, durationMs, this.now());
          }
        },
      };
    // Promise boundary also catches a host that throws synchronously before it
    // returns its run promise, preserving the same terminal/release path.
    void Promise.resolve()
      .then(() => this.host.runSession(runOpts))
      .then(({ reason }) => {
        if (this.shuttingDown) return;
        const finalReason = this.requestedStopReasons.get(row.id) ?? reason;
        this.finishPersistedSession(row.id, "ended", finalReason);
        this.safeNotify(row, { kind: "ended", sessionId: row.id, reason: finalReason });
      })
      .catch((err) => {
        if (this.shuttingDown) return;
        const requested = this.requestedStopReasons.get(row.id);
        if (requested && abort.signal.aborted) {
          this.finishPersistedSession(row.id, "ended", requested);
          this.safeNotify(row, { kind: "ended", sessionId: row.id, reason: requested });
          return;
        }
        const message = errorMessage(err);
        this.finishPersistedSession(row.id, "failed", message);
        this.safeNotify(row, { kind: "failed", sessionId: row.id, error: message });
        this.logger.warn({ err, threadVoiceId: row.id }, "thread voice session failed");
      })
      .finally(() => {
        this.running.delete(row.id);
        this.runtimeStates.delete(row.id);
        this.outstandingSequences.delete(row.id);
        this.requestedStopReasons.delete(row.id);
        this.leases.release(lease);
        this.logger.info(
          { threadVoiceId: row.id, guild: row.guildId, vc: row.voiceChannelId },
          "thread voice lease released"
        );
        if (!this.shuttingDown) void this.releaseIfIdle(row.id);
        resolveDone();
      });
  }

  private finishPersistedSession(
    sessionId: string,
    status: "ended" | "failed",
    reason: string
  ): void {
    this.store.updateThreadVoiceSession(sessionId, {
      status,
      updatedUtc: this.now(),
      endedUtc: this.now(),
      endReason: reason,
    });
  }

  private releaseLease(session: ThreadVoiceSession): void {
    this.leases.release({
      kind: "thread_voice",
      sessionId: session.id,
      guildId: session.guildId,
    });
  }

  private setRuntimeState(session: ThreadVoiceSession, state: ThreadVoiceRuntimeState): void {
    this.runtimeStates.set(session.id, state);
    this.safeNotify(session, { kind: "state", sessionId: session.id, state });
  }

  private safeNotify(session: ThreadVoiceSession, event: ThreadVoiceNotification): void {
    void this.host.notify(session.channelRef, event).catch((err) => {
      this.logger.warn(
        { err, threadVoiceId: session.id, notificationKind: event.kind },
        "thread voice notification failed"
      );
    });
  }

  private settleSequence(sessionId: string, sequence: number): void {
    const outstanding = this.outstandingSequences.get(sessionId);
    outstanding?.delete(sequence);
  }

  private commitDroppedSegment(sessionId: string, dropped: DroppedVoiceSegment): void {
    this.settleSequence(sessionId, dropped.sequence);
    const session = this.store.getThreadVoiceSession(sessionId);
    if (!session || dropped.authorId !== session.ownerUserId) {
      this.logger.warn(
        { threadVoiceId: sessionId, sequence: dropped.sequence, authorId: dropped.authorId },
        "thread voice dropped segment rejected: author does not match owner"
      );
      void this.releaseIfIdle(sessionId);
      return;
    }
    const now = this.now();
    this.store.recordDroppedThreadVoiceSegment({
      id: newThreadVoiceSegmentId(),
      sessionId,
      sequence: dropped.sequence,
      authorId: dropped.authorId,
      transcript: "",
      state: dropped.state,
      audioMs: dropped.audioMs,
      dispatchId: null,
      capturedStartedUtc: dropped.capturedStartedUtc,
      capturedEndedUtc: dropped.capturedEndedUtc,
      createdUtc: now,
      updatedUtc: now,
      error: dropped.error ?? null,
    });
    void this.releaseIfIdle(sessionId);
  }

  private toDispatchRequest(batch: ThreadVoiceBatch): ThreadVoiceDispatchRequest {
    return {
      id: batch.dispatchId,
      target: batch.session.channelRef,
      prompt: batch.prompt,
      authorId: batch.session.ownerUserId,
      authorName: batch.session.ownerName,
      threadVoiceSessionId: batch.session.id,
      createdUtc: this.now(),
    };
  }
}

function threadKey(session: Pick<ThreadVoiceSession, "platform" | "channelRef">): string {
  return `${session.platform}:${session.channelRef}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
