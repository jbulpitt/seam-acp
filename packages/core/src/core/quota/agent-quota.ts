import type {
  AgyUsage,
  ClaudeUsageData,
  CodexRateWindow,
  CodexUsageData,
  CopilotQuotaSnapshot,
  CopilotUsageData,
  GrokUsageData,
  OllamaCloudUsageData,
} from "@seam/adapters";

export interface QuotaWindow {
  usedPercent: number | null;
  /** Unix seconds, or null when the window has no reset. */
  resetsAt: number | null;
  label: string;
  /** Why this window is unknown, when the source did not report it. */
  error?: string;
}

export interface QuotaPool {
  displayName: string;
  description?: string;
  rolling: QuotaWindow;
  weekly: QuotaWindow;
}

export interface AgentQuota extends QuotaAgentIdentity {
  ok: boolean;
  error?: string;
  plan?: string | null;
  noSubscription?: boolean;
  rolling: QuotaWindow;
  weekly: QuotaWindow;
  /** Independent provider pools; top-level windows remain the worst reported. */
  pools?: QuotaPool[];
  credits?: { balance: string; unlimited: boolean; onDemand?: { used: string; cap: string } } | null;
  /** Unix seconds of the observation; null when its timestamp is unknown. */
  fetchedAt: number | null;
  source?: CodexUsageData["source"];
  liveError?: string;
  stale?: boolean;
}

export interface QuotaAgentIdentity {
  agentId: string;
  displayName: string;
  location?: string;
  host?: string;
  trackingUnavailable?: string;
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
    rolling: rolling ?? { usedPercent: null, resetsAt: null, label: "rolling" },
    weekly: weekly ?? { usedPercent: null, resetsAt: null, label: "weekly" },
    credits: data.credits
      ? { balance: data.credits.balance, unlimited: data.credits.unlimited }
      : null,
    fetchedAt: data.source ? unixSeconds(data.source.observedAt) : fetchedAt,
    ...(data.source ? { source: data.source } : {}),
    ...(data.liveError ? { liveError: data.liveError } : {}),
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
  const noSubscription = data.subscriptionTier === "Free" && data.creditUsagePercent === null;
  const paidTier = Boolean(data.subscriptionTier && data.subscriptionTier !== "Free");
  // ProtoJSON can omit the zero scalar; a paid period still supplies its reset.
  const usedPercent = data.creditUsagePercent ?? (paidTier && data.periodType && unixSeconds(data.periodEnd) !== null ? 0 : null);
  const ok = usedPercent !== null || noSubscription;
  const hasAmounts = data.prepaidBalance != null || data.onDemandCap != null || data.onDemandUsed != null;
  return {
    ...identity,
    ok,
    ...(!ok ? { error: "Grok quota data unavailable" } : {}),
    ...(noSubscription ? { noSubscription: true } : {}),
    plan: data.subscriptionTier,
    ...normalizeQuotaWindows(
      {
        weekly:
          usedPercent !== null
            ? quotaWindow("weekly", usedPercent, data.periodEnd)
            : null,
      },
      fetchedAt
    ),
    credits: paidTier && hasAmounts ? {
      balance: data.prepaidBalance != null ? String(data.prepaidBalance) : "unknown",
      unlimited: false,
      ...(data.onDemandCap != null || data.onDemandUsed != null ? { onDemand: {
        used: data.onDemandUsed != null ? String(data.onDemandUsed) : "unknown",
        cap: data.onDemandCap != null ? String(data.onDemandCap) : "unknown",
      } } : {}),
    } : null,
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

function unknownAgyWindow(label: "rolling" | "weekly", error: string): QuotaWindow {
  return { usedPercent: null, resetsAt: null, label, error };
}

function agyPools(data: AgyUsage, error?: string): QuotaPool[] {
  // Native RetrieveUserQuotaSummary labels; never fill an absent pool with 0%.
  const groups = [...data.groups];
  for (const displayName of ["Gemini Models", "Claude and GPT models"]) {
    if (!groups.some(group => group.displayName === displayName)) groups.push({ displayName, buckets: [] });
  }
  return groups.map(group => ({
    displayName: group.displayName,
    ...(group.description ? { description: group.description } : {}),
    rolling: agyWindow({ groups: [group] }, "5h", "rolling") ?? unknownAgyWindow("rolling",
      error ?? `RetrieveUserQuotaSummary: ${group.displayName} did not report a usable 5h bucket`),
    weekly: agyWindow({ groups: [group] }, "weekly", "weekly") ?? unknownAgyWindow("weekly",
      error ?? `RetrieveUserQuotaSummary: ${group.displayName} did not report a usable weekly bucket`),
  }));
}

export function mapAgyQuota(
  identity: QuotaAgentIdentity,
  data: AgyUsage,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const rolling = agyWindow(data, "5h", "rolling");
  const weekly = agyWindow(data, "weekly", "weekly");
  const hasBuckets = rolling !== null || weekly !== null;
  return {
    ...identity,
    ok: hasBuckets,
    ...(!hasBuckets ? { error: "Antigravity quota data unavailable" } : {}),
    plan: null,
    rolling: rolling ?? unknownAgyWindow("rolling", "RetrieveUserQuotaSummary did not report a usable 5h bucket"),
    weekly: weekly ?? unknownAgyWindow("weekly", "RetrieveUserQuotaSummary did not report a usable weekly bucket"),
    pools: agyPools(data),
    credits: null,
    fetchedAt,
  };
}

export function mapOllamaCloudQuota(
  identity: QuotaAgentIdentity,
  data: OllamaCloudUsageData,
  fetchedAt = Math.floor(Date.now() / 1000)
): AgentQuota {
  const ok = data.ok && data.fiveHour !== null && data.weekly !== null;
  return {
    ...identity,
    ok,
    ...(!ok
      ? { error: data.error ?? "Ollama Cloud quota data unavailable" }
      : {}),
    plan: null,
    ...normalizeQuotaWindows(
      {
        rolling: data.fiveHour
          ? quotaWindow("rolling", data.fiveHour.pctUsed, data.fiveHour.resetAt)
          : null,
        weekly: data.weekly
          ? quotaWindow("weekly", data.weekly.pctUsed, data.weekly.resetAt)
          : null,
      },
      fetchedAt
    ),
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
  if (identity.agentId === "agy") {
    return {
      ...mapAgyQuota(identity, { groups: [] }, fetchedAt),
      error,
      rolling: unknownAgyWindow("rolling", error),
      weekly: unknownAgyWindow("weekly", error),
      pools: agyPools({ groups: [] }, error),
    };
  }
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
