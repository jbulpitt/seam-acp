import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  RequestError,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentProfile } from "./agent-profile.js";
import type { Logger } from "../lib/logger.js";

/** Events surfaced from the ACP `session/update` stream. */
export type AgentEvent =
  | { kind: "agent-text"; text: string; messageId?: string }
  | { kind: "agent-thought"; text: string }
  | {
      kind: "tool-start";
      toolCallId: string;
      title?: string;
      kindLabel?: string;
    }
  | {
      kind: "tool-update";
      toolCallId: string;
      status?: string;
      title?: string;
    }
  | { kind: "mode-changed"; modeId: string }
  | { kind: "model-changed"; modelId: string }
  | { kind: "config-options"; options: unknown }
  | { kind: "error"; message: string };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;
export type PermissionPolicy = (
  req: RequestPermissionRequest
) => Promise<RequestPermissionResponse>;

export interface NewSessionOptions {
  cwd: string;
  /** Optional model override (passed via `_meta`; agent applied via `set_model`). */
  model?: string;
  /** Extra ACP `_meta` to merge into `session/new`. */
  meta?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  /** Available models (if the agent advertised them in `session/new`). */
  availableModels: ReadonlyArray<{ modelId: string; name: string }>;
  /** Current model id, if known. */
  currentModelId?: string;
  /** Available modes. */
  availableModes: ReadonlyArray<{ id: string; name: string }>;
  currentModeId?: string;
}

export interface PromptOutcome {
  stopReason: string;
  cancelled: boolean;
}

interface AvailableModel {
  modelId: string;
  name: string;
}

interface AvailableMode {
  id: string;
  name: string;
}

/**
 * Owns one ACP child process and (optionally) one ACP session.
 *
 * Lifecycle:
 *   start() → newSession()/loadSession() → prompt()… → cancel()/dispose()
 *
 * One AgentRuntime per chat thread. The chat layer fans events to the user via
 * a single onEvent handler (set with `onEvent`).
 */
export class AgentRuntime {
  private readonly profile: AgentProfile;
  private readonly logger: Logger;
  private readonly permissionPolicy: PermissionPolicy;

  private child?: ReturnType<AgentProfile["spawn"]>;
  private connection?: ClientSideConnection;
  private sessionId?: string;
  private sessionInfo?: SessionInfo;

  private eventHandler?: AgentEventHandler;

  constructor(opts: {
    profile: AgentProfile;
    logger: Logger;
    permissionPolicy?: PermissionPolicy;
  }) {
    this.profile = opts.profile;
    this.logger = opts.logger.child({ agent: opts.profile.id });
    this.permissionPolicy =
      opts.permissionPolicy ??
      (async (req) => {
        // Default: pick the first "allow_..." option, or the first option.
        const allow =
          req.options.find((o) => o.kind?.startsWith("allow_")) ??
          req.options[0];
        if (!allow) {
          return {
            outcome: { outcome: "cancelled" },
          };
        }
        return {
          outcome: { outcome: "selected", optionId: allow.optionId },
        };
      });
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandler = handler;
  }

  /** Start the agent process and complete ACP `initialize`. */
  async start(): Promise<void> {
    if (this.connection) return;
    const child = this.profile.spawn();
    this.child = child;

    child.on("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "agent process exited");
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trimEnd();
      if (line) this.logger.debug({ stderr: line }, "agent stderr");
    });

    const writable = Writable.toWeb(
      child.stdin
    ) as unknown as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(
      child.stdout
    ) as unknown as ReadableStream<Uint8Array>;

    const stream = ndJsonStream(writable, readable);

    const client = this.makeClient();
    this.connection = new ClientSideConnection(() => client, stream);

    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    });
    this.logger.debug("acp initialized");
  }

  /** Create a new ACP session in `cwd`. */
  async newSession(opts: NewSessionOptions): Promise<SessionInfo> {
    const conn = this.requireConnection();
    const meta: Record<string, unknown> = {
      ...(this.profile.newSessionMeta?.() ?? {}),
      ...(opts.meta ?? {}),
    };

    const result = await conn.newSession({
      cwd: opts.cwd,
      mcpServers: [],
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });

    this.sessionId = result.sessionId;
    this.sessionInfo = this.buildSessionInfo(result);

    // Apply model override after session creation if requested and supported.
    const wantedModel = opts.model ?? this.profile.defaultModel;
    if (
      wantedModel &&
      this.sessionInfo.currentModelId &&
      wantedModel !== this.sessionInfo.currentModelId &&
      this.sessionInfo.availableModels.some((m) => m.modelId === wantedModel)
    ) {
      try {
        await this.setModel(wantedModel);
        this.sessionInfo = { ...this.sessionInfo, currentModelId: wantedModel };
      } catch (err) {
        this.logger.warn({ err, wantedModel }, "failed to set initial model");
      }
    }

    return this.sessionInfo;
  }

  /** Resume an existing ACP session. */
  async loadSession(opts: {
    sessionId: string;
    cwd: string;
  }): Promise<SessionInfo> {
    const conn = this.requireConnection();
    const result = await conn.loadSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: [],
    });
    this.sessionId = opts.sessionId;
    this.sessionInfo = {
      sessionId: opts.sessionId,
      availableModels: this.toAvailableModels(result.models),
      currentModelId: this.toCurrentModelId(result.models),
      availableModes: this.toAvailableModes(result.modes),
      currentModeId: this.toCurrentModeId(result.modes),
    };
    return this.sessionInfo;
  }

  getSessionInfo(): SessionInfo | undefined {
    return this.sessionInfo;
  }

  async prompt(text: string): Promise<PromptOutcome> {
    const conn = this.requireConnection();
    const sid = this.requireSessionId();
    const res = await conn.prompt({
      sessionId: sid,
      prompt: [{ type: "text", text }],
    });
    return {
      stopReason: res.stopReason,
      cancelled: res.stopReason === "cancelled",
    };
  }

  async setModel(modelId: string): Promise<void> {
    const conn = this.requireConnection();
    const sid = this.requireSessionId();
    await conn.unstable_setSessionModel({ sessionId: sid, modelId });
    if (this.sessionInfo) {
      this.sessionInfo = { ...this.sessionInfo, currentModelId: modelId };
    }
  }

  async setMode(modeId: string): Promise<void> {
    const conn = this.requireConnection();
    const sid = this.requireSessionId();
    await conn.setSessionMode({ sessionId: sid, modeId });
    if (this.sessionInfo) {
      this.sessionInfo = { ...this.sessionInfo, currentModeId: modeId };
    }
  }

  async setConfigOption(
    configId: string,
    value: string | boolean
  ): Promise<void> {
    const conn = this.requireConnection();
    const sid = this.requireSessionId();
    if (typeof value === "boolean") {
      await conn.setSessionConfigOption({
        sessionId: sid,
        configId,
        type: "boolean",
        value,
      });
    } else {
      await conn.setSessionConfigOption({
        sessionId: sid,
        configId,
        value,
      });
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch (err) {
      this.logger.warn({ err }, "cancel failed");
    }
  }

  async dispose(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.cancel();
      } catch {
        /* ignore */
      }
    }
    const child = this.child;
    if (child && !child.killed) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.connection = undefined;
    this.sessionId = undefined;
    this.sessionInfo = undefined;
    this.child = undefined;
  }

  // --- internals ---

  private requireConnection(): ClientSideConnection {
    if (!this.connection) throw new Error("AgentRuntime not started");
    return this.connection;
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error("No active session");
    return this.sessionId;
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (!this.eventHandler) return;
    try {
      await this.eventHandler(event);
    } catch (err) {
      this.logger.error({ err, event }, "event handler failed");
    }
  }

  private makeClient(): Client {
    const runtime = this;
    return {
      async requestPermission(
        params: RequestPermissionRequest
      ): Promise<RequestPermissionResponse> {
        return runtime.permissionPolicy(params);
      },

      async sessionUpdate(params: SessionNotification): Promise<void> {
        await runtime.handleSessionUpdate(params.update);
      },
    };
  }

  private async handleSessionUpdate(update: SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textFromContent(update.content);
        if (text) {
          await this.emit({
            kind: "agent-text",
            text,
            messageId: update.messageId ?? undefined,
          });
        }
        return;
      }
      case "agent_thought_chunk": {
        const text = textFromContent(update.content);
        if (text) await this.emit({ kind: "agent-thought", text });
        return;
      }
      case "tool_call": {
        await this.emit({
          kind: "tool-start",
          toolCallId: update.toolCallId,
          title: update.title,
          kindLabel: update.kind,
        });
        return;
      }
      case "tool_call_update": {
        await this.emit({
          kind: "tool-update",
          toolCallId: update.toolCallId,
          status: update.status ?? undefined,
          title: update.title ?? undefined,
        });
        return;
      }
      case "current_mode_update": {
        await this.emit({ kind: "mode-changed", modeId: update.currentModeId });
        return;
      }
      case "config_option_update": {
        // Track current model if present in the new options.
        const opts = (update as unknown as { configOptions?: unknown })
          .configOptions;
        const currentModel = extractCurrentModel(opts);
        if (currentModel && this.sessionInfo) {
          this.sessionInfo = {
            ...this.sessionInfo,
            currentModelId: currentModel,
          };
          await this.emit({ kind: "model-changed", modelId: currentModel });
        }
        await this.emit({ kind: "config-options", options: opts });
        return;
      }
      default:
        // user_message_chunk, plan, available_commands_update,
        // session_info_update, usage_update — currently ignored.
        return;
    }
  }

  private buildSessionInfo(
    result: import("@agentclientprotocol/sdk").NewSessionResponse
  ): SessionInfo {
    return {
      sessionId: result.sessionId,
      availableModels: this.toAvailableModels(result.models),
      currentModelId: this.toCurrentModelId(result.models),
      availableModes: this.toAvailableModes(result.modes),
      currentModeId: this.toCurrentModeId(result.modes),
    };
  }

  private toAvailableModels(
    models: import("@agentclientprotocol/sdk").NewSessionResponse["models"]
  ): ReadonlyArray<AvailableModel> {
    if (!models) return [];
    const list = (
      models as { availableModels?: Array<AvailableModel> }
    ).availableModels;
    return Array.isArray(list) ? list : [];
  }

  private toCurrentModelId(
    models: import("@agentclientprotocol/sdk").NewSessionResponse["models"]
  ): string | undefined {
    if (!models) return undefined;
    return (models as { currentModelId?: string }).currentModelId;
  }

  private toAvailableModes(
    modes: import("@agentclientprotocol/sdk").NewSessionResponse["modes"]
  ): ReadonlyArray<AvailableMode> {
    if (!modes) return [];
    const list = (modes as { availableModes?: Array<AvailableMode> })
      .availableModes;
    return Array.isArray(list) ? list : [];
  }

  private toCurrentModeId(
    modes: import("@agentclientprotocol/sdk").NewSessionResponse["modes"]
  ): string | undefined {
    if (!modes) return undefined;
    return (modes as { currentModeId?: string }).currentModeId;
  }
}

function textFromContent(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const c = content as { type?: string; text?: string };
  if (c.type === "text" && typeof c.text === "string") return c.text;
  return undefined;
}

function extractCurrentModel(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const modelOpt = options.find(
    (o): o is { id?: string; currentValue?: string } =>
      typeof o === "object" &&
      o !== null &&
      (o as { id?: string }).id === "model"
  );
  return modelOpt?.currentValue;
}

export { RequestError };
