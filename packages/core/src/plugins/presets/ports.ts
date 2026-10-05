import type { BrowserReply } from "../../core/session-browser.js";
import type { ModalBuilder } from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { ComponentEvent, ChannelRef, ChatAdapter } from "../../platforms/chat-adapter.js";
import type { CardView } from "../../platforms/discord/collector-lifecycle.js";
import type { ModelCatalogService } from "../../core/model-catalog/service.js";
import type { Preset } from "../../core/types.js";
import type { SlashInvocation } from "../slash-registry.js";
import type { PresetRepository } from "./repository.js";

type Reply = CardView & { flags?: number | bigint };
export interface PresetInteraction {
  readonly cardReply: BrowserReply;
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
  reply(view: Reply | string): Promise<void>;
  fetchReply(): Promise<{ id: string }>;
}
export interface PresetClick extends PresetInteraction {
  editReply(view: CardView | string): Promise<void>;
  customId: string;
  values: string[];
  isButton(): boolean;
  isStringSelectMenu(): boolean;
  isModalSubmit(): boolean;
  fields: { getTextInputValue(name: string): string };
  mutationRefusal(): string | undefined;
  update(view: CardView): Promise<void>;
  showModal(modal: ModalBuilder): Promise<void>;
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
  component(event: ComponentEvent): PresetClick;
  reply(target: string, user: string, channel: string): BrowserReply;
  track(work: Promise<void>): Promise<void>;
}
