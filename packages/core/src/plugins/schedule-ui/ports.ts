import type { ModalBuilder } from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { ChannelRef, ComponentEvent } from "../../platforms/chat-adapter.js";
import type { CardLifecycle, CardView, StoppableCollector } from "../../platforms/discord/collector-lifecycle.js";
import type { ScheduledPrompt } from "../../core/scheduled-prompts/types.js";
import type { SlashInvocation } from "../slash-registry.js";
import type { ComponentAcknowledgement } from "../../platforms/interaction-response.js";

export type ScheduleReply = CardView & { flags?: number | bigint };
export interface ScheduleModal {
  customId: string;
  user: { id: string };
  fields: { getTextInputValue(name: string): string };
  reply(view: ScheduleReply): Promise<void>;
  followUp(view: ScheduleReply): Promise<void>;
}
export interface ScheduleCollector extends StoppableCollector {
  on(event: "collect", handle: (click: ScheduleClick) => Promise<void>): unknown;
  on(event: "end", handle: (collected: unknown, reason: string) => void): unknown;
}
/** UI capabilities only: no Discord client, session, router or store. */
export interface ScheduleInteraction {
  channelRef?: ChannelRef;
  user: { id: string };
  readonly deferred: boolean;
  readonly replied: boolean;
  options: { getString(name: string, required: true): string; getString(name: string): string | null };
  reply(view: ScheduleReply | string): Promise<void>;
  fetchReply(): Promise<{ id: string; createMessageComponentCollector(options: { filter(click: { user: { id: string } }): boolean; time: number; acknowledgement: ComponentAcknowledgement }): ScheduleCollector }>;
  attachLifecycle(collector: ScheduleCollector, expired: (reason: string) => CardView): CardLifecycle;
}
export interface ScheduleClick extends ScheduleInteraction {
  editReply(view: CardView | string): Promise<void>;
  customId: string;
  messageId: string;
  messageButtons: Array<{ customId: string; disabled: boolean }>;
  values: string[];
  isButton(): boolean;
  isStringSelectMenu(): boolean;
  mutationRefusal(): string | undefined;
  update(view: CardView): Promise<void>;
  followUp(view: ScheduleReply): Promise<void>;
  showModal(modal: ModalBuilder): Promise<void>;
  awaitModalSubmit(options: { filter(modal: ScheduleModal): boolean; time: number; acknowledgement: ComponentAcknowledgement }): Promise<ScheduleModal | null>;
  openFollowUp(): ScheduleInteraction;
}

export interface ScheduleUiPorts {
  logger: Pick<Logger, "warn" | "error">;
  reposRoot: string;
  repository: {
    list(channelId: string): ScheduledPrompt[];
    get(id: string): ScheduledPrompt | undefined;
    save(row: ScheduledPrompt): void;
    remove(id: string): void;
  };
  admin: {
    arm(row: ScheduledPrompt): void;
    disarm(id: string): void;
    reschedule(id: string): void;
    runNow(id: string): Promise<void>;
  };
  builderDefaults(channel: ChannelRef): {
    agent: string; registered: boolean; model: string; cwd: string;
    models: Array<{ modelId: string; name: string }>;
  };
  interaction(invocation: SlashInvocation): ScheduleInteraction;
  component(invocation: ComponentEvent): ScheduleClick;
}
