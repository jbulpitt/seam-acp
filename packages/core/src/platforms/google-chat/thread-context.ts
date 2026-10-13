import type { Logger } from "pino";
import type { GoogleChatHistoryReader, GoogleChatHistoryMessage } from "../../core/messages/google-chat-history.js";
import type { GoogleChatMessageRoot, GoogleChatSpaceStore } from "./space-store.js";

export function messageRoot(message: GoogleChatHistoryMessage, own = false): GoogleChatMessageRoot {
  return { name: message.name, sender: message.sender?.displayName ?? (own ? "Seam" : message.sender?.name ?? "Unknown sender"),
    createTime: message.createTime, text: (message.text ?? "").slice(0, 200),
    filename: message.attachment?.[0]?.contentName, own };
}

/** Context is optional; a history outage never prevents prompt admission. */
export async function threadContext(space: string, thread: string, opts: {
  store?: Pick<GoogleChatSpaceStore, "messageRoot" | "recordMessageRoot"> & Partial<Pick<GoogleChatSpaceStore, "isOwnMessage">>;
  history?: Pick<GoogleChatHistoryReader, "getMessage" | "readRawPage">;
  logger: Logger;
}): Promise<string | undefined> {
  const saved = opts.store?.messageRoot(space, thread);
  let root = saved;
  if (!saved?.own && opts.history) {
    try {
      const message = saved ? await opts.history.getMessage(saved.name)
        : (await opts.history.readRawPage({ space, thread, order: "oldest", limit: 1 })).messages[0];
      if (message) {
        root = messageRoot(message, message.sender?.type === "BOT" || opts.store?.isOwnMessage?.(message));
        opts.store?.recordMessageRoot(space, thread, root);
      }
    } catch (err) {
      opts.logger.warn({ err, space, thread }, "Google Chat thread context unavailable; admitting without header");
      return undefined;
    }
  }
  return root ? `[In thread under ${root.sender}'s message from ${root.createTime}: ${JSON.stringify(root.text)}${root.filename ? ` (${root.filename})` : ""}]` : undefined;
}
