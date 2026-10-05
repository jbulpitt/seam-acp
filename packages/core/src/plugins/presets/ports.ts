import type { ModalBuilder } from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { ChannelRef, ChatAdapter } from "../../platforms/chat-adapter.js";
import type { CardLifecycle, CardView, StoppableCollector } from "../../platforms/discord/collector-lifecycle.js";
import type { ModelCatalogService } from "../../core/model-catalog/service.js";
import type { Preset } from "../../core/types.js";
import type { SlashInvocation } from "../slash-registry.js";
import type { PresetRepository } from "./repository.js";

type Reply = CardView & { flags?: number | bigint };
export interface PresetModal {
  customId: string;
  user: { id: string };
  fields: { getTextInputValue(name: string): string };
  reply(view: Reply): Promise<void>;
  followUp(view: Reply): Promise<void>;
  deferUpdate(): Promise<void>;
}
export interface PresetCollector extends StoppableCollector {
  on(event: "collect", handle: (click: PresetClick) => Promise<void>): unknown;
  on(event: "end", handle: (collected: unknown, reason: string) => void): unknown;
}
export interface PresetInteraction {
  channelRef?: ChannelRef;
  channelId?: string;
  parentId?: string;
  projectScopeId?: string;
  user: { id: string };
  readonly deferred: boolean;
  readonly replied: boolean;
  options: {
    getString(name: string, required: true): string;
    getString(name: string): string | null;
    getBoolean(name: string): boolean | null;
    getInteger(name: string): number | null;
  };
  reply(view: Reply): Promise<void>;
  editReply(view: CardView | string): Promise<void>;
  deferReply(view: { flags?: number | bigint }): Promise<void>;
  fetchReply(): Promise<{ id: string; createMessageComponentCollector(options: { filter(click: { user: { id: string } }): boolean; time: number }): PresetCollector }>;
  attachLifecycle(collector: PresetCollector, expired: (reason: string) => CardView): CardLifecycle;
}
export interface PresetClick extends PresetInteraction {
  customId: string;
  values: string[];
  isButton(): boolean;
  isStringSelectMenu(): boolean;
  mutationRefusal(): string | undefined;
  deferUpdate(): Promise<void>;
  update(view: CardView): Promise<void>;
  showModal(modal: ModalBuilder): Promise<void>;
  awaitModalSubmit(options: { filter(modal: PresetModal): boolean; time: number }): Promise<PresetModal>;
}

/** Preset UI data and operations; admission and runtime ownership stay in the kernel. */
export interface PresetUiPorts {
  logger: Pick<Logger, "warn" | "error">;
  repository: Pick<PresetRepository, "getPreset" | "getPresetByNameScoped" | "listPresetsForProject" | "upsertPreset" | "deletePreset">;
  catalog: Pick<ModelCatalogService, "models" | "model">;
  transport: Pick<ChatAdapter, "sendChoicePicker">;
  builderDefaults(channel?: ChannelRef): { location: string; profiles: Array<{ id: string; displayName: string }> };
  listWorkspace(channel?: ChannelRef): Promise<string[] | undefined>;
  promptRepoPath(channel: ChannelRef, options: { title: string; includeInherit: boolean; authorizedUserIds: ReadonlySet<string> }): Promise<string | null>;
  resolveRequestedRepoPath(channel: ChannelRef, path: string): Promise<string>;
  repoDisplay(repo: string | null): string;
  canCreateThread: boolean;
  defaultRole(parent: string): string | undefined;
  apply(channel: ChannelRef, preset: Preset): Promise<string>;
  createFromPreset(channelId: string, name: string, author: string, preset: Preset): Promise<{ thread: ChannelRef; summary: string }>;
  interaction(invocation: SlashInvocation): PresetInteraction;
}
