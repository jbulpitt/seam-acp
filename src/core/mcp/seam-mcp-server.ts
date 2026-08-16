/**
 * seam-MCP HTTP server — the agent-facing tool surface (#24).
 *
 * ONE shared in-process MCP-over-HTTP server serves every ACP session. Per
 * session we inject an `mcpServers` entry pointing at this server and carrying
 * an `X-Seam-Session: <token>` header (see `buildSeamMcpServerEntry` +
 * `SeamTokenRegistry`); the server reads that header off each `tools/call`
 * request to identify the calling thread. Transport verified end-to-end in the
 * #17 spike: injected http config → claude-agent-acp (`type:"http"` → SDK map)
 * → Claude SDK → outbound HTTP request with the header intact.
 *
 * We hand-roll the minimal JSON-RPC 2.0 subset MCP needs — `initialize`,
 * `tools/list`, `tools/call`, and the `notifications/initialized` no-op — over
 * `node:http`. No new npm dependency; MCP is just JSON-RPC and this is all the
 * three tools require.
 *
 * The tools are intentionally thin: they resolve the caller from the token and
 * enqueue a dispatch spec (or read a thread). The runtime's DispatchWatcher +
 * report-back own correlation and delivery — exactly as the operator-dispatch
 * bridge and the `<seam-*>` fence directives already do.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { HttpHeader, McpServer } from "@agentclientprotocol/sdk";
import type { Logger } from "../../lib/logger.js";
import type { SessionRecord } from "../types.js";
import type { DispatchSpec } from "../dispatch/types.js";
import { frameSteerPrompt } from "../steer.js";
import { buildChainHopSpec } from "../dispatch/types.js";
import type { ConfigDescription } from "../session-router.js";

/** Read-only entities visible to the calling thread (schedules + presets),
 *  returned by `config_describe` alongside the effective config. Kept as a
 *  minimal projection so the server stays decoupled from the store types. */
export interface ConfigEntities {
  schedules: Array<{
    name: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    nextRunUtc: string | null;
  }>;
  presets: Array<{
    name: string;
    scope: "project" | "global";
    agentId: string | null;
    model: string | null;
  }>;
}

/** MCP protocol version we speak. We echo the client's if it sends a newer one
 *  it thinks we support; otherwise advertise this. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** Header the injected mcpServers entry carries; read per request to identify
 *  the calling session. A header (not a URL path) keeps the token out of logs. */
export const SEAM_SESSION_HEADER = "x-seam-session";

/** Recent messages from a thread, as the peek tool renders them. */
export interface PeekedMessage {
  authorIsBot: boolean;
  text: string;
}

export interface SeamMcpServerDeps {
  logger: Logger;
  /** token → the calling session's record (or undefined if unknown/revoked). */
  resolveSession: (token: string | undefined) => SessionRecord | undefined;
  /** Persist a dispatch spec into the pending queue (the DispatchWatcher runs it). */
  enqueueDispatch: (spec: DispatchSpec) => Promise<void>;
  /**
   * Create a durable chain row and pop its first hop (#25). Returns the new
   * chain id and the worker string of hop 1 (the caller then enqueues it).
   * Undefined ⇒ chains are unsupported on this deployment.
   */
  createChain?: (input: {
    hops: string[];
    originRef: string;
    promptPreview?: string | null;
  }) => { chainId: string; firstHop: string };
  /** Read recent messages from a thread; undefined ⇒ peek is unsupported. */
  peekThread?: (threadId: string, count: number) => Promise<PeekedMessage[]>;
  /**
   * Compute the EFFECTIVE config + which layer won for the calling session
   * (#58 P1). Undefined ⇒ config introspection is unsupported on this
   * deployment. Read-only; scope is always the caller's own thread (D3).
   */
  describeConfig?: (record: SessionRecord) => ConfigDescription;
  /** List the read-only entities (schedules / presets) visible to the calling
   *  thread. Undefined ⇒ omit the entity section from `config_describe`. */
  listConfigEntities?: (record: SessionRecord) => ConfigEntities;
  /** Arm a one-shot wake for the calling thread (#59). Returns the new wake id
   *  and fire time, or an error string the tool surfaces verbatim. Undefined ⇒
   *  wakes are unsupported on this deployment. */
  scheduleWake?: (
    record: SessionRecord,
    req: { delaySeconds: number; reason: string; prompt: string }
  ) => { ok: true; wakeId: string; fireAtUtc: string } | { ok: false; error: string };
  /** Cancel a pending wake owned by the calling thread (#59). Returns whether a
   *  row was removed. Undefined ⇒ wakes are unsupported on this deployment. */
  cancelWake?: (record: SessionRecord, id: string) => boolean;
}

/** A Discord snowflake is a long run of digits; a preset is a human name. Used
 *  to decide whether `worker`/`to` names a thread (stateful) or a preset. */
function looksLikeThreadId(s: string): boolean {
  return /^\d{15,}$/.test(s.trim());
}

const TOOLS = [
  {
    name: "handoff",
    description:
      "Hand a task to a worker and (by default) get its result reported back to you. " +
      "`worker` is EITHER a thread id (a stateful teammate — the task runs in that thread's own session) " +
      "OR a preset name (a stateless specialist spun up cold for this one task). " +
      "The worker's output is delivered back into your thread automatically when it finishes — you do not wait inline.",
    inputSchema: {
      type: "object",
      properties: {
        worker: {
          type: "string",
          description: "Target thread id (stateful) or preset name (stateless specialist).",
        },
        prompt: { type: "string", description: "The task to hand off." },
        returnTo: {
          type: "string",
          description: "Thread id to report the result back into. Defaults to YOUR thread.",
        },
      },
      required: ["worker", "prompt"],
    },
  },
  {
    name: "forward",
    description:
      "Forward a message straight into another thread — a thin handoff with no specialist framing. " +
      "Use to relay context or nudge another teammate. The reply is reported back to you by default.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destination thread id." },
        content: { type: "string", description: "The message to deliver into that thread." },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "steer",
    description:
      "Redirect a teammate mid-task. Injects a framed steering instruction into that thread's LIVE " +
      "session (its history is preserved) so it adjusts course now. Use when a running teammate is " +
      "heading the wrong way or you have a new constraint for it.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "Target thread id to steer." },
        prompt: { type: "string", description: "The steering instruction to inject now." },
      },
      required: ["thread", "prompt"],
    },
  },
  {
    name: "peek",
    description:
      "Read the most recent messages from a thread WITHOUT posting anything, so you can catch up on " +
      "another teammate's context before you hand off to or forward into them.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "Thread id to read." },
        count: {
          type: "number",
          description: "How many recent messages to return (default 20, max 50).",
        },
      },
      required: ["thread"],
    },
  },
  {
    name: "chain",
    description:
      "Run a durable multi-hop chain: your prompt flows through each worker in order, and EACH hop's " +
      "output becomes the NEXT hop's input. `workers` is an ordered list of thread ids (stateful teammates) " +
      "and/or preset names (stateless specialists). The runtime drives every hop and survives a restart " +
      "mid-chain — you do not wait inline. The final hop's output is delivered back into `returnTo` " +
      "(your thread by default).",
    inputSchema: {
      type: "object",
      properties: {
        workers: {
          type: "array",
          items: { type: "string" },
          description: "Ordered hops — each a thread id (stateful) or preset name (stateless specialist).",
          minItems: 1,
        },
        prompt: { type: "string", description: "The initial input handed to hop 1." },
        returnTo: {
          type: "string",
          description: "Thread id to deliver the final output into. Defaults to YOUR thread.",
        },
      },
      required: ["workers", "prompt"],
    },
  },
  {
    name: "schedule_wake",
    description:
      "Schedule your OWN future re-entry into THIS thread: wake yourself in `delaySeconds` seconds and " +
      "replay `prompt` back to yourself as a live turn, with this thread's context intact. One-shot — it " +
      "fires once and is deleted; to keep a loop going you must call this again during the woken turn " +
      "(nothing re-arms automatically). Durable across restarts. Use for deferred follow-up: \"check back on " +
      "that build in 20 minutes\", polling until a condition holds, or picking up work after a wait. " +
      "`reason` is a short human-facing note shown when the wake fires (not an instruction).",
    inputSchema: {
      type: "object",
      properties: {
        delaySeconds: {
          type: "number",
          description: "How many seconds from now to wake (min 60, max 604800 = 7 days).",
        },
        reason: {
          type: "string",
          description: "Short human-facing reason, shown when the wake fires (telemetry, not instructions).",
        },
        prompt: {
          type: "string",
          description: "The prompt to replay to yourself on waking. Write it to stand on its own.",
        },
      },
      required: ["delaySeconds", "prompt"],
    },
  },
  {
    name: "cancel_wake",
    description:
      "Cancel a pending wake you scheduled in THIS thread, by its id (as returned by schedule_wake).",
    inputSchema: {
      type: "object",
      properties: {
        wakeId: { type: "string", description: "The wake id to cancel." },
      },
      required: ["wakeId"],
    },
  },
  {
    name: "config_describe",
    description:
      "Describe YOUR thread's effective configuration and WHY each value is what it is. " +
      "Returns the effective agent / model / effort / cwd / permission, and for each one " +
      "WHICH layer set it (channel preset vs thread preset vs session config vs bot default) — " +
      "so you can answer questions like \"what model am I on?\" or \"why is my working directory wrong?\". " +
      "Also lists the scheduled prompts and presets visible in this thread. Read-only: it changes nothing, " +
      "and it only ever reports YOUR OWN thread (cross-thread config is a separate privileged capability).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description:
            "Optional. Only \"self\" (or your own thread id) is allowed — describing another " +
            "thread's config is privileged and not available here. Defaults to your own thread.",
        },
      },
      required: [],
    },
  },
] as const;

const INSTRUCTIONS = [
  "You are one teammate in a shared workspace of parallel agent threads. These tools let you",
  "coordinate with the others without leaving your own turn:",
  "",
  "- handoff(worker, prompt, returnTo?): delegate a task. `worker` is a thread id (a stateful",
  "  teammate) or a preset name (a fresh stateless specialist). You do NOT block — the worker's",
  "  result is dispatched back into your thread when it completes.",
  "- forward(to, content): relay a message into another thread (thin handoff, no specialist framing).",
  "- steer(thread, prompt): redirect a teammate mid-task — inject a new instruction into its live session.",
  "- peek(thread, count?): read another thread's recent messages to get context before delegating.",
  "- chain(workers, prompt, returnTo?): pipe a prompt through an ordered list of workers where each",
  "  hop's output feeds the next; the final output is delivered back to you. Durable across restarts.",
  "- schedule_wake(delaySeconds, prompt, reason?): wake YOURSELF later in this thread and replay `prompt`",
  "  as a live turn (context intact). One-shot and durable — it fires once, then is deleted; re-arm during",
  "  the woken turn to continue a loop. This is the working substrate for \"wake me in N minutes\"; the",
  "  native ScheduleWakeup / Monitor tools do NOT function here, so use this instead.",
  "- cancel_wake(wakeId): cancel a pending wake you scheduled.",
  "",
  "Prefer handoff to a preset for well-scoped specialist work, and to a thread id when a specific",
  "teammate already holds the context. Use chain when work has a fixed multi-stage pipeline.",
  "Correlation and delivery are handled for you.",
].join("\n");

/**
 * The shared seam-MCP HTTP server. `start()` binds an ephemeral loopback port;
 * read `.port` afterwards to build per-session injection entries.
 */
export class SeamMcpServer {
  private readonly deps: SeamMcpServerDeps;
  private readonly logger: Logger;
  private server?: http.Server;
  private boundPort?: number;

  constructor(deps: SeamMcpServerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ comp: "seam-mcp" });
  }

  /** Bind 127.0.0.1:0 (ephemeral) and start serving. Idempotent. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        this.boundPort = (server.address() as AddressInfo).port;
        resolve();
      });
    });
    this.logger.info({ port: this.boundPort }, "seam-mcp server listening");
  }

  /** The ephemeral port the server bound to (after `start()`). */
  get port(): number {
    if (this.boundPort === undefined) throw new Error("SeamMcpServer not started");
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // --- HTTP / JSON-RPC plumbing -------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || (req.url ?? "").replace(/\/+$/, "") !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      this.logger.warn({ err }, "failed to read request body");
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
      return;
    }

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
      return;
    }

    // Notifications (no `id`) get a bare 202 with no JSON-RPC body.
    const isNotification = msg.id === undefined || msg.id === null;

    const token = headerValue(req.headers[SEAM_SESSION_HEADER]);
    const response = await this.dispatch(msg, token);

    if (isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  }

  private async dispatch(
    msg: JsonRpcRequest,
    token: string | undefined
  ): Promise<JsonRpcResponse> {
    const id = msg.id ?? null;
    switch (msg.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion:
            typeof msg.params?.protocolVersion === "string"
              ? msg.params.protocolVersion
              : DEFAULT_PROTOCOL_VERSION,
          serverInfo: { name: "seam-mcp", version: "1.0.0" },
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
        });
      case "notifications/initialized":
      case "initialized":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call":
        return this.callTool(id, msg.params, token);
      default:
        return rpcError(id, -32601, `method not found: ${msg.method}`);
    }
  }

  private async callTool(
    id: JsonRpcId,
    params: JsonRpcRequest["params"],
    token: string | undefined
  ): Promise<JsonRpcResponse> {
    const record = this.deps.resolveSession(token);
    if (!record) {
      // Unknown/missing token — the caller cannot be identified. Fail loudly
      // rather than guess a thread.
      return rpcError(id, -32001, "unauthorized: unknown or missing X-Seam-Session token");
    }

    const name = typeof params?.name === "string" ? params.name : "";
    const args = (params?.arguments ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "handoff":
          return rpcResult(id, await this.toolHandoff(record, args));
        case "forward":
          return rpcResult(id, await this.toolForward(record, args));
        case "steer":
          return rpcResult(id, await this.toolSteer(record, args));
        case "peek":
          return rpcResult(id, await this.toolPeek(args));
        case "chain":
          return rpcResult(id, await this.toolChain(record, args));
        case "schedule_wake":
          return rpcResult(id, this.toolScheduleWake(record, args));
        case "cancel_wake":
          return rpcResult(id, this.toolCancelWake(record, args));
        case "config_describe":
          return rpcResult(id, this.toolConfigDescribe(record, args));
        default:
          return rpcError(id, -32602, `unknown tool: ${name}`);
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.logger.warn({ err, tool: name, session: record.id }, "seam-mcp tool failed");
      // Surface tool-level failures as an MCP error result, not a JSON-RPC
      // protocol error, so the agent sees it as a tool that ran and failed.
      return rpcResult(id, textResult(`Error: ${message}`, true));
    }
  }

  // --- the three tools -----------------------------------------------------

  private async toolHandoff(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const worker = requireString(args, "worker");
    const prompt = requireString(args, "prompt");
    const returnTo = optionalString(args, "returnTo") ?? caller.channelRef;
    const toThread = looksLikeThreadId(worker);
    const dispatchId = randomUUID();

    // A thread-id worker runs live in that teammate's own session; a preset name
    // spins up a stateless specialist (dispatchInjectTurn forces isolated for
    // presets). For a preset we default the target to the caller's own thread so
    // the specialist's work is visible where the caller is.
    const spec: DispatchSpec = {
      id: dispatchId,
      target: toThread ? worker : caller.channelRef,
      prompt,
      session: toThread ? "live" : "isolated",
      ...(toThread ? {} : { preset: worker }),
      returnTo,
      kind: "handoff",
      correlationId: dispatchId,
      createdUtc: new Date().toISOString(),
    };
    await this.deps.enqueueDispatch(spec);
    this.logger.info(
      { dispatchId, from: caller.channelRef, worker, toThread, returnTo },
      "seam-mcp handoff enqueued"
    );
    return textResult(
      `Handed off to ${toThread ? `thread ${worker}` : `preset "${worker}"`} ` +
        `(dispatch ${dispatchId}). Its result will be reported back into thread ${returnTo}.`
    );
  }

  private async toolForward(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const to = requireString(args, "to");
    const content = requireString(args, "content");
    const dispatchId = randomUUID();
    const spec: DispatchSpec = {
      id: dispatchId,
      target: to,
      prompt: content,
      session: "live",
      returnTo: caller.channelRef,
      kind: "forward",
      correlationId: dispatchId,
      createdUtc: new Date().toISOString(),
    };
    await this.deps.enqueueDispatch(spec);
    this.logger.info(
      { dispatchId, from: caller.channelRef, to },
      "seam-mcp forward enqueued"
    );
    return textResult(
      `Forwarded into thread ${to} (dispatch ${dispatchId}). ` +
        `Any reply will be reported back into thread ${caller.channelRef}.`
    );
  }

  /** Steer a teammate: enqueue a LIVE dispatch into the target thread whose
   *  prompt is the framed steer text, so it lands in that thread's own session
   *  (history preserved). Minimal by design — unlike the `/seam steer` command
   *  it does not preemptively cancel the target's in-flight turn; it queues
   *  behind it on that thread. kind = "handoff". */
  private async toolSteer(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const thread = requireString(args, "thread");
    const prompt = requireString(args, "prompt");
    const dispatchId = randomUUID();
    const spec: DispatchSpec = {
      id: dispatchId,
      target: thread,
      prompt: frameSteerPrompt(prompt),
      session: "live",
      returnTo: caller.channelRef,
      kind: "handoff",
      correlationId: dispatchId,
      createdUtc: new Date().toISOString(),
    };
    await this.deps.enqueueDispatch(spec);
    this.logger.info(
      { dispatchId, from: caller.channelRef, thread },
      "seam-mcp steer enqueued"
    );
    return textResult(
      `Steered thread ${thread} (dispatch ${dispatchId}). The instruction was ` +
        `injected into its live session; its response is reported back into thread ${caller.channelRef}.`
    );
  }

  private async toolChain(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.createChain) {
      return textResult("chains are not supported on this deployment.", true);
    }
    const workers = requireStringArray(args, "workers");
    const prompt = requireString(args, "prompt");
    const originRef = optionalString(args, "returnTo") ?? caller.channelRef;

    // Create the durable chain row and pop hop 1. The runtime drives the rest:
    // each hop's completion advances the chain (see Orchestrator.advanceChain),
    // and the row is the source of truth so a mid-chain restart resumes.
    const { chainId, firstHop } = this.deps.createChain({
      hops: workers,
      originRef,
      promptPreview: prompt,
    });
    const spec = buildChainHopSpec({
      id: randomUUID(),
      chainId,
      worker: firstHop,
      prompt,
      originRef,
    });
    await this.deps.enqueueDispatch(spec);
    this.logger.info(
      { chainId, from: caller.channelRef, hops: workers.length, firstHop, originRef },
      "seam-mcp chain started"
    );
    return textResult(
      `Started chain ${chainId} across ${workers.length} hop(s): ${workers.join(" → ")}. ` +
        `Each hop's output feeds the next; the final result will be delivered into thread ${originRef}.`
    );
  }

  private async toolPeek(args: Record<string, unknown>): Promise<McpToolResult> {
    const thread = requireString(args, "thread");
    const rawCount = typeof args.count === "number" ? args.count : 20;
    const count = Math.max(1, Math.min(50, Math.floor(rawCount)));
    if (!this.deps.peekThread) {
      return textResult("peek is not supported on this platform.", true);
    }
    const msgs = await this.deps.peekThread(thread, count);
    if (msgs.length === 0) {
      return textResult(`Thread ${thread} has no readable messages.`);
    }
    const rendered = msgs
      .slice(-count)
      .map((m) => `${m.authorIsBot ? "🤖" : "👤"} ${m.text}`)
      .join("\n");
    return textResult(`Recent messages in thread ${thread}:\n\n${rendered}`);
  }

  /** Schedule a one-shot wake for the calling thread (#59). Self-scope by
   *  construction — the wake is armed for the token-resolved caller, never a
   *  caller-supplied thread. All loop-safety validation lives behind
   *  `scheduleWake` so the MCP and fence paths enforce it identically. */
  private toolScheduleWake(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): McpToolResult {
    if (!this.deps.scheduleWake) {
      return textResult("wakes are not supported on this deployment.", true);
    }
    const prompt = requireString(args, "prompt");
    const reason = optionalString(args, "reason") ?? "";
    const delaySeconds = typeof args.delaySeconds === "number" ? args.delaySeconds : NaN;
    const result = this.deps.scheduleWake(caller, { delaySeconds, reason, prompt });
    if (!result.ok) {
      return textResult(`Wake not scheduled: ${result.error}`, true);
    }
    this.logger.info(
      { wakeId: result.wakeId, thread: caller.channelRef, fireAtUtc: result.fireAtUtc },
      "seam-mcp schedule_wake armed"
    );
    return textResult(
      `Wake ${result.wakeId} scheduled — this thread will resume at ${result.fireAtUtc} with your prompt ` +
        `replayed as a live turn. It fires once; call schedule_wake again during that turn to continue a loop.`
    );
  }

  /** Cancel a pending wake owned by the calling thread (#59). */
  private toolCancelWake(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): McpToolResult {
    if (!this.deps.cancelWake) {
      return textResult("wakes are not supported on this deployment.", true);
    }
    const wakeId = requireString(args, "wakeId");
    const removed = this.deps.cancelWake(caller, wakeId);
    return removed
      ? textResult(`Wake ${wakeId} cancelled.`)
      : textResult(`No pending wake ${wakeId} found in this thread (already fired, cancelled, or not yours).`, true);
  }

  /**
   * Read-only config introspection (#58 P1). Reports the calling thread's
   * effective agent/model/effort/cwd/permission AND which layer won for each,
   * plus the schedules/presets visible here. Self-scope only (D3): a caller may
   * describe its OWN thread; naming another thread is refused as a privileged
   * capability that this read-only phase does not grant. The caller is resolved
   * from the X-Seam-Session token (never a caller-supplied id), so a thread
   * cannot read another thread's config.
   */
  private toolConfigDescribe(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): McpToolResult {
    if (!this.deps.describeConfig) {
      return textResult("config introspection is not supported on this deployment.", true);
    }
    const scope = optionalString(args, "scope");
    if (
      scope &&
      scope !== "self" &&
      scope !== caller.channelRef &&
      scope !== caller.id
    ) {
      return textResult(
        `Refused: describing another thread's config is a privileged capability that is not ` +
          `available here. You can only describe your own thread (${caller.channelRef}). ` +
          `Requested scope: "${scope}".`,
        true
      );
    }

    const d = this.deps.describeConfig(caller);
    const line = (label: string, value: string, source: string) =>
      `• ${label.padEnd(11)} ${value}  (from ${source})`;
    const lines = [
      `Effective configuration for thread ${d.channelRef}${d.locked ? " 🔒 (locked — read-only over MCP)" : ""}:`,
      line("agent:", d.agent.value, d.agent.source),
      line("model:", d.model.value, d.model.source),
      line("effort:", d.effort.value ?? "(none)", d.effort.source),
      line("cwd:", d.cwd.value, d.cwd.source),
      line("permission:", d.permission.value, d.permission.source),
    ];
    if (d.effortIgnoredNote) lines.push(`⚠ ${d.effortIgnoredNote}`);

    const entities = this.deps.listConfigEntities?.(caller);
    if (entities) {
      lines.push("", `Scheduled prompts (${entities.schedules.length}):`);
      if (entities.schedules.length === 0) {
        lines.push("  (none)");
      } else {
        for (const s of entities.schedules) {
          lines.push(
            `  • ${s.name} — ${s.cron} ${s.timezone}` +
              `${s.enabled ? "" : " [disabled]"}` +
              `${s.nextRunUtc ? ` — next ${s.nextRunUtc}` : ""}`
          );
        }
      }
      lines.push("", `Presets visible here (${entities.presets.length}):`);
      if (entities.presets.length === 0) {
        lines.push("  (none)");
      } else {
        for (const p of entities.presets) {
          const bits = [p.agentId, p.model].filter(Boolean).join(" / ");
          lines.push(`  • ${p.name} [${p.scope}]${bits ? ` — ${bits}` : ""}`);
        }
      }
    }

    return textResult(lines.join("\n"));
  }
}

/** Build the per-session `mcpServers` entry that points a session at the shared
 *  seam-MCP server and carries its identifying token. */
export function buildSeamMcpServerEntry(port: number, token: string): McpServer {
  const headers: HttpHeader[] = [{ name: "X-Seam-Session", value: token }];
  return {
    type: "http",
    name: "seam-mcp",
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
  };
}

// --- small helpers ---------------------------------------------------------

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method: string;
  params?: {
    protocolVersion?: unknown;
    name?: unknown;
    arguments?: unknown;
    [k: string]: unknown;
  };
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}
interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return v;
}
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim() === "") return undefined;
  return v;
}
function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty array of strings`);
  }
  const out = v.map((s) => (typeof s === "string" ? s.trim() : ""));
  if (out.some((s) => s === "")) {
    throw new Error(`"${key}" must contain only non-empty strings`);
  }
  return out;
}

function headerValue(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) return h[0];
  return h;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // Guard against a runaway body — tool args are small.
      if (size > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
