import type { AgentQuota } from "./agent-quota.js";

export const QUOTA_ACTIVITY_WINDOW_MS = 10 * 60_000;
export const QUOTA_MIN_REFRESH_MS = 15_000;

/**
 * Default window over which the poller keeps serving the last-known-good quota
 * when an upstream read returns "unavailable", instead of flapping the card to
 * ⚠️. A sustained outage longer than this still surfaces honestly. Tunable via
 * the QUOTA_STALE_RETENTION_MS env var.
 */
export const QUOTA_STALE_RETENTION_MS = 30 * 60_000;

/**
 * Scheduled poll cadence by recent activity. Backed off from the original
 * 15s/30s/60s tiers to ease pressure on per-agent usage endpoints (e.g. the
 * Anthropic OAuth usage API) that intermittently 429/blip under tight polling.
 */
export function quotaPollIntervalMs(turnsInLast10Minutes: number): number {
  if (turnsInLast10Minutes >= 8) return 30_000;
  if (turnsInLast10Minutes >= 3) return 60_000;
  if (turnsInLast10Minutes >= 1) return 120_000;
  return 10 * 60_000;
}

export class QuotaRegistry {
  private readonly quotas = new Map<string, AgentQuota>();

  get(agentId: string): AgentQuota | undefined {
    return this.quotas.get(agentId);
  }

  all(): AgentQuota[] {
    return [...this.quotas.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName) || a.agentId.localeCompare(b.agentId)
    );
  }

  set(quota: AgentQuota): void {
    this.quotas.set(quota.agentId, quota);
  }
}

export class AgentTurnWindow {
  private readonly starts = new Map<string, number[]>();

  record(agentId: string, startedAtMs = Date.now()): void {
    const recent = this.prune(agentId, startedAtMs);
    recent.push(startedAtMs);
    this.starts.set(agentId, recent);
  }

  turnsInLast10Min(agentId: string, nowMs = Date.now()): number {
    const recent = this.prune(agentId, nowMs);
    if (recent.length === 0) this.starts.delete(agentId);
    else this.starts.set(agentId, recent);
    return recent.length;
  }

  private prune(agentId: string, nowMs: number): number[] {
    const cutoff = nowMs - QUOTA_ACTIVITY_WINDOW_MS;
    return (this.starts.get(agentId) ?? []).filter((startedAt) => startedAt >= cutoff);
  }
}
