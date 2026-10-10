import type { ChannelRef, MessageAttachment } from "../../platforms/chat-adapter.js";

export type InboundAdmissionState = "pending" | "running" | "completed";

export interface InboundCommandResult {
  replies: Array<{ channel: ChannelRef; text: string; index: number }>;
  error?: string;
}

/**
 * Durable ownership record for one platform message. Its platform message id
 * is the idempotency key: reconnect delivery cannot create a second turn.
 */
export interface InboundAdmission {
  messageId: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  sessionRecordId: string;
  authorId: string;
  authorName: string | null;
  text: string;
  attachments: MessageAttachment[];
  state: InboundAdmissionState;
  queueEpoch: number | null;
  createdUtc: string;
  updatedUtc: string;
  /** Exact ACP conversation this synthetic admission is allowed to enter. */
  expectedAcpSessionId: string | null;
  /** Real platform messages pre-empt; card-routed async answers wait FIFO. */
  preemptive: boolean;
  /** Command receipt and pending replies; commands never become agent prompts. */
  commandResult?: InboundCommandResult;
}

export interface NewInboundAdmission {
  messageId: string;
  platform: string;
  channelRef: string;
  parentRef?: string | null;
  sessionRecordId: string;
  authorId: string;
  authorName?: string | null;
  text: string;
  attachments?: MessageAttachment[];
  createdUtc: string;
  expectedAcpSessionId?: string | null;
  preemptive?: boolean;
  commandResult?: InboundCommandResult;
}
