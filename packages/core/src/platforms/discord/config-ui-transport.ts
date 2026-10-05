import type { ChatInputCommandInteraction, InteractionReplyOptions } from "discord.js";
import type { ChannelRef } from "../chat-adapter.js";
import type { ConfigInteraction } from "../../plugins/config-ui/ports.js";
import { replyToInteraction } from "./interaction-response.js";

/** Keep native interaction/client objects on the Discord side of the UI port. */
export function configUiInteraction(i: ChatInputCommandInteraction, channel: ChannelRef | undefined): ConfigInteraction {
  return {
    channelRef: channel, isThread: i.channel?.isThread() === true,
    user: { id: i.user.id, displayName: i.user.displayName, username: i.user.username },
    options: {
      getString: name => i.options.getString(name), getBoolean: name => i.options.getBoolean(name), getInteger: name => i.options.getInteger(name),
    },
    reply: view => replyToInteraction(i, view as InteractionReplyOptions),
  };
}
