import {
  MessageFlags, MessageFlagsBitField,
  type ChatInputCommandInteraction, type MessageComponentInteraction,
  type ModalSubmitInteraction, type InteractionReplyOptions, type InteractionEditReplyOptions,
} from "discord.js";
import type { ComponentAcknowledgement, ComponentAcknowledgementContext, ComponentResponseMode } from "../interaction-response.js";
import { runAcknowledged } from "../interaction-response.js";

type Interaction = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;
export type InteractionReply = string | InteractionReplyOptions | InteractionEditReplyOptions;
const acknowledgements = new WeakMap<object, Promise<void>>();

export async function waitForInteractionAcknowledgement(interaction: object): Promise<void> {
  await acknowledgements.get(interaction);
}

/** Dispatch owns the initial acknowledgement; handlers fill its reply. */
export function acknowledgeInteraction(interaction: Interaction, mode: ComponentResponseMode): Promise<void> {
  const pending = acknowledgements.get(interaction);
  if (pending) return pending;
  if (mode === "modal" || interaction.deferred || interaction.replied) return Promise.resolve();
  const acknowledgement = (mode === "update"
    ? (interaction as MessageComponentInteraction | ModalSubmitInteraction).deferUpdate()
    : interaction.deferReply(mode === "ephemeral" ? { flags: MessageFlags.Ephemeral } : {})).then(() => {});
  // Dispatch and replies retain the rejection, even when no reply is attempted.
  void acknowledgement.catch(() => {});
  acknowledgements.set(interaction, acknowledgement);
  return acknowledgement;
}

type ReplyOptions = { followUp?: boolean; fetchReply?: boolean };
export function replyToInteraction(interaction: Interaction, reply: InteractionReply, options: ReplyOptions & { fetchReply: true }): Promise<string>;
export function replyToInteraction(interaction: Interaction, reply: InteractionReply, options?: ReplyOptions): Promise<void>;
export async function replyToInteraction(interaction: Interaction, reply: InteractionReply, options: ReplyOptions = {}): Promise<string | void> {
  await waitForInteractionAcknowledgement(interaction);
  const payload = typeof reply === "string" ? { content: reply } : reply;
  let message;
  if (interaction.deferred || interaction.replied) {
    const { flags, ...rest } = payload;
    const bits = flags == null ? undefined : new MessageFlagsBitField(flags as ConstructorParameters<typeof MessageFlagsBitField>[0]);
    if (options.followUp || (bits?.has(MessageFlags.Ephemeral) && interaction.ephemeral !== true)) {
      if (interaction.ephemeral === false && interaction.deferred && !interaction.replied) await interaction.deleteReply();
      message = await interaction.followUp(payload as InteractionReplyOptions);
    } else {
      const editableFlags = bits == null ? undefined : bits.bitfield & (MessageFlags.SuppressEmbeds | MessageFlags.IsComponentsV2);
      message = await interaction.editReply({ ...rest, ...(editableFlags ? { flags: editableFlags } : {}) } as InteractionEditReplyOptions);
    }
  } else {
    await interaction.reply({ flags: MessageFlags.Ephemeral, ...payload } as InteractionReplyOptions);
    if (options.fetchReply) message = await interaction.fetchReply();
  }
  if (options.fetchReply) return message!.id;
}

export function componentAcknowledgementContext(interaction: MessageComponentInteraction | ModalSubmitInteraction): ComponentAcknowledgementContext {
  return { customId: interaction.customId,
    kind: interaction.isModalSubmit() ? "modal" : interaction.isStringSelectMenu() ? "select" : "button",
    ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}) };
}

export function acknowledgeComponentInteraction(interaction: MessageComponentInteraction | ModalSubmitInteraction, declaration: ComponentAcknowledgement): Promise<void> {
  const mode = typeof declaration === "function" ? declaration(componentAcknowledgementContext(interaction)) : declaration;
  return acknowledgeInteraction(interaction, mode);
}

/** Collector callbacks use the same acknowledgement path as persistent routes. */
export function collectAcknowledgedInteractions<T extends MessageComponentInteraction>(collector: {
  on(event: "collect", handle: (interaction: T) => void): unknown;
}, declaration: ComponentAcknowledgement, handle: (interaction: T) => Promise<unknown>, onError: (error: unknown) => void): void {
  collector.on("collect", async interaction => {
    try { await runAcknowledged(acknowledgeComponentInteraction(interaction, declaration), () => handle(interaction)); }
    catch (error) {
      onError(error);
      await replyToInteraction(interaction, { content: `Could not complete this action: ${error instanceof Error ? error.message : String(error)}`,
        flags: MessageFlags.Ephemeral }).catch(onError);
    }
  });
}

/** Modal submissions and single-pick collectors acknowledge before returning. */
export async function awaitAcknowledgedInteraction<T extends MessageComponentInteraction | ModalSubmitInteraction>(wait: () => Promise<T>, declaration: ComponentAcknowledgement): Promise<T> {
  const interaction = await wait();
  await acknowledgeComponentInteraction(interaction, declaration);
  return interaction;
}

/** Only collector expiry is a missing response; acknowledgement errors propagate. */
export function ignoreCollectorTimeout(error: unknown): null {
  if ((error as { code?: unknown } | null)?.code === "InteractionCollectorError") return null;
  throw error;
}
