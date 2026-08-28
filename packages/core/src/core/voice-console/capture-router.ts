/**
 * Shared Voice Console capture policy.
 *
 * This module has no Discord or Gemini dependencies. Package A supplies the
 * transactional snapshot/commit/drop port; the Discord host supplies capture
 * lifecycle callbacks. Raw audio never crosses this boundary.
 */

export type VoiceConsoleSpeakerLaneState =
  | "ready"
  | "awaiting_safe_mute"
  | "arming"
  | "capturing"
  | "finalizing";

export type VoiceConsoleCaptureDropReason =
  | "input_off"
  | "speaker_left"
  | "speaker_unauthorized"
  | "unsafe_rebind"
  | "arm_cancelled"
  | "arm_failed"
  | "capture_dropped"
  | "transcribe_failed"
  | "host_failed"
  | "router_closed";

export interface VoiceConsoleCaptureTarget {
  bindingId: string;
  sequence: number;
}

/** Draft returned by Package A's transactional edge-time allocator. */
export interface VoiceConsoleCaptureSnapshotDraft {
  consoleId: string;
  captureId: string;
  fanoutGroupId?: string | null;
  consoleRevision: number;
  speakerId: string;
  speakerName: string;
  capturedStartedUtc: string;
  targets: ReadonlyArray<VoiceConsoleCaptureTarget>;
}

/** Frozen copy retained for the complete lifetime of one logical utterance. */
export interface VoiceConsoleCaptureSnapshot
  extends Omit<VoiceConsoleCaptureSnapshotDraft, "targets"> {
  readonly targets: ReadonlyArray<Readonly<VoiceConsoleCaptureTarget>>;
}

export interface VoiceConsoleBindingCommitResult {
  bindingId: string;
  sequence: number;
  status: "committed" | "dropped" | "failed";
  segmentId?: string;
  error?: string;
}

export interface VoiceConsoleCaptureCommit {
  /** Stable idempotency key repeated outside the immutable snapshot for adapters. */
  captureId: string;
  snapshot: VoiceConsoleCaptureSnapshot;
  transcript: string;
  audioMs: number;
  /** Cumulative PCM accepted by Gemini for this speaker capture, never fan-out multiplied. */
  forwardedBytes: number;
  /** Integer duration derived from the cumulative 16 kHz mono s16 PCM bytes. */
  forwardedAudioMs: number;
  capturedEndedUtc: string;
  source: "live" | "unary";
}

export interface VoiceConsoleCaptureDrop {
  /** Stable idempotency key repeated outside the immutable snapshot for adapters. */
  captureId: string;
  snapshot: VoiceConsoleCaptureSnapshot;
  reason: VoiceConsoleCaptureDropReason;
  audioMs: number;
  /** Cumulative PCM accepted by Gemini for this speaker capture, never fan-out multiplied. */
  forwardedBytes: number;
  /** Integer duration derived from the cumulative 16 kHz mono s16 PCM bytes. */
  forwardedAudioMs: number;
  capturedEndedUtc: string;
  source?: "live" | "unary";
  error?: string;
}

export interface VoiceConsoleCapturePersistencePort {
  /**
   * Atomically snapshots current targets and allocates every binding-local
   * sequence. Null means Input off/no valid targets and allocates nothing.
   */
  snapshotCapture(input: {
    speakerId: string;
    speakerName: string;
    capturedStartedUtc: string;
  }): Promise<VoiceConsoleCaptureSnapshotDraft | null>;
  /** One call per STT winner; Package A returns binding-local fan-out results. */
  commitCapture(
    input: VoiceConsoleCaptureCommit
  ): Promise<ReadonlyArray<VoiceConsoleBindingCommitResult>>;
  /** Settles every allocated target without creating a prompt. */
  dropCapture(input: VoiceConsoleCaptureDrop): Promise<void>;
}

export interface VoiceConsoleArmedCapture {
  captureId: string;
  speakerId: string;
  speakerName: string;
  snapshot: VoiceConsoleCaptureSnapshot;
}

export type VoiceConsoleCaptureOutcome =
  | {
      ok: true;
      transcript: string;
      audioMs: number;
      capturedEndedUtc: string;
      source: "live" | "unary";
    }
  | {
      ok: false;
      reason: "capture_dropped" | "transcribe_failed" | "host_failed";
      audioMs: number;
      capturedEndedUtc: string;
      source?: "live" | "unary";
      error?: string;
    };

export type VoiceConsoleCaptureSettlement =
  | {
      status: "committed";
      captureId: string;
      results: ReadonlyArray<VoiceConsoleBindingCommitResult>;
    }
  | { status: "dropped"; captureId: string; reason: VoiceConsoleCaptureDropReason }
  | { status: "failed"; captureId: string; error: string }
  | { status: "ignored"; captureId: string };

export interface VoiceConsoleSpeakerLaneSnapshot {
  userId: string;
  speakerName: string;
  selfMuted: boolean;
  state: VoiceConsoleSpeakerLaneState;
  captureId?: string;
  transportEpoch: number;
}

export interface VoiceConsoleCaptureRouterCallbacks {
  onCaptureArmed: (capture: VoiceConsoleArmedCapture) => void | Promise<void>;
  onCaptureFinalize: (capture: VoiceConsoleArmedCapture) => void | Promise<void>;
  /** Observer fired once when the logical capture enters bounded finalization. */
  onCaptureFinalizing?: (capture: VoiceConsoleArmedCapture) => void;
  onCaptureAbort: (
    capture: VoiceConsoleArmedCapture,
    reason: VoiceConsoleCaptureDropReason
  ) => void | Promise<void>;
  onInterim?: (capture: VoiceConsoleArmedCapture, text: string) => void;
  onForwardedBytes?: (event: {
    capture: VoiceConsoleArmedCapture;
    bytes: number;
    totalBytes: number;
  }) => void;
  onSettled?: (settlement: VoiceConsoleCaptureSettlement) => void;
  onError?: (error: Error, context: string) => void;
}

type Lane = {
  userId: string;
  speakerName: string;
  selfMuted: boolean;
  state: VoiceConsoleSpeakerLaneState;
  generation: number;
  transportEpoch: number;
  captureId?: string;
};

type CaptureRecord = {
  capture: VoiceConsoleArmedCapture;
  forwardedBytes: number;
  decision?: "commit" | "drop";
  settlement?: Promise<VoiceConsoleCaptureSettlement>;
};

const MAX_CAPTURE_TARGETS = 5;
const SETTLED_CAPTURE_CACHE = 512;
const PCM16K_MONO_S16_BYTES_PER_MS = 32;

export class VoiceConsoleCaptureRouter {
  private readonly persistence: VoiceConsoleCapturePersistencePort;
  private readonly isAllowedUser: (userId: string) => boolean;
  private readonly callbacks: VoiceConsoleCaptureRouterCallbacks;
  private readonly now: () => string;
  private readonly lanes = new Map<string, Lane>();
  private readonly captures = new Map<string, CaptureRecord>();
  private readonly settledCaptureIds = new Set<string>();
  private readonly settledCaptureOrder: string[] = [];
  private inputActive: boolean;
  private stopped = false;
  private totalForwardedBytes = 0;

  constructor(opts: {
    persistence: VoiceConsoleCapturePersistencePort;
    isAllowedUser: (userId: string) => boolean;
    callbacks: VoiceConsoleCaptureRouterCallbacks;
    inputActive?: boolean;
    now?: () => string;
  }) {
    this.persistence = opts.persistence;
    this.isAllowedUser = opts.isAllowedUser;
    this.callbacks = opts.callbacks;
    this.inputActive = opts.inputActive ?? false;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  get forwardedBytes(): number {
    return this.totalForwardedBytes;
  }

  get activeLaneCount(): number {
    let active = 0;
    for (const lane of this.lanes.values()) {
      if (lane.state === "arming" || lane.state === "capturing" || lane.state === "finalizing") {
        active += 1;
      }
    }
    return active;
  }

  get inputEnabled(): boolean {
    return this.inputActive;
  }

  listLanes(): VoiceConsoleSpeakerLaneSnapshot[] {
    return [...this.lanes.values()]
      .map((lane) => this.laneSnapshot(lane))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  getLane(userId: string): VoiceConsoleSpeakerLaneSnapshot | undefined {
    const lane = this.lanes.get(userId);
    return lane ? this.laneSnapshot(lane) : undefined;
  }

  speakerPresent(input: {
    userId: string;
    speakerName: string;
    selfMuted: boolean;
  }): boolean {
    if (this.stopped || !this.isAllowedUser(input.userId)) return false;
    const current = this.lanes.get(input.userId);
    if (current) {
      current.speakerName = input.speakerName;
      current.selfMuted = input.selfMuted;
      return true;
    }
    this.lanes.set(input.userId, {
      userId: input.userId,
      speakerName: input.speakerName,
      selfMuted: input.selfMuted,
      state: input.selfMuted ? "ready" : "awaiting_safe_mute",
      generation: 0,
      transportEpoch: 0,
    });
    return true;
  }

  async speakerLeft(userId: string): Promise<void> {
    const lane = this.lanes.get(userId);
    if (!lane) return;
    lane.generation += 1;
    const record = lane.captureId ? this.captures.get(lane.captureId) : undefined;
    lane.captureId = undefined;
    this.lanes.delete(userId);
    if (record) await this.dropRecord(record, "speaker_left", true);
  }

  /**
   * Rebinds transport identity without creating another user lane. Unknown
   * continuity aborts the current capture and reapplies fresh-safe-mute rules.
   */
  async rebindSpeaker(input: {
    userId: string;
    speakerName: string;
    selfMuted: boolean;
    continuityProven: boolean;
  }): Promise<boolean> {
    if (this.stopped || !this.isAllowedUser(input.userId)) {
      await this.refreshAuthorization(input.userId);
      return false;
    }
    this.speakerPresent(input);
    const lane = this.lanes.get(input.userId)!;
    lane.speakerName = input.speakerName;
    lane.selfMuted = input.selfMuted;
    lane.transportEpoch += 1;
    if (input.continuityProven) return true;

    lane.generation += 1;
    const record = lane.captureId ? this.captures.get(lane.captureId) : undefined;
    lane.captureId = undefined;
    lane.state = input.selfMuted ? "ready" : "awaiting_safe_mute";
    if (record) await this.dropRecord(record, "unsafe_rebind", true);
    return true;
  }

  async setSpeakerMuted(input: {
    userId: string;
    speakerName?: string;
    selfMuted: boolean;
  }): Promise<void> {
    if (this.stopped) return;
    if (!this.isAllowedUser(input.userId)) {
      await this.refreshAuthorization(input.userId);
      return;
    }
    if (!this.lanes.has(input.userId)) {
      this.speakerPresent({
        userId: input.userId,
        speakerName: input.speakerName ?? input.userId,
        selfMuted: input.selfMuted,
      });
      return;
    }
    const lane = this.lanes.get(input.userId)!;
    if (input.speakerName) lane.speakerName = input.speakerName;
    const priorMuted = lane.selfMuted;
    lane.selfMuted = input.selfMuted;
    if (priorMuted === input.selfMuted) return;

    if (input.selfMuted) {
      if (lane.state === "arming") {
        lane.generation += 1;
        lane.state = "ready";
        return;
      }
      if (lane.state === "capturing" && lane.captureId) {
        const record = this.captures.get(lane.captureId);
        if (!record || record.decision) return;
        lane.state = "finalizing";
        this.safeCallback(() => this.callbacks.onCaptureFinalizing?.(record.capture));
        try {
          await this.callbacks.onCaptureFinalize(record.capture);
        } catch (err) {
          this.reportError(err, "capture finalize callback");
          await this.dropRecord(record, "host_failed", true, errorMessage(err));
        }
        return;
      }
      if (lane.state === "awaiting_safe_mute") lane.state = "ready";
      return;
    }

    if (lane.state !== "ready") return;
    if (!this.inputActive) {
      lane.state = "awaiting_safe_mute";
      return;
    }
    await this.armLane(lane);
  }

  /** Input off is the only target change that invalidates current snapshots. */
  async setInputEnabled(enabled: boolean): Promise<void> {
    if (this.stopped || this.inputActive === enabled) return;
    this.inputActive = enabled;
    if (enabled) {
      for (const lane of this.lanes.values()) {
        lane.state = lane.selfMuted ? "ready" : "awaiting_safe_mute";
      }
      return;
    }

    const drops: Promise<VoiceConsoleCaptureSettlement>[] = [];
    for (const lane of this.lanes.values()) {
      if (lane.state === "arming") lane.generation += 1;
      const record = lane.captureId ? this.captures.get(lane.captureId) : undefined;
      lane.captureId = undefined;
      lane.state = lane.selfMuted ? "ready" : "awaiting_safe_mute";
      if (record) drops.push(this.dropRecord(record, "input_off", true));
    }
    await Promise.all(drops);
  }

  /** Re-evaluate a dynamic DISCORD_ALLOWED_USER_IDS set. */
  async refreshAuthorization(userId?: string): Promise<void> {
    const ids = userId ? [userId] : [...this.lanes.keys()];
    for (const id of ids) {
      const lane = this.lanes.get(id);
      if (!lane || this.isAllowedUser(id)) continue;
      lane.generation += 1;
      const record = lane.captureId ? this.captures.get(lane.captureId) : undefined;
      lane.captureId = undefined;
      this.lanes.delete(id);
      if (record) await this.dropRecord(record, "speaker_unauthorized", true);
    }
  }

  canSubscribe(userId: string): boolean {
    return this.canForward(userId);
  }

  canForward(userId: string, captureId?: string): boolean {
    if (this.stopped || !this.inputActive || !this.isAllowedUser(userId)) return false;
    const lane = this.lanes.get(userId);
    if (!lane || lane.selfMuted || lane.state !== "capturing" || !lane.captureId) return false;
    return captureId === undefined || captureId === lane.captureId;
  }

  reportInterim(captureId: string, text: string): void {
    const record = this.captures.get(captureId);
    if (!record || record.decision || !text.trim()) return;
    this.safeCallback(() => this.callbacks.onInterim?.(record.capture, text.trim()));
  }

  recordForwardedBytes(userId: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const lane = this.lanes.get(userId);
    const record = lane?.captureId ? this.captures.get(lane.captureId) : undefined;
    if (!lane || !record || record.decision || !this.isAllowedUser(userId)) return;
    const wholeBytes = Math.trunc(bytes);
    record.forwardedBytes += wholeBytes;
    this.totalForwardedBytes += wholeBytes;
    this.safeCallback(() =>
      this.callbacks.onForwardedBytes?.({
        capture: record.capture,
        bytes: wholeBytes,
        totalBytes: this.totalForwardedBytes,
      })
    );
  }

  settleCapture(
    captureId: string,
    outcome: VoiceConsoleCaptureOutcome
  ): Promise<VoiceConsoleCaptureSettlement> {
    const record = this.captures.get(captureId);
    if (!record) {
      return Promise.resolve({ status: "ignored", captureId });
    }
    if (record.settlement) return record.settlement;
    if (record.decision) return Promise.resolve({ status: "ignored", captureId });

    const transcript = outcome.ok ? outcome.transcript.trim() : "";
    if (!this.isAllowedUser(record.capture.speakerId)) {
      return this.dropRecord(
        record,
        "speaker_unauthorized",
        true,
        "speaker removed from DISCORD_ALLOWED_USER_IDS before final commit",
        outcome.audioMs,
        outcome.capturedEndedUtc
      );
    }
    if (!outcome.ok || !transcript) {
      return this.dropRecord(
        record,
        outcome.ok ? "capture_dropped" : outcome.reason,
        false,
        outcome.ok ? undefined : outcome.error,
        outcome.audioMs,
        outcome.capturedEndedUtc,
        outcome.ok ? undefined : outcome.source
      );
    }

    record.decision = "commit";
    const forwardedBytes = record.forwardedBytes;
    record.settlement = this.persistence
      .commitCapture({
        captureId,
        snapshot: record.capture.snapshot,
        transcript,
        audioMs: nonNegativeInt(outcome.audioMs),
        forwardedBytes,
        forwardedAudioMs: forwardedPcmDurationMs(forwardedBytes),
        capturedEndedUtc: outcome.capturedEndedUtc,
        source: outcome.source,
      })
      .then((results): VoiceConsoleCaptureSettlement => ({
        status: "committed",
        captureId,
        results: Object.freeze(results.map((result) => Object.freeze({ ...result }))),
      }))
      .catch((err): VoiceConsoleCaptureSettlement => ({
        status: "failed",
        captureId,
        error: errorMessage(err),
      }))
      .then((settlement) => this.finishRecord(record, settlement));
    return record.settlement;
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const drops: Promise<VoiceConsoleCaptureSettlement>[] = [];
    for (const lane of this.lanes.values()) {
      lane.generation += 1;
      const record = lane.captureId ? this.captures.get(lane.captureId) : undefined;
      lane.captureId = undefined;
      if (record) drops.push(this.dropRecord(record, "router_closed", true));
    }
    this.lanes.clear();
    await Promise.all(drops);
  }

  private async armLane(lane: Lane): Promise<void> {
    lane.generation += 1;
    const generation = lane.generation;
    lane.state = "arming";
    const startedUtc = this.now();
    let draft: VoiceConsoleCaptureSnapshotDraft | null = null;
    try {
      draft = await this.persistence.snapshotCapture({
        speakerId: lane.userId,
        speakerName: lane.speakerName,
        capturedStartedUtc: startedUtc,
      });
      if (!draft) {
        if (lane.generation === generation) lane.state = "awaiting_safe_mute";
        return;
      }
      const snapshot = freezeSnapshot(draft, lane.userId);
      if (
        this.stopped ||
        lane.generation !== generation ||
        lane.selfMuted ||
        !this.inputActive ||
        !this.isAllowedUser(lane.userId)
      ) {
        await this.dropOrphanSnapshot(snapshot, "arm_cancelled");
        return;
      }
      const capture: VoiceConsoleArmedCapture = Object.freeze({
        captureId: snapshot.captureId,
        speakerId: snapshot.speakerId,
        speakerName: snapshot.speakerName,
        snapshot,
      });
      const record: CaptureRecord = {
        capture,
        forwardedBytes: 0,
      };
      if (this.captures.has(capture.captureId) || this.settledCaptureIds.has(capture.captureId)) {
        throw new Error(`duplicate voice-console capture id: ${capture.captureId}`);
      }
      this.captures.set(capture.captureId, record);
      lane.captureId = capture.captureId;
      lane.state = "capturing";
      try {
        await this.callbacks.onCaptureArmed(capture);
      } catch (err) {
        this.reportError(err, "capture arm callback");
        await this.dropRecord(record, "arm_failed", true, errorMessage(err));
      }
    } catch (err) {
      this.reportError(err, "capture snapshot/arm");
      if (draft) {
        try {
          await this.dropOrphanSnapshot(freezeSnapshot(draft, lane.userId), "arm_failed", errorMessage(err));
        } catch (dropErr) {
          this.reportError(dropErr, "invalid capture snapshot cleanup");
        }
      }
      if (lane.generation === generation && lane.state === "arming") {
        lane.state = lane.selfMuted ? "ready" : "awaiting_safe_mute";
      }
    }
  }

  private dropRecord(
    record: CaptureRecord,
    reason: VoiceConsoleCaptureDropReason,
    notifyHost: boolean,
    error?: string,
    audioMs = 0,
    capturedEndedUtc = this.now(),
    source?: "live" | "unary"
  ): Promise<VoiceConsoleCaptureSettlement> {
    if (record.settlement) return record.settlement;
    if (record.decision) {
      return Promise.resolve({ status: "ignored", captureId: record.capture.captureId });
    }
    record.decision = "drop";
    const hostAbort = notifyHost
      ? Promise.resolve().then(() => this.callbacks.onCaptureAbort(record.capture, reason)).catch((err) => {
          this.reportError(err, "capture abort callback");
        })
      : Promise.resolve();
    const durableDrop = Promise.resolve().then(() =>
      this.persistence.dropCapture({
        captureId: record.capture.captureId,
        snapshot: record.capture.snapshot,
        reason,
        audioMs: nonNegativeInt(audioMs),
        forwardedBytes: record.forwardedBytes,
        forwardedAudioMs: forwardedPcmDurationMs(record.forwardedBytes),
        capturedEndedUtc,
        ...(source ? { source } : {}),
        ...(error ? { error } : {}),
      })
    );
    record.settlement = Promise.all([
      hostAbort,
      durableDrop,
    ])
      .then((): VoiceConsoleCaptureSettlement => ({
        status: "dropped",
        captureId: record.capture.captureId,
        reason,
      }))
      .catch((err): VoiceConsoleCaptureSettlement => ({
        status: "failed",
        captureId: record.capture.captureId,
        error: errorMessage(err),
      }))
      .then((settlement) => this.finishRecord(record, settlement));
    return record.settlement;
  }

  private async dropOrphanSnapshot(
    snapshot: VoiceConsoleCaptureSnapshot,
    reason: VoiceConsoleCaptureDropReason,
    error?: string
  ): Promise<void> {
    await this.persistence.dropCapture({
      captureId: snapshot.captureId,
      snapshot,
      reason,
      audioMs: 0,
      forwardedBytes: 0,
      forwardedAudioMs: 0,
      capturedEndedUtc: this.now(),
      ...(error ? { error } : {}),
    });
    const settlement: VoiceConsoleCaptureSettlement = {
      status: "dropped",
      captureId: snapshot.captureId,
      reason,
    };
    this.rememberSettled(snapshot.captureId);
    this.safeCallback(() => this.callbacks.onSettled?.(settlement));
  }

  private finishRecord(
    record: CaptureRecord,
    settlement: VoiceConsoleCaptureSettlement
  ): VoiceConsoleCaptureSettlement {
    const captureId = record.capture.captureId;
    this.captures.delete(captureId);
    this.rememberSettled(captureId);
    const lane = this.lanes.get(record.capture.speakerId);
    if (lane?.captureId === captureId) {
      lane.captureId = undefined;
      lane.state = lane.selfMuted && this.inputActive ? "ready" : "awaiting_safe_mute";
    }
    this.safeCallback(() => this.callbacks.onSettled?.(settlement));
    return settlement;
  }

  private rememberSettled(captureId: string): void {
    if (this.settledCaptureIds.has(captureId)) return;
    this.settledCaptureIds.add(captureId);
    this.settledCaptureOrder.push(captureId);
    while (this.settledCaptureOrder.length > SETTLED_CAPTURE_CACHE) {
      const oldest = this.settledCaptureOrder.shift();
      if (oldest) this.settledCaptureIds.delete(oldest);
    }
  }

  private laneSnapshot(lane: Lane): VoiceConsoleSpeakerLaneSnapshot {
    return {
      userId: lane.userId,
      speakerName: lane.speakerName,
      selfMuted: lane.selfMuted,
      state: lane.state,
      ...(lane.captureId ? { captureId: lane.captureId } : {}),
      transportEpoch: lane.transportEpoch,
    };
  }

  private safeCallback(callback: () => void): void {
    try {
      callback();
    } catch (err) {
      this.reportError(err, "capture router observer");
    }
  }

  private reportError(err: unknown, context: string): void {
    try {
      this.callbacks.onError?.(
        err instanceof Error ? err : new Error(errorMessage(err)),
        context
      );
    } catch {
      // Error reporting cannot change capture safety.
    }
  }
}

function forwardedPcmDurationMs(bytes: number): number {
  return Math.floor(nonNegativeInt(bytes) / PCM16K_MONO_S16_BYTES_PER_MS);
}

function freezeSnapshot(
  draft: VoiceConsoleCaptureSnapshotDraft,
  expectedSpeakerId: string
): VoiceConsoleCaptureSnapshot {
  if (!draft.consoleId.trim() || !draft.captureId.trim()) {
    throw new Error("voice-console capture snapshot requires consoleId and captureId");
  }
  if (draft.speakerId !== expectedSpeakerId) {
    throw new Error("voice-console capture snapshot speaker mismatch");
  }
  if (!Number.isSafeInteger(draft.consoleRevision) || draft.consoleRevision < 0) {
    throw new Error("voice-console capture snapshot revision must be a non-negative integer");
  }
  if (draft.targets.length < 1 || draft.targets.length > MAX_CAPTURE_TARGETS) {
    throw new Error("voice-console capture snapshot must contain one through five targets");
  }
  const seen = new Set<string>();
  const targets = draft.targets.map((target) => {
    if (!target.bindingId.trim() || !Number.isSafeInteger(target.sequence) || target.sequence < 1) {
      throw new Error("voice-console capture target is invalid");
    }
    if (seen.has(target.bindingId)) {
      throw new Error("voice-console capture snapshot contains duplicate bindings");
    }
    seen.add(target.bindingId);
    return Object.freeze({ bindingId: target.bindingId, sequence: target.sequence });
  });
  return Object.freeze({
    consoleId: draft.consoleId,
    captureId: draft.captureId,
    fanoutGroupId: draft.fanoutGroupId ?? null,
    consoleRevision: draft.consoleRevision,
    speakerId: draft.speakerId,
    speakerName: draft.speakerName,
    capturedStartedUtc: draft.capturedStartedUtc,
    targets: Object.freeze(targets),
  });
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}
