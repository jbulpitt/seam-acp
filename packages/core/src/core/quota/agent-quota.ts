import type {
  AgyUsage,
  ClaudeUsageData,
  CodexRateWindow,
  CodexUsageData,
  CopilotQuotaSnapshot,
  CopilotUsageData,
  GrokUsageData,
} from "@seam/adapters";

export interface QuotaWindow {
  usedPercent: number;
  /** Unix seconds, or null when the window has no reset. */
  resetsAt: number | null;
  label: string;
}

export interface AgentQuota {
  agentId: string;
  displayName: string;
  ok: boolean;
  error?: string;
  plan?: string | null;
  rolling: QuotaWindow;
  weekly: QuotaWindow;
  credits?: { balance: string; unlimited: boolean } | null;
  /** Unix seconds when this snapshot was fetched. */
  fetchedAt: number;
}

export interface QuotaAgentIdentity {
  agentId: string;
  displayName: string;
}

export const ROLLING_WINDOW_SECONDS = 5 * 60 * 60;
export const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function unixSeconds(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function synthesizeFullWindow(
  label: "rolling" | "weekly",
  nowSeconds = Math.floor(Date.now() / 1000)
): QuotaWindow {
  return {
    usedPercent: 0,
    resetsAt:
      nowSeconds +
      (label === "rolling" ? ROLLING_WINDOW_SECONDS : WEEKLY_WINDOW_SECONDS),
    label,
  };
}

export function normalizeQuotaWindows(
  input: { rolling?: QuotaWindow | null; weekly?: QuotaWindow | null },
  nowSeconds = Math.floor(Date.now() / 1000)
): Pick<AgentQuota, "rolling" | "weekly"> {
  return {
    rolling: input.rolling ?? synthesizeFullWindow("rolling", nowSeconds),
    weekly: input.weekly ?? synthesizeFullWindow("weekly", nowSeconds),
  };
}

function quotaWindow(
  label: "rolling" | "weekly",
  usedPercent: number,
  resetsAt: string | number | null | undefined
): QuotaWindow {
  return {
    usedPercent: clampPercent(usedPercent),
    resetsAt: unixSeconds(resetsAt),
    label,
  };
}

function codexWindow(
  window: CodexRateWindow | null,
  label: "rolling" | "weekly"
): QuotaWindow | null {
  if (!window) return null;
  return quotaWindow(label, window.usedPercent, window.resetsAt);
}

export function mapCodexQuota(
  identity: QuotaAgentIdentity,
  data: CodexUsageData,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const windows = [data.primary, data.secondary].filter(
    (window): window is CodexRateWindow => window !== null
  );
  const closest = (minutes: number): CodexRateWindow | null =>
    windows.length === 0
      ? null
      : windows.reduce((best, window) =>
          Math.abs(window.windowMinutes - minutes) < Math.abs(best.windowMinutes - minutes)
            ? window
            : best
        );
  const rollingRaw = closest(300);
  const weeklyRaw = closest(10_080);
  const rolling = rollingRaw && Math.abs(rollingRaw.windowMinutes - 300) <= 300
    ? codexWindow(rollingRaw, "rolling")
    : null;
  const weekly = weeklyRaw && Math.abs(weeklyRaw.windowMinutes - 10_080) <= 5_040
    ? codexWindow(weeklyRaw, "weekly")
    : null;
  return {
    ...identity,
    ok: data.ok,
    ...(data.error ? { error: data.error } : {}),
    plan: data.plan,
    ...normalizeQuotaWindows({ rolling, weekly }, fetchedAt),
    credits: data.credits
      ? { balance: data.credits.balance, unlimited: data.credits.unlimited }
      : null,
    fetchedAt,
  };
}

export function mapClaudeQuota(
  identity: QuotaAgentIdentity,
  data: ClaudeUsageData,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const ok = data.fiveHour !== null || data.sevenDay !== null;
  return {
    ...identity,
    ok,
    ...(!ok ? { error: "Claude quota data unavailable" } : {}),
    plan: data.subscriptionType ?? data.rateLimitTier,
    ...normalizeQuotaWindows(
      {
        rolling: data.fiveHour
          ? quotaWindow("rolling", data.fiveHour.utilization, data.fiveHour.resetsAt)
          : null,
        weekly: data.sevenDay
          ? quotaWindow("weekly", data.sevenDay.utilization, data.sevenDay.resetsAt)
          : null,
      },
      fetchedAt
    ),
    credits: data.extraUsage
      ? {
          balance: String(Math.max(0, data.extraUsage.limit - data.extraUsage.used)),
          unlimited: false,
        }
      : null,
    fetchedAt,
  };
}

function copilotUsedPercent(snapshot: CopilotQuotaSnapshot): number {
  if (snapshot.unlimited) return 0;
  if (snapshot.entitlement > 0) {
    return ((snapshot.entitlement - snapshot.remaining) / snapshot.entitlement) * 100;
  }
  return 100 - snapshot.percentRemaining;
}

export function mapCopilotQuota(
  identity: QuotaAgentIdentity,
  data: CopilotUsageData,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const snapshot = data.premiumInteractions ?? data.chat ?? data.completions;
  return {
    ...identity,
    ok: snapshot !== null,
    ...(snapshot === null ? { error: "Copilot quota data unavailable" } : {}),
    plan: data.plan,
    ...normalizeQuotaWindows(
      {
        weekly: snapshot
          ? quotaWindow("weekly", copilotUsedPercent(snapshot), data.quotaResetAt)
          : null,
      },
      fetchedAt
    ),
    credits: snapshot
      ? {
          balance: snapshot.unlimited ? "unlimited" : String(snapshot.remaining),
          unlimited: snapshot.unlimited,
        }
      : null,
    fetchedAt,
  };
}

export function mapGrokQuota(
  identity: QuotaAgentIdentity,
  data: GrokUsageData,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const ok = data.creditUsagePercent !== null;
  return {
    ...identity,
    ok,
    ...(!ok ? { error: "Grok quota data unavailable" } : {}),
    plan: data.subscriptionTier,
    ...normalizeQuotaWindows(
      {
        weekly:
          data.creditUsagePercent !== null
            ? quotaWindow("weekly", data.creditUsagePercent, data.periodEnd)
            : null,
      },
      fetchedAt
    ),
    credits: null,
    fetchedAt,
  };
}

function agyWindow(
  data: AgyUsage,
  window: "5h" | "weekly",
  label: "rolling" | "weekly"
): QuotaWindow | null {
  const buckets = data.groups
    .flatMap((group) => group.buckets)
    .filter(
      (bucket) => bucket.window === window && Number.isFinite(bucket.remainingFraction)
    );
  if (buckets.length === 0) return null;
  const worst = buckets.reduce((lowest, bucket) =>
    bucket.remainingFraction < lowest.remainingFraction ? bucket : lowest
  );
  return quotaWindow(
    label,
    (1 - worst.remainingFraction) * 100,
    worst.resetTime
  );
}

export function mapAgyQuota(
  identity: QuotaAgentIdentity,
  data: AgyUsage,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const hasBuckets = data.groups.some((group) => group.buckets.length > 0);
  const rolling = agyWindow(data, "5h", "rolling");
  const weekly = agyWindow(data, "weekly", "weekly");
  return {
    ...identity,
    ok: hasBuckets,
    ...(!hasBuckets ? { error: "Antigravity quota data unavailable" } : {}),
    plan: null,
    ...normalizeQuotaWindows({ rolling, weekly }, fetchedAt),
    credits: null,
    fetchedAt,
  };
}

export function mapUnlimitedQuota(
  identity: QuotaAgentIdentity,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const unlimited = (): QuotaWindow => ({
    usedPercent: 0,
    resetsAt: null,
    label: "unlimited",
  });
  return {
    ...identity,
    ok: true,
    plan: "unlimited",
    rolling: unlimited(),
    weekly: unlimited(),
    credits: { balance: "unlimited", unlimited: true },
    fetchedAt,
  };
}

export function mapUnavailableQuota(
  identity: QuotaAgentIdentity,
  error: string,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  return {
    ...identity,
    ok: false,
    error,
    plan: null,
    ...normalizeQuotaWindows({}, fetchedAt),
    credits: null,
    fetchedAt,
  };
}
