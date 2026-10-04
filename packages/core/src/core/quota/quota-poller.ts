import { redactProbeText } from "@seam/adapters";
import type { TurnBinding } from "../../plugins/turn-activity-registry.js";
import type { Logger } from "../../lib/logger.js";
import {
  mapUnavailableQuota,
  type AgentQuota,
  type QuotaAgentIdentity,
} from "./agent-quota.js";
import {
  AgentTurnWindow,
  QUOTA_FAILURE_RETRY_CAP,
  QUOTA_FAILURE_RETRY_MS,
  QUOTA_MIN_REFRESH_MS,
  QUOTA_SOURCE_TIMEOUT_MS,
  QUOTA_STALE_RETENTION_MS,
  QuotaRegistry,
  quotaPollIntervalMs,
} from "./quota-registry.js";

export interface AgentQuotaSource extends QuotaAgentIdentity {
  eventDriven: boolean;
  fetch: (signal: AbortSignal, binding?: Readonly<TurnBinding>) => Promise<AgentQuota>;
}

export interface AgentQuotaRefreshResult {
  agentId: string;
  displayName: string;
  outcome: "refreshed" | "retained" | "unavailable" | "timed_out";
  durationMs: number;
  quota: AgentQuota;
  error: string | null;
}

export interface AgentQuotaRefreshSummary {
  outcome: "succeeded" | "mixed" | "failed";
  durationMs: number;
  timeoutMs: number;
  sources: AgentQuotaRefreshResult[];
}

function quotaFailureDiagnostic(error: unknown): { name: string; message: string; code?: string | number } {
  const safe = (value: string): string => redactProbeText(
    value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[redacted]"), process.env,
  )
    .replace(/(["']?(?:password|passphrase|secret|(?:access|refresh|csrf)[_-]?token|token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, "$1[redacted]")
    .replace(/\s+/g, " ").slice(0, 500);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    name: error instanceof Error ? safe(error.name) : "Error",
    message: safe(error instanceof Error ? error.message : String(error)),
    ...(typeof code === "string" ? { code: safe(code) } : typeof code === "number" ? { code } : {}),
  };
}


export class AgentQuotaPoller {
  private readonly logger: Logger;
  private readonly registry: QuotaRegistry;
  private readonly sources = new Map<string, AgentQuotaSource>();
  private readonly activity = new AgentTurnWindow();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Absolute ms each pending timer is scheduled to fire, so activity can only
   *  pull a refresh sooner — never push it out (which would starve the timer). */
  private readonly timerFireAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<AgentQuotaRefreshResult>>();
  private readonly controllers = new Set<AbortController>();
  private readonly owned = new Set<Promise<AgentQuota>>();
  private readonly lastRefreshAt = new Map<string, number>();
  /** When each agent last produced an `ok` snapshot (for stale retention). */
  private readonly lastGoodAt = new Map<string, number>();
  /** Consecutive surfaced-unavailable results per agent (for fast retry). */
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly staleRetentionMs: number;
  private readonly sourceTimeoutMs: number;
  private onUpdate?: (quota: AgentQuota) => void;
  private started = false;

  constructor(opts: {
    logger: Pick<Logger, "child">;
    registry: QuotaRegistry;
    sources: AgentQuotaSource[];
    onUpdate?: (quota: AgentQuota) => void;
    /** Keep last-known-good this long when reads return unavailable. */
    staleRetentionMs?: number;
    /** Test/embedding override. Production uses QUOTA_SOURCE_TIMEOUT_MS. */
    sourceTimeoutMs?: number;
  }) {
    this.logger = opts.logger.child({ comp: "agent-quota" });
    this.registry = opts.registry;
    this.onUpdate = opts.onUpdate;
    this.staleRetentionMs = opts.staleRetentionMs ?? QUOTA_STALE_RETENTION_MS;
    this.sourceTimeoutMs = opts.sourceTimeoutMs ?? QUOTA_SOURCE_TIMEOUT_MS;
    for (const source of opts.sources) this.sources.set(source.agentId, source);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all(
      [...this.sources.keys()].map((agentId) => this.refresh(agentId, undefined, true))
    );
    for (const agentId of this.sources.keys()) this.schedule(agentId);
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.timerFireAt.clear();
    for (const controller of this.controllers) controller.abort();
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.owned, ...this.inFlight.values()]); }

  setOnUpdate(onUpdate: ((quota: AgentQuota) => void) | undefined): void {
    this.onUpdate = onUpdate;
  }

  recordTurnStart(agentId: string, startedAtMs = Date.now()): void {
    this.activity.record(agentId, startedAtMs);
    if (!this.started || !this.sources.has(agentId)) return;
    // Picking an agent back up after a lull: if its snapshot is already older
    // than the (freshly activity-scaled) cadence, refresh now instead of waiting
    // out the pending timer. refresh() self-throttles (QUOTA_MIN_REFRESH_MS) and
    // dedupes in-flight, so a burst of turns can't hammer the upstream endpoint —
    // steady-state rate stays the intended cadence, just aligned to real use.
    const lastAt = this.lastRefreshAt.get(agentId) ?? 0;
    if (startedAtMs - lastAt >= this.nextIntervalMs(agentId)) {
      void this.refresh(agentId);
    }
    this.schedule(agentId);
  }

  turnsInLast10Min(agentId: string, nowMs = Date.now()): number {
    return this.activity.turnsInLast10Min(agentId, nowMs);
  }

  async turnCompleted(
    agentId: string,
    binding?: Readonly<TurnBinding>
  ): Promise<AgentQuota | undefined> {
    const source = this.sources.get(agentId);
    if (!source?.eventDriven) return undefined;
    const quota = await this.refresh(agentId, binding);
    if (this.started) this.schedule(agentId);
    return quota;
  }

  /**
   * Force-refresh every source now — the manual "Refresh" button on the quota
   * card. `force` bypasses the QUOTA_MIN_REFRESH_MS cadence floor; refresh()
   * still dedupes an already-in-flight fetch per agent, and each fresh `ok`
   * snapshot fires onUpdate so the card re-renders with new timestamps.
   */
  async refreshAll(force = false): Promise<AgentQuotaRefreshSummary> {
    const startedAt = Date.now();
    const sources = await Promise.all(
      [...this.sources.keys()].map((agentId) => this.refreshResult(agentId, undefined, force))
    );
    const failures = sources.filter((source) =>
      source.outcome === "unavailable" || source.outcome === "timed_out"
    ).length;
    return {
      outcome: failures === 0 ? "succeeded" : failures === sources.length ? "failed" : "mixed",
      durationMs: Date.now() - startedAt,
      timeoutMs: this.sourceTimeoutMs,
      sources,
    };
  }

  async refresh(
    agentId: string,
    binding?: Readonly<TurnBinding>,
    force = false
  ): Promise<AgentQuota | undefined> {
    return (await this.refreshResult(agentId, binding, force))?.quota;
  }

  private async refreshResult(
    agentId: string,
    binding?: Readonly<TurnBinding>,
    force = false
  ): Promise<AgentQuotaRefreshResult> {
    const source = this.sources.get(agentId);
    if (!source) throw new Error(`Unknown quota source '${agentId}'`);
    const pending = this.inFlight.get(agentId);
    if (pending) return pending;
    const now = Date.now();
    const previousAt = this.lastRefreshAt.get(agentId) ?? 0;
    if (!force && now - previousAt < QUOTA_MIN_REFRESH_MS) {
      const quota = this.registry.get(agentId) ?? mapUnavailableQuota({ agentId, displayName: source.displayName }, "Quota has not been fetched yet");
      return {
        agentId: source.agentId,
        displayName: source.displayName,
        outcome: quota.ok ? "retained" : "unavailable",
        durationMs: 0,
        quota,
        error: quota.error ?? null,
      };
    }
    this.lastRefreshAt.set(agentId, now);
    const controller = new AbortController();
    this.controllers.add(controller);
    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let sourceWorkSettled = false;
    const sourceWork = (async (): Promise<AgentQuota> => {
      return await source.fetch(controller.signal, binding);
    })().then(
      (quota) => {
        sourceWorkSettled = true;
        return quota;
      },
      (err: unknown) => {
        sourceWorkSettled = true;
        throw err;
      }
    );
    this.owned.add(sourceWork);
    const releaseWork = () => { this.owned.delete(sourceWork); this.controllers.delete(controller); };
    void sourceWork.then(releaseWork, releaseWork);
    const task = (async (): Promise<AgentQuotaRefreshResult> => {
      let quota: AgentQuota;
      let timedOut = false;
      try {
        quota = await Promise.race([
          sourceWork,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              // #307: this deadline refuses only the stuck quota source;
              // deleting it restores the permanent usage-card spinner.
              timedOut = true;
              const error = new Error(
                `Quota refresh for '${source.displayName}' timed out after ${this.sourceTimeoutMs / 1000}s`
              );
              controller.abort(error);
              reject(error);
            }, this.sourceTimeoutMs);
            timeout.unref?.();
          }),
        ]);
      } catch (err) {
        const diagnostic = quotaFailureDiagnostic(err);
        const message = timedOut
          ? `Quota refresh timed out after ${this.sourceTimeoutMs / 1000}s`
          : diagnostic.message;
        quota = mapUnavailableQuota({ agentId, displayName: source.displayName }, message);
        this.logger.warn(
          { agentId, error: diagnostic, timeoutMs: timedOut ? this.sourceTimeoutMs : undefined },
          timedOut ? "agent quota refresh timed out" : "agent quota refresh failed"
        );
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      const { quota: effective, changed } = this.applyResult(quota);
      if (changed) this.onUpdate?.(effective);
      const retained = !quota.ok && effective.ok;
      return {
        agentId: source.agentId,
        displayName: source.displayName,
        outcome: timedOut ? "timed_out" : retained ? "retained" : effective.ok ? "refreshed" : "unavailable",
        durationMs: Date.now() - startedAt,
        quota: effective,
        error: timedOut
          ? `Quota refresh timed out after ${this.sourceTimeoutMs / 1000}s`
          : quota.error ?? null,
      };
    })();
    this.inFlight.set(agentId, task);
    try {
      return await task;
    } finally {
      const release = () => {
        if (this.inFlight.get(agentId) === task) this.inFlight.delete(agentId);
      };
      if (sourceWorkSettled) {
        release();
      } else {
        // #307: retaining ownership prevents overlap; deleting this lets a
        // second click start IO while the timed-out source is still alive.
        // Promise.race bounds what the caller waits for, but the ownership
        // record stays until the aborted source itself settles. This prevents
        // a second click from overlapping owned IO. The source can no longer
        // publish (only `task` calls applyResult), so a late completion is inert.
        void sourceWork.then(release, release);
      }
    }
  }

  /**
   * Commit a freshly-fetched result, applying last-known-good retention: an
   * `ok` snapshot always wins; an unavailable snapshot is suppressed in favour
   * of the previous good value while it is still within the retention window,
   * so a transient upstream blip does not flap the card to ⚠️. Returns the
   * value that is now authoritative and whether the registry actually changed
   * (so callers can skip a redundant card refresh on a no-op retention).
   */
  private applyResult(fetched: AgentQuota): {
    quota: AgentQuota;
    changed: boolean;
  } {
    const now = Date.now();
    if (fetched.ok) {
      this.lastGoodAt.set(fetched.agentId, now);
      this.consecutiveFailures.set(fetched.agentId, 0);
      this.registry.set(fetched);
      return { quota: fetched, changed: true };
    }
    const previous = this.registry.get(fetched.agentId);
    const goodAt = this.lastGoodAt.get(fetched.agentId) ?? 0;
    if (previous?.ok && now - goodAt < this.staleRetentionMs) {
      this.logger.debug(
        { agentId: fetched.agentId, error: fetched.error, ageMs: now - goodAt },
        "quota read unavailable; retaining last-known-good value"
      );
      // Effective value is still good — no surfaced failure to fast-retry.
      return { quota: previous, changed: false };
    }
    this.consecutiveFailures.set(
      fetched.agentId,
      (this.consecutiveFailures.get(fetched.agentId) ?? 0) + 1
    );
    this.registry.set(fetched);
    return { quota: fetched, changed: true };
  }

  private schedule(agentId: string): void {
    if (!this.started) return;
    const interval = this.nextIntervalMs(agentId);
    const fireAt = Date.now() + interval;
    const existing = this.timers.get(agentId);
    const existingFireAt = this.timerFireAt.get(agentId);
    // Never push a pending refresh further out. schedule() is called on every
    // turn start, so unconditionally re-arming here starves the timer: a heavily
    // used agent (turns arriving faster than the interval) would keep resetting
    // its own countdown and never refresh. Only (re)arm when nothing is pending
    // or the new cadence fires sooner (activity ramped up → accelerate).
    if (existing && existingFireAt != null && fireAt >= existingFireAt) return;
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.timers.delete(agentId);
      this.timerFireAt.delete(agentId);
      await this.refresh(agentId);
      this.schedule(agentId);
    }, interval);
    timer.unref?.();
    this.timers.set(agentId, timer);
    this.timerFireAt.set(agentId, fireAt);
  }

  /**
   * Normal activity cadence, shortened to a fast-retry interval when the agent
   * is currently surfacing an unavailable snapshot — but only for the first few
   * consecutive misses, so a permanently quota-less agent settles back onto the
   * slow cadence instead of polling every minute forever.
   */
  private nextIntervalMs(agentId: string): number {
    const base = quotaPollIntervalMs(this.turnsInLast10Min(agentId));
    const current = this.registry.get(agentId);
    const failures = this.consecutiveFailures.get(agentId) ?? 0;
    if (current && !current.ok && failures <= QUOTA_FAILURE_RETRY_CAP) {
      return Math.min(base, QUOTA_FAILURE_RETRY_MS);
    }
    return base;
  }
}
