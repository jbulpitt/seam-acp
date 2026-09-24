import { createNdjsonReader } from "./ndjson-reader.js";
import { randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import {
  SESSIOND_PROTOCOL_VERSION,
  type SessiondEvent,
  type SessiondKillParams,
  type SessiondListSlotsResult,
  type SessiondMethod,
  type SessiondReplayOutputParams,
  type SessiondAckParams,
  type SessiondReplayOutputResult,
  type SessiondResponse,
  type SessiondSpawnParams,
  type SessiondSubscribeParams,
  type SessiondWireMessage,
} from "./sessiond-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// Matches sessiond's request cap; see sessiond-server.ts.
const MAX_WIRE_BYTES = 256 * 1024 * 1024;

export class SessiondClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly processCode?: string,
    readonly syscall?: string,
  ) {
    super(message);
  }
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface SessiondClientOptions {
  requestTimeoutMs?: number;
}

export class SessiondClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<number, (event: SessiondEvent) => void>();
  private readonly reader = createNdjsonReader((line) => this.deliver(line.toString("utf8")), MAX_WIRE_BYTES);
  private closed = false;
  private disconnected?: () => void;
  private closedByClient = false;

  private constructor(
    private readonly socket: Socket,
    private readonly requestTimeoutMs: number,
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => {
      this.failAll(new SessiondClientError("disconnected", "seam-sessiond disconnected"));
      if (!this.closedByClient) this.disconnected?.();
    });
  }

  /** Called once when sessiond goes away without this client closing it. */
  onDisconnect(listener: () => void): void {
    this.disconnected = listener;
  }

  static async connect(socketPath: string, options: SessiondClientOptions = {}): Promise<SessiondClient> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new SessiondClient(socket, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async spawn(params: SessiondSpawnParams): Promise<{ slot: number; pid: number }> {
    return this.request("spawn", params) as Promise<{ slot: number; pid: number }>;
  }

  async write(slot: number, data: Uint8Array | string): Promise<{ slot: number; acceptedBytes: number; backpressured: boolean }> {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    return this.request("write", { slot, dataBase64: bytes.toString("base64") }) as Promise<{
      slot: number;
      acceptedBytes: number;
      backpressured: boolean;
    }>;
  }

  async subscribe(
    params: SessiondSubscribeParams,
    onEvent: (event: SessiondEvent) => void,
  ): Promise<{ slot: number; subscribed: true; throughSeq: number }> {
    this.subscriptions.set(params.slot, onEvent);
    try {
      return await this.request("subscribe", params) as { slot: number; subscribed: true; throughSeq: number };
    } catch (error) {
      if (this.subscriptions.get(params.slot) === onEvent) this.subscriptions.delete(params.slot);
      throw error;
    }
  }

  async kill(params: SessiondKillParams): Promise<{ slot: number; signalled: boolean; alreadyDead: boolean }> {
    return this.request("kill", params) as Promise<{ slot: number; signalled: boolean; alreadyDead: boolean }>;
  }

  async listSlots(): Promise<SessiondListSlotsResult> {
    return this.request("listSlots", {}) as Promise<SessiondListSlotsResult>;
  }

  async replayOutput(params: SessiondReplayOutputParams): Promise<SessiondReplayOutputResult> {
    return this.request("replayOutput", params) as Promise<SessiondReplayOutputResult>;
  }

  async ack(params: SessiondAckParams): Promise<{ slot: number }> {
    return this.request("ack", params) as Promise<{ slot: number }>;
  }

  close(): void {
    this.closedByClient = true;
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
    this.failAll(new SessiondClientError("closed", "seam-sessiond client closed"));
  }

  private request(method: SessiondMethod, params: unknown): Promise<unknown> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new SessiondClientError("disconnected", "seam-sessiond is not connected"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SessiondClientError("timeout", `${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { timer, resolve, reject });
      this.socket.write(`${JSON.stringify({ v: SESSIOND_PROTOCOL_VERSION, id, method, params })}\n`);
    });
  }

  private receive(chunk: Buffer): void {
    if (!this.reader.push(chunk)) {
      this.socket.destroy(new SessiondClientError("protocol_error", "sessiond frame exceeded the wire limit"));
    }
  }


  private deliver(line: string): void {
    let message: SessiondWireMessage;
    try {
      message = JSON.parse(line) as SessiondWireMessage;
    } catch {
      this.socket.destroy(new SessiondClientError("protocol_error", "sessiond sent invalid JSON"));
      return;
    }
    if (message.v !== SESSIOND_PROTOCOL_VERSION) {
      this.socket.destroy(new SessiondClientError("protocol_error", "sessiond protocol version mismatch"));
      return;
    }
    if ("type" in message) {
      this.subscriptions.get(message.slot)?.(message);
      return;
    }
    const response = message as SessiondResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.payload);
    else pending.reject(new SessiondClientError(
      response.error?.code ?? "internal_error",
      response.error?.message ?? "sessiond request failed",
      response.error?.processCode,
      response.error?.syscall,
    ));
  }

  private failAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.subscriptions.clear();
  }
}
