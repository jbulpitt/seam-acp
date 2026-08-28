import type { Logger } from "../../lib/logger.js";
import type { SessionStore } from "../session-store.js";
import { VoiceLeaseManager, type VoiceLease } from "../voice-lease.js";
import type {
  AddVoiceConsoleBindingInput,
  CreateVoiceConsoleInput,
  ThreadVoiceBinding,
  VoiceConsoleBootResult,
  VoiceConsoleCaptureCommitResult,
  VoiceConsoleDispatchHost,
  VoiceConsoleDispatchRequest,
  VoiceConsoleFinalCapture,
  VoiceConsoleMutationOutcome,
  VoiceConsoleRemoveResult,
  VoiceConsoleRuntimeHost,
  VoiceConsoleSession,
  VoiceConsoleStartResult,
  VoiceConsoleUpgradeDefaults,
} from "./types.js";

export class VoiceConsoleManager {
  private readonly store: SessionStore;
  private readonly logger: Logger;
  private readonly host: VoiceConsoleRuntimeHost;
  private readonly dispatch: VoiceConsoleDispatchHost;
  private readonly leases: VoiceLeaseManager;
  private readonly now: () => string;
  private readonly releaseRuns = new Map<string, Promise<boolean>>();
  private readonly releaseRequested = new Set<string>();
  /** Linearization barrier for remove/stop versus an already-running release. */
  private readonly releaseBlocked = new Set<string>();
  private readonly activeDispatchByBinding = new Map<string, string>();

  constructor(opts: {
    store: SessionStore;
    logger: Logger;
    host: VoiceConsoleRuntimeHost;
    dispatch: VoiceConsoleDispatchHost;
    leases: VoiceLeaseManager;
    now?: () => string;
  }) {
    this.store = opts.store;
    this.logger = opts.logger.child({ comp: "voice-console" });
    this.host = opts.host;
    this.dispatch = opts.dispatch;
    this.leases = opts.leases;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Package E performs Discord permission/owner preflight before this call. */
  async start(input: CreateVoiceConsoleInput): Promise<VoiceConsoleStartResult> {
    const acquired = this.acquireConsoleLease(input.console);
    if (!acquired.ok) return { ok: false, error: acquired.error };
    try {
      this.store.createVoiceConsole(input);
    } catch (err) {
      this.leases.release(acquired.lease);
      return { ok: false, error: errorMessage(err) };
    }

    try {
      const started = await this.host.startConsole(input.console, [input.binding]);
      if (!started.ok) throw new Error(started.reason);
      const console = this.store.markVoiceConsoleReady(input.console.id, this.now());
      const binding = this.store.getVoiceConsoleBinding(input.binding.id);
      if (!console || !binding) throw new Error("Voice Console disappeared during startup.");
      return { ok: true, console, binding };
    } catch (err) {
      const reason = errorMessage(err);
      await this.host.stopConsole(input.console.id, reason).catch(() => undefined);
      this.store.finishVoiceConsoleStop(input.console.id, "failed", reason, this.now());
      this.leases.release(acquired.lease);
      return { ok: false, error: reason };
    }
  }

  async addBinding(input: AddVoiceConsoleBindingInput): Promise<VoiceConsoleMutationOutcome> {
    const outcome = this.store.addVoiceConsoleBinding(input);
    if (!outcome.ok || !outcome.value.applied) return outcome;
    const console = outcome.value.console;
    const binding = this.store.getVoiceConsoleBinding(input.binding.id);
    if (!binding) throw new Error("Voice Console binding disappeared after add.");
    let attachAttempted = false;
    try {
      attachAttempted = true;
      const attached = await this.host.addBinding(console, binding);
      if (!attached.ok) throw new Error(attached.reason);
      const activated = this.store.activateVoiceConsoleBinding(binding.id, {
        expectedRevision: console.revision,
        claim: input.claim,
        updatedUtc: this.now(),
      });
      if (activated.ok) return activated;
      throw new Error(activated.error);
    } catch (err) {
      const reason = errorMessage(err);
      const failedUtc = this.now();
      try {
        this.store.failStagedVoiceConsoleBinding(binding.id, reason, failedUtc);
      } catch (cleanupErr) {
        this.logger.error(
          { err: cleanupErr, bindingId: binding.id },
          "voice console staged binding terminalization failed"
        );
        try {
          this.store.finishVoiceConsoleBindingRemoval(binding.id, "failed", reason, failedUtc);
        } catch (fallbackErr) {
          this.logger.error(
            { err: fallbackErr, bindingId: binding.id },
            "voice console staged binding terminalization fallback failed"
          );
        }
      }
      if (attachAttempted) {
        try {
          await this.host.stopBinding(binding.id, reason);
        } catch (cleanupErr) {
          this.logger.warn(
            { err: cleanupErr, bindingId: binding.id },
            "voice console binding detach cleanup failed"
          );
        }
      }
      throw new Error(reason);
    }
  }

  allocateCapture(input: Parameters<SessionStore["allocateVoiceConsoleCapture"]>[0]) {
    return this.store.allocateVoiceConsoleCapture(input);
  }

  commitCapture(final: VoiceConsoleFinalCapture): VoiceConsoleCaptureCommitResult {
    const result = this.store.finalizeVoiceConsoleCapture(final);
    for (const segment of [...result.committed, ...result.dropped]) {
      void this.releaseIfIdle(segment.bindingId);
    }
    return {
      captureId: final.captureId,
      committed: result.committed,
      dropped: result.dropped,
      failures: result.failures,
    };
  }

  /** Input-off safety path: durable terminal outcomes unblock every sequence. */
  dropActiveCaptures(consoleId: string, reason = "input disabled") {
    const dropped = this.store.dropActiveVoiceConsoleCaptures(consoleId, reason, this.now());
    for (const bindingId of new Set(dropped.map((segment) => segment.bindingId))) {
      void this.releaseIfIdle(bindingId);
    }
    return dropped;
  }

  releaseIfIdle(bindingId: string): Promise<boolean> {
    const existing = this.releaseRuns.get(bindingId);
    if (existing) {
      this.releaseRequested.add(bindingId);
      return existing;
    }
    const run = this.releaseIfIdleInner(bindingId).finally(() => {
      this.releaseRuns.delete(bindingId);
      if (this.releaseRequested.delete(bindingId)) void this.releaseIfIdle(bindingId);
    });
    this.releaseRuns.set(bindingId, run);
    return run;
  }

  private async releaseIfIdleInner(bindingId: string): Promise<boolean> {
    if (this.releaseBlocked.has(bindingId)) return false;
    const binding = this.store.getVoiceConsoleBinding(bindingId);
    if (!binding || this.activeDispatchByBinding.has(bindingId)) return false;
    if (await this.dispatch.isBindingBusy(binding)) return false;
    await this.host.waitForBindingSpeechIdle(bindingId);
    if (this.releaseBlocked.has(bindingId) || this.activeDispatchByBinding.has(bindingId)) return false;
    if (await this.dispatch.isBindingBusy(binding)) return false;

    const batch = this.store.claimPendingVoiceConsoleBatch(bindingId);
    if (!batch) return false;
    try {
      const artifact = await this.dispatch.inspectArtifact(batch.dispatchId);
      // Removal/stop can linearize while artifact inspection is awaiting I/O.
      if (this.releaseBlocked.has(bindingId)) return false;
      if (artifact === "missing") await this.dispatch.enqueue(this.toDispatchRequest(batch));
      this.store.markThreadVoiceBatchDispatched(batch.dispatchId, this.now());
      if (artifact !== "done") this.activeDispatchByBinding.set(bindingId, batch.dispatchId);
      this.logger.info(
        {
          consoleId: binding.consoleId,
          bindingId,
          dispatchId: batch.dispatchId,
          segmentCount: batch.segments.length,
          speakerId: batch.authorId,
        },
        "voice console binding batch dispatched"
      );
      return true;
    } catch (err) {
      this.store.markThreadVoiceBatchError(batch.dispatchId, errorMessage(err), this.now());
      this.logger.warn(
        { err, consoleId: binding.consoleId, bindingId, dispatchId: batch.dispatchId },
        "voice console dispatch enqueue failed; batch left for recovery"
      );
      return false;
    }
  }

  /** Integration calls this only after this binding's ACP and accepted speech drain. */
  async markDispatchSettled(bindingId: string, dispatchId: string): Promise<void> {
    await this.host.waitForBindingSpeechIdle(bindingId).catch((err) => {
      this.logger.warn({ err, bindingId }, "voice console binding speech drain failed");
    });
    if (this.activeDispatchByBinding.get(bindingId) === dispatchId) {
      this.activeDispatchByBinding.delete(bindingId);
    }
    await this.markBindingActivitySettled(bindingId);
  }

  /**
   * Package E calls this after every visible binding turn path settles—not only
   * Thread Voice artifacts. The host drain is intentionally origin-agnostic.
   */
  async markBindingActivitySettled(bindingId: string): Promise<boolean> {
    await this.host.waitForBindingSpeechIdle(bindingId);
    return this.releaseIfIdle(bindingId);
  }

  async removeBinding(
    bindingId: string,
    opts: {
      expectedRevision: number;
      discardPending?: boolean;
      interactionId?: string;
      reason?: string;
    }
  ): Promise<VoiceConsoleRemoveResult> {
    const binding = this.store.getVoiceConsoleBinding(bindingId);
    if (!binding) return { ok: false, error: "Voice Console binding does not exist." };
    const reason = opts.reason ?? "binding removed";
    this.releaseBlocked.add(bindingId);
    try {
      const began = this.store.beginVoiceConsoleBindingRemoval(bindingId, {
        expectedRevision: opts.expectedRevision,
        interactionId: opts.interactionId,
        reason,
        updatedUtc: this.now(),
      });
      if (!began.ok) return { ok: false, error: began.error };
      await this.host.stopBinding(bindingId, reason);
      await this.releaseRuns.get(bindingId);
      const discarded = opts.discardPending
        ? await this.discardArtifactFreeBindingText(bindingId)
        : await this.preparePreservedBindingText(bindingId).then(() => 0);
      this.store.finishVoiceConsoleBindingRemoval(bindingId, "ended", reason, this.now());
      const remaining = this.store.listVoiceConsoleBindings(binding.consoleId);
      const consoleEnded = remaining.length === 0;
      if (consoleEnded) {
        const console = this.store.getVoiceConsole(binding.consoleId);
        if (console && console.status !== "ended" && console.status !== "failed") {
          await this.stopConsole(binding.consoleId, {
            expectedRevision: began.value.console.revision,
            reason: "last binding removed",
          });
        }
      }
      this.releaseBlocked.delete(bindingId);
      if (!opts.discardPending) await this.releaseIfIdle(bindingId);
      return { ok: true, discarded, consoleEnded };
    } catch (err) {
      this.store.finishVoiceConsoleBindingRemoval(bindingId, "failed", errorMessage(err), this.now());
      return { ok: false, error: errorMessage(err) };
    } finally {
      this.releaseBlocked.delete(bindingId);
    }
  }

  async stopConsole(
    consoleId: string,
    opts: {
      expectedRevision?: number;
      discardPending?: boolean;
      interactionId?: string;
      reason?: string;
    } = {}
  ): Promise<
    | { ok: true; discarded: number; duplicate?: true }
    | { ok: false; error: string }
  > {
    const console = this.store.getVoiceConsole(consoleId);
    if (!console) return { ok: false, error: "Voice Console does not exist." };
    const replay = this.store.getVoiceConsoleInteractionReplay(consoleId, opts.interactionId);
    if (replay?.ok) return { ok: true, discarded: 0, duplicate: true };
    if (console.status === "ended" || console.status === "failed") {
      return { ok: false, error: "Voice Console has already ended." };
    }
    const bindings = this.store.listVoiceConsoleBindings(consoleId);
    bindings.forEach((binding) => this.releaseBlocked.add(binding.id));
    const reason = opts.reason ?? "console stopped";
    try {
      const began = this.store.beginVoiceConsoleStop(consoleId, {
        expectedRevision: opts.expectedRevision,
        interactionId: opts.interactionId,
        reason,
        updatedUtc: this.now(),
      });
      if (!began.ok) return { ok: false, error: began.error };
      await this.host.stopConsole(consoleId, reason);
      await Promise.all(bindings.map((binding) => this.releaseRuns.get(binding.id)));
      let discarded = 0;
      if (opts.discardPending) {
        for (const binding of bindings) {
          discarded += await this.discardArtifactFreeBindingText(binding.id);
        }
      } else {
        for (const binding of bindings) {
          await this.preparePreservedBindingText(binding.id);
        }
      }
      this.store.finishVoiceConsoleStop(consoleId, "ended", reason, this.now());
      this.releaseConsoleLease(console);
      bindings.forEach((binding) => this.releaseBlocked.delete(binding.id));
      if (!opts.discardPending) {
        await Promise.all(bindings.map((binding) => this.releaseIfIdle(binding.id)));
      }
      return { ok: true, discarded };
    } catch (err) {
      const message = errorMessage(err);
      this.store.finishVoiceConsoleStop(consoleId, "failed", message, this.now());
      this.releaseConsoleLease(console);
      return { ok: false, error: message };
    } finally {
      bindings.forEach((binding) => this.releaseBlocked.delete(binding.id));
    }
  }

  /**
   * Runs before the dispatch watcher. It upgrades V1 rows, establishes the
   * console lease, and lets Package E install verification/runtime callbacks.
   */
  async reconcileOnBoot(defaults: VoiceConsoleUpgradeDefaults): Promise<VoiceConsoleBootResult> {
    const result: VoiceConsoleBootResult = {
      upgraded: 0,
      reconciled: 0,
      ended: 0,
      dispatchesEnqueued: 0,
      dispatchesFound: 0,
      failures: 0,
    };
    const legacy = this.store.listActiveThreadVoiceSessions();
    const upgraded = this.store.upgradeActiveV1ThreadVoiceSessions(defaults, this.now());
    result.upgraded = upgraded.length;
    this.store.recoverUnfinishedVoiceConsoleCaptures(
      "process restarted before capture finalization",
      this.now()
    );
    for (const old of legacy) {
      this.leases.release({ kind: "thread_voice", sessionId: old.id, guildId: old.guildId });
    }

    for (const console of this.store.listActiveVoiceConsoles()) {
      if (console.status === "stopping") {
        this.store.finishVoiceConsoleStop(console.id, "ended", "process restarted while stopping", this.now());
        this.releaseConsoleLease(console);
        result.ended++;
        continue;
      }
      const acquired = this.acquireConsoleLease(console);
      if (!acquired.ok) {
        this.store.finishVoiceConsoleStop(console.id, "failed", acquired.error, this.now());
        result.failures++;
        continue;
      }
      try {
        const bindings = this.store.listVoiceConsoleBindings(console.id);
        const reconciled = await this.host.reconcileConsole(console, bindings);
        if (!reconciled.ok) throw new Error(reconciled.reason);
        this.store.markVoiceConsoleReady(console.id, this.now());
        result.reconciled++;
      } catch (err) {
        const message = errorMessage(err);
        this.store.finishVoiceConsoleStop(console.id, "failed", message, this.now());
        this.leases.release(acquired.lease);
        result.failures++;
      }
    }

    const dispatchRecovery = await this.recoverDispatches();
    result.dispatchesEnqueued = dispatchRecovery.enqueued;
    result.dispatchesFound = dispatchRecovery.found;
    result.failures += dispatchRecovery.failures;
    return result;
  }

  async recoverDispatches(): Promise<{ enqueued: number; found: number; failures: number }> {
    let enqueued = 0;
    let found = 0;
    let failures = 0;
    const reconciled = new Set<string>();
    for (const batch of this.store.listVoiceConsoleBatchesByState("batched")) {
      reconciled.add(batch.dispatchId);
      try {
        const artifact = await this.dispatch.inspectArtifact(batch.dispatchId);
        if (artifact === "missing") {
          await this.dispatch.enqueue(this.toDispatchRequest(batch));
          enqueued++;
        } else {
          found++;
        }
        this.store.markThreadVoiceBatchDispatched(batch.dispatchId, this.now());
        if (artifact !== "done") this.activeDispatchByBinding.set(batch.binding.id, batch.dispatchId);
      } catch (err) {
        failures++;
        this.store.markThreadVoiceBatchError(batch.dispatchId, errorMessage(err), this.now());
      }
    }
    for (const batch of this.store.listVoiceConsoleBatchesByState("dispatched")) {
      if (reconciled.has(batch.dispatchId)) continue;
      try {
        const artifact = await this.dispatch.inspectArtifact(batch.dispatchId);
        if (artifact === "missing") {
          await this.dispatch.enqueue(this.toDispatchRequest(batch));
          this.activeDispatchByBinding.set(batch.binding.id, batch.dispatchId);
          enqueued++;
        } else if (artifact === "pending" || artifact === "running") {
          this.activeDispatchByBinding.set(batch.binding.id, batch.dispatchId);
          found++;
        } else {
          found++;
        }
      } catch (err) {
        failures++;
        this.logger.warn(
          { err, bindingId: batch.binding.id, dispatchId: batch.dispatchId },
          "voice console dispatched-artifact recovery failed"
        );
      }
    }
    for (const binding of this.store.listVoiceConsoleBindingsWithBufferedSegments()) {
      if (!this.activeDispatchByBinding.has(binding.id)) void this.releaseIfIdle(binding.id);
    }
    return { enqueued, found, failures };
  }

  getActiveDispatchId(bindingId: string): string | undefined {
    return this.activeDispatchByBinding.get(bindingId);
  }

  /** Shutdown releases only in-memory ownership; durable active rows remain recoverable. */
  shutdown(): void {
    for (const console of this.store.listActiveVoiceConsoles()) this.releaseConsoleLease(console);
    this.activeDispatchByBinding.clear();
  }

  private async discardArtifactFreeBindingText(bindingId: string): Promise<number> {
    let discarded = this.store.discardPendingThreadVoiceSegments(bindingId, this.now());
    for (const batch of this.store
      .listVoiceConsoleBatchesByState("batched")
      .filter((candidate) => candidate.binding.id === bindingId)) {
      try {
        if ((await this.dispatch.inspectArtifact(batch.dispatchId)) === "missing") {
          discarded += this.store.discardArtifactFreeThreadVoiceBatch(
            bindingId,
            batch.dispatchId,
            this.now()
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, bindingId, dispatchId: batch.dispatchId },
          "voice console discard artifact inspection failed; preserving batch"
        );
      }
    }
    return discarded;
  }

  /**
   * A preserve teardown may overtake a release after it has claimed rows but
   * before it creates an artifact. Requeue only missing-artifact claims; once
   * any artifact exists it owns the stable batch and must never be duplicated.
   */
  private async preparePreservedBindingText(bindingId: string): Promise<void> {
    for (const batch of this.store
      .listVoiceConsoleBatchesByState("batched")
      .filter((candidate) => candidate.binding.id === bindingId)) {
      try {
        const artifact = await this.dispatch.inspectArtifact(batch.dispatchId);
        if (artifact === "missing") {
          this.store.requeueArtifactFreeVoiceConsoleBatch(
            bindingId,
            batch.dispatchId,
            this.now()
          );
          continue;
        }
        this.store.markThreadVoiceBatchDispatched(batch.dispatchId, this.now());
        if (artifact === "pending" || artifact === "running") {
          this.activeDispatchByBinding.set(bindingId, batch.dispatchId);
        }
      } catch (err) {
        this.logger.warn(
          { err, bindingId, dispatchId: batch.dispatchId },
          "voice console preserve artifact inspection failed; retaining claimed batch"
        );
      }
    }
  }

  private acquireConsoleLease(console: VoiceConsoleSession) {
    return this.leases.acquire({
      kind: "thread_voice",
      sessionId: console.id,
      guildId: console.guildId,
      voiceChannelId: console.voiceChannelId,
    });
  }

  private releaseConsoleLease(console: Pick<VoiceConsoleSession, "id" | "guildId">): boolean {
    return this.leases.release({
      kind: "thread_voice",
      sessionId: console.id,
      guildId: console.guildId,
    });
  }

  private toDispatchRequest(batch: ReturnType<SessionStore["claimPendingVoiceConsoleBatch"]> extends infer T ? Exclude<T, null> : never): VoiceConsoleDispatchRequest {
    return {
      id: batch.dispatchId,
      target: batch.binding.channelRef,
      prompt: batch.prompt,
      authorId: batch.authorId,
      authorName: batch.authorName,
      consoleId: batch.binding.consoleId,
      bindingId: batch.binding.id,
      createdUtc: this.now(),
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
