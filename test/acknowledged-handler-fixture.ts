import type { ChatInputCommandInteraction } from "discord.js";
import { acknowledgeInteraction } from "../packages/core/src/platforms/discord/interaction-response.js";
import type { InteractionResponseMode } from "../packages/core/src/platforms/interaction-response.js";

/** Direct handler tests enter through the dispatcher's acknowledgement phase. */
export async function acknowledgedHandler<I, T>(interaction: I, handle: (acknowledged: I) => Promise<T>, mode: InteractionResponseMode = "ephemeral"): Promise<T> {
  await acknowledgeInteraction(interaction as ChatInputCommandInteraction, mode);
  // Partial native mocks model the state discord.js sets after the ACK.
  if (mode !== "modal") Object.assign(interaction as object, { deferred: true, ephemeral: mode === "ephemeral" });
  return handle(interaction);
}
