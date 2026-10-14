import type { CreateElicitationRequest, CreateElicitationResponse, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export interface PermissionIdentity {
  requestId: string | number | null;
  sessionId: string;
  toolCallId: string;
  ownerPid?: number;
}

export interface ElicitationIdentity {
  method: "elicitation/create";
  requestId: string | number | null;
  sessionId: string;
  ownerPid?: number;
}

export type PendingRequestIdentity = PermissionIdentity | ElicitationIdentity;
export type PendingResponse = RequestPermissionResponse | CreateElicitationResponse;

export interface PermissionSnapshot {
  state: "pending" | "answered" | "gone";
  pid: number;
  detail?: string;
  response?: PendingResponse;
  cancelled?: boolean;
}

type Pending = { requestId: string | number | null; sessionId: string; response?: PendingResponse; cancelled?: string } & (
  | { method: "session/request_permission"; request: RequestPermissionRequest; toolCallId: string }
  | { method: "elicitation/create"; request: CreateElicitationRequest }
);

/** The agent's original requests stay with its child, not a controller connection. */
export class PendingPermissions {
  private readonly requests = new Map<string, Pending>();
  private readonly prompts = new Map<string, string>();
  private readonly answered = new Set<string>();

  constructor(private readonly write: (line: string) => boolean, private readonly pid = process.pid) {}

  observeOutput(line: string, acpSessionId?: string): void {
    const frame = this.frame(line);
    if (!frame) return;
    if (frame.method && this.isId(frame.id)) {
      this.answered.delete(this.key(frame.id));
      this.requests.delete(this.key(frame.id));
    }
    if (frame.method === "session/request_permission" && this.isId(frame.id)) {
      const request = frame.params as RequestPermissionRequest;
      this.requests.set(this.key(frame.id), {
        requestId: frame.id, sessionId: request.sessionId,
        method: "session/request_permission", toolCallId: request.toolCall.toolCallId, request,
      });
    } else if (frame.method === "elicitation/create" && this.isId(frame.id)) {
      const request = frame.params as CreateElicitationRequest;
      const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : acpSessionId;
      if (sessionId) this.requests.set(this.key(frame.id), {
        method: "elicitation/create", requestId: frame.id, sessionId, request,
      });
    } else if (frame.method === "$/cancel_request") {
      const params = frame.params as { requestId?: string | number | null; reason?: string };
      const request = this.requests.get(this.key(params.requestId ?? null));
      if (request?.method === "elicitation/create") request.cancelled = params.reason || "ACP request was cancelled.";
    } else if (this.isId(frame.id) && !frame.method) {
      const session = this.prompts.get(this.key(frame.id));
      if (session) {
        this.prompts.delete(this.key(frame.id));
        for (const [id, request] of this.requests) {
          if (request.sessionId === session) this.requests.delete(id);
        }
      }
    }
  }

  /** Drop only a replayed response to a request already answered here. */
  observeInput(line: string): boolean {
    const frame = this.frame(line);
    if (!frame) return true;
    if (frame.method === "session/prompt" && this.isId(frame.id)) {
      this.prompts.set(this.key(frame.id), String((frame.params as { sessionId?: unknown })?.sessionId));
    }
    if (!frame.method && this.isId(frame.id)) {
      if (this.answered.has(this.key(frame.id))) return false;
      const request = this.requests.get(this.key(frame.id));
      if (request && frame.result) {
        request.response = frame.result as PendingResponse;
        this.answered.add(this.key(frame.id));
      }
    }
    return true;
  }

  status(identity: PendingRequestIdentity): PermissionSnapshot {
    const request = this.find(identity);
    return { state: request && !request.cancelled ? request.response ? "answered" : "pending" : "gone", pid: this.pid,
      ...(request?.response ? { response: request.response } : {}),
      ...(request?.cancelled ? { cancelled: true } : {}),
      ...(!request || request.cancelled ? { detail: request?.cancelled ?? "The original agent request is no longer pending." } : {}) };
  }

  /** Output acknowledgement does not answer a client request. */
  unanswered(sessionId: string): string[] {
    return [...this.requests.values()].filter(request => request.sessionId === sessionId && !request.response && !request.cancelled)
      .map(request => `${JSON.stringify({ jsonrpc: "2.0", id: request.requestId,
        method: request.method, params: request.request })}\n`);
  }

  answer(identity: PendingRequestIdentity, response: PendingResponse): PermissionSnapshot {
    const request = this.find(identity);
    if (!request || request.response || request.cancelled) return this.status(identity);
    if (request.method === "session/request_permission") {
      const outcome = (response as RequestPermissionResponse).outcome;
      if (outcome.outcome === "selected" &&
        !request.request.options.some(option => option.optionId === outcome.optionId)) {
        throw new Error("The selected permission option was not offered by the agent.");
      }
    }
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: response })}\n`;
    if (!this.write(line)) throw new Error("The pending request's agent stdin is closed.");
    request.response = response;
    this.answered.add(this.key(request.requestId));
    return this.status(identity);
  }

  private find(identity: PendingRequestIdentity): Pending | undefined {
    const request = this.requests.get(this.key(identity.requestId));
    return request && request.sessionId === identity.sessionId &&
      ("method" in identity ? request.method === identity.method
        : request.method === "session/request_permission" && request.toolCallId === identity.toolCallId) &&
      (identity.ownerPid === undefined || identity.ownerPid === this.pid) ? request : undefined;
  }

  private key(id: string | number | null): string { return JSON.stringify(id); }
  private isId(id: unknown): id is string | number | null { return id === null || typeof id === "string" || typeof id === "number"; }
  private frame(line: string): Record<string, unknown> | undefined {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  }
}
