import {
  MessageFlags, MessageFlagsBitField,
  type ChatInputCommandInteraction, type MessageComponentInteraction,
  type ModalSubmitInteraction, type InteractionReplyOptions, type InteractionEditReplyOptions,
} from "discord.js";
import type { InteractionResponseMode } from "../interaction-response.js";

type Interaction = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;
export type InteractionReply = string | InteractionReplyOptions | InteractionEditReplyOptions;
const acknowledgements = new WeakMap<object, Promise<void>>();

export async function waitForInteractionAcknowledgement(interaction: object): Promise<void> {
  await acknowledgements.get(interaction);
}

/** Dispatch owns the initial acknowledgement; handlers fill its reply. */
export async function acknowledgeInteraction(interaction: Interaction, mode: InteractionResponseMode): Promise<void> {
  const pending = acknowledgements.get(interaction);
  if (pending) return pending;
  if (mode === "modal" || interaction.deferred || interaction.replied) return;
  const acknowledgement = interaction.deferReply(mode === "ephemeral" ? { flags: MessageFlags.Ephemeral } : {});
  acknowledgements.set(interaction, acknowledgement);
  return acknowledgement;
}

export async function replyToInteraction(interaction: Interaction, reply: InteractionReply): Promise<void> {
  await waitForInteractionAcknowledgement(interaction);
  const payload = typeof reply === "string" ? { content: reply } : reply;
  if (interaction.deferred || interaction.replied) {
    const { flags, ...rest } = payload;
    const bits = flags == null ? undefined : new MessageFlagsBitField(flags as ConstructorParameters<typeof MessageFlagsBitField>[0]);
    if (bits?.has(MessageFlags.Ephemeral) && interaction.ephemeral === false) {
      if (interaction.deferred && !interaction.replied) await interaction.deleteReply();
      await interaction.followUp(payload as InteractionReplyOptions);
      return;
    }
    const editableFlags = bits == null ? undefined : bits.bitfield & (MessageFlags.SuppressEmbeds | MessageFlags.IsComponentsV2);
    await interaction.editReply({ ...rest, ...(editableFlags ? { flags: editableFlags } : {}) } as InteractionEditReplyOptions);
  } else {
    await interaction.reply({ flags: MessageFlags.Ephemeral, ...payload } as InteractionReplyOptions);
  }
}
