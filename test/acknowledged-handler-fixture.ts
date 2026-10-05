import type { ChatInputCommandInteraction } from "discord.js";
import { acknowledgeInteraction } from "../packages/core/src/platforms/discord/interaction-response.js";

/** Direct handler tests enter through the dispatcher's acknowledgement phase. */
export async function acknowledgedHandler<T>(interaction: unknown, handle: () => Promise<T>): Promise<T> {
  await acknowledgeInteraction(interaction as ChatInputCommandInteraction, "ephemeral");
  return handle();
}
