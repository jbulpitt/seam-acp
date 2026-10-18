import type { DelegationKind } from "../types.js";

export const DISPATCH_PANEL_TITLES = {
  handoff: "📨 Handoff", forward: "📤 Forward", wake: "⏰ Wake", watch: "👁 Watch",
  report_back: "🔁 Report-back", peek: "🔍 Peek", compact: "🗜 Compact",
  scheduled: "📅 Scheduled", parked: "📥 Parked", choice: "🗳️ Choice",
  ingest: "🌐 Ingest", migrate_self: "🔀 Migration", chain: "🔗 Chain",
} as const;

export function dispatchPanelTitle(kind: DelegationKind | undefined, chained: boolean): string {
  if (chained) return DISPATCH_PANEL_TITLES.chain;
  return DISPATCH_PANEL_TITLES[kind as keyof typeof DISPATCH_PANEL_TITLES] ?? DISPATCH_PANEL_TITLES.handoff;
}
