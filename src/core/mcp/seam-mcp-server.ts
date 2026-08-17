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
import type { ConfigMutationInput } from "../config-mutation.js";

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
    req: { delaySeconds: number; reason: string; prompt: string; fireOnStartup?: boolean }
  ) => { ok: true; wakeId: string; fireAtUtc: string } | { ok: false; error: string };
  /** Cancel a pending wake owned by the calling thread (#59). Returns whether a
   *  row was removed. Undefined ⇒ wakes are unsupported on this deployment. */
  cancelWake?: (record: SessionRecord, id: string) => boolean;
  /** Register a bridge-evaluated watch for the calling thread (#60). Returns the
   *  new watch id + expiry, or an error string surfaced verbatim. Undefined ⇒
   *  watches are unsupported on this deployment. */
  createWatch?: (
    record: SessionRecord,
    req: {
      kind: string;
      spec: string;
      match?: string;
      intervalSeconds: number;
      prompt: string;
      reason?: string;
      mode?: string;
      maxFires?: number;
      expiresInSeconds: number;
    }
  ) =>
    | { ok: true; watchId: string; expiresAtUtc: string; intervalSeconds: number }
    | { ok: false; error: string };
  /** Cancel a pending watch owned by the calling thread (#60). Returns whether a
   *  row was removed. Undefined ⇒ watches are unsupported on this deployment. */
  cancelWatch?: (record: SessionRecord, id: string) => boolean;
  /** List pending watches owned by the calling thread (#60, D7). Undefined ⇒
   *  watches are unsupported on this deployment. */
  listWatches?: (record: SessionRecord) => Array<{
    id: string;
    kind: string;
    spec: string;
    intervalSeconds: number;
    mode: string;
    fireCount: number;
    maxFires: number;
    expiresAtUtc: string;
    reason: string;
  }>;
  /**
   * Is the calling thread's channel locked? (#58 D2). The MUTATION tool refuses
   * outright when this is true — enforced HERE, in the tool layer, so the lock
   * is a second entry point's own gate, not something only the slash layer
   * checks. Undefined ⇒ treated as never-locked (deployments without presets).
   */
  isChannelLocked?: (record: SessionRecord) => boolean;
  /**
   * Propose a config mutation for the calling thread (#58 P2/P3). The platform
   * validates + computes the diff, renders a confirm CARD, and applies only on a
   * human click (D5) — this call returns as soon as the card is posted (or with
   * a validation refusal). Undefined ⇒ config mutation is unsupported.
   */
  proposeConfig?: (
    record: SessionRecord,
    input: ConfigMutationInput
  ) => Promise<ConfigProposeOutcome>;
  /**
   * The reusable thread-compaction primitive (run premium pipeline → seed a new
   * session → rebind the thread if active). Its PRESENCE gates the `compact`
   * tool — undefined ⇒ compaction is unsupported on this deployment. Delivery is
   * non-blocking: the tool ENQUEUES a `kind:"compact"` dispatch and returns
   * immediately; the DispatchWatcher invokes THIS SAME method (minutes later,
   * off the caller's turn) and posts the result into the target thread. Wired in
   * index.ts to `orchestrator.compactThread`, like `scheduleWake`/`proposeConfig`.
   */
  compactThread?: (
    record: SessionRecord,
    opts?: { source?: "session" | "discord"; onProgress?: (m: string) => void }
  ) => Promise<{
    newSessionId: string;
    originalSessionId: string;
    wasActive: boolean;
    reportMarkdown: string;
    stats: { chunks: number };
  }>;
}

/** Result of asking the platform to propose a config change. */
export interface ConfigProposeOutcome {
  /** True ⇒ a confirmation card was posted; false ⇒ refused (see `error`). */
  ok: boolean;
  /** Agent-facing refusal reason when `ok` is false. */
  error?: string;
  /** One-line summary of the proposed change (when `ok`). */
  summary?: string;
  fields?: ProposedFieldView[];
  warnings?: string[];
  /** True when applying will restart the session (stated so it's not a surprise). */
  restartsSession?: boolean;
}

/** A rendered diff line for the agent's confirmation text. */
export interface ProposedFieldView {
  label: string;
  before: string;
  after: string;
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
        stream: {
          type: "boolean",
          description:
            "Live-stream the worker's output into its thread as it runs, behind a start indicator (default true). " +
            "Set false for a quiet run that posts one clean artifact at the end (the indicator still shows). " +
            "Your report-back always gets the full result either way.",
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
        stream: {
          type: "boolean",
          description:
            "Live-stream the delivery into the destination thread as it runs, behind a start indicator " +
            "(default true). Set false for a quiet run that posts one clean artifact at the end.",
        },
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
    name: "compact",
    description:
      "Compact a thread's conversation: run the premium multi-agent compaction pipeline over its history " +
      "and seed a FRESH, resumable session from the assembled summary, rebinding the thread to it. " +
      "NON-DESTRUCTIVE — the original session is preserved (recoverable / deletable from the session manager). " +
      "Targets YOUR OWN thread by default; pass `thread` (a snowflake) to compact another teammate's thread " +
      "(the actor→target is audited). Runs for MINUTES, so it does NOT block your turn: this returns immediately " +
      "and the result card posts into the target thread when the pipeline finishes. Use when a thread's context " +
      "has grown large and you want to reclaim room without losing the pinned facts / recent verbatim window. " +
      "`source` picks the history read: \"session\" (the raw session history, default) or \"discord\" " +
      "(reconstructed from the full Discord thread — use when the session history is thin or unavailable).",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "Thread id (snowflake) to compact. Defaults to YOUR thread.",
        },
        source: {
          type: "string",
          enum: ["session", "discord"],
          description: "Which history to compact: \"session\" (default) or \"discord\" (full thread reconstruction).",
        },
      },
      required: [],
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
      "`reason` is a short human-facing note shown when the wake fires (not an instruction). " +
      "Set `onStartup: true` instead to fire on the NEXT process boot (after a restart/redeploy) rather than at " +
      "a wall-clock time — `delaySeconds` is then ignored. Use it to resume work right after a restart. Still " +
      "one-shot: it fires once on the next boot, then it's gone.",
    inputSchema: {
      type: "object",
      properties: {
        delaySeconds: {
          type: "number",
          description: "How many seconds from now to wake (min 60, max 604800 = 7 days). Ignored when onStartup is true.",
        },
        reason: {
          type: "string",
          description: "Short human-facing reason, shown when the wake fires (telemetry, not instructions).",
        },
        prompt: {
          type: "string",
          description: "The prompt to replay to yourself on waking. Write it to stand on its own.",
        },
        onStartup: {
          type: "boolean",
          description: "Fire on the next process boot instead of at a wall-clock time. When true, delaySeconds is ignored.",
        },
      },
      required: ["prompt"],
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
    name: "watch_create",
    description:
      "Register a CONDITION the bridge checks cheaply on an interval and re-enters THIS thread ONLY when it " +
      "actually fires — instead of you waking every N minutes to check for yourself (which burns a whole turn " +
      "each time). The bridge evaluates the predicate; you are woken with a live turn (carrying your `prompt` " +
      "plus the captured event) only on a real event.\n" +
      "Sources: `file` (fires when a path's existence/size/mtime changes), `http` (GET the url; fire on a " +
      "status match via match=\"status:200\", a body regex via match=\"<regex>\", or any change by default), " +
      "`command` (run an allowlisted command; fire on non-empty stdout — a PRIVILEGED source, often disabled). " +
      "Default `mode:\"once\"` fires once then deletes; `mode:\"each\"` re-fires up to `maxFires`. " +
      "`expiresInSeconds` is REQUIRED — on expiry you are told so, so a wait never silently evaporates. " +
      "Prefer this over schedule_wake for \"wait until X\"; write predicates that also match FAILURE states, " +
      "not just the happy path, or a crash leaves the watch silent.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["file", "http", "command"],
          description: "What to observe: file path | http url | command (command may be disabled).",
        },
        spec: {
          type: "string",
          description: "The target: a file path, a URL, or a command string.",
        },
        match: {
          type: "string",
          description:
            "http only. \"status:NNN\" fires on that status; any other string is a body regex. Omit for change-detection.",
        },
        intervalSeconds: {
          type: "number",
          description: "How often to check. Floored per kind (file 2s, command 10s, http 30s).",
        },
        prompt: {
          type: "string",
          description: "The prompt replayed to you when the watch fires. Write it to stand on its own.",
        },
        reason: {
          type: "string",
          description: "Short human-facing note shown when it fires (telemetry, not instructions).",
        },
        mode: {
          type: "string",
          enum: ["once", "each"],
          description: "\"once\" (default): fire once then delete. \"each\": re-fire up to maxFires.",
        },
        maxFires: {
          type: "number",
          description: "For mode=\"each\": stop after this many fires (default 10).",
        },
        expiresInSeconds: {
          type: "number",
          description: "REQUIRED — auto-expire after this many seconds; on expiry you are notified.",
        },
      },
      required: ["kind", "spec", "intervalSeconds", "prompt", "expiresInSeconds"],
    },
  },
  {
    name: "watch_cancel",
    description:
      "Cancel a pending watch you registered in THIS thread, by its id (as returned by watch_create). " +
      "The row IS the poll — cancelling stops the checking entirely.",
    inputSchema: {
      type: "object",
      properties: {
        watchId: { type: "string", description: "The watch id to cancel." },
      },
      required: ["watchId"],
    },
  },
  {
    name: "watch_list",
    description:
      "List the pending watches you have registered in THIS thread (id, kind, target, interval, mode, " +
      "fire count, expiry) so you can review or cancel them. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
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
  {
    name: "config_propose",
    description:
      "Propose a configuration change for YOUR OWN thread. This does NOT apply anything: it posts a " +
      "confirmation card in your thread showing the exact before→after diff, and a human must click " +
      "Apply before it takes effect. Provide EXACTLY ONE of `session`, `preset`, or `channelPreset`.\n" +
      "- session: your thread's own runtime config (agent, model, effort, cwd, permission).\n" +
      "- preset: create/update a reusable specialist preset in this thread's project (usable as a handoff target).\n" +
      "- channelPreset: this channel's shared preset in channel-presets.json (agent/model/cwd/effort/rider). " +
      "May be disabled by the deployment; the `locked` flag can NEVER be changed.\n" +
      "You can only ever change your OWN thread/channel — cross-thread config is not available here, and a " +
      "locked channel refuses every change.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "object",
          description: "Tier A — your thread's own session config.",
          properties: {
            agent: { type: "string", description: "Agent profile id." },
            model: { type: "string", description: "Model id." },
            effort: { type: "string", description: "Reasoning effort level (agent-dependent)." },
            cwd: { type: "string", description: "Working directory." },
            permission: {
              type: "string",
              enum: ["always", "ask", "deny"],
              description: "Permission policy.",
            },
          },
        },
        preset: {
          type: "object",
          description: "Tier B — a preset in this thread's project scope.",
          properties: {
            name: { type: "string", description: "Preset name (required)." },
            agent: { type: "string" },
            model: { type: "string" },
            effort: { type: "string" },
            description: { type: "string" },
            permission: { type: "string", enum: ["always", "ask", "deny"] },
          },
          required: ["name"],
        },
        channelPreset: {
          type: "object",
          description:
            "Tier C — this channel's shared preset (channel-presets.json). Applies to every thread " +
            "under the channel. `locked` is not settable.",
          properties: {
            agent: { type: "string" },
            model: { type: "string" },
            cwd: { type: "string" },
            effort: { type: "string" },
            rider: { type: "string", description: "Extra per-turn harness-preamble rule." },
          },
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
  "- watch_create(kind, spec, intervalSeconds, prompt, expiresInSeconds, ...): register a CONDITION the bridge",
  "  checks cheaply and re-enters you ONLY when it fires (file/http/command source). Prefer this over a",
  "  schedule_wake poll loop for \"wait until X\" — the bridge does the checking, so a turn is spent only on a",
  "  real event, not on repeatedly producing \"no\". Always set expiresInSeconds; watch_list / watch_cancel manage them.",
  "- compact(thread?, source?): run the premium multi-agent compaction pipeline on a thread (yours by default,",
  "  or a named teammate's) and reseed it from the summary — non-destructive (the original session is kept). It",
  "  runs for minutes and does NOT block you: it returns at once and the result posts into the target thread.",
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
        case "compact":
          return rpcResult(id, await this.toolCompact(record, args));
        case "schedule_wake":
          return rpcResult(id, this.toolScheduleWake(record, args));
        case "cancel_wake":
          return rpcResult(id, this.toolCancelWake(record, args));
        case "watch_create":
          return rpcResult(id, this.toolWatchCreate(record, args));
        case "watch_cancel":
          return rpcResult(id, this.toolWatchCancel(record, args));
        case "watch_list":
          return rpcResult(id, this.toolWatchList(record));
        case "config_describe":
          return rpcResult(id, this.toolConfigDescribe(record, args));
        case "config_propose":
          return rpcResult(id, await this.toolConfigPropose(record, args));
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
    const stream = optionalBool(args, "stream");
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
      ...(stream !== undefined ? { stream } : {}),
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
    const stream = optionalBool(args, "stream");
    const dispatchId = randomUUID();
    const spec: DispatchSpec = {
      id: dispatchId,
      target: to,
      prompt: content,
      session: "live",
      returnTo: caller.channelRef,
      kind: "forward",
      correlationId: dispatchId,
      ...(stream !== undefined ? { stream } : {}),
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

  /**
   * Trigger thread compaction (agent-callable premium compaction). Self-scoped
   * by default — the caller is the token-resolved thread; an explicit `thread`
   * arg targets another teammate's thread (still allowed, but the actor→target
   * is ledgered by the dispatch handler). Delivery is NON-BLOCKING: we enqueue a
   * `kind:"compact"` dispatch (NOT an inject-turn) carrying the caller as
   * `returnTo` for the ledger, and return at once — the DispatchWatcher runs the
   * pipeline and posts the result card into the target thread minutes later.
   */
  private async toolCompact(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.compactThread) {
      return textResult("compaction is not supported on this deployment.", true);
    }
    const target = optionalString(args, "thread") ?? caller.channelRef;
    const source = optionalString(args, "source") === "discord" ? "discord" : "session";
    const dispatchId = randomUUID();
    const spec: DispatchSpec = {
      id: dispatchId,
      target,
      // Compact has no injected prompt; carry a readable preview so the ledger
      // and the start indicator show what's running (schema requires non-empty).
      prompt: `[seam-compact] compact thread ${target} (${source} history)`,
      session: "live",
      kind: "compact",
      compactSource: source,
      // The caller thread is the actor — recorded actor→target by the handler.
      returnTo: caller.channelRef,
      correlationId: dispatchId,
      createdUtc: new Date().toISOString(),
    };
    await this.deps.enqueueDispatch(spec);
    const self = target === caller.channelRef;
    this.logger.info(
      { dispatchId, actor: caller.channelRef, target, source, self },
      "seam-mcp compact enqueued"
    );
    return textResult(
      `Compaction started for thread ${target}${self ? " (your own thread)" : ""} ` +
        `using ${source} history (dispatch ${dispatchId}). It runs for a few minutes and does not block you — ` +
        `the result card will post into thread ${target} when it finishes.`
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
    const fireOnStartup = args.onStartup === true;
    const delaySeconds = typeof args.delaySeconds === "number" ? args.delaySeconds : NaN;
    const result = this.deps.scheduleWake(caller, { delaySeconds, reason, prompt, fireOnStartup });
    if (!result.ok) {
      return textResult(`Wake not scheduled: ${result.error}`, true);
    }
    this.logger.info(
      { wakeId: result.wakeId, thread: caller.channelRef, fireAtUtc: result.fireAtUtc, fireOnStartup },
      "seam-mcp schedule_wake armed"
    );
    return textResult(
      fireOnStartup
        ? `Wake ${result.wakeId} scheduled — this thread will resume on the next process boot with your prompt ` +
            `replayed as a live turn. It fires once on startup; call schedule_wake again during that turn to continue.`
        : `Wake ${result.wakeId} scheduled — this thread will resume at ${result.fireAtUtc} with your prompt ` +
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

  /** Register a bridge-evaluated watch for the calling thread (#60). Self-scope
   *  by construction — the watch is armed for the token-resolved caller, never a
   *  caller-supplied thread. All validation (including the command source gate,
   *  D8) lives behind `createWatch` so the MCP and fence paths enforce it
   *  identically. */
  private toolWatchCreate(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): McpToolResult {
    if (!this.deps.createWatch) {
      return textResult("watches are not supported on this deployment.", true);
    }
    const kind = requireString(args, "kind");
    const spec = requireString(args, "spec");
    const prompt = requireString(args, "prompt");
    const intervalSeconds = typeof args.intervalSeconds === "number" ? args.intervalSeconds : NaN;
    const expiresInSeconds = typeof args.expiresInSeconds === "number" ? args.expiresInSeconds : NaN;
    const result = this.deps.createWatch(caller, {
      kind,
      spec,
      ...(optionalString(args, "match") ? { match: optionalString(args, "match")! } : {}),
      intervalSeconds,
      prompt,
      ...(optionalString(args, "reason") ? { reason: optionalString(args, "reason")! } : {}),
      ...(optionalString(args, "mode") ? { mode: optionalString(args, "mode")! } : {}),
      ...(typeof args.maxFires === "number" ? { maxFires: args.maxFires } : {}),
      expiresInSeconds,
    });
    if (!result.ok) {
      return textResult(`Watch not registered: ${result.error}`, true);
    }
    this.logger.info(
      { watchId: result.watchId, thread: caller.channelRef, kind, spec, expiresAt: result.expiresAtUtc },
      "seam-mcp watch_create armed"
    );
    return textResult(
      `Watch ${result.watchId} registered — the bridge will check this ${kind} condition every ` +
        `${result.intervalSeconds}s and re-enter this thread with a live turn ONLY when it fires. ` +
        `It auto-expires at ${result.expiresAtUtc} (you'll be told if it expires without firing).`
    );
  }

  /** Cancel a pending watch owned by the calling thread (#60). */
  private toolWatchCancel(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): McpToolResult {
    if (!this.deps.cancelWatch) {
      return textResult("watches are not supported on this deployment.", true);
    }
    const watchId = requireString(args, "watchId");
    const removed = this.deps.cancelWatch(caller, watchId);
    return removed
      ? textResult(`Watch ${watchId} cancelled — the bridge stopped checking.`)
      : textResult(`No pending watch ${watchId} found in this thread (already fired, cancelled, or not yours).`, true);
  }

  /** List pending watches owned by the calling thread (#60, D7). */
  private toolWatchList(caller: SessionRecord): McpToolResult {
    if (!this.deps.listWatches) {
      return textResult("watches are not supported on this deployment.", true);
    }
    const watches = this.deps.listWatches(caller);
    if (watches.length === 0) {
      return textResult("No pending watches in this thread.");
    }
    const lines = watches.map((w) => {
      const fires = w.mode === "each" ? ` [${w.fireCount}/${w.maxFires} fires]` : "";
      const reason = w.reason ? ` — ${w.reason}` : "";
      return `• ${w.id} — ${w.kind}:${w.spec} every ${w.intervalSeconds}s (${w.mode}), expires ${w.expiresAtUtc}${fires}${reason}`;
    });
    return textResult(`Pending watches in this thread (${watches.length}):\n${lines.join("\n")}`);
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

  /**
   * Propose a config mutation for the calling thread (#58 P2/P3).
   *
   * LOCK ENFORCEMENT POINT (D2). This is the tool layer's OWN gate, deliberately
   * re-derived here rather than inherited from the slash layer's
   * `LOCK_EXEMPT_SUBCOMMANDS` (abort/cancel/steer). That exemption list exists
   * because redirecting or stopping a RUNNING agent is not reconfiguration —
   * `steer` is exempt for exactly that reason, and it is already its own separate
   * tool here. `config_propose` is PURE reconfiguration, so it grants ZERO lock
   * exemptions: in a locked channel it is refused outright, before any proposal
   * is built, and the refusal cannot be talked around because the lock is read
   * from the channel-presets file (the source of truth), never from the model's
   * argument. The scope is the token-resolved caller (D3) — a caller cannot name
   * another thread, so this can only ever propose changes to its OWN config.
   */
  private async toolConfigPropose(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.proposeConfig) {
      return textResult("config mutation is not supported on this deployment.", true);
    }
    // Strictly read-only over MCP for a locked channel — no exceptions, no
    // override tool (D2). Enforced HERE in the tool layer.
    if (this.deps.isChannelLocked?.(caller)) {
      this.logger.warn(
        { session: caller.id, channel: caller.parentRef },
        "seam-mcp config_propose refused: channel is locked"
      );
      return textResult(
        `🔒 Refused: this channel is locked, so its configuration is strictly read-only over MCP. ` +
          `This cannot be overridden by asking — unlocking is a deliberate out-of-band act ` +
          `(edit the presets file and redeploy). No change was proposed.`,
        true
      );
    }

    const input: ConfigMutationInput = {};
    if (args.session && typeof args.session === "object") {
      input.session = args.session as ConfigMutationInput["session"];
    }
    if (args.preset && typeof args.preset === "object") {
      input.preset = args.preset as ConfigMutationInput["preset"];
    }
    if (args.channelPreset && typeof args.channelPreset === "object") {
      input.channelPreset = args.channelPreset as ConfigMutationInput["channelPreset"];
    }

    const outcome = await this.deps.proposeConfig(caller, input);
    if (!outcome.ok) {
      return textResult(outcome.error ?? "Proposal refused.", true);
    }
    const lines = [
      `Proposed — a confirmation card was posted in your thread. Nothing changes until a human clicks Apply.`,
      outcome.summary ? `\n${outcome.summary}` : "",
    ];
    for (const f of outcome.fields ?? []) {
      lines.push(`  • ${f.label}: ${f.before} → ${f.after}`);
    }
    for (const w of outcome.warnings ?? []) {
      lines.push(`  ⚠ ${w}`);
    }
    if (outcome.restartsSession) {
      lines.push(`  (applying this will restart the session so it takes effect)`);
    }
    return textResult(lines.filter(Boolean).join("\n"));
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
/** Read an optional boolean arg. Absent / non-boolean ⇒ undefined (so the
 *  caller can apply its own default). */
function optionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
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
