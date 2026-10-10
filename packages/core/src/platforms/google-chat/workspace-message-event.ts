import { GOOGLE_CHAT_MESSAGE_BATCH_CREATED, GOOGLE_CHAT_MESSAGE_CREATED } from "./space-subscriptions.js";
import type { GoogleChatAnnotation, GoogleChatSpace } from "./spaces.js";

export interface WorkspacePubSubMessage {
  attributes?: Record<string, string>;
  /** Base64-encoded JSON, as returned by Pub/Sub REST pull. */
  data?: string;
  messageId?: string;
}

export interface WorkspaceChatMessageResource {
  name: string;
  text?: string;
  annotations?: GoogleChatAnnotation[];
  slashCommand?: { commandId?: string | number };
  threadReply?: boolean;
  argumentText?: string;
  sender?: { name?: string; displayName?: string; type?: string };
  space?: GoogleChatSpace;
  thread?: { name?: string; [key: string]: unknown };
  createTime?: string;
  attachment?: Array<{ contentName?: string; contentType?: string; attachmentDataRef?: { resourceName?: string } }>;
  /** Retain annotations and other native fields for the adapter's addressed-to-Seam filter. */
  [key: string]: unknown;
}

interface WorkspaceMessageMetadata {
  resourceName: string;
  space: string;
  resource: WorkspaceChatMessageResource;
  /** CloudEvent identity is distinct from message identity. */
  cloudEvent: { id?: string; source?: string; time?: string; type: string };
}

export type ParsedWorkspaceChatMessage = WorkspaceMessageMetadata & (
  | { kind: "message" }
  | { kind: "message-reference"; missingFields: string[] }
);

function parseMessage(payload: { message?: WorkspaceChatMessageResource }, attributes: Record<string, string>): ParsedWorkspaceChatMessage {
  const message = payload?.message;
  if (!message?.name) throw new Error("Workspace Chat message-created payload is missing message.name");
  const space = message.name.match(/^(spaces\/[^/]+)\/messages\/[^/]+$/)?.[1];
  if (!space) throw new Error(`Workspace Chat message has an invalid resource name: ${message.name}`);
  const metadata: WorkspaceMessageMetadata = {
    resourceName: message.name, space, resource: message,
    cloudEvent: { id: attributes["ce-id"], source: attributes["ce-source"], time: attributes["ce-time"], type: attributes["ce-type"]! },
  };
  const missingFields = [!message.sender?.name && "message.sender.name",
    message.text === undefined && !message.attachment?.length && "message.text"]
    .filter((field): field is string => Boolean(field));
  // Name-only or field-masked payloads need hydration, not a fabricated empty turn.
  if (missingFields.length) return { ...metadata, kind: "message-reference", missingFields };
  return { ...metadata, kind: "message" };
}

/** Unrelated/lifecycle events return []; malformed message data throws its actual parse cause. */
export function parseGoogleChatWorkspaceMessages(delivery: WorkspacePubSubMessage): ParsedWorkspaceChatMessage[] {
  const attributes = delivery.attributes ?? {};
  const type = attributes["ce-type"];
  if (type !== GOOGLE_CHAT_MESSAGE_CREATED && type !== GOOGLE_CHAT_MESSAGE_BATCH_CREATED) return [];
  if (delivery.data === undefined) throw new Error(`Workspace Chat ${type} event is missing Pub/Sub data`);
  const payload = JSON.parse(Buffer.from(delivery.data, "base64").toString("utf8"));
  if (type === GOOGLE_CHAT_MESSAGE_CREATED) return [parseMessage(payload, attributes)];
  if (!Array.isArray(payload?.messages)) throw new Error("Workspace Chat batch-created payload is missing messages[]");
  return payload.messages.map((entry: { message?: WorkspaceChatMessageResource }) => parseMessage(entry, attributes));
}
