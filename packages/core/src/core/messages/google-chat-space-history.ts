import { googleChatClientMessageId } from "../../platforms/google-chat/message-id.js";
export { googleChatClientMessageId } from "../../platforms/google-chat/message-id.js";
import type { MessagePage, MessagePageRequest } from "../message-reader.js";
import {
  normalizeGoogleChatMessage,
  type GoogleChatHistoryReader,
  type GoogleChatHistoryMessage,
  type GoogleChatHistoryItem,
  type GoogleChatHistoryRequest,
} from "./google-chat-history.js";

export const GOOGLE_CHAT_DM_HISTORY_CAUSE =
  "DMs are not supported for methods requiring app authentication with administrator approval";

export interface GoogleChatHistoryTarget {
  space: string;
  thread?: string;
  spaceType: "SPACE" | "GROUP_CHAT" | "DIRECT_MESSAGE";
}

export type GoogleChatHistoryUnsupported = { status: "unsupported"; cause: string };
export type GoogleChatMessagePageResult =
  | { status: "supported"; page: MessagePage & { messages: GoogleChatHistoryItem[] } }
  | GoogleChatHistoryUnsupported;
export type GoogleChatNonceResult =
  | { status: "found"; message: GoogleChatHistoryItem }
  | { status: "absent" }
  | GoogleChatHistoryUnsupported;

type HistoryApi = Pick<GoogleChatHistoryReader, "readRawPage" | "getMessage">;

/** Bridge native tokens to the existing message-id page contract without cursor state. */
export async function fetchMessagePage(
  reader: HistoryApi,
  target: GoogleChatHistoryTarget,
  request: MessagePageRequest,
): Promise<GoogleChatMessagePageResult> {
  if (target.spaceType === "DIRECT_MESSAGE") {
    return { status: "unsupported", cause: GOOGLE_CHAT_DM_HISTORY_CAUSE };
  }
  const limit = Math.max(1, Math.min(100, Math.floor(request.limit)));
  const anchorId = request.around ?? request.before ?? request.after;
  const anchor = anchorId ? await reader.getMessage(anchorId) : undefined;
  const order = request.after ? "oldest" : "newest";
  // Include the anchor's whole millisecond; exclusive time filters would lose ties.
  const bounds = request.before && anchor
    ? { before: new Date(Date.parse(anchor.createTime) + 1).toISOString() }
    : request.after && anchor
      ? { after: new Date(Date.parse(anchor.createTime) - 1).toISOString() }
      : {};
  const selected: GoogleChatHistoryMessage[] = [];
  const newer: GoogleChatHistoryMessage[] = [];
  let reachedAnchor = !anchor;
  let olderLimit = limit;

  for await (const message of rawMessages(reader, target, limit, order, bounds)) {
    if (!reachedAnchor) {
      if (message.name !== anchor!.name) {
        if (request.around) {
          newer.push(message);
          if (newer.length > limit - 1) newer.shift();
        }
        continue;
      }
      reachedAnchor = true;
      if (request.around) {
        selected.push(message);
        olderLimit = limit - Math.min(newer.length, Math.floor((limit - 1) / 2));
        if (selected.length >= olderLimit) break;
      }
      continue;
    }
    selected.push(message);
    if (selected.length >= olderLimit) break;
  }

  if (!reachedAnchor) {
    throw new Error(`Google Chat history did not list anchor ${anchor!.name} in ${target.thread ?? target.space}`);
  }
  const newerCount = limit - selected.length;
  if (request.around && newerCount > 0) selected.unshift(...newer.slice(-newerCount));
  if (request.after) selected.reverse();
  const oldest = selected.at(-1);
  return {
    status: "supported",
    page: {
      messages: selected.filter((message) => !message.deleteTime).map(normalizeGoogleChatMessage),
      rawCount: selected.length,
      oldestRawId: oldest?.name ?? null,
      oldestRawTimestampMs: oldest ? Date.parse(oldest.createTime) : null,
    },
  };
}

async function* rawMessages(
  reader: HistoryApi,
  target: GoogleChatHistoryTarget,
  limit: number,
  order: "oldest" | "newest",
  bounds: Pick<GoogleChatHistoryRequest, "before" | "after">,
): AsyncGenerator<GoogleChatHistoryMessage> {
  let pageToken: string | undefined;
  do {
    const page = await reader.readRawPage({
      space: target.space, thread: target.thread, limit, order, pageToken, ...bounds,
    });
    yield* page.messages;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
}

/** Lookup uses the sender's deterministic client ID, not a recent-history scan. */
export async function findMessageByNonce(
  reader: HistoryApi,
  target: GoogleChatHistoryTarget,
  nonce: string,
): Promise<GoogleChatNonceResult> {
  if (target.spaceType === "DIRECT_MESSAGE") {
    return { status: "unsupported", cause: GOOGLE_CHAT_DM_HISTORY_CAUSE };
  }
  try {
    const message = await reader.getMessage(`${target.space}/messages/${googleChatClientMessageId(nonce)}`);
    return { status: "found", message: normalizeGoogleChatMessage(message) };
  } catch (error) {
    if ((error as { response?: { status?: number } } | null)?.response?.status === 404) return { status: "absent" };
    throw error;
  }
}
