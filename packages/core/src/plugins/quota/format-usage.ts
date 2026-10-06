import type { ProviderUsage } from "../../core/quota/usage-provider.js";
import { formatUsageObservation } from "../../core/quota/usage-observation.js";

export function formatUsage(usage: ProviderUsage): string {
  switch (usage.provider) {
    case "agy": return formatAgyUsage(usage.data);
    case "ollama-cloud": return formatOllamaCloudUsage(usage.data);
    case "copilot": return formatCopilotUsage(usage.data);
    case "grok": return formatGrokUsage(usage.data);
    case "codex": return formatCodexUsage(usage.data);
    case "claude": return formatClaudeUsage(usage.data);
  }
}

function usageBar(pct: number): string {
  const filled = Math.min(20, Math.round(pct / 5));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function usageLine(pct: number | null, label: string): string {
  const bar = pct !== null ? usageBar(pct) : "░░░░░░░░░░░░░░░░░░░░";
  const pctStr = pct !== null ? `${Math.round(pct)}%`.padStart(4) : "  — ";
  return `\`${bar}\`  ${pctStr}  ${label}`;
}

function formatAgyUsage(d: import("@seam/adapters").AgyUsage): string {
  const lines = ["**Antigravity usage**", "", "**Models & Quota**"];
  const windows = [
    { window: "weekly", label: "Weekly" },
    { window: "5h", label: "Five-Hour" },
  ] as const;
  for (const group of d.groups) {
    lines.push("", `**${group.displayName}**`);
    for (const { window, label } of windows) {
      const bucket = group.buckets.find((candidate) => candidate.window === window);
      if (!bucket) continue;
      const usedPercent = (1 - bucket.remainingFraction) * 100;
      const reset = bucket.resetTime
        ? ` · resets ${formatResetTime(bucket.resetTime)}`
        : "";
      lines.push(usageLine(usedPercent, `${label}${reset}`));
    }
  }
  return lines.join("\n");
}

function formatOllamaCloudUsage(
  d: import("@seam/adapters").OllamaCloudUsageData
): string {
  if (!d.ok) {
    return `Couldn't read Ollama Cloud usage: ${d.error ?? "no data"}`;
  }
  const lines = ["**Ollama Cloud usage**", "", "**Rate limits**"];
  const windows = [
    { data: d.fiveHour, label: "5h" },
    { data: d.weekly, label: "Weekly" },
  ] as const;
  for (const { data, label } of windows) {
    if (!data) continue;
    const reset = data.resetAt
      ? ` · resets ${formatResetTime(data.resetAt)}`
      : "";
    lines.push(usageLine(data.pctUsed, `${label} limit${reset}`));
  }
  const topModels = [...(d.weekly?.models ?? [])]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);
  if (topModels.length > 0) {
    lines.push(
      "",
      "**Top models (weekly)**",
      ...topModels.map(
        (model) => `• \`${model.model}\` — ${model.requests.toLocaleString("en-US")} requests`
      )
    );
  }
  return lines.join("\n");
}

function formatCopilotUsage(
  d: import("@seam/adapters").CopilotUsageData
): string {
  const lines: string[] = [];
  const who = [d.login, d.org ? `(${d.org})` : null].filter(Boolean).join(" ");
  lines.push(`**GitHub Copilot usage**${who ? ` — ${who}` : ""}`);
  if (d.plan) lines.push(`Plan: \`${d.plan}\``);
  const fmtQuota = (
    label: string,
    q: import("@seam/adapters").CopilotQuotaSnapshot | null
  ): string | null => {
    if (!q) return null;
    if (q.unlimited) return `${label}: unlimited`;
    const used = q.entitlement - q.remaining;
    const pct = q.entitlement > 0 ? (used / q.entitlement) * 100 : 0;
    const over = q.overageCount > 0 ? ` (+${q.overageCount} overage)` : "";
    return usageLine(pct, `${label} — ${used} / ${q.entitlement}${over}`);
  };
  const quotas = [
    fmtQuota("Premium interactions", d.premiumInteractions),
    fmtQuota("Chat", d.chat),
    fmtQuota("Completions", d.completions),
  ].filter((s): s is string => s !== null);
  if (quotas.length > 0) {
    lines.push("", "**Quotas**", ...quotas);
    if (d.quotaResetAt) lines.push(`Resets ${formatResetTime(d.quotaResetAt)}`);
  }
  return lines.join("\n");
}

function formatGrokUsage(
  d: import("@seam/adapters").GrokUsageData
): string {
  const lines: string[] = [];
  lines.push(`**Grok usage**${d.subscriptionTier ? ` — ${d.subscriptionTier}` : ""}`);
  const period = d.periodType ? d.periodType : "period";
  const reset = d.periodEnd ? ` · resets ${formatResetTime(d.periodEnd)}` : "";
  if (d.creditUsagePercent !== null) {
    lines.push(
      "",
      `**${period.charAt(0).toUpperCase() + period.slice(1)} allowance**`,
      usageLine(d.creditUsagePercent, `used${reset}`)
    );
  } else {
    lines.push("No billing data available.");
  }
  return lines.join("\n");
}

function formatCodexUsage(
  d: import("@seam/adapters").CodexUsageData
): string {
  if (!d.ok) return `Couldn't read codex usage: ${d.error ?? "no data"}`;
  const lines: string[] = [
    `**OpenAI Codex usage**${d.plan ? ` — plan \`${d.plan}\`` : ""}`,
  ];
  const windowLabel = (min: number): string => {
    if (min >= 9000) return "Weekly";
    if (min >= 240 && min <= 360) return "5h";
    if (min % 1440 === 0) return `${min / 1440}d`;
    if (min % 60 === 0) return `${min / 60}h`;
    return `${min}m`;
  };
  const fmtWin = (
    w: import("@seam/adapters").CodexRateWindow | null
  ): string | null => {
    if (!w) return null;
    const reset =
      w.resetsAt != null
        ? ` · resets ${formatResetTime(new Date(w.resetsAt * 1000).toISOString())}`
        : "";
    return usageLine(w.usedPercent, `${windowLabel(w.windowMinutes)} limit${reset}`);
  };
  const rows = [fmtWin(d.primary), fmtWin(d.secondary)].filter(
    (s): s is string => s !== null
  );
  if (rows.length > 0) {
    lines.push("", "**Rate limits**", ...rows);
  } else {
    lines.push("", "_No rate-limit data yet — run a codex turn first._");
  }
  if (d.credits) {
    lines.push(
      d.credits.unlimited ? "Credits: unlimited" : `Credits: ${d.credits.balance}`
    );
  }
  if (d.source) lines.push("", formatUsageObservation(d.source));
  if (d.liveError) lines.push(`Live read unavailable: ${d.liveError}`);
  return lines.join("\n");
}

function formatClaudeUsage(
  d: import("@seam/adapters").ClaudeUsageData
): string {
  const lines: string[] = [];
  lines.push(`**Claude Code usage**${d.login ? ` — ${d.login}` : ""}`);
  if (d.subscriptionType) {
    const tier = d.rateLimitTier ? ` (${d.rateLimitTier})` : "";
    lines.push(`Subscription: \`${d.subscriptionType}${tier}\``);
  }
  const fmtBucket = (
    label: string,
    b: import("@seam/adapters").ClaudeUsageBucket | null
  ): string | null => {
    if (!b) return null;
    const reset = b.resetsAt ? ` · resets ${formatResetTime(b.resetsAt)}` : "";
    return usageLine(b.utilization, `${label}${reset}`);
  };
  const buckets = [
    fmtBucket("Current 5h session", d.fiveHour),
    fmtBucket("Current week (all models)", d.sevenDay),
    fmtBucket("Current week (Sonnet)", d.sevenDaySonnet),
    fmtBucket("Current week (Opus)", d.sevenDayOpus),
  ].filter((s): s is string => s !== null);
  if (buckets.length > 0) {
    lines.push("", "**Rate-limit utilization**", ...buckets);
  }
  if (d.extraUsage && d.extraUsage.enabled) {
    const dollars = (n: number): string => `$${(n / 100).toFixed(2)}`;
    const pct = d.extraUsage.utilization;
    lines.push(
      "",
      "**Usage credits**",
      usageLine(d.extraUsage.utilization, `${dollars(d.extraUsage.used)} / ${dollars(d.extraUsage.limit)}`),
    );
  }
  return lines.join("\n");
}

function formatResetTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const secs = Math.round((d.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "now";
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86400)}d`;
}
