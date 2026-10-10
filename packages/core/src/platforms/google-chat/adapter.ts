import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ChatAdapter, ChannelRef, DeliveryNonceLookup, DeliveryNonceOptions, IncomingMessage,
  MessageAttachment, MessageRef, ChoiceCardPost, ChoiceInteraction, ComponentEvent, ElicitationCardPost } from "../chat-adapter.js";
import type { StructuredPanel, StructuredLayout } from "../../core/types.js";
import type { GoogleDriveUploader } from "../../core/files/google-drive-upload.js";
import type { ComponentAcknowledgement } from "../interaction-response.js";
import type { GoogleApi } from "./api.js";
import { googleErrorStatus } from "./api.js";
import { PubSubPullTransport } from "./transport.js";
import { SpaceWriteQueue } from "./write-queue.js";
import { formatGoogleChatText, GOOGLE_CHAT_TEXT_MARKUP_SYNTAX } from "./text-format.js";
import { splitGoogleChatText } from "./text-split.js";
import { parseGoogleChatCardClick, type GoogleChatCardClickEvent } from "./card-click.js";
import { renderGoogleChatPanel, renderGoogleChatLayout, renderGoogleChatChoiceCard,
  renderGoogleChatElicitationCard, type GoogleChatCardsMessage } from "./card-renderer.js";
import { parseGoogleChatCommand, type GoogleChatCommandEvent } from "./commands.js";
import { executeGoogleChatCommand, type GoogleChatCommandDeps } from "./command-actions.js";

export const GOOGLE_CHAT_PLATFORM = "google-chat";
const root = "https://chat.googleapis.com/v1";
type ChatMessage = { name?: string; text?: string; thread?: { name?: string }; threadReply?: boolean;
  sender?: { name?: string; type?: string; displayName?: string };
  attachment?: Array<{ contentName?: string; contentType?: string;
    attachmentDataRef?: { resourceName?: string } }> };
type ChatEvent = GoogleChatCommandEvent & { user?: ChatMessage["sender"]; space?: { name?: string; spaceThreadingState?: string };
  message?: ChatMessage; thread?: { name?: string }; action?: GoogleChatCardClickEvent["action"];
  common?: GoogleChatCardClickEvent["common"] };

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
  // Unacked events redeliver via Pub/Sub; admitted work resumes from the ledger.
  readonly catchUpMessagesAfter = undefined;
  private handler?: (message: IncomingMessage) => void | Promise<void>;
  private readonly writes: SpaceWriteQueue;
  private readonly transport: PubSubPullTransport;
  private choiceHandler?: (event: ChoiceInteraction) => void | Promise<void>;
  private componentHandler?: (event: ComponentEvent) => void | Promise<void>;
  private choiceAcknowledgement: ComponentAcknowledgement = "update";
  private componentAcknowledgement: ComponentAcknowledgement = "update";
  private commandDeps?: Pick<GoogleChatCommandDeps, "router" | "runtimeTransition" | "cancelChannel">;

  constructor(private readonly opts: { api: GoogleApi; subscription: string; allowedUserIds: ReadonlySet<string>;
    defaultCwd: string; logger: Logger; writeIntervalMs?: number; driveUploader?: Pick<GoogleDriveUploader, "upload"> }) {
    this.writes = new SpaceWriteQueue({ logger: opts.logger, intervalMs: opts.writeIntervalMs });
    this.transport = new PubSubPullTransport({ ...opts,
      receive: (event, signal, id) => this.receiveEvent(event, signal, id) });
  }

  async start(): Promise<void> { await this.transport.start(); }
  async stop(): Promise<void> { await this.transport.stop(); await this.writes.flush(); }
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void { this.handler = handler; }
  onChoiceInteraction(handler: (event: ChoiceInteraction) => void | Promise<void>, acknowledgement: ComponentAcknowledgement): void {
    this.choiceHandler = handler; this.choiceAcknowledgement = acknowledgement;
  }
  onComponent(handler: (event: ComponentEvent) => void | Promise<void>, acknowledgement: ComponentAcknowledgement): void {
    this.componentHandler = handler; this.componentAcknowledgement = acknowledgement;
  }
  setCommandDeps(deps: Pick<GoogleChatCommandDeps, "router" | "runtimeTransition" | "cancelChannel">): void {
    this.commandDeps = deps;
  }

  isAllowedUser(platform: string, userId: string): boolean {
    return platform === this.platform && this.opts.allowedUserIds.has(userId.startsWith("users/") ? userId : `users/${userId}`);
  }

  async receiveEvent(raw: unknown, signal?: AbortSignal, interactionId?: string): Promise<void> {
    const event = raw as ChatEvent;
    const message = event.message;
    this.opts.logger.info({ type: event.type, space: event.space?.name, message: message?.name,
      thread: message?.thread?.name, threadReply: message?.threadReply,
      spaceThreadingState: event.space?.spaceThreadingState }, "Google Chat event");
    const user = event.user ?? message?.sender;
    if (user?.type === "BOT" || !user?.name || !this.isAllowedUser(this.platform, user.name)) return;
    if (event.type === "CARD_CLICKED") {
      await this.receiveCardClick(event, interactionId);
      return;
    }
    const command = parseGoogleChatCommand(event);
    if (command) {
      if (!this.commandDeps) throw new Error("Google Chat command handlers not installed");
      // Command invocations are private to the user and app.
      const respond = async (channel: ChannelRef, text: string) => {
        await this.sendText(channel, text, undefined, command.user.id);
      };
      const result = await executeGoogleChatCommand({ ...command,
        user: { ...command.user, id: resourceId(command.user.id, "users") } }, {
        ...this.commandDeps,
        channelFor: (space, thread) => thread ? channelForThread(thread)
          : { platform: this.platform, id: resourceId(space, "spaces") },
        createThread: (parent, name) => this.createThread(parent, name),
        cwd: this.opts.defaultCwd,
        respond,
      });
      if (result.command === "cancel") {
        const { outcome } = result;
        let text: string;
        if ("error" in outcome) text = `Cancel requested, but not confirmed: ${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}. Work may still be running.`;
        else if (outcome.outcome === "idle") text = outcome.cancelled.cancelled ? "Turn cancelled."
          : outcome.parked ? "Queued prompt cancelled."
          : outcome.queue.queued ? `No active turn; ${outcome.queue.queued} durable items remain queued. Nothing was discarded.`
          : "No active turn.";
        else text = outcome.outcome === "unacknowledged"
          ? "Cancel requested, but not confirmed. Work may still be running." : "Cancel sent to the active turn.";
        await respond(result.channel, text);
      }
      return;
    }
    if (event.type !== "MESSAGE") return;
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
    return this.sendText(channel, text, delivery);
  }

  private async sendText(channel: ChannelRef, text: string, delivery?: DeliveryNonceOptions, privateUser?: string): Promise<MessageRef> {
    const { thread } = names(channel);
    const extra = { ...(thread ? { thread: { name: thread } } : {}),
      ...(privateUser ? { privateMessageViewer: { name: privateUser } } : {}) };
    const reservedBytes = Buffer.byteLength(JSON.stringify(extra), "utf8") - 1;
    const parts = splitGoogleChatText(formatGoogleChatText(text), { reservedBytes });
    let ref: MessageRef | undefined;
    for (const [part, value] of (parts.length ? parts : [""]).entries()) {
      ref = await this.postMessage(channel, { text: value, markupSyntax: GOOGLE_CHAT_TEXT_MARKUP_SYNTAX,
        ...(privateUser ? { privateMessageViewer: { name: privateUser } } : {}) }, delivery
        ? { ...delivery, nonce: part ? `${delivery.nonce}-${part}` : delivery.nonce } : undefined);
    }
    return ref!;
  }

  private async postMessage(channel: ChannelRef, body: Record<string, unknown>, delivery?: DeliveryNonceOptions): Promise<MessageRef> {
    const { space, thread } = names(channel);
    const requestId = randomUUID();
    const params = { requestId, ...(thread ? { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" } : {}),
      ...(delivery ? { messageId: clientId(delivery.nonce) } : {}) };
    const message = await this.writes.enqueue(space, async () => {
      try {
        return await this.opts.api.request<ChatMessage>("chat", { method: "POST", url: `${root}/${space}/messages`,
          params, data: { ...body, ...(thread ? { thread: { name: thread } } : {}) } });
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
    const { thread } = names(message.channel);
    const reservedBytes = thread ? Buffer.byteLength(JSON.stringify({ thread: { name: thread } }), "utf8") - 1 : 0;
    const parts = splitGoogleChatText(formatGoogleChatText(text), { reservedBytes });
    await this.patchMessage(message, { text: parts[0] ?? "", markupSyntax: GOOGLE_CHAT_TEXT_MARKUP_SYNTAX }, "text");
    for (const part of parts.slice(1)) await this.postMessage(message.channel,
      { text: part, markupSyntax: GOOGLE_CHAT_TEXT_MARKUP_SYNTAX });
  }

  private async patchMessage(message: MessageRef, body: Record<string, unknown>, updateMask: string): Promise<void> {
    await this.writes.enqueue(names(message.channel).space, async () => {
      await this.opts.api.request("chat", { method: "PATCH", url: `${root}/${message.id}`,
        params: { updateMask }, data: body });
    }, message.id);
  }

  async sendPanel(channel: ChannelRef, panel: StructuredPanel, delivery?: DeliveryNonceOptions): Promise<MessageRef> {
    return this.postCards(channel, renderGoogleChatPanel(panel, randomUUID()), delivery);
  }
  async editPanel(message: MessageRef, panel: StructuredPanel): Promise<void> {
    await this.patchCards(message, renderGoogleChatPanel(panel, message.id));
  }
  async sendLayout(channel: ChannelRef, layout: StructuredLayout): Promise<MessageRef> {
    return this.postCards(channel, renderGoogleChatLayout(layout, randomUUID()));
  }
  async editLayout(message: MessageRef, layout: StructuredLayout): Promise<void> {
    await this.patchCards(message, renderGoogleChatLayout(layout, message.id));
  }
  async sendChoiceCard(channel: ChannelRef, card: ChoiceCardPost): Promise<MessageRef> {
    return this.postCards(channel, renderGoogleChatChoiceCard(card));
  }
  async editChoiceCard(message: MessageRef, card: ChoiceCardPost): Promise<void> {
    await this.patchCards(message, renderGoogleChatChoiceCard(card));
  }
  async sendElicitationCard(channel: ChannelRef, card: ElicitationCardPost): Promise<MessageRef> {
    return this.postCards(channel, renderGoogleChatElicitationCard(card, randomUUID()));
  }
  async editElicitationCard(message: MessageRef, card: ElicitationCardPost): Promise<void> {
    await this.patchCards(message, renderGoogleChatElicitationCard(card, message.id));
  }
  private postCards(channel: ChannelRef, card: GoogleChatCardsMessage, delivery?: DeliveryNonceOptions): Promise<MessageRef> {
    return this.postMessage(channel, { ...card }, delivery);
  }
  private patchCards(message: MessageRef, card: GoogleChatCardsMessage): Promise<void> {
    return this.patchMessage(message, { ...card }, "cardsV2");
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
    if (this.opts.driveUploader) {
      const link = await this.opts.driveUploader.upload(file);
      return this.sendMessage(channel, [file.caption, `[${file.filename}](${link})`].filter(Boolean).join("\n\n"), delivery);
    }
    const textFile = /^text\//.test(file.mimeType) || /json|javascript|xml/.test(file.mimeType);
    const body = textFile ? file.data.toString("utf8") : `[${file.data.length} bytes; Drive upload is not configured]`;
    const text = [file.caption, file.filename, body].filter(Boolean).join("\n\n");
    return this.sendMessage(channel, text, delivery);
  }

  private async receiveCardClick(event: ChatEvent, interactionId?: string): Promise<void> {
    const thread = event.message?.thread?.name ?? event.thread?.name;
    if (!thread) throw new Error("Google Chat CARD_CLICKED has no thread name");
    if (!interactionId) throw new Error("Google Chat CARD_CLICKED has no Pub/Sub delivery id");
    const parsed = parseGoogleChatCardClick({ ...event, type: "CARD_CLICKED" },
      { channel: channelForThread(thread), interactionId });
    if (!parsed) return;
    const data = { ...parsed.interaction, userId: resourceId(parsed.interaction.userId, "users") };
    const acknowledgement = parsed.type === "choice" ? this.choiceAcknowledgement : this.componentAcknowledgement;
    const mode = typeof acknowledgement === "function" ? acknowledgement(data) : acknowledgement;
    const privateUser = event.user!.name!;
    let reply: MessageRef | undefined;
    const replyEphemeral = async (text: string) => { reply = await this.sendText(data.channel, text, undefined, privateUser); };
    const showModal = async () => { throw new Error("Google Chat Pub/Sub does not support dialogs; use inline card inputs"); };
    this.opts.logger.debug({ interactionId, customId: data.customId, mode }, "Google Chat card interaction");
    // Pub/Sub ACK follows the durable handler; card refreshes use whole-message PATCH.
    if (parsed.type === "choice") {
      if (!this.choiceHandler) throw new Error("Google Chat choice handler not installed");
      await this.choiceHandler({ ...data, replyEphemeral, followUpEphemeral: replyEphemeral, showModal });
    } else {
      if (!this.componentHandler) throw new Error("Google Chat component handler not installed");
      await this.componentHandler({ ...data, interactionId, replyEphemeral, followUpEphemeral: replyEphemeral,
        editReplyEphemeral: async text => { if (reply) await this.editMessage(reply, text); else await replyEphemeral(text); },
        replyEphemeralView: async () => { throw new Error("Google Chat cannot render a Discord ephemeral view"); },
        updateEphemeralView: async () => { throw new Error("Google Chat cannot render a Discord ephemeral view"); },
        followUpEphemeralFile: async file => { await replyEphemeral(`${file.filename}\n\n${file.data.toString("utf8")}`); },
        showModal });
    }
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
