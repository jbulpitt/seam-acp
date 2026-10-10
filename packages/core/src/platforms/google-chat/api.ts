import { GoogleAuth } from "google-auth-library";

export interface GoogleRequest {
  url: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  params?: Record<string, string>;
  data?: unknown;
  responseType?: "arraybuffer";
  signal?: AbortSignal;
}

export interface GoogleApi {
  request<T>(scope: "chat" | "pubsub", request: GoogleRequest): Promise<T>;
}

/** Use the already-installed Google client for key loading, refresh and REST auth. */
export class GoogleRestApi implements GoogleApi {
  private readonly auth;

  constructor(keyFile: string, projectId: string) {
    this.auth = {
      chat: new GoogleAuth({ keyFile, projectId, scopes: ["https://www.googleapis.com/auth/chat.bot"] }),
      pubsub: new GoogleAuth({ keyFile, projectId, scopes: ["https://www.googleapis.com/auth/pubsub"] }),
    };
  }

  async request<T>(scope: "chat" | "pubsub", request: GoogleRequest): Promise<T> {
    const client = await this.auth[scope].getClient();
    // Writes are retried by the space lane, never invisibly outside its budget.
    const response = await client.request<T>({ ...request, retry: false });
    return response.data;
  }
}

export function googleErrorStatus(error: unknown): number | undefined {
  const e = error as { response?: { status?: number }; status?: number } | undefined;
  return e?.response?.status ?? e?.status;
}
