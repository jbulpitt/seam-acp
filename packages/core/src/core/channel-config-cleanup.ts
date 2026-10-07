import type { Config } from "../config.js";
import type { SessionStore } from "./session-store.js";
import type { ConfigApplyPlan } from "./config-apply-plan.js";
import type { ChannelPresetChanges, MutationActor } from "./config-mutation.js";
import { configOverrideFields, CONFIG_DEFAULT_FIELDS, type OverrideCounts } from "./config-target.js";
import { randomUUID } from "node:crypto";

export interface ConfigParentChannel { id: string; name: string; guildId: string; guildName: string }
export interface ParentConfigCleanupEntry extends ConfigParentChannel {
  sessionId?: string;
  threadEntry: boolean;
  changes: ChannelPresetChanges;
  preserved: string[];
  overrides: OverrideCounts;
  source: string;
}
export interface ParentConfigCleanupPreview { entries: ParentConfigCleanupEntry[] }

/** Preview is read-only; only the confirmed admin action calls apply. */
export class ParentConfigCleanup {
  constructor(private readonly deps: { config: Config; store: SessionStore; plan(): ConfigApplyPlan; parents(): Promise<ConfigParentChannel[]> }) {}

  async preview(): Promise<ParentConfigCleanupPreview> {
    const plan = this.deps.plan();
    const presets = plan.readPresetsSnapshot();
    const entries: ParentConfigCleanupEntry[] = [];
    for (const parent of await this.deps.parents()) {
      const row = this.deps.store.getByChannel("discord", parent.id);
      const thread = presets.threads?.[parent.id] as Record<string, unknown> | undefined;
      const threadEntry = configOverrideFields(Object.keys(thread ?? {})).length > 0;
      if (!row && !threadEntry) continue;
      const cfg = row ? this.deps.store.readConfig(row) : {};
      const legacy: Record<string, unknown> = { ...(row ? { agent: row.agentId } : {}),
        ...Object.fromEntries(Object.entries(cfg).map(([key, value]) => [key === "reasoningEffort" ? "effort" : key, value])),
        ...(cfg.sessionCwdExplicit && row?.repoPath ? { cwd: row.repoPath } : {}) };
      const current = this.deps.config.channelPresets.get(parent.id);
      const changes: ChannelPresetChanges = {};
      const preserved: string[] = [];
      for (const field of CONFIG_DEFAULT_FIELDS) {
        const pin = thread?.[field] as { value?: unknown } | undefined;
        const value = pin?.value ?? legacy[field];
        if (value === undefined) continue;
        if (current?.[field] !== undefined) preserved.push(field);
        else Object.assign(changes, { [field]: value });
      }
      entries.push({ ...parent, ...(row ? { sessionId: row.id } : {}), threadEntry,
        changes, preserved, overrides: plan.overrideCounts(parent.id), source: JSON.stringify({ row, thread }) });
    }
    return { entries };
  }

  async apply(preview: ParentConfigCleanupPreview, actor: MutationActor): Promise<number> {
    const current = await this.preview();
    if (JSON.stringify(current) !== JSON.stringify(preview)) throw new Error("Cleanup preview changed. Run the dry-run again and confirm its new output.");
    const plan = this.deps.plan();
    for (const entry of preview.entries) {
      if (Object.keys(entry.changes).length) {
        const written = plan.applyChannelOverlay({ channelId: entry.id, changes: entry.changes, actor });
        if (!written.ok && !written.error.includes("No effective change")) throw new Error(written.error);
      }
      if (entry.threadEntry) {
        const remaining = { ...plan.readPresetsSnapshot().threads?.[entry.id] as Record<string, unknown> };
        for (const field of configOverrideFields(Object.keys(remaining))) delete remaining[field];
        const removed = plan.restoreThreadPresetEntry(entry.id, Object.keys(remaining).length ? remaining : undefined);
        if (!removed.ok) throw new Error(removed.error);
      }
      const audit = {
        id: randomUUID(), tier: "channel-preset", scope: entry.id, actorId: actor.id, actorName: actor.name,
        summary: "Confirmed cleanup of misfiled parent-channel configuration", beforeJson: entry.source,
        afterJson: JSON.stringify({ moved: entry.changes, preserved: entry.preserved }),
      } as const;
      if (entry.sessionId) this.deps.store.removeMisfiledSession(entry.sessionId, audit);
      else this.deps.store.recordConfigMutation(audit);
    }
    return preview.entries.length;
  }
}
