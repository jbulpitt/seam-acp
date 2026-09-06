import {
  fetchAgyUserStatus,
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchCopilotUsage,
  fetchGrokUsage,
  fetchGrokUsageFromConnection,
  fetchOllamaCloudUsage,
  type AgentProfile,
} from "@seam/adapters";
import type { Logger } from "../../lib/logger.js";
import { isOllamaCloudAgentId } from "../parked-agents.js";
import {
  mapAgyQuota,
  mapClaudeQuota,
  mapCodexQuota,
  mapCopilotQuota,
  mapGrokQuota,
  mapOllamaCloudQuota,
  mapUnavailableQuota,
  mapUnlimitedQuota,
  type AgentQuota,
  type QuotaAgentIdentity,
} from "./agent-quota.js";
import {
  AgentTurnWindow,
  QUOTA_FAILURE_RETRY_CAP,
  QUOTA_FAILURE_RETRY_MS,
  QUOTA_MIN_REFRESH_MS,
  QUOTA_STALE_RETENTION_MS,
  QuotaRegistry,
  quotaPollIntervalMs,
} from "./quota-registry.js";

export type QuotaConnectionRequest = (
  method: string,
  params?: unknown
) => Promise<unknown>;

export interface AgentQuotaSource extends QuotaAgentIdentity {
  eventDriven: boolean;
  fetch: () => Promise<AgentQuota>;
  fetchFromConnection?: (request: QuotaConnectionRequest) => Promise<AgentQuota>;
}

export function createAgentQuotaSources(
  profiles: AgentProfile[],
  opts: {
    agyCliPath?: string;
    grokCliPath?: string;
    ollamaUsageCliPath?: string;
    /**
     * When false, never wire an ollama-cloud quota source — even if a stale
     * profile is still in the list. `undefined` keeps historical behaviour
     * (profile-driven) so existing tests that pass an ollama-cloud profile
     * without the flag still exercise the CLI path.
     */
    ollamaCloudEnabled?: boolean;
  }
): AgentQuotaSource[] {
  const live =
    opts.ollamaCloudEnabled === false
      ? profiles.filter((profile) => !isOllamaCloudAgentId(profile.id))
      : profiles;
  return live.map((profile) => {
    const identity = { agentId: profile.id, displayName: profile.displayName };
    if (profile.id === "agy") {
      return {
        ...identity,
        eventDriven: false,
        fetch: async () => mapAgyQuota(identity, await fetchAgyUserStatus(opts.agyCliPath)),
      };
    }
    if (profile.id === "ollama-cloud") {
      return {
        ...identity,
        eventDriven: false,
        fetch: async () =>
          mapOllamaCloudQuota(
            identity,
            await fetchOllamaCloudUsage(opts.ollamaUsageCliPath)
          ),
      };
    }
    if (profile.id === "codex" || profile.id.startsWith("codex-")) {
      return {
        ...identity,
        eventDriven: true,
        fetch: async () => mapCodexQuota(identity, await fetchCodexUsage()),
      };
    }
    if (profile.id === "grok" || profile.id.startsWith("grok-")) {
      return {
        ...identity,
        eventDriven: true,
        fetch: async () => mapGrokQuota(identity, await fetchGrokUsage(opts.grokCliPath)),
        fetchFromConnection: async (request) =>
          mapGrokQuota(identity, await fetchGrokUsageFromConnection(request)),
      };
    }
    if (profile.id === "copilot" || profile.id.startsWith("copilot-")) {
      return {
        ...identity,
        eventDriven: false,
        fetch: async () =>
          mapCopilotQuota(identity, await fetchCopilotUsage(profile.configDir)),
      };
    }
    if (
      (profile.id === "claude" || profile.id.startsWith("claude-")) &&
      !profile.brand
    ) {
      return {
        ...identity,
        eventDriven: false,
        fetch: async () => mapClaudeQuota(identity, await fetchClaudeUsage(profile.configDir)),
      };
    }
    return {
      ...identity,
      eventDriven: false,
      fetch: async () =>
        mapUnavailableQuota(identity, "This agent does not expose quota data"),
    };
  });
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
  private readonly inFlight = new Map<string, Promise<AgentQuota | undefined>>();
  private readonly lastRefreshAt = new Map<string, number>();
  /** When each agent last produced an `ok` snapshot (for stale retention). */
  private readonly lastGoodAt = new Map<string, number>();
  /** Consecutive surfaced-unavailable results per agent (for fast retry). */
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly staleRetentionMs: number;
  private onUpdate?: (quota: AgentQuota) => void;
  private started = false;

  constructor(opts: {
    logger: Logger;
    registry: QuotaRegistry;
    sources: AgentQuotaSource[];
    onUpdate?: (quota: AgentQuota) => void;
    /** Keep last-known-good this long when reads return unavailable. */
    staleRetentionMs?: number;
  }) {
    this.logger = opts.logger.child({ comp: "agent-quota" });
    this.registry = opts.registry;
    this.onUpdate = opts.onUpdate;
    this.staleRetentionMs = opts.staleRetentionMs ?? QUOTA_STALE_RETENTION_MS;
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
  }

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
    request?: QuotaConnectionRequest
  ): Promise<AgentQuota | undefined> {
    const source = this.sources.get(agentId);
    if (!source?.eventDriven) return undefined;
    const quota = await this.refresh(agentId, request);
    if (this.started) this.schedule(agentId);
    return quota;
  }

  /**
   * Force-refresh every source now — the manual "Refresh" button on the quota
   * card. `force` bypasses the QUOTA_MIN_REFRESH_MS cadence floor; refresh()
   * still dedupes an already-in-flight fetch per agent, and each fresh `ok`
   * snapshot fires onUpdate so the card re-renders with new timestamps.
   */
  async refreshAll(force = false): Promise<void> {
    await Promise.all(
      [...this.sources.keys()].map((agentId) => this.refresh(agentId, undefined, force))
    );
  }

  async refresh(
    agentId: string,
    request?: QuotaConnectionRequest,
    force = false
  ): Promise<AgentQuota | undefined> {
    const source = this.sources.get(agentId);
    if (!source) return undefined;
    const pending = this.inFlight.get(agentId);
    if (pending) return pending;
    const now = Date.now();
    const previousAt = this.lastRefreshAt.get(agentId) ?? 0;
    if (!force && now - previousAt < QUOTA_MIN_REFRESH_MS) {
      return this.registry.get(agentId);
    }
    this.lastRefreshAt.set(agentId, now);
    const task = (async (): Promise<AgentQuota> => {
      let quota: AgentQuota;
      try {
        quota = request && source.fetchFromConnection
          ? await source.fetchFromConnection(request)
          : await source.fetch();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        quota = mapUnavailableQuota(source, message);
        this.logger.warn({ err, agentId }, "agent quota refresh failed");
      }
      const { quota: effective, changed } = this.applyResult(quota);
      if (changed) this.onUpdate?.(effective);
      return effective;
    })();
    this.inFlight.set(agentId, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(agentId);
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
