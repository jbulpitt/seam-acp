import type { ChatInputCommandInteraction, MessageComponentInteraction, ModalSubmitInteraction, InteractionReplyOptions, InteractionEditReplyOptions, InteractionUpdateOptions } from "discord.js";
import type { ChannelRef } from "../chat-adapter.js";
import type { PresetInteraction, PresetClick } from "../../plugins/presets/ports.js";
import { browserReplyFromInteraction } from "./browser-reply.js";
import { replyToInteraction } from "./interaction-response.js";

type Interaction = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;
/** Wrap native interactions without exposing their client or channel objects. */
export function presetUiInteraction<T extends Interaction>(i: T, deps: {
  channel(interaction: Interaction): ChannelRef | undefined;
  mutationRefusal(interaction: Interaction): string | undefined;
  projectScopeId(interaction: Interaction): string | undefined;
}): T extends ChatInputCommandInteraction ? PresetInteraction : PresetClick {
  const common: PresetInteraction = {
    cardReply: browserReplyFromInteraction(i),
    channelRef: deps.channel(i), channelId: i.channelId ?? undefined,
    parentId: i.channel?.isThread() ? i.channel.parentId ?? undefined : undefined, projectScopeId: deps.projectScopeId(i), user: { id: i.user.id },
    get deferred() { return i.deferred; }, get replied() { return i.replied; },
    options: { getString: ((name: string, required?: boolean) => (i as ChatInputCommandInteraction).options.getString(name, required)) as PresetInteraction["options"]["getString"],
      getBoolean: name => (i as ChatInputCommandInteraction).options.getBoolean(name), getInteger: name => (i as ChatInputCommandInteraction).options.getInteger(name),
    },
    reply: view => replyToInteraction(i, view as InteractionReplyOptions),
    fetchReply: async () => ({ id: (await i.fetchReply()).id }),
  };
  if (!("customId" in i)) return common as never;
  const click: PresetClick = {
    ...common, customId: i.customId,
    get deferred() { return i.deferred; }, get replied() { return i.replied; },
    values: i.isStringSelectMenu() ? [...i.values] : [],
    fields: { getTextInputValue: name => (i as ModalSubmitInteraction).fields.getTextInputValue(name) },
    isButton: () => i.isButton(), isStringSelectMenu: () => i.isStringSelectMenu(), isModalSubmit: () => i.isModalSubmit(),
    mutationRefusal: () => deps.mutationRefusal(i),
    editReply: view => replyToInteraction(i, view as InteractionReplyOptions),
    deferReply: async view => { await i.deferReply(view as Parameters<typeof i.deferReply>[0]); },
    deferUpdate: async () => { await i.deferUpdate(); },
    update: async view => { await (i as MessageComponentInteraction).update(view as InteractionUpdateOptions); },
    showModal: async view => { await (i as MessageComponentInteraction).showModal(view); },
  };
  return click as never;
}
