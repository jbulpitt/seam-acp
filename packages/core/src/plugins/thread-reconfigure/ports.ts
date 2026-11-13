import type { ThreadConfigurationIdentity } from "../../core/runtime-transition.js";
import type { FastModeOutcome } from "../../core/fast-mode.js";
export type Actor = Readonly<{ id: string; name: string }>;
export interface BulkRequest {
  scope: "all" | "guild" | "channel";
  scopeId?: string;
  agent?: string;
  model?: string;
  role?: string;
  name?: string;
  preset?: string;
  presetScope?: string | null;
  targetModel: string;
  targetAgent?: string;
}
export interface BulkSnapshot {
  id: string; name: string; parentId: string; guildId: string;
  identity: ThreadConfigurationIdentity;
  preset: { id: string; projectRef: string | null; name: string; appliedUtc: string } | null;
}
export interface BulkRow {
  before: BulkSnapshot;
  /** Requested configuration; runtime observations are separate. */
  after?: ThreadConfigurationIdentity;
  consequence?: "none" | "live-apply" | "reload" | "reset";
  verification?: string;
  warnings?: string[];
  status: "eligible" | "unchanged" | "skipped" | "failed" | "changed";
  reason?: string;
  saved?: boolean;
  runtime?: "applied" | "next-acquisition" | "pending" | "unverified";
  runtimeSelection?: { model?: string; fastMode?: FastModeOutcome };
}
export interface BulkPlan {
  id: string; actor: Actor; origin: string; request: BulkRequest; rows: BulkRow[]; notes: string[];
}
export interface BulkPorts {
  preview(actor: Actor, request: BulkRequest): Promise<Pick<BulkPlan, "rows" | "notes">>;
  apply(actor: Actor, plan: BulkPlan): Promise<BulkRow[]>;
}
