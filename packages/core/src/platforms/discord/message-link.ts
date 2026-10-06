import type { MessageLink } from "../chat-adapter.js";

/** A guild message link uses the containing channel, including a thread's own id. */
export function discordMessageLink(
  guildId: string | null | undefined,
  channelId: string,
  messageId: string | null | undefined
): MessageLink {
  if (!messageId) return { jumpLinkUnavailableReason: "No Discord message has been posted." };
  if (!guildId) return { jumpLinkUnavailableReason: "The Discord guild is unavailable." };
  return { jumpUrl: `https://discord.com/channels/${guildId}/${channelId}/${messageId}` };
}
