import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ChatAdapter, ChannelRef, DeliveryNonceLookup, DeliveryNonceOptions, IncomingMessage,
  MessageAttachment, MessageRef } from "../chat-adapter.js";
import type { GoogleApi } from "./api.js";
import { googleErrorStatus } from "./api.js";
import { PubSubPullTransport } from "./transport.js";
import { SpaceWriteQueue } from "./write-queue.js";

export const GOOGLE_CHAT_PLATFORM = "google-chat";
const root = "https://chat.googleapis.com/v1";
type ChatMessage = { name?: string; text?: string; thread?: { name?: string }; threadReply?: boolean;
  sender?: { name?: string; type?: string; displayName?: string };
  attachment?: Array<{ contentName?: string; contentType?: string;
    attachmentDataRef?: { resourceName?: string } }> };
type ChatEvent = { type?: string; user?: ChatMessage["sender"]; space?: { name?: string; spaceThreadingState?: string };
  message?: ChatMessage };

function resourceId(name: string, kind: string): string {
  const parts = name.split("/");
  const index = parts.indexOf(kind);
  if (index < 0 || !parts[index + 1]) throw new Error(`Google Chat ${kind} resource missing: ${name}`);
  return parts[index + 1]!;
}

function names(channel: ChannelRef): { space: string; thread?: string } {
  const [spaceId, threadId] = channel.id.split(".");
  return { space: `spaces/${spaceId}`, ...(threadId ? { thread: `spaces/${spaceId}/threads/${threadId}` } : {}) };
}

function channelForThread(thread: string): ChannelRef {
  const spaceId = resourceId(thread, "spaces"), threadId = resourceId(thread, "threads");
  return { platform: GOOGLE_CHAT_PLATFORM, id: `${spaceId}.${threadId}`, parentId: spaceId };
}

function clientId(nonce: string): string {
  return `client-${createHash("sha256").update(nonce).digest("hex").slice(0, 56)}`;
}

export class GoogleChatAdapter implements ChatAdapter {
  readonly platform = GOOGLE_CHAT_PLATFORM;
  private handler?: (message: IncomingMessage) => void | Promise<void>;
  private readonly writes: SpaceWriteQueue;
  private readonly transport: PubSubPullTransport;

  constructor(private readonly opts: { api: GoogleApi; subscription: string; allowedUserIds: ReadonlySet<string>;
    defaultCwd: string; logger: Logger; writeIntervalMs?: number }) {
    this.writes = new SpaceWriteQueue({ logger: opts.logger, intervalMs: opts.writeIntervalMs });
    this.transport = new PubSubPullTransport({ ...opts, receive: (event, signal) => this.receiveEvent(event, signal) });
  }

  async start(): Promise<void> { await this.transport.start(); }
  async stop(): Promise<void> { await this.transport.stop(); await this.writes.flush(); }
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void { this.handler = handler; }

  isAllowedUser(platform: string, userId: string): boolean {
    return platform === this.platform && this.opts.allowedUserIds.has(userId.startsWith("users/") ? userId : `users/${userId}`);
  }

  async receiveEvent(raw: unknown, signal?: AbortSignal): Promise<void> {
    const event = raw as ChatEvent;
    const message = event.message;
    this.opts.logger.info({ type: event.type, space: event.space?.name, message: message?.name,
      thread: message?.thread?.name, threadReply: message?.threadReply,
      spaceThreadingState: event.space?.spaceThreadingState }, "Google Chat event");
    if (event.type !== "MESSAGE") return;
    const user = event.user ?? message?.sender;
    if (user?.type === "BOT" || !user?.name || !this.isAllowedUser(this.platform, user.name)) return;
    if (!message?.name || !message.thread?.name) throw new Error("Google Chat MESSAGE has no message or thread name");
    if (!this.handler) throw new Error("Google Chat inbound handler not installed");
    const attachments: MessageAttachment[] = (message.attachment ?? []).map(a => ({
      url: a.attachmentDataRef?.resourceName ?? "", filename: a.contentName ?? "attachment",
      contentType: a.contentType ?? null, size: 0, platform: this.platform,
    }));
    let acknowledge!: () => void;
    let refuse!: (error: unknown) => void;
    let admitted = false;
    const admission = new Promise<void>((resolve, reject) => { acknowledge = resolve; refuse = reject; });
    const abort = () => refuse(signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const incoming: IncomingMessage = {
      messageId: `gchat_${createHash("sha256").update(message.name).digest("base64url")}`,
      channel: channelForThread(message.thread.name), authorId: resourceId(user.name, "users"),
      authorName: user.displayName, authorIsBot: false, text: message.text ?? "", attachments, raw,
      cwd: this.opts.defaultCwd,
      onAdmitted: () => { admitted = true; acknowledge(); },
    };
    void Promise.resolve().then(() => this.handler!(incoming)).then(() => {
      if (!admitted) refuse(new Error("Google Chat handler finished without durable admission"));
    }, err => {
      if (!admitted) refuse(err);
      else this.opts.logger.error({ err, messageId: incoming.messageId }, "Google Chat admitted handler failed");
    });
    try { if (signal?.aborted) abort(); await admission; }
    finally { signal?.removeEventListener("abort", abort); }
  }

  async sendMessage(channel: ChannelRef, text: string, delivery?: DeliveryNonceOptions): Promise<MessageRef> {
    const { space, thread } = names(channel);
    const requestId = randomUUID();
    const params = { requestId, ...(thread ? { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" } : {}),
      ...(delivery ? { messageId: clientId(delivery.nonce) } : {}) };
    const message = await this.writes.enqueue(space, async () => {
      try {
        return await this.opts.api.request<ChatMessage>("chat", { method: "POST", url: `${root}/${space}/messages`,
          params, data: { text, markupSyntax: "MARKUP_SYNTAX_MARKDOWN", ...(thread ? { thread: { name: thread } } : {}) } });
      } catch (err) {
        if (!delivery || googleErrorStatus(err) !== 409) throw err;
        return this.opts.api.request<ChatMessage>("chat", { method: "GET", url: `${root}/${space}/messages/${clientId(delivery.nonce)}` });
      }
    });
    if (!message.name) throw new Error("Google Chat create returned no message name");
    if (thread && message.thread?.name !== thread) this.opts.logger.warn({ expected: thread, actual: message.thread?.name,
      message: message.name }, "Google Chat reply fell back to a different thread");
    this.opts.logger.info({ message: message.name, thread: message.thread?.name, expectedThread: thread }, "Google Chat message sent");
    return { channel: message.thread?.name ? channelForThread(message.thread.name) : channel, id: message.name,
      jumpLinkUnavailableReason: "Google Chat message permalink is not supplied by the API" };
  }

  async editMessage(message: MessageRef, text: string): Promise<void> {
    await this.writes.enqueue(names(message.channel).space, async () => {
      await this.opts.api.request("chat", { method: "PATCH", url: `${root}/${message.id}`,
        params: { updateMask: "text" }, data: { text, markupSyntax: "MARKUP_SYNTAX_MARKDOWN" } });
    }, message.id);
  }

  async deleteMessage(message: MessageRef): Promise<void> {
    await this.writes.enqueue(names(message.channel).space, async () => {
      await this.opts.api.request("chat", { method: "DELETE", url: `${root}/${message.id}` });
    });
  }

  async createThread(parent: ChannelRef, name: string): Promise<ChannelRef> {
    const message = await this.sendMessage({ platform: this.platform, id: names(parent).space.slice(7) }, name);
    if (!message.channel.parentId) throw new Error("Google Chat new top-level message returned no thread");
    return message.channel;
  }

  async sendFile(channel: ChannelRef, file: { data: Buffer; filename: string; mimeType: string; caption?: string },
    delivery?: DeliveryNonceOptions): Promise<MessageRef> {
    const textFile = /^text\//.test(file.mimeType) || /json|javascript|xml/.test(file.mimeType);
    const body = textFile ? file.data.toString("utf8") : `[${file.data.length} bytes; binary upload is not available in this slice]`;
    const text = [file.caption, file.filename, body].filter(Boolean).join("\n\n");
    let remaining = text;
    let ref: MessageRef | undefined;
    let part = 0;
    while (remaining.length) {
      // Leave room for JSON overhead under Chat's 32 KB message budget.
      let length = Math.min(remaining.length, 4000);
      if (/[\uD800-\uDBFF]/.test(remaining[length - 1] ?? "")) length--;
      ref = await this.sendMessage(channel, remaining.slice(0, length), delivery
        ? { ...delivery, nonce: part === 0 ? delivery.nonce : `${delivery.nonce}-${part}` } : undefined);
      remaining = remaining.slice(length); part++;
    }
    return ref!;
  }

  async downloadAttachment(attachment: MessageAttachment): Promise<Buffer> {
    const data = await this.opts.api.request<ArrayBuffer>("chat", { method: "GET",
      url: `${root}/media/${attachment.url}`, params: { alt: "media" }, responseType: "arraybuffer" });
    return Buffer.from(data);
  }

  async findMessageByNonce(_channel: ChannelRef, _nonce: string): Promise<DeliveryNonceLookup> {
    // Current app auth cannot prove absence; keep uncertain output without a denied lookup.
    return { status: "indeterminate",
      reason: "Google Chat nonce lookup is unsupported until history access is configured with admin-approved chat.app.messages.readonly" };
  }

  async resolveChannel(channel: ChannelRef): Promise<ChannelRef> {
    const { thread } = names(channel);
    return thread ? channelForThread(thread) : channel;
  }

  async getMessageLink(): Promise<{ jumpLinkUnavailableReason: string }> {
    return { jumpLinkUnavailableReason: "Google Chat message permalink is not supplied by the API" };
  }

  async getThreadLiveState(channel: ChannelRef): Promise<{ locked: boolean; archived: boolean } | undefined> {
    try {
      await this.opts.api.request("chat", { method: "GET", url: `${root}/${names(channel).space}` });
      return { locked: false, archived: false };
    } catch (err) {
      if (googleErrorStatus(err) === 404) return undefined;
      throw err;
    }
  }
}
