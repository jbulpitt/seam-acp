import { MessageFlags, type Message, type ChatInputCommandInteraction, type MessageComponentInteraction, type ModalSubmitInteraction, type InteractionReplyOptions, type InteractionEditReplyOptions, type InteractionUpdateOptions } from "discord.js";
import type { ChannelRef } from "../chat-adapter.js";
import type { CardLifecycle, CardView } from "./collector-lifecycle.js";
import type { ScheduleInteraction, ScheduleClick, ScheduleCollector, ScheduleModal } from "../../plugins/schedule-ui/ports.js";
import { replyToInteraction } from "./interaction-response.js";

type Interaction = ChatInputCommandInteraction | MessageComponentInteraction;
/** Wrap native interactions without exposing their client or channel objects. */
export function scheduleUiInteraction<T extends Interaction>(i: T, deps: {
  channel(interaction: Interaction): ChannelRef | undefined;
  mutationRefusal(interaction: Interaction): string | undefined;
  lifecycle(interaction: Interaction, collector: ScheduleCollector, expired: (reason: string) => CardView): CardLifecycle;
}): T extends MessageComponentInteraction ? ScheduleClick : ScheduleInteraction {
  const modal = (m: ModalSubmitInteraction): ScheduleModal => ({
    customId: m.customId, user: { id: m.user.id },
    fields: { getTextInputValue: name => m.fields.getTextInputValue(name) },
    reply: async view => { await m.reply(view as InteractionReplyOptions); },
    followUp: async view => { await m.followUp(view as InteractionReplyOptions); },
    deferUpdate: async () => { await m.deferUpdate(); },
  });
  const wrap = (native: Interaction): ScheduleInteraction => ({
    channelRef: deps.channel(native), user: { id: native.user.id },
    get deferred() { return native.deferred; },
    get replied() { return native.replied; },
    options: { getString: ((name: string, required?: boolean) => (native as ChatInputCommandInteraction).options.getString(name, required)) as ScheduleInteraction["options"]["getString"] },
    reply: view => replyToInteraction(native, view as InteractionReplyOptions),
    fetchReply: async () => {
      const message = await native.fetchReply();
      return { id: message.id, createMessageComponentCollector: options => {
        const collector = message.createMessageComponentCollector({ time: options.time, filter: click => options.filter({ user: { id: click.user.id } }) });
        return {
          stop: reason => collector.stop(reason),
          on: (event: string, handle: (...args: any[]) => unknown) => event === "collect"
            ? collector.on("collect", click => handle(wrapClick(click)))
            : collector.on("end", (_collected, reason) => handle(undefined, reason)),
        } as ScheduleCollector;
      } };
    },
    attachLifecycle: (collector, expired) => deps.lifecycle(native, collector, expired),
  });
  const wrapClick = (click: MessageComponentInteraction): ScheduleClick => ({
    ...wrap(click), customId: click.customId,
    get messageId() { return click.message.id; },
    get messageButtons() {
      return click.message.components.flatMap(row => "components" in row
        ? row.components.flatMap(component => "customId" in component && component.customId
          ? [{ customId: component.customId, disabled: "disabled" in component && component.disabled }] : []) : []);
    },
    get deferred() { return click.deferred; },
    get replied() { return click.replied; },
    values: click.isStringSelectMenu() ? [...click.values] : [],
    isButton: () => click.isButton(), isStringSelectMenu: () => click.isStringSelectMenu(),
    mutationRefusal: () => deps.mutationRefusal(click),
    editReply: view => replyToInteraction(click, view as InteractionReplyOptions),
    deferUpdate: async () => { await click.deferUpdate(); },
    deferReply: async options => { await click.deferReply(options as Parameters<typeof click.deferReply>[0]); },
    update: async view => { await click.update(view as InteractionUpdateOptions); },
    followUp: async view => { await click.followUp(view as InteractionReplyOptions); },
    showModal: async view => { await click.showModal(view); },
    awaitModalSubmit: async options => modal(await click.awaitModalSubmit({ time: options.time, filter: m => options.filter(modal(m)) })),
    openFollowUp: () => {
      let message: Message;
      const editor = Object.create(click) as MessageComponentInteraction;
      editor.editReply = async view => {
        const payload = (typeof view === "string" ? { content: view } : view) as InteractionEditReplyOptions;
        if (!message) message = await click.followUp({ ...payload, flags: MessageFlags.Ephemeral } as InteractionReplyOptions);
        else message = await click.editReply({ ...payload, message: message.id });
        return message;
      };
      editor.fetchReply = async () => message;
      return wrap(editor);
    },
  });
  return ("customId" in i ? wrapClick(i) : wrap(i)) as T extends MessageComponentInteraction ? ScheduleClick : ScheduleInteraction;
}
