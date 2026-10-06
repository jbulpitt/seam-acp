import type { Logger } from "../../lib/logger.js";
import type { ChannelRef, ChatAdapter } from "../../platforms/chat-adapter.js";
import type { ConfigDescription } from "../../core/session-router.js";
import type { ConfigApplyPlan, ConfigSetRequest, PreparedConfigSet } from "../../core/config-apply-plan.js";
import type { ConfigAuditEntry } from "../../core/types.js";
import type { ModelCatalogService } from "../../core/model-catalog/service.js";
import type { MutationActor } from "../../core/config-mutation.js";
import type { ThreadConfigDraft, InheritedConfig, ChannelPresetPins } from "../../platforms/discord/config-editor.js";
import type { CardView } from "../../platforms/discord/collector-lifecycle.js";
import type { SlashInvocation } from "../slash-registry.js";
import type { AutocompleteResponder } from "../../platforms/discord/autocomplete.js";
import type { ConfigDefaultField, OverrideCounts } from "../../core/config-target.js";
import type { ParentConfigCleanup } from "../../core/channel-config-cleanup.js";

export interface ConfigInteraction {
  channelRef?: ChannelRef;
  isThread: boolean;
  user: { id: string; displayName?: string; username: string };
  options: {
    getString(name: string): string | null;
    getBoolean(name: string): boolean | null;
    getInteger(name: string): number | null;
  };
  reply(view: string | (CardView & { flags?: number | bigint })): Promise<void>;
}

/** Built-in UI operations only. Session records and runtime ownership stay in the kernel. */
export interface ConfigUiPorts {
  logger: Pick<Logger, "warn" | "error">;
  transport: Pick<ChatAdapter, "sendMessage" | "sendPanel" | "editPanel" | "sendFile" | "sendChoicePicker">;
  catalog: Pick<ModelCatalogService, "models" | "model" | "effortChoices" | "isHidden">;
  bind(channel: ChannelRef): void;
  readConfig(channel: ChannelRef): unknown;
  snapshot(channel: ChannelRef): { desc: ConfigDescription; withoutThread: InheritedConfig; channelPins: ChannelPresetPins };
  canEditChannelPreset(user: string, parent?: string): boolean;
  hasFastMode(agent: string): boolean;
  agentChoices(): Array<{ value: string; label: string; description?: string }>;
  promptRepoPath(channel: ChannelRef, options: { title: string; location: string; authorizedUserIds: ReadonlySet<string>; includeInherit: boolean }): Promise<string | null>;
  saveEditor(draft: ThreadConfigDraft, actor: MutationActor): ReturnType<ConfigApplyPlan["saveEditor"]>;
  prepareSet(channel: ChannelRef, request: ConfigSetRequest): ReturnType<ConfigApplyPlan["prepareConfigSet"]>;
  applySet(channel: ChannelRef, request: ConfigSetRequest, prepared: PreparedConfigSet, actor: { id: string; name: string }, options: { retireRuntime: boolean; applyName: boolean }): Promise<
    { ok: true; effective: ConfigDescription; restartRequested: boolean } | { ok: false; message: string; rollbackError: string }>;
  prepareChannelSet: ConfigApplyPlan["prepareChannelSet"];
  applyChannelSet: ConfigApplyPlan["applyChannelSet"];
  overrideCounts(channelId: string, fields?: readonly ConfigDefaultField[]): OverrideCounts;
  followChannel: ConfigApplyPlan["followChannel"];
  clearThreadOverrides: ConfigApplyPlan["clearThreadOverrides"];
  cleanup: Pick<ParentConfigCleanup, "preview" | "apply">;
  rebuild(channel: ChannelRef): Promise<string>;
  auditEntries(limit: number): ConfigAuditEntry[];
  codeBlock(text: string, language: string): string;
  repoDisplay(repo: string | null): string;
  description(key: string): string | undefined;
  autocomplete: ReadonlyArray<{ option: string; policy: "canonical"; respond: AutocompleteResponder }>;
  interaction(invocation: SlashInvocation): ConfigInteraction;
}
