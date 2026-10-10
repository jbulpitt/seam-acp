import { GoogleAuth } from "google-auth-library";
import type { MessagePage, MessagePageItem } from "../message-reader.js";

export const GOOGLE_CHAT_HISTORY_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly";

export interface GoogleChatHistoryConfig {
  credentialsFile: string;
}

/** Standalone config; this does not change controller boot or enable an adapter. */
export function loadGoogleChatHistoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleChatHistoryConfig {
  const credentialsFile = env.GOOGLE_CHAT_CREDENTIALS_FILE?.trim();
  if (!credentialsFile) throw new Error("GOOGLE_CHAT_CREDENTIALS_FILE is required for Chat history reads");
  return { credentialsFile };
}

export type ChatHistoryHttpRequest = Parameters<GoogleAuth["request"]>[0];

export interface ChatHistoryRequestor {
  request<T>(options: ChatHistoryHttpRequest): Promise<{ data: T }>;
}

export interface GoogleChatHistoryRequest {
  /** Full resource name: spaces/{space}. */
  space: string;
  /** Full resource name: spaces/{space}/threads/{thread}. */
  thread?: string;
  /** Per-page limit; Google caps pageSize at 1000. */
  limit: number;
  order?: "oldest" | "newest";
  pageToken?: string;
  /** Exclusive RFC3339 time bounds, not message-id cursors. */
  before?: string;
  after?: string;
}

export interface GoogleChatHistoryItem extends MessagePageItem {
  threadName?: string;
}

export interface GoogleChatHistoryPage extends MessagePage {
  messages: GoogleChatHistoryItem[];
  /** Native continuation token; null means Google returned no next page. */
  nextPageToken: string | null;
}

interface ChatMessage {
  name: string;
  createTime: string;
  sender?: { name?: string; displayName?: string; type?: string };
  text?: string;
  formattedText?: string;
  thread?: { name?: string };
  attachment?: { contentName?: string }[];
  cards?: unknown[];
  cardsV2?: unknown[];
  accessoryWidgets?: unknown[];
  deleteTime?: string;
}

interface ListMessagesResponse {
  messages?: ChatMessage[];
  nextPageToken?: string;
}

/** App-auth history without adapter, session, or cursor-cache state. */
export class GoogleChatHistoryReader {
  private readonly client: ChatHistoryRequestor;

  constructor(config: GoogleChatHistoryConfig, client?: ChatHistoryRequestor) {
    this.client = client ?? new GoogleAuth({
      keyFilename: config.credentialsFile,
      scopes: [GOOGLE_CHAT_HISTORY_SCOPE],
    });
  }

  async readPage(request: GoogleChatHistoryRequest): Promise<GoogleChatHistoryPage> {
    const query = new URLSearchParams({
      pageSize: String(request.limit),
      orderBy: `createTime ${request.order === "oldest" ? "ASC" : "DESC"}`,
      markupSyntax: "MARKUP_SYNTAX_MARKDOWN",
    });
    if (request.pageToken) query.set("pageToken", request.pageToken);
    const filters: string[] = [];
    if (request.thread) filters.push(`thread.name = ${request.thread}`);
    if (request.before) filters.push(`createTime < ${JSON.stringify(request.before)}`);
    if (request.after) filters.push(`createTime > ${JSON.stringify(request.after)}`);
    if (filters.length) query.set("filter", filters.join(" AND "));

    // Google errors (including unapproved scopes) retain their response and cause.
    const { data } = await this.client.request<ListMessagesResponse>({
      url: `https://chat.googleapis.com/v1/${request.space}/messages?${query}`,
      method: "GET",
      retry: false,
    });
    const raw = data.messages ?? [];
    const oldest = request.order === "oldest" ? raw[0] : raw.at(-1);
    return {
      messages: raw.filter((message) => !message.deleteTime).map(normalizeMessage),
      rawCount: raw.length,
      oldestRawId: oldest?.name ?? null,
      oldestRawTimestampMs: oldest ? Date.parse(oldest.createTime) : null,
      nextPageToken: data.nextPageToken || null,
    };
  }

  /** Keep every query parameter stable while following Google's page tokens. */
  async *pages(request: GoogleChatHistoryRequest): AsyncGenerator<GoogleChatHistoryPage> {
    let pageToken = request.pageToken;
    do {
      const page = await this.readPage({ ...request, pageToken });
      yield page;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  }
}

function normalizeMessage(message: ChatMessage): GoogleChatHistoryItem {
  return {
    messageId: message.name,
    timestampMs: Date.parse(message.createTime),
    authorId: message.sender?.name ?? "",
    authorName: message.sender?.displayName ?? message.sender?.name ?? "",
    authorType: message.sender?.type === "BOT" ? "bot" : "human",
    content: message.formattedText ?? message.text ?? "",
    attachmentNames: (message.attachment ?? []).flatMap((attachment) =>
      attachment.contentName === undefined ? [] : [attachment.contentName]),
    hasEmbeds: Boolean(message.cards?.length || message.cardsV2?.length),
    hasComponents: Boolean(message.accessoryWidgets?.length),
    threadName: message.thread?.name,
    jumpLinkUnavailableReason: "Google Chat messages.list does not return a message permalink",
  };
}
