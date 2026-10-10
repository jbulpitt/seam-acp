import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ChatAdapter, ChannelRef, DeliveryNonceLookup, DeliveryNonceOptions, IncomingMessage,
  MessageAttachment, MessageRef, ChoiceCardPost, ChoiceInteraction, ComponentEvent, ElicitationCardPost } from "../chat-adapter.js";
import type { StructuredPanel, StructuredLayout } from "../../core/types.js";
import type { SessionStore } from "../../core/session-store.js";
import type { InboundCommandResult } from "../../core/inbound-admission/types.js";
import type { MessagePage, MessagePageRequest } from "../../core/message-reader.js";
import type { GoogleChatHistoryReader } from "../../core/messages/google-chat-history.js";
import { fetchMessagePage as fetchSpaceMessagePage, findMessageByNonce as findSpaceMessageByNonce,
  type GoogleChatHistoryTarget } from "../../core/messages/google-chat-space-history.js";
import type { GoogleDriveUploader } from "../../core/files/google-drive-upload.js";
import type { ComponentAcknowledgement } from "../interaction-response.js";
import type { GoogleApi } from "./api.js";
import { googleErrorStatus } from "./api.js";
import { googleChatClientMessageId } from "./message-id.js";
import { PubSubPullTransport } from "./transport.js";
import { SpaceWriteQueue } from "./write-queue.js";
import { formatGoogleChatText, GOOGLE_CHAT_TEXT_MARKUP_SYNTAX } from "./text-format.js";
import { splitGoogleChatText } from "./text-split.js";
import { parseGoogleChatCardClick, type GoogleChatCardClickEvent } from "./card-click.js";
import { renderGoogleChatPanel, renderGoogleChatLayout, renderGoogleChatChoiceCard,
  renderGoogleChatElicitationCard, type GoogleChatCardsMessage } from "./card-renderer.js";
import { parseGoogleChatCommand, type GoogleChatCommand, type GoogleChatCommandEvent } from "./commands.js";
import { bindGoogleChatSession, executeGoogleChatCommand, type GoogleChatCommandDeps } from "./command-actions.js";
import { hasAppMention, mentionsChatApp, isSharedSpace, stripAppMentions,
  type GoogleChatAnnotation, type GoogleChatSpace, type GoogleChatSpaceLifecycle } from "./spaces.js";
import type { GoogleChatSpaceEvents } from "./space-events.js";
import type { ParsedWorkspaceChatMessage } from "./workspace-message-event.js";

export const GOOGLE_CHAT_PLATFORM = "google-chat";
const root = "https://chat.googleapis.com/v1";
type ChatMessage = { name?: string; text?: string; thread?: { name?: string }; threadReply?: boolean;
  annotations?: GoogleChatAnnotation[];
  sender?: { name?: string; type?: string; displayName?: string };
  attachment?: Array<{ contentName?: string; contentType?: string;
    attachmentDataRef?: { resourceName?: string } }> };
type ChatEvent = GoogleChatCommandEvent & { user?: ChatMessage["sender"]; space?: GoogleChatSpace;
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

function inboundId(name: string): string {
  return `gchat_${createHash("sha256").update(name).digest("base64url")}`;
}

type CommandDeps = Pick<GoogleChatCommandDeps, "router" | "mutation" | "runtimeTransition" | "cancelChannel"> & {
  store: Pick<SessionStore, "getByChannel" | "admitInbound" | "getInbound" | "claimInbound" | "completeInboundCommand">;
};

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
  private commandDeps?: CommandDeps;
  private readonly spaces = new Map<string, GoogleChatSpace>();
  private botUserId?: string;
  private spaceLifecycle?: (event: GoogleChatSpaceLifecycle) => void | Promise<void>;

  constructor(private readonly opts: { api: GoogleApi; subscription: string; allowedUserIds: ReadonlySet<string>;
    allowedSpaceIds?: ReadonlySet<string>; defaultCwd: string; defaultLocation?: string; logger: Logger;
    spaceEvents?: Pick<GoogleChatSpaceEvents, "start" | "stop" | "handle" | "space" | "appUser" | "recordAppUser">;
    hasSession?: (channel: ChannelRef) => boolean;
    writeIntervalMs?: number; driveUploader?: Pick<GoogleDriveUploader, "upload">;
    historyReader?: Pick<GoogleChatHistoryReader, "readRawPage" | "getMessage"> }) {
    this.writes = new SpaceWriteQueue({ logger: opts.logger, intervalMs: opts.writeIntervalMs });
    this.transport = new PubSubPullTransport({ ...opts,
      receive: (event, signal, id) => this.receiveEvent(event, signal, id),
      receiveWorkspaceMessage: (message, signal) => this.receiveWorkspaceMessage(message, signal) });
    if (opts.spaceEvents) this.onSpaceLifecycle(event => opts.spaceEvents!.handle(event));
  }

  async start(): Promise<void> {
    await this.transport.start();
    void this.opts.spaceEvents?.start().catch(err => {
      this.opts.logger.error({ err }, "Google Chat Workspace reconciliation failed");
    });
  }
  async stop(): Promise<void> {
    await Promise.all([this.opts.spaceEvents?.stop(), this.transport.stop()]);
    await this.writes.flush();
  }
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void { this.handler = handler; }
  onChoiceInteraction(handler: (event: ChoiceInteraction) => void | Promise<void>, acknowledgement: ComponentAcknowledgement): void {
    this.choiceHandler = handler; this.choiceAcknowledgement = acknowledgement;
  }
  onComponent(handler: (event: ComponentEvent) => void | Promise<void>, acknowledgement: ComponentAcknowledgement): void {
    this.componentHandler = handler; this.componentAcknowledgement = acknowledgement;
  }
  setCommandDeps(deps: CommandDeps): void {
    this.commandDeps = deps;
  }
  onSpaceLifecycle(handler: (event: GoogleChatSpaceLifecycle) => void | Promise<void>): void {
    this.spaceLifecycle = handler;
  }

  private isAllowedSpace(space: GoogleChatSpace): boolean {
    const ids = this.opts.allowedSpaceIds;
    return !isSharedSpace(space) || !ids?.size || Boolean(space.name &&
      (ids.has(space.name) || ids.has(resourceId(space.name, "spaces"))));
  }

  private channelFor(space: string, thread?: string | null): ChannelRef {
    return thread && this.space(space)?.spaceThreadingState !== "UNTHREADED_MESSAGES"
      ? channelForThread(thread) : { platform: this.platform, id: resourceId(space, "spaces") };
  }

  private space(name: string): GoogleChatSpace | undefined {
    return this.spaces.get(name) ?? this.opts.spaceEvents?.space(name);
  }

  isAllowedUser(platform: string, userId: string): boolean {
    return platform === this.platform && this.opts.allowedUserIds.has(userId.startsWith("users/") ? userId : `users/${userId}`);
  }

  async receiveWorkspaceMessage(parsed: ParsedWorkspaceChatMessage, signal?: AbortSignal): Promise<void> {
    if (!this.isAllowedSpace({ name: parsed.space, spaceType: "SPACE" })) return;
    let message = parsed.resource;
    if (message.sender?.type === "BOT" || (message.sender?.name && !this.isAllowedUser(this.platform, message.sender.name))) return;
    if (parsed.kind === "message-reference") {
      try {
        message = await this.opts.api.request("messages", { method: "GET", url: `${root}/${parsed.resourceName}`, signal });
        if (!message.sender?.name || (message.text === undefined && !message.attachment?.length)) {
          throw new Error(`Google Chat message ${parsed.resourceName} still lacks sender or content after hydration`);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        this.opts.logger.warn({ err, message: parsed.resourceName, missingFields: parsed.missingFields },
          "Google Chat Workspace message hydration failed; skipping reference");
        return;
      }
    }
    await this.receiveEvent({ type: "MESSAGE", space: { ...this.space(parsed.space), ...message.space, name: parsed.space },
      user: message.sender, message, cloudEvent: parsed.cloudEvent }, signal, undefined, "workspace");
  }

  async receiveEvent(raw: unknown, signal?: AbortSignal, interactionId?: string, source: "direct" | "workspace" = "direct"): Promise<void> {
    const event = raw as ChatEvent;
    const message = event.message;
    this.opts.logger.info({ type: event.type, space: event.space?.name, message: message?.name,
      thread: message?.thread?.name, threadReply: message?.threadReply,
      spaceThreadingState: event.space?.spaceThreadingState }, "Google Chat event");
    const space = { ...this.space(event.space?.name ?? ""), ...event.space };
    if (event.type === "REMOVED_FROM_SPACE") {
      if (!space.name) throw new Error("Google Chat REMOVED_FROM_SPACE has no space name");
      this.spaces.delete(space.name);
      await this.spaceLifecycle?.({ ...event, type: "REMOVED_FROM_SPACE", space: { ...space, name: space.name } });
      return;
    }
    if (!this.isAllowedSpace(space)) return;
    if (space.name) this.spaces.set(space.name, space);
    if (event.type === "ADDED_TO_SPACE") {
      if (!space.name) throw new Error("Google Chat ADDED_TO_SPACE has no space name");
      if (isSharedSpace(space)) await this.spaceLifecycle?.({ ...event, type: "ADDED_TO_SPACE", space: { ...space, name: space.name } });
      return;
    }
    const user = event.user ?? message?.sender;
    if (user?.type === "BOT" || !user?.name || !this.isAllowedUser(this.platform, user.name)) return;
    if (event.type === "CARD_CLICKED") {
      await this.receiveCardClick(event, interactionId);
      return;
    }
    const appUser = this.opts.spaceEvents?.appUser(space.name ?? "");
    const invokedApp = message?.annotations?.find(annotation => annotation.type === "SLASH_COMMAND")?.slashCommand?.bot?.name;
    if (source === "workspace" && invokedApp && invokedApp !== appUser) return;
    const commandEvent = source === "workspace" && message ? { ...event, message: { ...message,
      argumentText: message.argumentText ?? stripAppMentions(message.text ?? "", message.annotations, appUser) } } : event;
    const command = parseGoogleChatCommand(commandEvent);
    if (command) {
      const identity = event.type === "APP_COMMAND" ? interactionId : message?.name ?? interactionId;
      if (!identity) throw new Error("Google Chat command has no durable message identity");
      const replyChannel = message && message.threadReply !== true
        && event.appCommandMetadata?.appCommandType !== "QUICK_COMMAND"
        ? { platform: this.platform, id: resourceId(command.space, "spaces") } : undefined;
      await this.receiveCommand(command, inboundId(identity), replyChannel);
      return;
    }
    if (event.type !== "MESSAGE") return;
    // Unsupported slash commands still belong to command handling, never a prompt.
    if (message?.slashCommand || message?.annotations?.some(annotation => annotation.type === "SLASH_COMMAND"
      && annotation.slashCommand?.type !== "ADD")) return;
    const thread = message?.thread?.name ?? event.thread?.name;
    const spaceName = space.name ?? thread?.split("/threads/")[0];
    if (!message?.name || !spaceName) throw new Error("Google Chat MESSAGE has no message or space name");
    const channel = this.channelFor(spaceName, thread);
    if (isSharedSpace(space)) {
      if (source === "direct" && !hasAppMention(message.annotations)) return;
      if (source === "workspace" && !mentionsChatApp(message.annotations, appUser) && !this.opts.hasSession?.(channel)) return;
    }
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
      messageId: inboundId(message.name),
      channel, authorId: resourceId(user.name, "users"),
      authorName: user.displayName, authorIsBot: false,
      text: isSharedSpace(space) ? stripAppMentions(message.text ?? "", message.annotations, appUser) : message.text ?? "", attachments, raw,
      cwd: this.opts.defaultCwd,
      onAdmitted: () => { admitted = true; acknowledge(); },
    };
    void Promise.resolve().then(() => {
      if (this.commandDeps) bindGoogleChatSession(incoming.channel, { ...this.commandDeps,
        cwd: this.opts.defaultCwd, location: this.opts.defaultLocation }, { id: incoming.authorId, name: incoming.authorName ?? null });
      return this.handler!(incoming);
    }).then(() => {
      if (!admitted) refuse(new Error("Google Chat handler finished without durable admission"));
    }, err => {
      if (!admitted) refuse(err);
      else this.opts.logger.error({ err, messageId: incoming.messageId }, "Google Chat admitted handler failed");
    });
    try { if (signal?.aborted) abort(); await admission; }
    finally { signal?.removeEventListener("abort", abort); }
  }

  private async receiveCommand(command: GoogleChatCommand, messageId: string, replyChannel?: ChannelRef): Promise<void> {
    if (!this.commandDeps) throw new Error("Google Chat command handlers not installed");
    const { store } = this.commandDeps;
    const channel = this.channelFor(command.space, command.thread);
    store.admitInbound({ messageId, platform: this.platform, channelRef: channel.id, parentRef: channel.parentId,
      sessionRecordId: `${this.platform}:${channel.id}`, authorId: resourceId(command.user.id, "users"),
      authorName: command.user.name, text: `/${command.command} ${command.args}`.trim(),
      createdUtc: new Date().toISOString(), preemptive: false, commandResult: { replies: [] } });
    const admitted = store.getInbound(messageId)!;
    let receipt = admitted.commandResult!;
    if (admitted.state !== "completed") {
      if (!store.claimInbound(messageId, 0, new Date().toISOString())) {
        this.opts.logger.warn({ messageId, command: command.command, state: admitted.state },
          "Google Chat command execution already claimed; duplicate will not repeat it");
        return;
      }
      const respond = async (channel: ChannelRef, text: string) => {
        receipt.replies.push({ channel: replyChannel ?? channel, text, index: receipt.replies.length });
      };
      try {
        const result = command.command === "new" && this.space(command.space)?.spaceThreadingState === "UNTHREADED_MESSAGES"
          ? await respond(channel, "This space does not support threads; it uses one shared session. /new made no changes.")
          : await executeGoogleChatCommand({ ...command,
          user: { ...command.user, id: resourceId(command.user.id, "users") } }, {
          ...this.commandDeps,
          channelFor: (space, thread) => this.channelFor(space, thread),
          createThread: (parent, name) => this.createThread(parent, name,
            { nonce: `${messageId}-new`, enforceNonce: true }),
          cwd: this.opts.defaultCwd,
          location: this.opts.defaultLocation,
          respond,
        });
        if (result && result.command === "cancel") {
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
      } catch (err) {
        receipt = { replies: [], error: err instanceof Error ? err.message : String(err) };
        store.completeInboundCommand(messageId, receipt, new Date().toISOString());
        this.opts.logger.error({ err, messageId, command: command.command },
          "Google Chat command execution failed; admitted effect will not be replayed");
        throw err;
      }
      store.completeInboundCommand(messageId, receipt, new Date().toISOString());
    }
    for (const reply of [...receipt.replies]) {
      try {
        await this.sendText(reply.channel, reply.text, { nonce: `${messageId}-reply-${reply.index}`, enforceNonce: true },
          command.user.id);
      } catch (err) {
        const status = googleErrorStatus(err);
        if (status === undefined || status < 400 || status === 408 || status === 429 || status >= 500) throw err;
        this.opts.logger.error({ err, messageId, command: command.command, channel: reply.channel.id },
          "Google Chat command reply rejected after execution; acknowledging event");
      }
      receipt.replies = receipt.replies.filter(pending => pending.index !== reply.index);
      store.completeInboundCommand(messageId, receipt, new Date().toISOString());
    }
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
      ...(delivery ? { messageId: googleChatClientMessageId(delivery.nonce) } : {}) };
    const message = await this.writes.enqueue(space, async () => {
      try {
        return await this.opts.api.request<ChatMessage>("chat", { method: "POST", url: `${root}/${space}/messages`,
          params, data: { ...body, ...(thread ? { thread: { name: thread } } : {}) } });
      } catch (err) {
        if (!delivery || googleErrorStatus(err) !== 409) throw err;
        return this.opts.api.request<ChatMessage>("chat", { method: "GET", url: `${root}/${space}/messages/${googleChatClientMessageId(delivery.nonce)}` });
      }
    });
    if (!message.name) throw new Error("Google Chat create returned no message name");
    // The sender of our own app-auth write is the canonical app user, without a membership lookup.
    if (message.sender?.name) {
      this.botUserId = message.sender.name;
      this.opts.spaceEvents?.recordAppUser(space, message.sender.name);
    }
    if (thread && message.thread?.name !== thread) this.opts.logger.warn({ expected: thread, actual: message.thread?.name,
      message: message.name }, "Google Chat reply fell back to a different thread");
    this.opts.logger.info({ message: message.name, thread: message.thread?.name, expectedThread: thread }, "Google Chat message sent");
    return { channel: message.thread?.name ? this.channelFor(space, message.thread.name) : channel, id: message.name,
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

  async createThread(parent: ChannelRef, name: string, delivery?: DeliveryNonceOptions): Promise<ChannelRef> {
    if (this.spaces.get(names(parent).space)?.spaceThreadingState === "UNTHREADED_MESSAGES") {
      throw new Error("Google Chat space does not support threads; it uses one shared session");
    }
    const message = await this.sendMessage({ platform: this.platform, id: names(parent).space.slice(7) }, name, delivery);
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
    const space = event.space?.name ?? thread?.split("/threads/")[0];
    if (!space) throw new Error("Google Chat CARD_CLICKED has no space name");
    if (!interactionId) throw new Error("Google Chat CARD_CLICKED has no Pub/Sub delivery id");
    const parsed = parseGoogleChatCardClick({ ...event, type: "CARD_CLICKED" },
      { channel: this.channelFor(space, thread), interactionId });
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

  private async historyTarget(channel: ChannelRef): Promise<GoogleChatHistoryTarget> {
    const { space, thread } = names(channel);
    let metadata = this.space(space);
    if (!metadata?.spaceType) {
      const fetched = await this.opts.api.request<GoogleChatSpace>("chat", { method: "GET", url: `${root}/${space}` });
      metadata = { ...metadata, ...fetched, name: space };
      this.spaces.set(space, metadata);
    }
    return { space, thread, spaceType: metadata.spaceType as GoogleChatHistoryTarget["spaceType"] };
  }

  async fetchMessagePage(threadId: string, request: MessagePageRequest): Promise<MessagePage> {
    if (!this.opts.historyReader) throw new Error("Google Chat history reader is not configured");
    const target = await this.historyTarget({ platform: this.platform, id: threadId });
    const result = await fetchSpaceMessagePage(this.opts.historyReader, target, request);
    if (result.status === "unsupported") throw new Error(result.cause);
    return { ...result.page, messages: result.page.messages.map(message =>
      message.authorName !== message.authorId ? message : { ...message,
        authorName: this.commandDeps?.store.getInbound(inboundId(message.messageId))?.authorName || message.authorName,
      }) };
  }

  async findMessageByNonce(channel: ChannelRef, nonce: string): Promise<DeliveryNonceLookup> {
    if (!this.opts.historyReader) return { status: "indeterminate",
      reason: "Google Chat nonce lookup is unsupported until history access is configured with admin-approved chat.app.messages.readonly" };
    const result = await findSpaceMessageByNonce(this.opts.historyReader, await this.historyTarget(channel), nonce);
    if (result.status === "unsupported") return { status: "indeterminate", reason: result.cause };
    if (result.status === "absent") return result;
    const { message } = result;
    return { status: "found", message: { channel: this.channelFor(names(channel).space, message.threadName),
      id: message.messageId, jumpLinkUnavailableReason: message.jumpLinkUnavailableReason } };
  }

  getBotUserId(channel?: ChannelRef): string | undefined {
    return (channel ? this.opts.spaceEvents?.appUser(names(channel).space) : undefined) ?? this.botUserId;
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
      const name = names(channel).space;
      const space = await this.opts.api.request<GoogleChatSpace>("chat", { method: "GET", url: `${root}/${name}` });
      this.spaces.set(name, { ...this.spaces.get(name), ...space, name });
      return { locked: false, archived: false };
    } catch (err) {
      if (googleErrorStatus(err) === 404) return undefined;
      throw err;
    }
  }
}
