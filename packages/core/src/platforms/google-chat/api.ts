import { GoogleAuth } from "google-auth-library";
import { googleDownloadError } from "../../core/files/google-download-error.js";

export interface GoogleRequest {
  url: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  params?: Record<string, string>;
  data?: unknown;
  headers?: Record<string, string>;
  responseType?: "arraybuffer";
  signal?: AbortSignal;
}

export type GoogleScope = "chat" | "messages" | "pubsub" | "spaces" | "memberships" | "media";
export interface GoogleApi { request<T>(scope: GoogleScope, request: GoogleRequest): Promise<T>; }

/** Use the already-installed Google client for key loading, refresh and REST auth. */
export class GoogleRestApi implements GoogleApi {
  private readonly auth;

  constructor(keyFile: string, projectId: string, mediaTokenFile?: string) {
    this.auth = {
      chat: new GoogleAuth({ keyFile, projectId, scopes: ["https://www.googleapis.com/auth/chat.bot"] }),
      messages: new GoogleAuth({ keyFile, projectId, scopes: ["https://www.googleapis.com/auth/chat.app.messages.readonly"] }),
      pubsub: new GoogleAuth({ keyFile, projectId, scopes: ["https://www.googleapis.com/auth/pubsub"] }),
      spaces: new GoogleAuth({ keyFile, projectId, scopes: ["https://www.googleapis.com/auth/chat.app.spaces"] }),
      memberships: new GoogleAuth({ keyFile, projectId, scopes: ["https://www.googleapis.com/auth/chat.app.memberships"] }),
      media: mediaTokenFile ? new GoogleAuth({ keyFile: mediaTokenFile,
        scopes: ["https://www.googleapis.com/auth/chat.messages.create", "https://www.googleapis.com/auth/chat.messages.readonly"] }) : undefined,
    };
  }

  async request<T>(scope: GoogleScope, request: GoogleRequest): Promise<T> {
    const auth = this.auth[scope];
    if (!auth) throw new Error("GOOGLE_CHAT_MEDIA_TOKEN_FILE is not configured for native media");
    const client = await auth.getClient();
    // Writes are retried by the space lane, never invisibly outside its budget.
    try {
      const response = await client.request<T>({ ...request, retry: false });
      return response.data;
    } catch (error) { throw googleDownloadError(error); }
  }
}

export function googleErrorStatus(error: unknown): number | undefined {
  const e = error as { response?: { status?: number }; status?: number } | undefined;
  return e?.response?.status ?? e?.status;
}

export function isGoogleChatThreadReplyLimit(error: unknown): boolean {
  const cause = (error as { response?: { data?: { error?: {
    code?: number; status?: string; message?: string; errors?: Array<{ domain?: string; reason?: string }>;
  } } } } | null)?.response?.data?.error;
  return (googleErrorStatus(error) ?? cause?.code) === 429 && cause?.code === 429
    && cause.status === "RESOURCE_EXHAUSTED"
    && cause.message === "Cannot create reply since it has reached the threading reply limit."
    && cause.errors?.some(item => item.domain === "global" && item.reason === "rateLimitExceeded") === true;
}
