import { MessageFlags, type Message, type ChatInputCommandInteraction, type MessageComponentInteraction, type ModalSubmitInteraction, type InteractionReplyOptions, type InteractionEditReplyOptions } from "discord.js";
import type { ChannelRef } from "../chat-adapter.js";
import type { CardLifecycle, CardView } from "./collector-lifecycle.js";
import type { ScheduleInteraction, ScheduleClick, ScheduleCollector, ScheduleModal } from "../../plugins/schedule-ui/ports.js";
import { replyToInteraction, collectAcknowledgedInteractions, awaitAcknowledgedInteraction, ignoreCollectorTimeout } from "./interaction-response.js";

type Interaction = ChatInputCommandInteraction | MessageComponentInteraction;
/** Wrap native interactions without exposing their client or channel objects. */
export function scheduleUiInteraction<T extends Interaction>(i: T, deps: {
  channel(interaction: Interaction): ChannelRef | undefined;
  mutationRefusal(interaction: Interaction): string | undefined;
  lifecycle(interaction: Interaction, collector: ScheduleCollector, expired: (reason: string) => CardView): CardLifecycle;
  onError(error: unknown): void;
}): T extends MessageComponentInteraction ? ScheduleClick : ScheduleInteraction {
  const modal = (m: ModalSubmitInteraction): ScheduleModal => ({
    customId: m.customId, user: { id: m.user.id },
    fields: { getTextInputValue: name => m.fields.getTextInputValue(name) },
    reply: view => replyToInteraction(m, view as InteractionReplyOptions),
    followUp: view => replyToInteraction(m, view as InteractionReplyOptions, { followUp: true }),
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
          on: (event: string, handle: (...args: any[]) => Promise<void>) => event === "collect"
            ? collectAcknowledgedInteractions(collector, options.acknowledgement, click => handle(wrapClick(click)), deps.onError)
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
    update: view => replyToInteraction(click, view as InteractionReplyOptions),
    followUp: view => replyToInteraction(click, view as InteractionReplyOptions, { followUp: true }),
    showModal: async view => { await click.showModal(view); },
    awaitModalSubmit: async options => {
      const submitted = await awaitAcknowledgedInteraction(() => click.awaitModalSubmit({ time: options.time, filter: m => options.filter(modal(m)) }), options.acknowledgement).catch(ignoreCollectorTimeout);
      return submitted ? modal(submitted) : null;
    },
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
