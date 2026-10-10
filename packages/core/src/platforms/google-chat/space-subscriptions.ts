import { GoogleAuth } from "google-auth-library";
import { setTimeout as delay } from "node:timers/promises";

export const GOOGLE_CHAT_MESSAGE_CREATED = "google.workspace.chat.message.v1.created";
export const GOOGLE_CHAT_MESSAGE_BATCH_CREATED = "google.workspace.chat.message.v1.batchCreated";
export const GOOGLE_CHAT_APP_MESSAGES_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly";
export const GOOGLE_CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

const root = "https://workspaceevents.googleapis.com/v1";
export type WorkspaceEventsScope = "messages" | "bot";
export type WorkspaceEventsRequest = Parameters<GoogleAuth["request"]>[0];

export interface WorkspaceEventsRequestor {
  request<T>(scope: WorkspaceEventsScope, request: WorkspaceEventsRequest): Promise<T>;
}

export interface GoogleChatSpaceSubscription {
  name: string;
  targetResource: string;
  eventTypes: string[];
  notificationEndpoint: { pubsubTopic: string };
  payloadOptions?: { includeResource?: boolean; fieldMask?: string };
  expireTime: string;
  state?: string;
  suspensionReason?: string;
  serviceAccountAuthority?: string;
  etag?: string;
}

export interface WorkspaceEventsStatus {
  code: number;
  message: string;
  details?: unknown[];
}

interface WorkspaceOperation<T> {
  name: string;
  done?: boolean;
  response?: T;
  error?: WorkspaceEventsStatus;
}

/** A failed long-running operation returns a Google RPC Status, not an Error. */
export class WorkspaceEventsOperationError extends Error {
  readonly code: number;
  readonly details: unknown[] | undefined;

  constructor(status: WorkspaceEventsStatus) {
    super(status.message, { cause: status });
    this.name = "WorkspaceEventsOperationError";
    this.code = status.code;
    this.details = status.details;
  }
}

export class GoogleWorkspaceEventsApi implements WorkspaceEventsRequestor {
  private readonly clients: Record<WorkspaceEventsScope, GoogleAuth>;

  constructor(credentialsFile: string) {
    this.clients = {
      messages: new GoogleAuth({ keyFilename: credentialsFile, scopes: [GOOGLE_CHAT_APP_MESSAGES_SCOPE] }),
      bot: new GoogleAuth({ keyFilename: credentialsFile, scopes: [GOOGLE_CHAT_BOT_SCOPE] }),
    };
  }

  async request<T>(scope: WorkspaceEventsScope, request: WorkspaceEventsRequest): Promise<T> {
    const response = await this.clients[scope].request<T>({ ...request, retry: false });
    return response.data;
  }
}

function target(space: string): string { return `//chat.googleapis.com/${space}`; }
function resourceUrl(name: string): string {
  return `${root}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export interface CreateGoogleChatSubscriptionOptions {
  /** Full resource data by default; Google caps these subscriptions at four hours. */
  includeResource?: boolean;
  /** Google field-mask paths, for example message.sender,message.thread. */
  fieldMask?: string;
  /** Protobuf duration; 0s asks Google for the maximum permitted TTL. */
  ttl?: string;
  signal?: AbortSignal;
}

/** Standalone API operations only; the caller owns scheduling and durable state. */
export class GoogleChatSpaceSubscriptions {
  private readonly api: WorkspaceEventsRequestor;

  constructor(private readonly opts: {
    pubsubTopic: string;
    credentialsFile?: string;
    operationPollIntervalMs?: number;
  }, api?: WorkspaceEventsRequestor) {
    if (api) this.api = api;
    else {
      const credentialsFile = opts.credentialsFile ?? process.env.GOOGLE_CHAT_CREDENTIALS_FILE;
      if (!credentialsFile) throw new Error("GOOGLE_CHAT_CREDENTIALS_FILE is required for Workspace Events app authentication");
      this.api = new GoogleWorkspaceEventsApi(credentialsFile);
    }
  }

  /** space is the Chat resource name, spaces/{space}. */
  async create(space: string, options: CreateGoogleChatSubscriptionOptions = {}): Promise<GoogleChatSpaceSubscription> {
    const operation = await this.api.request<WorkspaceOperation<GoogleChatSpaceSubscription>>("messages", {
      method: "POST", url: `${root}/subscriptions`, signal: options.signal,
      data: {
        targetResource: target(space), eventTypes: [GOOGLE_CHAT_MESSAGE_CREATED],
        notificationEndpoint: { pubsubTopic: this.opts.pubsubTopic },
        payloadOptions: { includeResource: options.includeResource ?? true,
          ...(options.fieldMask === undefined ? {} : { fieldMask: options.fieldMask }) },
        ttl: options.ttl ?? "0s",
      },
    });
    return (await this.finish(operation, options.signal))!;
  }

  async renew(name: string, ttl = "0s", signal?: AbortSignal): Promise<GoogleChatSpaceSubscription> {
    const operation = await this.api.request<WorkspaceOperation<GoogleChatSpaceSubscription>>("messages", {
      method: "PATCH", url: resourceUrl(name), params: { updateMask: "ttl" }, data: { ttl }, signal,
    });
    return (await this.finish(operation, signal))!;
  }

  async delete(name: string, signal?: AbortSignal): Promise<void> {
    const operation = await this.api.request<WorkspaceOperation<unknown>>("bot", {
      method: "DELETE", url: resourceUrl(name), signal,
    });
    await this.finish(operation, signal);
  }

  /** Lists every page of this app's message-created subscriptions, optionally for one space. */
  async list(space?: string, signal?: AbortSignal): Promise<GoogleChatSpaceSubscription[]> {
    const subscriptions: GoogleChatSpaceSubscription[] = [];
    const filter = `event_types:${JSON.stringify(GOOGLE_CHAT_MESSAGE_CREATED)}`
      + (space === undefined ? "" : ` AND target_resource=${JSON.stringify(target(space))}`);
    let pageToken: string | undefined;
    do {
      const page = await this.api.request<{ subscriptions?: GoogleChatSpaceSubscription[]; nextPageToken?: string }>("bot", {
        method: "GET", url: `${root}/subscriptions`, signal,
        params: { filter, pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      });
      subscriptions.push(...page.subscriptions ?? []);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return subscriptions;
  }

  private async finish<T>(initial: WorkspaceOperation<T>, signal?: AbortSignal): Promise<T | undefined> {
    let operation = initial;
    while (!operation.done) {
      await delay(this.opts.operationPollIntervalMs ?? 1000, undefined, { signal });
      operation = await this.api.request<WorkspaceOperation<T>>("bot", {
        method: "GET", url: resourceUrl(initial.name), signal,
      });
    }
    if (operation.error) throw new WorkspaceEventsOperationError(operation.error);
    return operation.response;
  }
}

/** Use Google's returned expiry; the caller chooses the renewal lead time. */
export function nextGoogleChatSubscriptionRenewalTime(
  subscription: Pick<GoogleChatSpaceSubscription, "expireTime">, leadTimeMs: number,
): number {
  return Date.parse(subscription.expireTime) - leadTimeMs;
}
