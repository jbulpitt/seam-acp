import { describeError } from "./http.js";
import type { RegisteredSource, ServiceStatusStore } from "./store.js";
import {
  SERVICE_STATUS_DEFAULTS,
  type ServiceObservation,
  type ServiceStatusLevel,
  type ServiceStatusSnapshot,
  type ServiceStatusSourceDefinition,
} from "./types.js";

/**
 * Refresh lifecycle for the registered status sources.
 *
 * The state machine is deliberately small and is defined before any timer runs:
 *
 *   **Generation.** `start()` and `stop()` each increment a generation counter.
 *   Every flight records the generation it was admitted under, and a completed
 *   flight persists and notifies *only* if that generation is still current.
 *   This is what makes "work admitted before a restart can never overwrite
 *   newer state" and "no writes or notifications after `stop()`" true by
 *   construction rather than by careful sequencing.
 *
 *   **Admission.** Every flight — cadence, forced, or a standalone call made
 *   while stopped — goes through `admit()`. There is no second path that could
 *   miss the generation stamp.
 *
 *   **Settlement.** A caller waits on a deferred owned by the flight, not on
 *   the adapter promise. `stop()` aborts the controller *and* settles every
 *   deferred, so a caller can never hang behind an adapter that ignores its
 *   `AbortSignal`; the same reason the per-source timeout races the adapter
 *   instead of relying on abort being honoured.
 *
 *   **Cadence.** The next tick is scheduled only after the previous one
 *   settles, so a slow refresh delays the next tick instead of stacking.
 */

export type RefreshDisposition = "executed" | "coalesced" | "rate_limited" | "cancelled";
export type RefreshOutcome = "succeeded" | "failed" | "mixed" | "skipped";

export interface SourceRefreshResult {
  sourceId: string;
  /** What happened to *this call*. */
  disposition: RefreshDisposition;
  /** True only when this call itself caused an upstream fetch. */
  attempted: boolean;
  /** Flight outcome, or `null` when no flight outcome exists for this call. */
  succeeded: boolean | null;
  durationMs: number | null;
  /** Sanitized failure message, or `null`. */
  error: string | null;
  /** Why a non-executed disposition was chosen. */
  reason: string | null;
  observation: ServiceObservation | null;
  snapshot: ServiceStatusSnapshot | null;
}

export interface RefreshResult {
  outcome: RefreshOutcome;
  startedAt: string;
  durationMs: number;
  sources: SourceRefreshResult[];
}

export interface RefreshOptions {
  /** Bypass cadence backoff, but not the per-source forced cooldown. */
  force?: boolean;
}

/** Injectable timers keep cadence and backoff tests deterministic. */
export interface ServiceStatusTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface ServiceStatusLoggerLike {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
}

export interface ServiceStatusManagerOptions {
  store: ServiceStatusStore;
  sources: readonly ServiceStatusSourceDefinition[];
  logger?: ServiceStatusLoggerLike;
  now?: () => Date;
  random?: () => number;
  timers?: ServiceStatusTimers;
  fetchImpl?: typeof fetch;
  onUpdate?: (result: SourceRefreshResult) => void | Promise<void>;
  normalIntervalMs?: number;
  incidentIntervalMs?: number;
  forcedCooldownMs?: number;
  fetchTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  backoffJitterRatio?: number;
  /** Consecutive failures after which a source falls back to normal cadence. */
  maxBackoffAttempts?: number;
}

interface Flight {
  sourceId: string;
  generation: number;
  controller: AbortController;
  promise: Promise<SourceRefreshResult>;
  settle: (result: SourceRefreshResult) => void;
  settled: boolean;
  /**
   * The flight's own timeout, owned here rather than in a closure so every
   * settlement path — success, failure, supersession and `stop()` — can clear
   * it. `armed` is tracked explicitly because a timer handle is opaque and may
   * legitimately be `0` or `undefined`.
   */
  timeoutArmed: boolean;
  timeoutHandle: unknown;
}

interface BackoffState {
  failures: number;
}

/**
 * Effective statuses that warrant the faster cadence.
 *
 * `maintenance` is deliberately absent: planned maintenance is announced,
 * expected and time-boxed, so polling it every minute buys nothing.
 * `operational` is obviously absent. Everything else — including `unknown`,
 * which means a provider is reporting something we refused to grade — is a
 * situation worth watching closely.
 */
const ACCELERATED_STATUSES: ReadonlySet<ServiceStatusLevel> = new Set<ServiceStatusLevel>([
  "degraded",
  "unknown",
  "partial_outage",
  "major_outage",
]);

const DEFAULT_TIMERS: ServiceStatusTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class ServiceStatusRefreshManager {
  private readonly options: Required<
    Pick<
      ServiceStatusManagerOptions,
      | "normalIntervalMs"
      | "incidentIntervalMs"
      | "forcedCooldownMs"
      | "fetchTimeoutMs"
      | "backoffBaseMs"
      | "backoffMaxMs"
      | "backoffJitterRatio"
      | "maxBackoffAttempts"
    >
  >;
  private readonly store: ServiceStatusStore;
  private readonly sources: Map<string, ServiceStatusSourceDefinition>;
  private readonly timers: ServiceStatusTimers;
  private readonly now: () => Date;
  private readonly random: () => number;

  private generation = 0;
  private running = false;
  /**
   * The generation of the cadence tick currently refreshing, or `null`.
   *
   * Generation-stamped rather than a boolean: a `stop()` immediately followed by
   * `start()` can leave an old tick still unwinding while a new-generation tick
   * is already running, and a shared flag would let the old tick's cleanup
   * declare the new one finished.
   */
  private currentTickGeneration: number | null = null;
  private timerArmed = false;
  private timerHandle: unknown = undefined;
  private timerDueAtMs: number | null = null;
  private readonly inflight = new Map<string, Flight>();
  private readonly backoff = new Map<string, BackoffState>();
  private readonly lastForcedAtMs = new Map<string, number>();
  /**
   * When each source is next eligible. One scheduler timer is armed for the
   * earliest entry, so a source retrying on backoff never drags healthy sources
   * into an early refetch, and timers cannot stack.
   */
  private readonly dueAtMs = new Map<string, number>();

  constructor(private readonly config: ServiceStatusManagerOptions) {
    this.store = config.store;
    this.sources = new Map(config.sources.map((source) => [source.id, source]));
    this.timers = config.timers ?? DEFAULT_TIMERS;
    this.now = config.now ?? (() => new Date());
    this.random = config.random ?? Math.random;
    this.options = {
      normalIntervalMs: config.normalIntervalMs ?? SERVICE_STATUS_DEFAULTS.normalIntervalMs,
      incidentIntervalMs: config.incidentIntervalMs ?? SERVICE_STATUS_DEFAULTS.incidentIntervalMs,
      forcedCooldownMs: config.forcedCooldownMs ?? SERVICE_STATUS_DEFAULTS.forcedCooldownMs,
      fetchTimeoutMs: config.fetchTimeoutMs ?? SERVICE_STATUS_DEFAULTS.fetchTimeoutMs,
      backoffBaseMs: config.backoffBaseMs ?? SERVICE_STATUS_DEFAULTS.backoffBaseMs,
      backoffMaxMs: config.backoffMaxMs ?? SERVICE_STATUS_DEFAULTS.backoffMaxMs,
      backoffJitterRatio: config.backoffJitterRatio ?? SERVICE_STATUS_DEFAULTS.backoffJitterRatio,
      maxBackoffAttempts: config.maxBackoffAttempts ?? SERVICE_STATUS_DEFAULTS.maxBackoffAttempts,
    };
    this.store.registerSources([...this.sources.values()].map(toRegisteredSource));
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Visible for tests: no timer must survive a clean stop. */
  get hasArmedTimer(): boolean {
    return this.timerArmed;
  }

  /** Visible for tests: when each source is next eligible. */
  nextDueAtMs(sourceId: string): number | undefined {
    return this.dueAtMs.get(sourceId);
  }

  start(): void {
    if (this.running) return;
    this.generation += 1;
    this.running = true;
    const generation = this.generation;
    // A fresh lifecycle starts with a clean slate: every source is due at once
    // and no failure history carries over from the previous run.
    const nowMs = this.now().getTime();
    this.backoff.clear();
    for (const sourceId of this.sources.keys()) this.dueAtMs.set(sourceId, nowMs);
    // The startup refresh is a normal managed tick, so it obeys the same
    // admission and generation rules as every later one.
    void this.tick(generation);
  }

  stop(): void {
    if (!this.running && this.inflight.size === 0 && !this.timerArmed) return;
    this.running = false;
    this.generation += 1;
    this.clearTimer();

    const flights = [...this.inflight.values()];
    this.inflight.clear();
    for (const flight of flights) {
      // Every caller is settled and every timer released, so an adapter that
      // ignores its abort signal can neither hang a caller nor leave a pending
      // timeout behind.
      this.retireFlight(flight, "manager stopped");
    }
  }

  /** Refresh every eligible source. One source failing never blocks another. */
  async refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
    const startedAt = this.now();
    const results = await Promise.all(
      [...this.sources.keys()].map((sourceId) => this.refreshSource(sourceId, options))
    );
    return {
      outcome: aggregateOutcome(results),
      startedAt: startedAt.toISOString(),
      durationMs: this.now().getTime() - startedAt.getTime(),
      sources: results,
    };
  }

  async refreshSource(sourceId: string, options: RefreshOptions = {}): Promise<SourceRefreshResult> {
    const definition = this.sources.get(sourceId);
    if (!definition) throw new Error(`unknown service status source: ${JSON.stringify(sourceId)}`);

    const existing = this.inflight.get(sourceId);
    if (existing && existing.generation === this.generation) {
      // Coalesce onto the in-flight attempt. This caller did not cause a fetch,
      // and says so, but still receives that flight's real outcome.
      const result = await existing.promise;
      return {
        ...result,
        disposition: result.disposition === "cancelled" ? "cancelled" : "coalesced",
        attempted: false,
        reason: result.disposition === "cancelled" ? result.reason : "coalesced onto an in-flight refresh",
      };
    }
    if (existing) {
      // A flight from an older lifecycle generation is already doomed: it can
      // never persist or notify. Coalescing onto it would silently turn this
      // request — including the startup refresh after a restart — into a no-op,
      // so it is retired here and a current-generation fetch is admitted.
      this.retireFlight(existing, "superseded by a newer manager generation");
    }

    const nowMs = this.now().getTime();
    if (options.force) {
      // The cooldown is keyed on the physical source, so a global forced
      // refresh and a targeted one contend for the same budget.
      const lastForced = this.lastForcedAtMs.get(sourceId);
      if (lastForced !== undefined && nowMs - lastForced < this.options.forcedCooldownMs) {
        return this.notAttempted(sourceId, "rate_limited", "forced refresh cooldown is still active");
      }
      this.lastForcedAtMs.set(sourceId, nowMs);
    } else {
      const dueAt = this.dueAtMs.get(sourceId);
      if (dueAt !== undefined && nowMs < dueAt) {
        return this.notAttempted(
          sourceId,
          "rate_limited",
          this.backoff.has(sourceId) ? "source is in failure backoff" : "not yet due for refresh"
        );
      }
    }

    return this.admit(definition);
  }

  private admit(definition: ServiceStatusSourceDefinition): Promise<SourceRefreshResult> {
    let settle!: (result: SourceRefreshResult) => void;
    const promise = new Promise<SourceRefreshResult>((resolve) => {
      settle = resolve;
    });
    const flight: Flight = {
      sourceId: definition.id,
      generation: this.generation,
      controller: new AbortController(),
      promise,
      settle: (result) => {
        if (flight.settled) return;
        flight.settled = true;
        settle(result);
      },
      settled: false,
      timeoutArmed: false,
      timeoutHandle: undefined,
    };
    this.inflight.set(definition.id, flight);

    // Detached on purpose: `run` never rejects, and callers wait on the
    // flight's deferred so that `stop()` can settle them independently.
    void this.run(definition, flight);
    return promise;
  }

  /**
   * Drive one flight from fetch through persistence, notification and
   * settlement.
   *
   * The flight stays in `inflight` for the whole of that — not just the fetch —
   * so `stop()` can still reach it while an `onUpdate` callback is running. A
   * callback that never resolves would otherwise leave every caller waiting on
   * a flight nobody can see. It also means a second request for the same source
   * cannot start while this one is mid-write.
   */
  private async run(definition: ServiceStatusSourceDefinition, flight: Flight): Promise<void> {
    try {
      await this.runInner(definition, flight);
    } finally {
      this.clearFlightTimeout(flight);
      if (this.inflight.get(definition.id) === flight) this.inflight.delete(definition.id);
    }
  }

  private async runInner(
    definition: ServiceStatusSourceDefinition,
    flight: Flight
  ): Promise<void> {
    const startedAtMs = this.now().getTime();
    let succeeded = false;
    let error: string | null = null;
    let result: Awaited<ReturnType<ServiceStatusSourceDefinition["fetch"]>> | null = null;

    try {
      result = await this.withTimeout(definition, flight);
      succeeded = true;
    } catch (caught) {
      error = describeError(caught);
    }

    const durationMs = this.now().getTime() - startedAtMs;

    // The race is over either way; belt-and-braces against a path that left the
    // timeout armed. The flight stays *registered* until `finally` below, so it
    // remains cancellable while it persists and notifies.
    this.clearFlightTimeout(flight);

    if (flight.generation !== this.generation) {
      // Admitted under an older generation: the manager has since been stopped
      // or restarted, so this work must not touch the store or notify anyone.
      this.settleCancelled(flight, "superseded by a newer manager generation");
      return;
    }
    if (flight.settled) return;

    const source = toRegisteredSource(definition);
    const observedAt = this.now();
    let outcome: SourceRefreshResult;
    try {
      if (succeeded && result) {
        const recorded = this.store.recordSuccess({ source, result, durationMs, observedAt });
        outcome = {
          sourceId: definition.id,
          disposition: "executed",
          attempted: true,
          succeeded: true,
          durationMs,
          error: null,
          reason: null,
          observation: recorded.snapshot.observation,
          snapshot: recorded.snapshot,
        };
      } else {
        const recorded = this.store.recordFailure({
          source,
          error: error ?? "unknown refresh failure",
          durationMs,
          observedAt,
        });
        outcome = {
          sourceId: definition.id,
          disposition: "executed",
          attempted: true,
          succeeded: false,
          durationMs,
          error,
          reason: null,
          observation: recorded.snapshot.observation,
          snapshot: recorded.snapshot,
        };
      }
    } catch (storeError) {
      // A store failure is a refresh failure, not a crash: report it truthfully
      // and leave the previous snapshot in place.
      this.config.logger?.error(
        { sourceId: definition.id, error: describeError(storeError) },
        "service status refresh could not be persisted"
      );
      outcome = {
        sourceId: definition.id,
        disposition: "executed",
        attempted: true,
        succeeded: false,
        durationMs,
        error: describeError(storeError),
        reason: null,
        observation: null,
        snapshot: null,
      };
    }

    this.recordAttemptOutcome(definition.id, outcome, observedAt.getTime());

    await this.notify(outcome);

    // `stop()` may have retired this flight while the callback was running. The
    // settle guard makes the late arrival a no-op rather than a second
    // settlement, and the generation check above already prevented any further
    // write. Nothing here reschedules — the cadence does that, under its own
    // generation check.
    flight.settle(outcome);
  }

  /**
   * Bound the fetch even when the adapter never observes its `AbortSignal`.
   * The adapter promise is raced, not awaited, and its eventual settlement is
   * swallowed so a late rejection cannot surface as an unhandled rejection.
   */
  private withTimeout(
    definition: ServiceStatusSourceDefinition,
    flight: Flight
  ): Promise<Awaited<ReturnType<ServiceStatusSourceDefinition["fetch"]>>> {
    const attempt = definition.fetch({
      now: this.now,
      signal: flight.controller.signal,
      fetchImpl: this.config.fetchImpl,
    });
    // Once the race is lost the adapter promise has no consumer, so its late
    // rejection is swallowed here rather than surfacing as an unhandled one.
    attempt.catch(() => {});

    return new Promise((resolve, reject) => {
      flight.timeoutHandle = this.timers.setTimeout(() => {
        // The timer has fired, so there is nothing left to clear.
        flight.timeoutArmed = false;
        flight.timeoutHandle = undefined;
        flight.controller.abort(new Error("service status refresh timed out"));
        reject(
          new Error(
            `${definition.label} refresh exceeded ${String(this.options.fetchTimeoutMs)}ms`
          )
        );
      }, this.options.fetchTimeoutMs);
      flight.timeoutArmed = true;
      attempt.then(
        (value) => {
          this.clearFlightTimeout(flight);
          resolve(value);
        },
        (error: unknown) => {
          this.clearFlightTimeout(flight);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  /**
   * Clear a flight's pending timeout. Safe to call repeatedly and on a flight
   * that never armed one; never called before the flight's callers have been
   * settled, since the timeout is the only thing that would otherwise reject a
   * fetch an adapter has abandoned.
   */
  private clearFlightTimeout(flight: Flight): void {
    if (!flight.timeoutArmed) return;
    flight.timeoutArmed = false;
    const handle = flight.timeoutHandle;
    flight.timeoutHandle = undefined;
    this.timers.clearTimeout(handle);
  }

  /**
   * Abandon a flight: cancel its abort signal, settle every caller waiting on
   * it, drop it from the in-flight map, and only then release its timer. The
   * order matters — settling first means no caller can be stranded by the
   * removal of the timeout that would have rejected them.
   */
  private retireFlight(flight: Flight, reason: string): void {
    flight.controller.abort(new Error(`service status refresh cancelled: ${reason}`));
    this.settleCancelled(flight, reason);
    if (this.inflight.get(flight.sourceId) === flight) this.inflight.delete(flight.sourceId);
    this.clearFlightTimeout(flight);
  }

  private async notify(result: SourceRefreshResult): Promise<void> {
    const onUpdate = this.config.onUpdate;
    if (!onUpdate) return;
    try {
      await onUpdate(result);
    } catch (error) {
      this.config.logger?.error(
        { sourceId: result.sourceId, error: describeError(error) },
        "service status update callback failed"
      );
    }
  }

  /**
   * Decide when this source is next eligible, from the outcome just recorded.
   *
   * A success clears the failure history and returns the source to the ordinary
   * cadence — accelerated while anything is unhealthy. A failure schedules a
   * real retry at the computed backoff, starting at the base delay, until the
   * source has failed `maxBackoffAttempts` times in a row; past that it drops
   * back to the ordinary cadence rather than retrying forever on a fast timer.
   *
   * Only this source's due time moves, which is what keeps a retry for a broken
   * source from dragging healthy ones into an early refetch.
   */
  private recordAttemptOutcome(
    sourceId: string,
    outcome: SourceRefreshResult,
    nowMs: number
  ): void {
    let dueAtMs: number;
    if (outcome.succeeded === true) {
      this.backoff.delete(sourceId);
      dueAtMs = nowMs + this.cadenceIntervalMs();
    } else {
      const failures = (this.backoff.get(sourceId)?.failures ?? 0) + 1;
      this.backoff.set(sourceId, { failures });
      const delay =
        failures > this.options.maxBackoffAttempts
          ? this.options.normalIntervalMs
          : backoffDelayMs(failures, this.options, this.random);
      dueAtMs = nowMs + delay;
    }
    this.dueAtMs.set(sourceId, dueAtMs);
    this.offerDueToScheduler(dueAtMs);
  }

  /**
   * Let a freshly computed due time pull the armed scheduler earlier.
   *
   * Without this, an out-of-band refresh — a forced or targeted one made while
   * the manager is running — could discover a failure due for retry in five
   * seconds, or a degradation that warrants the one-minute cadence, while the
   * scheduler stayed armed for the five-minute slot it was holding. The earlier
   * due would not be honoured until far too late.
   *
   * While a tick of the *current* generation is running it owns scheduling and
   * this is skipped: that tick calls `scheduleNext` the moment it finishes, and
   * arming mid-tick could let a timer fire into a tick that is still running. A
   * tick left over from an older generation has no such claim — it can no
   * longer schedule anything — so it does not suppress the offer.
   *
   * `ensureSchedulerAt` only ever pulls the timer earlier, so a later due can
   * never postpone an earlier one, and it ignores a stale generation or a
   * stopped manager outright.
   *
   * Two ticks of the same generation cannot overlap: the only things that arm
   * the scheduler are `scheduleNext` (which runs after a tick completes) and
   * this method (which defers to a running current-generation tick), and
   * `start()` is a no-op while already running.
   */
  private offerDueToScheduler(dueAtMs: number): void {
    if (this.currentTickGeneration === this.generation) return;
    this.ensureSchedulerAt(dueAtMs, this.generation);
  }

  /**
   * The polling interval that currently applies.
   *
   * Any source reporting an active incident *or* an unhealthy effective status
   * accelerates the whole cadence: an outage a provider has not filed an
   * incident for still deserves close watching.
   */
  private cadenceIntervalMs(): number {
    const accelerate = this.store
      .listSnapshots(this.now())
      .some(
        (snapshot) =>
          ACCELERATED_STATUSES.has(snapshot.effectiveStatus) ||
          snapshot.incidents.some((incident) => incident.stage === "active")
      );
    return accelerate ? this.options.incidentIntervalMs : this.options.normalIntervalMs;
  }

  private notAttempted(
    sourceId: string,
    disposition: RefreshDisposition,
    reason: string
  ): SourceRefreshResult {
    const snapshot = this.store.getSnapshot(sourceId, this.now());
    return {
      sourceId,
      disposition,
      attempted: false,
      succeeded: null,
      durationMs: null,
      error: null,
      reason,
      observation: snapshot?.observation ?? null,
      snapshot,
    };
  }

  private settleCancelled(flight: Flight, reason: string): void {
    flight.settle({
      sourceId: flight.sourceId,
      disposition: "cancelled",
      attempted: true,
      succeeded: null,
      durationMs: null,
      error: null,
      reason,
      observation: null,
      snapshot: null,
    });
  }

  private async tick(generation: number): Promise<void> {
    if (!this.running || this.generation !== generation) return;
    this.currentTickGeneration = generation;
    try {
      await this.refresh({ force: false });
    } catch (error) {
      this.config.logger?.error(
        { error: describeError(error) },
        "service status cadence refresh failed"
      );
    } finally {
      // Release the slot only if this tick still owns it. After a restart the
      // slot belongs to the newer tick, and clearing it here would let an
      // out-of-band refresh arm a timer into that tick.
      if (this.currentTickGeneration === generation) this.currentTickGeneration = null;
    }
    // Re-check after the await: a stop() or restart during the refresh must not
    // be followed by a rearmed timer from the old generation.
    if (!this.running || this.generation !== generation) return;
    this.scheduleNext(generation);
  }

  /** Arm the scheduler for whichever source becomes eligible first. */
  private scheduleNext(generation: number): void {
    const nowMs = this.now().getTime();
    let earliest: number | null = null;
    for (const sourceId of this.sources.keys()) {
      const dueAt = this.dueAtMs.get(sourceId) ?? nowMs;
      if (earliest === null || dueAt < earliest) earliest = dueAt;
    }
    if (earliest === null) return;
    this.ensureSchedulerAt(earliest, generation);
  }

  /**
   * Arm the single scheduler timer, pulling it earlier when needed and never
   * pushing it later. A newly scheduled distant check must not be able to
   * postpone an imminent one, and only ever holding one timer is what keeps
   * ticks from stacking behind a slow refresh.
   */
  private ensureSchedulerAt(dueAtMs: number, generation: number): void {
    if (!this.running || this.generation !== generation) return;
    if (this.timerArmed && this.timerDueAtMs !== null && this.timerDueAtMs <= dueAtMs) return;
    this.clearTimer();
    const delay = Math.max(0, dueAtMs - this.now().getTime());
    this.timerDueAtMs = dueAtMs;
    this.timerArmed = true;
    this.timerHandle = this.timers.setTimeout(() => {
      this.timerArmed = false;
      this.timerHandle = undefined;
      this.timerDueAtMs = null;
      void this.tick(generation);
    }, delay);
  }

  private clearTimer(): void {
    // A timer handle can legitimately be `0` or `undefined`, so armedness is
    // tracked explicitly rather than inferred from the handle's truthiness.
    if (!this.timerArmed) return;
    this.timerArmed = false;
    const handle = this.timerHandle;
    this.timerHandle = undefined;
    this.timerDueAtMs = null;
    this.timers.clearTimeout(handle);
  }
}

function toRegisteredSource(definition: ServiceStatusSourceDefinition): RegisteredSource {
  return { id: definition.id, label: definition.label, provenance: definition.provenance };
}

/**
 * Aggregate outcome over the sources that actually produced a flight result.
 * Rate-limited and cancelled entries are reported through their disposition and
 * are deliberately excluded here, so a cooldown can never be read as a failure.
 */
export function aggregateOutcome(results: readonly SourceRefreshResult[]): RefreshOutcome {
  const evaluated = results.filter((result) => result.succeeded !== null);
  if (evaluated.length === 0) return "skipped";
  const succeeded = evaluated.filter((result) => result.succeeded === true).length;
  if (succeeded === evaluated.length) return "succeeded";
  if (succeeded === 0) return "failed";
  return "mixed";
}

/**
 * Exponential backoff with jitter, clamped *after* jitter is applied so the
 * result can never fall below the base delay or exceed the ceiling.
 */
export function backoffDelayMs(
  failures: number,
  options: { backoffBaseMs: number; backoffMaxMs: number; backoffJitterRatio: number },
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, failures - 1);
  const exponential = Math.min(options.backoffBaseMs * 2 ** exponent, options.backoffMaxMs);
  const jittered = exponential * (1 + (random() * 2 - 1) * options.backoffJitterRatio);
  return Math.min(Math.max(Math.round(jittered), options.backoffBaseMs), options.backoffMaxMs);
}
