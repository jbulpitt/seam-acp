import type { Logger } from "pino";
import { setTimeout as delay } from "node:timers/promises";
import type { GoogleApi } from "./api.js";
import { parseGoogleChatWorkspaceMessages, type ParsedWorkspaceChatMessage, type WorkspacePubSubMessage } from "./workspace-message-event.js";

export interface PubSubMessage {
  ackId?: string;
  message?: WorkspacePubSubMessage;
}

export class PubSubPullTransport {
  private controller?: AbortController;
  private loop?: Promise<void>;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly opts: { api: GoogleApi; subscription: string;
    receive: (event: unknown, signal?: AbortSignal, messageId?: string) => Promise<void>;
    receiveWorkspaceMessage?: (message: ParsedWorkspaceChatMessage, signal?: AbortSignal) => Promise<void>;
    logger: Logger }) {}

  async start(): Promise<void> {
    if (this.loop) return;
    this.controller = new AbortController();
    this.loop = this.pull(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
    this.loop = undefined;
  }

  async process(received: PubSubMessage, signal?: AbortSignal): Promise<void> {
    if (!received.ackId || !received.message?.data) throw new Error("Pub/Sub event missing ackId or data");
    const id = received.message.messageId ?? received.ackId;
    let admission = this.inFlight.get(id);
    if (!admission) {
      if (received.message.attributes?.["ce-type"]) {
        const messages = parseGoogleChatWorkspaceMessages(received.message);
        admission = (async () => {
          for (const message of messages) {
            if (!this.opts.receiveWorkspaceMessage) throw new Error("Google Chat Workspace handler not installed");
            await this.opts.receiveWorkspaceMessage(message, signal);
          }
        })();
      } else {
        // Buffer accepts missing padding and URL-safe base64 seen on the real subscription.
        const event: unknown = JSON.parse(Buffer.from(received.message.data, "base64").toString("utf8"));
        admission = this.opts.receive(event, signal, id);
      }
      this.inFlight.set(id, admission);
    }
    try {
      await admission;
      signal?.throwIfAborted();
      await this.opts.api.request("pubsub", { method: "POST",
        url: `https://pubsub.googleapis.com/v1/${this.opts.subscription}:acknowledge`,
        data: { ackIds: [received.ackId] }, signal });
      this.opts.logger.debug({ messageId: id }, "Google Chat event acknowledged after admission");
    } finally {
      if (this.inFlight.get(id) === admission) this.inFlight.delete(id);
    }
  }

  private async pull(signal: AbortSignal): Promise<void> {
    let retryMs = 1000;
    while (!signal.aborted) {
      try {
        const result = await this.opts.api.request<{ receivedMessages?: PubSubMessage[] }>("pubsub", { method: "POST",
          url: `https://pubsub.googleapis.com/v1/${this.opts.subscription}:pull`, data: { maxMessages: 10 }, signal });
        await Promise.all((result.receivedMessages ?? []).map(async message => {
          try { await this.process(message, signal); }
          catch (err) {
            if (!signal.aborted) this.opts.logger.error({ err, messageId: message.message?.messageId },
              "Google Chat event not acknowledged; awaiting redelivery");
          }
        }));
        retryMs = 1000;
        if (!result.receivedMessages?.length) await delay(1000, undefined, { signal });
      } catch (err) {
        if (signal.aborted) break;
        this.opts.logger.warn({ err, retryMs }, "Google Chat Pub/Sub pull retry");
        try { await delay(retryMs, undefined, { signal }); } catch { break; }
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  }
}
