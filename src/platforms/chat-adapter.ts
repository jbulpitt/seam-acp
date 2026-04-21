import type { SessionRecord } from "../core/types.js";

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

/** Incoming user message, normalized across platforms. */
export interface IncomingMessage {
  channel: ChannelRef;
  authorId: string;
  authorIsBot: boolean;
  text: string;
  /** Platform-specific raw object for advanced handlers. */
  raw?: unknown;
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

  /** Optional: platforms that support threads should implement this. */
  createThread?(parent: ChannelRef, name: string): Promise<ChannelRef>;

  /** Subscribe to bot-relevant incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void;
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
