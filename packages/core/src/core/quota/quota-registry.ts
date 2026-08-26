import type { AgentQuota } from "./agent-quota.js";

export const QUOTA_ACTIVITY_WINDOW_MS = 10 * 60_000;
export const QUOTA_MIN_REFRESH_MS = 15_000;

export function quotaPollIntervalMs(turnsInLast10Minutes: number): number {
  if (turnsInLast10Minutes >= 8) return 15_000;
  if (turnsInLast10Minutes >= 3) return 30_000;
  if (turnsInLast10Minutes >= 1) return 60_000;
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
