import type { CodexUsageData } from "@seam/adapters";

export function formatUsageObservation(source: NonNullable<CodexUsageData["source"]>): string {
  const at = Date.parse(source.observedAt ?? "");
  const age = Number.isFinite(at) ? `<t:${Math.floor(at / 1000)}:R>` : "age unknown";
  return `${source.kind === "live" ? "Live read" : "Rollout snapshot"} · ${source.host} · ${age}`;
}
