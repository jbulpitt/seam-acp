import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export interface PermissionIdentity {
  requestId: string | number | null;
  sessionId: string;
  toolCallId: string;
  ownerPid?: number;
}

export interface PermissionSnapshot {
  state: "pending" | "answered" | "gone";
  pid: number;
}

type Pending = PermissionIdentity & {
  options: RequestPermissionRequest["options"];
  response?: RequestPermissionResponse;
};

/** The agent's original requests stay with its child, not a controller connection. */
export class PendingPermissions {
  private readonly requests = new Map<string, Pending>();
  private readonly prompts = new Map<string, string>();
  private readonly answered = new Set<string>();

  constructor(private readonly write: (line: string) => boolean, private readonly pid = process.pid) {}

  observeOutput(line: string): void {
    const frame = this.frame(line);
    if (!frame) return;
    if (frame.method === "session/request_permission" && this.isId(frame.id)) {
      this.answered.delete(this.key(frame.id));
      const request = frame.params as RequestPermissionRequest;
      this.requests.set(this.key(frame.id), {
        requestId: frame.id, sessionId: request.sessionId,
        toolCallId: request.toolCall.toolCallId, options: request.options,
      });
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

  /** Drop only a replayed response to a permission already answered here. */
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
        request.response = frame.result as RequestPermissionResponse;
        this.answered.add(this.key(frame.id));
      }
    }
    return true;
  }

  status(identity: PermissionIdentity): PermissionSnapshot {
    const request = this.find(identity);
    return { state: request ? request.response ? "answered" : "pending" : "gone", pid: this.pid };
  }

  answer(identity: PermissionIdentity, response: RequestPermissionResponse): PermissionSnapshot {
    const request = this.find(identity);
    if (!request || request.response) return this.status(identity);
    const outcome = response.outcome;
    if (outcome.outcome === "selected" &&
      !request.options.some(option => option.optionId === outcome.optionId)) {
      throw new Error("The selected permission option was not offered by the agent.");
    }
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: response })}\n`;
    if (!this.write(line)) throw new Error("The pending permission's agent stdin is closed.");
    request.response = response;
    this.answered.add(this.key(request.requestId));
    return this.status(identity);
  }

  private find(identity: PermissionIdentity): Pending | undefined {
    const request = this.requests.get(this.key(identity.requestId));
    return request && request.sessionId === identity.sessionId && request.toolCallId === identity.toolCallId &&
      (identity.ownerPid === undefined || identity.ownerPid === this.pid) ? request : undefined;
  }

  private key(id: string | number | null): string { return JSON.stringify(id); }
  private isId(id: unknown): id is string | number | null { return id === null || typeof id === "string" || typeof id === "number"; }
  private frame(line: string): Record<string, unknown> | undefined {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  }
}
