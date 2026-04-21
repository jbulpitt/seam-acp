import type { SessionRecord } from "../core/types.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

/** Reference to a channel or thread on a chat platform. */
export interface ChannelRef {
  /** Platform id ("discord"). */
  platform: string;
  /** Stable id from the platform (channel or thread snowflake on Discord). */
  id: string;
  /** Optional parent channel id (for threads). */
  parentId?: string;
}

/** Reference to a previously-sent message; used for `editMessage`. */
export interface MessageRef {
  channel: ChannelRef;
  id: string;
}

/** A file attached to an incoming message, normalized across platforms. */
export interface MessageAttachment {
  /** Stable URL the bot can fetch (Discord CDN URL). */
  url: string;
  filename: string;
  /** MIME type if the platform reported one. */
  contentType: string | null;
  /** Size in bytes. */
  size: number;
}

/** Incoming user message, normalized across platforms. */
export interface IncomingMessage {
  channel: ChannelRef;
  authorId: string;
  authorIsBot: boolean;
  text: string;
  /** Files attached to the message, if any. */
  attachments?: MessageAttachment[];
  /** Platform-specific raw object for advanced handlers. */
  raw?: unknown;
}

/** Reaction event normalized across platforms. */
export interface ReactionEvent {
  message: MessageRef;
  /** Platform-specific reaction identifier (Discord: emoji name, e.g. "1️⃣"). */
  reaction: string;
  userId: string;
  userIsBot: boolean;
}

/**
 * Generic chat adapter contract. Discord today, Slack tomorrow.
 *
 * The adapter is responsible for:
 *  - connecting to the platform
 *  - receiving messages (filtered to "the bot should respond to this")
 *  - sending / editing messages
 *  - creating threads (if supported)
 *
 * Anything platform-specific (slash command schema, mentions, reactions,
 * etc.) lives under each adapter's own folder.
 */
export interface ChatAdapter {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;

  sendMessage(channel: ChannelRef, text: string): Promise<MessageRef>;
  editMessage(message: MessageRef, text: string): Promise<void>;

  /**
   * Optional: upload a file to the channel. Required for the agent → Discord
   * file path. Implementations may also send caption text alongside the file.
   */
  sendFile?(
    channel: ChannelRef,
    file: {
      data: Buffer;
      filename: string;
      mimeType: string;
      caption?: string;
    }
  ): Promise<MessageRef>;

  /** Optional: platforms that support threads should implement this. */
  createThread?(parent: ChannelRef, name: string): Promise<ChannelRef>;

  /** Optional: pre-add reactions to a message (for emoji menus). */
  addReactions?(message: MessageRef, reactions: string[]): Promise<void>;

  /** Subscribe to bot-relevant incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void;

  /** Optional: subscribe to reaction events. */
  onReaction?(handler: (event: ReactionEvent) => void | Promise<void>): void;

  /**
   * Optional: ask the user to approve / deny a tool permission request,
   * blocking until they respond or the timeout elapses. Required for the
   * `ask` permission policy. Implementations should default to "cancelled"
   * on timeout.
   */
  requestApproval?(
    channel: ChannelRef,
    req: RequestPermissionRequest,
    opts?: { timeoutMs?: number }
  ): Promise<RequestPermissionResponse>;
}

/**
 * Convenience: the session-router wants to translate channel refs to
 * SessionRecord ids. We expose this as a tiny helper rather than pollute the
 * adapter interface.
 */
export function makeSessionIdFromChannel(channel: ChannelRef): string {
  return `${channel.platform}:${channel.id}`;
}

export type { SessionRecord };
