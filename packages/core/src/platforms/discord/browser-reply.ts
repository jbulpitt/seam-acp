import { WebhookClient, MessageFlags, type InteractionEditReplyOptions, type InteractionReplyOptions,
  type ChatInputCommandInteraction, type MessageComponentInteraction, type ModalSubmitInteraction } from "discord.js";
import type { BrowserReply, BrowserClick } from "../../core/session-browser.js";
import type { ComponentEvent } from "../chat-adapter.js";
import { SyntheticInteraction, type SyntheticContext, type SyntheticReplySnapshot } from "./synthetic-interaction.js";

/** A scoped reply capability, retained only in private runtime card storage. */
export function browserReplyFromInteraction(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction | SyntheticInteraction,
): BrowserReply {
  return {
    get target() { return JSON.stringify(interaction instanceof SyntheticInteraction
      ? { kind: "synthetic", ...interaction.replySnapshot() }
      : { kind: "webhook", id: interaction.applicationId, token: interaction.token }); },
    user: { id: interaction.user.id }, channelId: interaction.channelId!,
    editReply: async (view) => {
      if (interaction instanceof SyntheticInteraction) await interaction.editReply(view);
      else await interaction.editReply(view as InteractionEditReplyOptions);
    },
    deleteReply: async () => { await interaction.deleteReply(); },
    followUp: async (view) => {
      const payload = { ...view, flags: MessageFlags.Ephemeral };
      if (interaction instanceof SyntheticInteraction) await interaction.followUp(payload);
      else await interaction.followUp(payload as InteractionReplyOptions);
    },
  };
}

export function browserReply(target: string, userId: string, channelId: string,
  syntheticContext: (snapshot: SyntheticReplySnapshot) => Promise<SyntheticContext>): BrowserReply {
  const saved = JSON.parse(target);
  const restored = saved.kind === "synthetic"
    ? syntheticContext(saved).then(ctx => SyntheticInteraction.restoreReply(saved, ctx)) : undefined;
  const webhook = saved.kind === "webhook" ? new WebhookClient(saved) : undefined;
  return {
    target, user: { id: userId }, channelId,
    editReply: async (view) => {
      if (restored) await (await restored).editReply(view);
      else await webhook!.editMessage("@original", view as InteractionEditReplyOptions);
    },
    deleteReply: async () => {
      if (restored) await (await restored).deleteReply();
      else await webhook!.deleteMessage("@original");
    },
    followUp: async (view) => {
      const payload = { ...view, flags: MessageFlags.Ephemeral };
      if (restored) await (await restored).followUp(payload);
      else await webhook!.send(payload as Parameters<WebhookClient["send"]>[0]);
    },
  };
}

export function browserClick(event: ComponentEvent): BrowserClick {
  const output = event.cardReply!;
  return {
    customId: event.customId, user: { id: event.userId, name: event.userName }, values: event.values ?? [],
    fields: { getTextInputValue: (name) => event.fields?.[name] ?? "" },
    isStringSelectMenu: () => event.kind === "select", isModalSubmit: () => event.kind === "modal",
    deferUpdate: () => event.deferUpdate(), editReply: (view) => output.editReply(view),
    deleteReply: () => output.deleteReply(),
    reply: (view) => event.replyEphemeral(view.content), followUp: (view) => event.followUpEphemeral(view.content),
    showModal: async (modal) => {
      const data = modal.toJSON() as { custom_id: string; title: string; components: Array<{ components: Array<{
        custom_id: string; label: string; style: number; required?: boolean; placeholder?: string;
      }> }> };
      await event.showModal({ customId: data.custom_id, title: data.title,
        inputs: data.components.flatMap(row => row.components.map(input => ({
          id: input.custom_id, label: input.label, style: input.style === 2 ? "paragraph" : "short",
          required: input.required, placeholder: input.placeholder,
        }))) });
    },
  };
}
