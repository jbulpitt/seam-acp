import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import type { IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import { GOOGLE_CHAT_MESSAGE_BATCH_CREATED, GOOGLE_CHAT_MESSAGE_CREATED } from "../packages/core/src/platforms/google-chat/space-subscriptions.js";
import { googleChatInboundMessageId, parseGoogleChatWorkspaceMessages,
  type WorkspacePubSubMessage } from "../packages/core/src/platforms/google-chat/workspace-message-event.js";

const resource = { name: "spaces/SPACE/messages/Message_1", text: "Hello world", createTime: "2026-10-10T20:00:00.123Z",
  sender: { name: "users/42", displayName: "Tester", type: "HUMAN" },
  space: { name: "spaces/SPACE", spaceType: "SPACE" }, thread: { name: "spaces/SPACE/threads/Thread_1" },
  annotations: [{ type: "USER_MENTION", startIndex: 0, length: 5, userMention: { user: { name: "users/app", type: "BOT" } } }],
};
function delivered(payload: unknown, type = GOOGLE_CHAT_MESSAGE_CREATED): WorkspacePubSubMessage {
  return { attributes: { "ce-id": "spaces/SPACE/spaceEvents/Event_1", "ce-type": type, "ce-specversion": "1.0",
    "ce-source": "//workspaceevents.googleapis.com/subscriptions/one", "ce-subject": "//chat.googleapis.com/spaces/SPACE",
    "ce-time": "2026-10-10T20:00:01Z", "ce-datacontenttype": "application/json" },
    data: Buffer.from(JSON.stringify(payload)).toString("base64"), messageId: "pubsub-delivery-one" };
}

describe("Workspace Chat message CloudEvents", () => {
  it("parses the documented Pub/Sub attributes and base64 resource payload into neutral inbound data", () => {
    const [parsed] = parseGoogleChatWorkspaceMessages(delivered({ message: resource }));
    expect(parsed).toEqual({ kind: "message", resourceName: resource.name, messageId: googleChatInboundMessageId(resource.name),
      space: "spaces/SPACE", resource,
      cloudEvent: { id: "spaces/SPACE/spaceEvents/Event_1", type: GOOGLE_CHAT_MESSAGE_CREATED,
        source: "//workspaceevents.googleapis.com/subscriptions/one", time: "2026-10-10T20:00:01Z" },
      incoming: { messageId: googleChatInboundMessageId(resource.name),
        channel: { platform: "google-chat", id: "SPACE.Thread_1", parentId: "SPACE" }, authorId: "42", authorName: "Tester",
        authorIsBot: false, text: "Hello world", attachments: [], raw: resource },
    });
    expect(parsed!.resource.annotations).toEqual(resource.annotations);
  });

  it("matches the existing direct MESSAGE adapter's dedupe id and neutral message fields", async () => {
    const incoming: IncomingMessage[] = [];
    const adapter = new GoogleChatAdapter({ api: { request: async () => { throw new Error("no Google call expected"); } },
      subscription: "projects/example/subscriptions/chat-events", allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects",
      logger: pino({ level: "silent" }), writeIntervalMs: 0 });
    adapter.onMessage(message => { incoming.push(message); message.onAdmitted?.(); });
    await adapter.receiveEvent({ type: "MESSAGE", space: resource.space, user: resource.sender, message: resource });
    expect(incoming).toHaveLength(1);
    const [parsed] = parseGoogleChatWorkspaceMessages(delivered({ message: resource }));
    expect(parsed!.kind).toBe("message");
    if (parsed!.kind !== "message") throw new Error("expected full message");
    expect(parsed!.incoming).toMatchObject({ messageId: incoming[0]!.messageId, channel: incoming[0]!.channel,
      authorId: incoming[0]!.authorId, authorName: incoming[0]!.authorName, text: incoming[0]!.text });
  });

  it("dedupes by the native message name, never the CloudEvent or Pub/Sub delivery id", () => {
    const first = delivered({ message: resource });
    const second = delivered({ message: resource });
    second.messageId = "different-delivery";
    second.attributes!["ce-id"] = "spaces/SPACE/spaceEvents/different-event";
    second.attributes!["ce-source"] = "//workspaceevents.googleapis.com/subscriptions/another";
    const [a] = parseGoogleChatWorkspaceMessages(first), [b] = parseGoogleChatWorkspaceMessages(second);
    expect(a!.messageId).toBe(b!.messageId);
    expect(a!.messageId).toMatch(/^gchat_[A-Za-z0-9_-]{43}$/);
    expect(googleChatInboundMessageId("spaces/OTHER/messages/Message_1")).not.toBe(a!.messageId);
  });

  it("unpacks every message in the documented automatic batchCreated payload", () => {
    const second = { ...resource, name: "spaces/SPACE/messages/Message_2" };
    const parsed = parseGoogleChatWorkspaceMessages(delivered({ messages: [{ message: resource }, { message: second }] },
      GOOGLE_CHAT_MESSAGE_BATCH_CREATED));
    expect(parsed.map(item => item.resourceName)).toEqual([resource.name, second.name]);
    expect(parsed[0]!.messageId).not.toBe(parsed[1]!.messageId);
    expect(parsed[0]!.cloudEvent.type).toBe(GOOGLE_CHAT_MESSAGE_BATCH_CREATED);
  });

  it("returns a hydration reference for a names-only payload, not an empty user prompt", () => {
    expect(parseGoogleChatWorkspaceMessages(delivered({ message: { name: resource.name } }))[0]).toMatchObject({
      kind: "message-reference", resourceName: resource.name, space: "spaces/SPACE", messageId: googleChatInboundMessageId(resource.name),
      missingFields: ["message.sender.name"],
    });
    expect(parseGoogleChatWorkspaceMessages(delivered({ message: { name: resource.name } }))[0]).not.toHaveProperty("incoming");
  });

  it("retains incomplete field-mask data as a hydration reference", () => {
    const { sender: _sender, ...partial } = resource;
    expect(parseGoogleChatWorkspaceMessages(delivered({ message: partial }))[0]).toMatchObject({
      kind: "message-reference", resource: partial, missingFields: ["message.sender.name"],
    });
  });

  it("uses the native space-only channel when a message has no thread", () => {
    const { thread: _thread, ...message } = resource;
    expect(parseGoogleChatWorkspaceMessages(delivered({ message }))[0]).toMatchObject({ kind: "message",
      incoming: { channel: { platform: "google-chat", id: "SPACE" } } });
  });

  it("retains bot identity and attachments without making adapter authorization decisions", () => {
    const message = { ...resource, text: undefined, sender: { name: "users/bot", type: "BOT" }, attachment: [
      { contentName: "report.txt", contentType: "text/plain", attachmentDataRef: { resourceName: "spaces/SPACE/messages/M/attachments/A" } },
    ] };
    const [parsed] = parseGoogleChatWorkspaceMessages(delivered({ message }));
    expect(parsed).toMatchObject({ kind: "message", incoming: { authorId: "bot", authorIsBot: true, text: "", attachments: [
      { filename: "report.txt", contentType: "text/plain", url: "spaces/SPACE/messages/M/attachments/A", size: 0, platform: "google-chat" },
    ] } });
  });

  it("accepts unpadded/url-safe base64 and preserves Unicode text exactly", () => {
    const text = "こんにちは 👋\n*not re-formatted* <users/42>";
    const delivery = delivered({ message: { ...resource, text } });
    delivery.data = Buffer.from(JSON.stringify({ message: { ...resource, text } })).toString("base64url");
    expect(parseGoogleChatWorkspaceMessages(delivery)[0]).toMatchObject({ kind: "message", incoming: { text } });
  });

  it.each([undefined, "google.workspace.chat.message.v1.updated", "google.workspace.chat.message.v1.deleted",
    "google.workspace.subscription.v1.expirationReminder", "google.workspace.chat.membership.v1.created"])(
    "leaves unrelated/direct/lifecycle event %s to its owner without trying to decode it", type => {
      expect(parseGoogleChatWorkspaceMessages({ attributes: type ? { "ce-type": type } : {}, data: "not-json" })).toEqual([]);
    });

  it("passes the JSON parser's real SyntaxError through", () => {
    expect(() => parseGoogleChatWorkspaceMessages({ attributes: { "ce-type": GOOGLE_CHAT_MESSAGE_CREATED },
      data: Buffer.from("{broken").toString("base64") })).toThrow(SyntaxError);
  });

  it.each([{}, { message: {} }, { message: { name: "not-a-message-resource" } }])("identifies the malformed native field in %j", payload => {
    expect(() => parseGoogleChatWorkspaceMessages(delivered(payload))).toThrow(/message.name|invalid resource name/);
  });

  it("identifies missing delivery data or a malformed batch instead of silently dropping messages", () => {
    expect(() => parseGoogleChatWorkspaceMessages({ attributes: { "ce-type": GOOGLE_CHAT_MESSAGE_CREATED } })).toThrow("missing Pub/Sub data");
    expect(() => parseGoogleChatWorkspaceMessages(delivered({}, GOOGLE_CHAT_MESSAGE_BATCH_CREATED))).toThrow("missing messages[]");
  });
});
