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
  }
): AgentQuotaSource[] {
  return profiles.map((profile) => {
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
    if (profile.id === "opencode" || profile.brand === "ollama") {
      return {
        ...identity,
        eventDriven: false,
        fetch: async () => mapUnlimitedQuota(identity),
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
  private readonly inFlight = new Map<string, Promise<AgentQuota | undefined>>();
  private readonly lastRefreshAt = new Map<string, number>();
  /** When each agent last produced an `ok` snapshot (for stale retention). */
  private readonly lastGoodAt = new Map<string, number>();
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
  }

  setOnUpdate(onUpdate: ((quota: AgentQuota) => void) | undefined): void {
    this.onUpdate = onUpdate;
  }

  recordTurnStart(agentId: string, startedAtMs = Date.now()): void {
    this.activity.record(agentId, startedAtMs);
    if (this.started && this.sources.has(agentId)) this.schedule(agentId);
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
      return { quota: previous, changed: false };
    }
    this.registry.set(fetched);
    return { quota: fetched, changed: true };
  }

  private schedule(agentId: string): void {
    const existing = this.timers.get(agentId);
    if (existing) clearTimeout(existing);
    if (!this.started) return;
    const interval = quotaPollIntervalMs(this.turnsInLast10Min(agentId));
    const timer = setTimeout(async () => {
      this.timers.delete(agentId);
      await this.refresh(agentId);
      this.schedule(agentId);
    }, interval);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }
}
