import type { MessageAttachment } from "../../platforms/chat-adapter.js";

export type InboundAdmissionState = "pending" | "running" | "completed";

/**
 * Durable ownership record for one platform message. The Discord snowflake is
 * the idempotency key: reconnect delivery of the same gateway event can never
 * create a second turn.
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
}
