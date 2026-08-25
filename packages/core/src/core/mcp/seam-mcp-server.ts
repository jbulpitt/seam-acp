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
import { isRestrictedParticipant, PARTICIPANT_CONFIG_REFUSAL } from "../../config.js";
import { formatHostPrefixed, parseDispatchWorker } from "../location.js";

/** Read-only entities visible to the calling thread (schedules + presets),
 *  returned by `config_describe` alongside the effective config. A FULL
 *  projection (#69): the schedule entries carry every field an agent needs to
 *  answer "what does my morning schedule do?" — most importantly `promptText`,
 *  the actual content — and the `id` needed to target a `config_propose`
 *  schedule edit. Kept as its own projection so the server stays decoupled from
 *  the store's row types. */
export interface ConfigEntities {
  schedules: Array<{
    /** The stable id — the handle `config_propose {schedule:{action:"update"…}}` targets. */
    id: string;
    name: string;
    /** The actual prompt the job runs — the field the thin listing omitted (#69). */
    promptText: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    /** "isolated" (throwaway session) or "live" (runs in this thread). */
    sessionMode: "isolated" | "live";
    /** Isolated-mode overrides (meaningless/ignored in live mode). */
    model: string | null;
    cwd: string | null;
    targetChannel: string | null;
    outputType: "card" | "messages";
    catchupSeconds: number;
    /** Reference files re-sent every run (names only — bytes live on disk). */
    attachments: string[];
    lastStatus: string | null;
    lastRunUtc: string | null;
    nextRunUtc: string | null;
  }>;
  presets: Array<{
    name: string;
    scope: "project" | "global";
    agentId: string | null;
    model: string | null;
    effort: string | null;
    permission: string | null;
    cwd: string | null;
    description: string | null;
    statusCardStyle?: string | null;
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

/** One sibling thread in the caller's channel, as the `threads` tool renders it
 *  (#73). A minimal projection over the store record + router runtime state +
 *  platform metadata, so the server stays decoupled from all three. Entries are
 *  returned newest-activity first. */
export interface ThreadEntry {
  /** The thread id every other coordination tool takes as its first arg
   *  (handoff/forward/steer/peek/send/…). This is the session's channelRef. */
  id: string;
  /** The platform thread name (e.g. "✨ HIST 2300") — how the agent picks the
   *  right teammate. Null when the platform could not resolve it. */
  name: string | null;
  /** True for the CALLER'S OWN thread, so it never hands off to itself. */
  isSelf: boolean;
  /** The teammate's effective agent / model / cwd (as `describeConfig` resolves
   *  them — the same precedence startRuntime applies). */
  agent: string;
  model: string;
  cwd: string;
  /** Whether a live turn is CURRENTLY running in that thread — the load-bearing
   *  field: choose `send` (non-interrupting) over `steer`/`handoff`
   *  (interrupting) when a teammate is busy. Derived from the control-plane
   *  runtime even when the agent process lives on a bridge. */
  busy: boolean;
  /** Host binding (D10). Omit ⇒ `local`. Rendered as `agentId@location`. */
  location?: string;
  /** Host emoji prefix (local 🏠 + each paired bridge). */
  hostEmoji?: string;
  /** Liveness of the underlying thread: "active" (addressable now), "archived"
   *  (bound but dormant — still addressable, wakes on delivery), or "gone" (the
   *  platform confirmed it deleted — do NOT address it). Marked, never silently
   *  dropped, so a stale id is visible rather than mysterious. */
  status: "active" | "archived" | "gone";
  /** ISO-8601 of the thread's last activity (the session's updated_utc). */
  lastActivityUtc: string;
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
   * Discover the sibling threads in the CALLER'S OWN channel (#73), newest
   * activity first. Composed in index.ts from `listSessionsByParent` (the SQL
   * per-channel query, so a quiet-but-bound thread is never lost to a global
   * newest-N cap), `router.isBusy`/`describeConfig`, and the platform's
   * thread-name / live-state lookups. Self-scoped by construction — the channel
   * is `record.parentRef`, never a caller-supplied arg. Undefined ⇒ thread
   * discovery is unsupported on this deployment.
   */
  listThreads?: (record: SessionRecord) => Promise<ThreadEntry[]>;
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
  /** Rename the CALLER'S OWN thread. Free-form name. Undefined ⇒ unsupported. */
  renameThread?: (
    record: SessionRecord,
    name: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
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
   * Config-mutation admins (#71). The propose gate consults this ONLY in a LOCKED
   * channel: a proposal is allowed when the caller's CURRENT-turn speaker id (see
   * `currentSpeakerId`) is in this set. Undefined ⇒ opt-out — a locked channel
   * refuses every proposal, exactly as before. Never relaxes the `locked`
   * immutability (that refusal lives in ConfigMutationService and stays).
   */
  configAdminUserIds?: ReadonlySet<string>;
  /**
   * Chat-only participants (#74). The propose gate refuses a restricted
   * participant OUTRIGHT (locked or unlocked) when the CURRENT-turn speaker
   * id is in this set AND not in `configAdminUserIds` (admin wins). Undefined
   * ⇒ opt-out, today's behavior: anyone who passes the lock gate may propose.
   */
  configParticipantUserIds?: ReadonlySet<string>;
  /**
   * The harness-stamped SPEAKER id of the caller session's CURRENT turn (#57 D4
   * trust anchor — NOT a user-editable display name). Undefined when speaker
   * identity is off, or the turn has no human speaker (dispatched/scheduled), so
   * the propose gate has no trustworthy id and MUST keep refusing in a locked
   * channel (never fail open). Undefined ⇒ treated as "no admin speaker".
   */
  currentSpeakerId?: (record: SessionRecord) => string | undefined;
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
  /**
   * Agent inbox PRODUCER (#61): push a pull-only message into a TARGET thread's
   * durable inbox, attributed to the caller. It must NOT enqueue a dispatch or
   * start a turn — the target reads it on its next `poll_inbox`. Returns how many
   * messages are now queued for the target, or an error string surfaced verbatim.
   * Undefined ⇒ the inbox is unsupported on this deployment. Wired in index.ts to
   * `orchestrator.pushInbox`, like `scheduleWake`.
   */
  pushInbox?: (
    caller: SessionRecord,
    to: string,
    message: string,
    priority?: boolean
  ) => { ok: true; queued: number } | { ok: false; error: string };
  /**
   * Preemptive interrupt (#67): CANCEL the target thread's in-flight dispatched
   * turn and issue `message` as a NEW directive NOW — the agent-facing twin of
   * the `/seam steer now:true` human path. Unlike `pushInbox` (pull-only, queued)
   * this reuses the steer-now canceller (graceful ACP cancel escalating to force
   * when wedged), SUPPRESSES the cancelled handoff's report-back so its
   * partial/stale output is never delivered, and re-prompts the SAME thread as a
   * fresh turn. `fresh:false` keeps the target's session/context (it pivots off
   * partial work); `fresh:true` resets the session first (clean slate). If the
   * target has no active turn it degrades to immediate delivery so the directive
   * is never silently lost. Undefined ⇒ interrupts are unsupported on this
   * deployment. Wired in index.ts to `orchestrator.interruptRedirect`.
   */
  interruptRedirect?: (
    caller: SessionRecord,
    to: string,
    message: string,
    fresh: boolean
  ) => Promise<
    | { ok: true; cancelled: "idle" | "cancelled" | "killed"; fresh: boolean; dispatchId: string }
    | { ok: false; error: string }
  >;
  /**
   * Agent inbox CONSUMER (#61): drain the calling thread's OWN inbox
   * (deliver-once-then-delete), returning the queued messages coalesced/ordered
   * (oldest first). Self-scope by construction — the caller is the token-resolved
   * record, never a caller-supplied id, so a thread can never drain another's
   * inbox. Undefined ⇒ the inbox is unsupported on this deployment.
   */
  drainInbox?: (record: SessionRecord) => InboxMessageView[];
  /**
   * Publish a frozen choice card in the calling thread (#91). Same helper as
   * the `seam-choice` fence. Participant authors are refused; injected turns
   * may author. Undefined ⇒ choice cards unsupported.
   */
  createChoice?: (
    record: SessionRecord,
    spec: unknown
  ) => Promise<
    | {
        ok: true;
        choiceId: string;
        messageId: string;
        ingestToken?: string;
        ingestUrl?: string;
      }
    | { ok: false; error: string }
  >;
  /** Cancel an open choice card in the calling (authoring) thread (#91). */
  cancelChoice?: (
    record: SessionRecord,
    choiceId: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Declare the HTTP body for an ingest-triggered turn (#92). First call wins. */
  submitResult?: (
    record: SessionRecord,
    value: unknown
  ) => { ok: true; dispatchId: string } | { ok: false; error: string };
  /** Mint a headless HTTP ingest endpoint (#95). No Discord card. */
  createIngest?: (
    record: SessionRecord,
    spec: unknown
  ) => Promise<
    | { ok: true; ingestId: string; ingestToken: string; ingestUrl: string }
    | { ok: false; error: string }
  >;
  /** Revoke a headless ingest endpoint minted from this thread. */
  cancelIngest?: (
    record: SessionRecord,
    ingestId: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Mint a Gemini Live voice-channel session (#98). Fire-and-forget. */
  createLiveHelp?: (
    record: SessionRecord,
    spec: unknown
  ) => Promise<
    | { ok: true; liveId: string; guildId: string; channelName: string }
    | { ok: false; error: string }
  >;
  /** Hang up a live-help call minted from this thread. */
  cancelLiveHelp?: (
    record: SessionRecord,
    liveId: string
  ) => { ok: true } | { ok: false; error: string };
}

/** One drained inbox message, as `poll_inbox` renders it. Kept as a minimal
 *  projection so the server stays decoupled from the store's row type. */
export interface InboxMessageView {
  fromRef: string | null;
  body: string;
  /** Priority steering flag (#66). True ⇒ `poll_inbox` renders it FIRST and
   *  distinctly as an "abandon your current plan and reorient" item. */
  priority: boolean;
  createdUtc: string;
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
        watchFeedback: {
          type: "boolean",
          description:
            "Tell the worker to watch its inbox for your mid-task steering (default false). When true, its prompt " +
            "gets a standing instruction to call `poll_inbox` after each discrete step/item (and at least every 1–2 minutes); " +
            "you then push feedback with `send` while it runs and it absorbs the guidance WITHOUT cancelling or restarting " +
            "its turn (cooperative, history intact).",
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
    name: "threads",
    description:
      "Discover the addressable teammate threads in YOUR OWN channel, newest-activity first — the way " +
      "to TURN A TASK INTO A THREAD ID before calling any other coordination tool (handoff/forward/steer/" +
      "peek/send/chain all take a thread id you must first obtain here). Each entry reports: `id` (pass this " +
      "verbatim as the thread arg elsewhere), `name` (the human thread title — how you pick the right " +
      "teammate), `isSelf` (true for YOUR OWN thread — never hand off to yourself), the teammate's " +
      "`agent`/`model`/`cwd` (agent is `agentId@location` with host emoji), `status` (active | archived | gone), `lastActivityUtc`, and `busy`. " +
      "`busy` IS LOAD-BEARING for choosing HOW to reach a teammate: when a thread is busy:true a live turn " +
      "is running, so prefer `send` (PULL-ONLY — it waits in the inbox and never interrupts) unless you " +
      "truly need to preempt, in which case use `steer` or `send(interrupt:true)`; when busy:false the " +
      "teammate is idle, so `handoff`/`forward` (which START a turn) land cleanly. Read-only and " +
      "self-scoped: it ALWAYS lists your own channel (resolved from your session, never an argument) and " +
      "works even in a locked channel (metadata only, no message content). A `status:\"gone\"` entry is a " +
      "dead thread — do not address it.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description:
            "Optional. Only \"self\" (or your own thread/channel id) is accepted — you can only ever list " +
            "YOUR OWN channel's threads. Naming another channel is refused. Defaults to your own channel.",
        },
      },
      required: [],
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
    name: "rename_thread",
    description:
      "Rename YOUR OWN Discord thread. Free-form `name` (not slug-enforced). Self-scoped: the " +
      "target is always the calling session's thread, never another teammate. Restricted " +
      "participants cannot rename.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "New thread title (max 100 characters).",
        },
      },
      required: ["name"],
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
    name: "poll_inbox",
    description:
      "Drain YOUR OWN inbox: read and REMOVE every message other agents (or the system) have left for you " +
      "via `send`, coalesced into one block — or \"No new messages.\" when it is empty. Deliver-once: polled " +
      "messages are deleted, so a second poll returns nothing new. You only ever see messages addressed to " +
      "YOU (self-scope — never another thread's inbox). Delivery is pull-only, so call this to pick up " +
      "asynchronous notes left for you without waiting on a fresh chat turn — mid-turn, or at the start of one. " +
      "Some messages are flagged PRIORITY: they are surfaced FIRST and mean you should abandon your current plan " +
      "and reorient to them, even mid-task; ordinary notes you merely fold into your current plan.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "send",
    description:
      "Leave a message in another thread's INBOX for that agent to read on its NEXT poll_inbox. " +
      "PULL-ONLY delivery: this does NOT start or interrupt a turn and does NOT enqueue a dispatch — the " +
      "message simply waits in the target's inbox until that agent polls for it. THIS IS THE KEY DIFFERENCE " +
      "FROM forward/handoff, which both START A TURN in the target right now: use forward/handoff when you " +
      "need the target to act immediately, and `send` when you only want to leave a note for whenever it next " +
      "checks. `to` is the target thread id; the message is recorded as coming FROM you. " +
      "Set `priority: true` to flag the message URGENT: it means \"the target should ABANDON its current plan " +
      "and reorient to this at its next poll\" (the target sees it FIRST, framed distinctly), versus a normal " +
      "note (priority omitted/false) it merely absorbs into its current plan. Priority is STILL pull-only and " +
      "queued — it does NOT cancel or interrupt the target's turn; it only changes how urgently the message " +
      "reads when polled. " +
      "Set `interrupt: true` for the PREEMPTIVE tier: instead of queuing, it CANCELS the target's in-flight " +
      "turn right now and issues `message` as a fresh directive in that same thread — use it when the target " +
      "is actively working the wrong thing and cannot wait for its next poll. `interrupt` SUPERSEDES " +
      "`priority`: if both are set the interrupt path is taken and `priority` is ignored (an interrupt is " +
      "already preemptive). With `interrupt`, `fresh` chooses context: `fresh:false` (default) keeps the " +
      "target's session so it pivots off its partial work; `fresh:true` resets the session first for a clean " +
      "slate. The cancelled handoff delivers NO result back to whoever it was reporting to. If the target has " +
      "no active turn, the directive is still delivered immediately (never lost).",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target thread id whose inbox to leave the message in." },
        message: { type: "string", description: "The message to queue for the target agent." },
        priority: {
          type: "boolean",
          description:
            "When true, flag the message urgent: the target should abandon its current plan and reorient " +
            "to it at its next poll_inbox. Default false (a normal note). Still pull-only — never interrupts a " +
            "turn. Ignored when `interrupt:true` is also set (interrupt supersedes priority).",
        },
        interrupt: {
          type: "boolean",
          description:
            "When true, PREEMPT the target: cancel its in-flight turn now and issue `message` as a fresh " +
            "directive in that thread, rather than queuing to its inbox. Default false. Supersedes `priority`. " +
            "The cancelled turn's report-back is suppressed. If the target has no active turn, the directive is " +
            "delivered immediately anyway.",
        },
        fresh: {
          type: "boolean",
          description:
            "Only meaningful with `interrupt:true`. false (default) keeps the target's session/context so it " +
            "pivots off its partial work; true resets the session first for a clean slate.",
        },
      },
      required: ["to", "message"],
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
      "Apply before it takes effect. Provide EXACTLY ONE of `session`, `preset`, `channelPreset`, `threadPreset`, or `schedule`.\n" +
      "- session: your thread's own runtime config (agent, model, effort, cwd, permission, statusCardStyle, simpleCardGif).\n" +
      "- preset: create/update a reusable specialist preset in this thread's project (usable as a handoff target).\n" +
      "- threadPreset: THIS thread's own preset in channel-presets.json (agent/model/cwd/effort/rider/statusCardStyle/simpleCardGif/detached/location/tts). " +
      "Applies to this thread ONLY and overrides the channel preset — the right scope for a per-thread rider. " +
      "`detached:true` stops treating this thread as a session (no bot replies; does not delete history). " +
      "`tts:true` speaks each completed turn as an ogg attachment (default off).\n" +
      "- channelPreset: this channel's shared preset in channel-presets.json (agent/model/cwd/effort/rider/statusCardStyle/simpleCardGif). " +
      "Applies to EVERY thread under the channel (statusCardStyle and simpleCardGif are inherited live at render time). May be disabled by the deployment; `locked` can NEVER be changed.\n" +
      "- schedule: create/update/enable/disable/delete a scheduled prompt for THIS thread. Translate the " +
      "user's natural-language cadence into a standard cron expression (e.g. \"every weekday at 7am\" → " +
      "\"0 7 * * 1-5\"); the card echoes the parsed cadence AND the resolved next run time so a timezone " +
      "mistake is visible before Apply. An invalid cron or timezone is refused before anything is written. " +
      "NOTE: attachments (reference files) CANNOT be managed here — their bytes come from Discord uploads " +
      "(`/seam schedule add-file`); everything else about a schedule can.\n" +
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
            mode: {
              type: "string",
              description: "ACP mode id (what `/seam mode` sets). Empty string clears it.",
            },
            availableTools: {
              type: "array",
              items: { type: "string" },
              description: "Tool allowlist (`/seam tools allow`). Empty array = all tools allowed.",
            },
            excludedTools: {
              type: "array",
              items: { type: "string" },
              description: "Tool blocklist (`/seam tools exclude`). Empty array = none excluded.",
            },
            statusCardStyle: {
              type: "string",
              enum: ["full", "simple"],
              description:
                "Per-turn status-card layout. \"full\" is the default (repo/model/action/effort). " +
                "\"simple\" is compact (state + brand icon + latest thought + elapsed + window %). " +
                "Empty string clears back to default full.",
            },
            simpleCardGif: {
              type: "boolean",
              description:
                "Random curated GIF thumbnail on the simple status card. true = on, false = off. " +
                "Only the simple card shows it. Session overlay wins over thread/channel presets.",
            },
          },
        },
        preset: {
          type: "object",
          description:
            "Tier B — a preset in this thread's project scope. Default action creates/updates; " +
            "action:\"delete\" removes the named preset (confirm card + audit, recoverable from the trail).",
          properties: {
            action: {
              type: "string",
              enum: ["upsert", "delete"],
              description: "\"upsert\" (default) creates/updates; \"delete\" removes the named preset.",
            },
            name: { type: "string", description: "Preset name (required)." },
            agent: { type: "string" },
            model: { type: "string" },
            effort: { type: "string" },
            description: { type: "string" },
            permission: { type: "string", enum: ["always", "ask", "deny"] },
            repoPath: {
              type: "string",
              description: "Working directory for this preset worker. Empty string clears it.",
            },
            toolsAllow: {
              type: "array",
              items: { type: "string" },
              description: "Tool allowlist for the preset worker. Empty array clears it.",
            },
            toolsExclude: {
              type: "array",
              items: { type: "string" },
              description: "Tool blocklist for the preset worker. Empty array clears it.",
            },
            instructions: {
              type: "string",
              description:
                "The preset worker's identity/personality — injected as a <seam-worker-identity> " +
                "block when the preset runs as a handoff/dispatch worker. Empty string clears it.",
            },
            statusCardStyle: {
              type: "string",
              enum: ["full", "simple"],
              description:
                "Status-card layout baked into this preset. Empty string clears it so apply " +
                "does not touch the thread's style.",
            },
          },
          required: ["name"],
        },
        threadPreset: {
          type: "object",
          description:
            "Tier C — THIS thread's own preset (channel-presets.json `threads`). Applies to this " +
            "thread only and overrides the channel preset per-field. `locked` is not settable. " +
            "`detached` is a raw boolean (not a wrapped value): true = this thread is not a session.",
          properties: {
            agent: { type: "string" },
            model: { type: "string" },
            cwd: { type: "string" },
            effort: { type: "string" },
            rider: { type: "string", description: "Extra per-turn harness-preamble rule for this thread." },
            statusCardStyle: {
              type: "string",
              enum: ["full", "simple"],
              description:
                "Thread-preset status-card layout. Overrides the channel preset; session `/seam config card` still wins. Empty string clears it.",
            },
            simpleCardGif: {
              type: "boolean",
              description:
                "Thread-preset simple-card GIF. Overrides the channel preset; session `/seam config gif` still wins.",
            },
            detached: {
              type: "boolean",
              description:
                "If true, this thread is detached: allowlisted users can chat but the bot will not " +
                "reply and will not bind a session. false re-attaches (next message binds/resumes). " +
                "Does not delete history. `locked` remains unsettable.",
            },
            location: {
              type: "string",
              description:
                "Host this thread's agent runs on: \"local\" (default) or a paired bridge id. " +
                "Omit / empty / \"local\" ⇒ loopback. Changing location starts a fresh session on that host.",
            },
            tts: {
              type: "boolean",
              description:
                "If true, after each completed turn seam synthesizes the visible reply " +
                "with Gemini TTS and attaches an ogg. false / omit = off (the default). " +
                "Thread-only — does not restart the session.",
            },
            ttsVoice: {
              type: "string",
              description:
                "Gemini prebuilt TTS voice name (Kore, Puck, …). Empty string clears " +
                "back to the env default. Samples play on /seam config tts Voice…",
            },
            ttsPace: {
              type: "string",
              enum: ["slow", "natural", "fast"],
              description: "Spoken pacing (director's note). natural / empty clears.",
            },
            ttsStyle: {
              type: "string",
              enum: ["neutral", "warm", "clear"],
              description: "Spoken style (director's note). neutral / empty clears.",
            },
          },
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
            statusCardStyle: {
              type: "string",
              enum: ["full", "simple"],
              description:
                "Channel-wide status-card layout. Every thread inherits this live at render time unless it has its own overlay. Empty string clears it.",
            },
            simpleCardGif: {
              type: "boolean",
              description:
                "Channel-wide simple-card GIF thumbnail. Inherited live unless a thread/session overlay wins.",
            },
          },
        },
        schedule: {
          type: "object",
          description:
            "Tier D — a scheduled prompt bound to THIS thread. `create` needs name + promptText + cron; " +
            "update/enable/disable/delete need `id` (from config_describe). Attachments are not settable here.",
          properties: {
            action: {
              type: "string",
              enum: ["create", "update", "enable", "disable", "delete"],
              description: "Which operation to propose.",
            },
            id: {
              type: "string",
              description: "Target schedule id (required for update/enable/disable/delete; from config_describe).",
            },
            name: { type: "string", description: "Human name for the schedule (required on create)." },
            promptText: { type: "string", description: "The prompt the job runs each fire (required on create)." },
            cron: {
              type: "string",
              description:
                "Standard cron expression — translate the NL cadence into this (\"every weekday at 7am\" → " +
                "\"0 7 * * 1-5\"). Hard-validated; a bad expression is refused before persisting.",
            },
            timezone: {
              type: "string",
              description: "IANA timezone, e.g. \"America/Chicago\". Defaults to the deployment default on create.",
            },
            sessionMode: {
              type: "string",
              enum: ["isolated", "live"],
              description:
                "\"isolated\" (default) runs each fire in a throwaway session; \"live\" runs it as a turn in " +
                "THIS thread (model/cwd/targetChannel/outputType are then ignored).",
            },
            model: { type: "string", description: "Isolated-mode model override. null = thread default." },
            cwd: { type: "string", description: "Isolated-mode working directory. null = thread default." },
            targetChannel: {
              type: "string",
              description: "Isolated-mode: channel/thread id to post output to. null = this thread.",
            },
            outputType: {
              type: "string",
              enum: ["card", "messages"],
              description: "Isolated-mode: render results as status cards or plain messages.",
            },
            catchupSeconds: {
              type: "number",
              description: "Retained for compatibility. A missed next-run always fires once on boot; this window is no longer consulted.",
            },
          },
          required: ["action"],
        },
      },
      required: [],
    },
  },
  {
    name: "create_choice",
    description:
      "Publish a frozen click-card in THIS thread. One click emits one prompt (live / isolated / thread snowflake). " +
      "Participants cannot create cards. Options freeze at publish — no edit-in-place. Prefer the agent guide " +
      "docs/agent-guides/interactive-prompts.md over this blurb.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card title (≤256)." },
        body: { type: "string", description: "Optional text on the card. Not emitted." },
        maxClicks: { type: "number", description: "Total successful claims (default 1, cap 100). Always one click per user." },
        targetUserId: { type: "string", description: "Optional Discord user id who alone may click." },
        defaultTarget: {
          type: "object",
          description: 'Default destination if an option omits target. { type: "live"|"isolated"|"thread", threadId? }.',
        },
        options: {
          type: "array",
          description: '1–25 options: { label, kind: "prompt"|"custom", payload?, target? }. prompt requires payload.',
        },
        select: {
          type: "object",
          description:
            'Multi-select: dropdown + Confirm, one combined prompt. { min?, max? } (min default 1, max default options.length). All options must be kind:"prompt". Cannot combine with maxClicks>1 (v1).',
        },
        ingress: {
          type: ["boolean", "object"],
          description:
            "If true or an object, mint an HTTP ingest token. POST /ingest with Bearer token is a custom submit. See docs/agent-guides/interactive-prompts.md.",
        },
      },
      required: ["title", "options"],
    },
  },
  {
    name: "cancel_choice",
    description:
      "Cancel an open choice card you published in THIS thread. Participants cannot cancel. Exhausted/cancelled cards have disabled buttons.",
    inputSchema: {
      type: "object",
      properties: {
        choiceId: { type: "string", description: "Id returned by create_choice." },
      },
      required: ["choiceId"],
    },
  },
  {
    name: "submit_result",
    description:
      "Declare the HTTP body for an ingest-triggered turn. First successful call wins. Optional resultSchema on the card is validated. See docs/agent-guides/interactive-prompts.md.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
  },
  {
    name: "create_ingest",
    description:
      "Mint a headless HTTP ingest endpoint (no Discord card). Token shown once. Isolated silent scoring; retries unlimited unless uniqueStudent. preset is resolved at fire (not snapshot). See docs/agent-guides/interactive-prompts.md.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for /seam workflows (≤80)." },
        wrapper: { type: "string", description: "Frozen instructions merged ahead of each POST body." },
        resultSchema: { type: "object", description: "Optional JSON Schema for submit_result." },
        corsOrigins: { type: "array", items: { type: "string" } },
        uniqueStudent: { type: "boolean", description: "If true, same studentId cannot submit twice. Default false." },
        notifyThread: { type: "string", description: "Optional Discord snowflake to copy working into. Omitted = no Discord." },
        preset: {
          type: "string",
          description:
            "Project preset name. Resolved at each POST (agent/model/effort/cwd + instructions). Cannot combine with agent/model/effort/cwd.",
        },
        cwd: { type: "string", description: "Override spawn cwd. Default: this thread's repo. Not with preset." },
        agent: { type: "string", description: "Override agent id. Default: this thread's agent. Not with preset." },
        model: { type: "string", description: "Not with preset." },
        effort: { type: "string", description: "Not with preset." },
      },
      required: ["name"],
    },
  },
  {
    name: "cancel_ingest",
    description:
      "Revoke a headless ingest endpoint you minted in THIS thread. In-flight jobs finish; new POSTs 409.",
    inputSchema: {
      type: "object",
      properties: {
        ingestId: { type: "string", description: "Id returned by create_ingest." },
      },
      required: ["ingestId"],
    },
  },
  {
    name: "create_live_help",
    description:
      "Join a Discord voice channel as Gemini Live (audio↔audio tutoring). Parallel to this text session — does not block. Restricted participants cannot mint. See docs/agent-guides/live-help.md.",
    inputSchema: {
      type: "object",
      properties: {
        voiceChannelId: {
          type: "string",
          description: "Discord voice channel snowflake to join. Required.",
        },
        system: {
          type: "string",
          description: "Packed lesson / student / problem instruction for Gemini. Required.",
        },
        historySummary: {
          type: "string",
          description: "Optional short text seed (not a file library).",
        },
        notifyThread: {
          type: "string",
          description: "Optional Discord snowflake for input/output transcripts. Omitted = no transcript posts.",
        },
        preset: {
          type: "string",
          description: "Optional project preset name, stored for end-of-call report-back. Not the Live model.",
        },
      },
      required: ["voiceChannelId", "system"],
    },
  },
  {
    name: "cancel_live_help",
    description: "Hang up a live-help Gemini voice call you minted from THIS thread.",
    inputSchema: {
      type: "object",
      properties: {
        liveId: { type: "string", description: "Id returned by create_live_help." },
      },
      required: ["liveId"],
    },
  },
] as const;

const INSTRUCTIONS = [
  "You are one teammate in a shared workspace of parallel agent threads. These tools let you",
  "coordinate with the others without leaving your own turn:",
  "",
  "- threads(): list the teammate threads in YOUR channel (id, name, agent/model, busy, status). START",
  "  HERE — every tool below takes a thread id, and this is the only way to discover one. `busy` tells you",
  "  HOW to reach a teammate: busy ⇒ prefer send (pull-only, won't interrupt); idle ⇒ handoff/forward land",
  "  a turn cleanly. The entry marked isSelf is YOUR OWN thread — never hand off to it.",
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
  "- rename_thread(name): rename YOUR OWN thread (free-form title). Restricted participants cannot.",
  "- create_choice / cancel_choice / submit_result: frozen click-cards; HTTP ingest + declared JSON result. Participants cannot author. See docs/agent-guides/interactive-prompts.md.",
  "- create_ingest / cancel_ingest: headless HTTP endpoint (no Discord card). Isolated silent scoring, retries unlimited. Token once. Same POST /ingest + submit_result.",
  "- create_live_help / cancel_live_help: Gemini joins a Discord voice channel (audio↔audio). Parallel to this text session. Restricted participants cannot mint. See docs/agent-guides/live-help.md.",
  "- watch_create(kind, spec, intervalSeconds, prompt, expiresInSeconds, ...): register a CONDITION the bridge",
  "  checks cheaply and re-enters you ONLY when it fires (file/http/command source). Prefer this over a",
  "  schedule_wake poll loop for \"wait until X\" — the bridge does the checking, so a turn is spent only on a",
  "  real event, not on repeatedly producing \"no\". Always set expiresInSeconds; watch_list / watch_cancel manage them.",
  "- compact(thread?, source?): run the premium multi-agent compaction pipeline on a thread (yours by default,",
  "  or a named teammate's) and reseed it from the summary — non-destructive (the original session is kept). It",
  "  runs for minutes and does NOT block you: it returns at once and the result posts into the target thread.",
  "- send(to, message): leave a PULL-ONLY message in another thread's inbox for its NEXT poll_inbox. Unlike",
  "  forward/handoff (which start a turn in the target now), send does NOT start or interrupt a turn — the",
  "  message simply waits until that agent polls. Use it to reach a teammate without forcing a new turn.",
  "- poll_inbox(): drain YOUR OWN inbox — read and remove the messages other agents left you via send",
  "  (deliver-once, self-scope). Call it to pick up asynchronous notes without waiting on a fresh chat turn.",
  "- config_describe(): report YOUR thread's effective config AND the FULL definition of every scheduled",
  "  prompt (incl. its promptText + id) and preset visible here — the way to answer \"what does my morning",
  "  schedule do?\" and to find the `id` a schedule edit needs.",
  "- config_propose(schedule|session|preset|channelPreset): propose a change (a human confirms via card).",
  "  The `schedule` branch creates/updates/enables/disables/deletes a scheduled prompt from a natural-language",
  "  cadence — translate it to cron; the card shows the parsed cadence + resolved next run before Apply.",
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

  /** Public so the health server can proxy `/mcp` for remote (bridge) agents. */
  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return this.handle(req, res);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || mcpPathname(req.url) !== "/mcp") {
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

    const token = sessionTokenFromRequest(req);
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
      // rather than guess a thread. Split the message so reconnect bugs
      // (header dropped vs rotated registry) are distinguishable in agent logs.
      const reason = token
        ? "unauthorized: unknown X-Seam-Session token"
        : "unauthorized: missing X-Seam-Session token";
      this.logger.warn({ method: "tools/call", hasToken: Boolean(token) }, reason);
      return rpcError(id, -32001, reason);
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
        case "threads":
          return rpcResult(id, await this.toolThreads(record, args));
        case "chain":
          return rpcResult(id, await this.toolChain(record, args));
        case "compact":
          return rpcResult(id, await this.toolCompact(record, args));
        case "schedule_wake":
          return rpcResult(id, this.toolScheduleWake(record, args));
        case "rename_thread":
          return rpcResult(id, await this.toolRenameThread(record, args));
        case "cancel_wake":
          return rpcResult(id, this.toolCancelWake(record, args));
        case "watch_create":
          return rpcResult(id, this.toolWatchCreate(record, args));
        case "watch_cancel":
          return rpcResult(id, this.toolWatchCancel(record, args));
        case "watch_list":
          return rpcResult(id, this.toolWatchList(record));
        case "poll_inbox":
          return rpcResult(id, this.toolPollInbox(record));
        case "send":
          return rpcResult(id, await this.toolSend(record, args));
        case "config_describe":
          return rpcResult(id, this.toolConfigDescribe(record, args));
        case "config_propose":
          return rpcResult(id, await this.toolConfigPropose(record, args));
        case "create_choice":
          return rpcResult(id, await this.toolCreateChoice(record, args));
        case "cancel_choice":
          return rpcResult(id, await this.toolCancelChoice(record, args));
        case "submit_result":
          return rpcResult(id, this.toolSubmitResult(record, args));
        case "create_ingest":
          return rpcResult(id, await this.toolCreateIngest(record, args));
        case "cancel_ingest":
          return rpcResult(id, await this.toolCancelIngest(record, args));
        case "create_live_help":
          return rpcResult(id, await this.toolCreateLiveHelp(record, args));
        case "cancel_live_help":
          return rpcResult(id, this.toolCancelLiveHelp(record, args));
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
    const watchFeedback = optionalBool(args, "watchFeedback");
    const parsed = parseDispatchWorker(worker);
    const toThread = parsed.kind === "thread";
    const dispatchId = randomUUID();

    // A thread-id worker runs live in that teammate's own session; a preset name
    // (or `agentId@location`) spins up a stateless specialist. Isolated workers
    // post visibility to the caller's thread. `name@location` carries the host
    // so DispatchWatcher can bind the spawn to that bridge (#84 remainder).
    const spec: DispatchSpec = {
      id: dispatchId,
      target: toThread ? parsed.threadId : caller.channelRef,
      prompt,
      session: toThread ? "live" : "isolated",
      ...(toThread ? {} : { preset: parsed.name }),
      ...(parsed.kind === "named" && parsed.location ? { location: parsed.location } : {}),
      returnTo,
      kind: "handoff",
      correlationId: dispatchId,
      ...(stream !== undefined ? { stream } : {}),
      ...(watchFeedback ? { watchFeedback: true } : {}),
      createdUtc: new Date().toISOString(),
    };
    await this.deps.enqueueDispatch(spec);
    this.logger.info(
      { dispatchId, from: caller.channelRef, worker, toThread, returnTo, watchFeedback },
      "seam-mcp handoff enqueued"
    );
    return textResult(
      `Handed off to ${toThread ? `thread ${worker}` : `preset "${worker}"`} ` +
        `(dispatch ${dispatchId}). Its result will be reported back into thread ${returnTo}.` +
        (watchFeedback
          ? ` It will poll its inbox for your feedback — push mid-task steering with send(to: "${spec.target}", …).`
          : "")
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

  /**
   * Discover the addressable sibling threads in the caller's OWN channel (#73).
   * Self-scope by construction (D3, matching config_describe): the channel is
   * `caller.parentRef` — resolved from the token-minted record, NEVER a
   * caller-supplied arg. The optional `scope` may only echo "self" or the
   * caller's own thread/channel id; naming another channel is refused as a
   * cross-channel read this tool does not grant. Read-only metadata only, so it
   * is ALLOWED in a locked channel (same posture as peek — no message content is
   * exposed). The heavy lifting (per-channel SQL query, busy derivation, config
   * resolution, platform name/live-state lookups) lives behind `listThreads`,
   * wired in index.ts; this method owns scope enforcement + rendering.
   */
  private async toolThreads(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.listThreads) {
      return textResult("thread discovery is not supported on this deployment.", true);
    }
    const scope = optionalString(args, "scope");
    if (
      scope &&
      scope !== "self" &&
      scope !== caller.channelRef &&
      scope !== caller.id &&
      scope !== caller.parentRef
    ) {
      return textResult(
        `Refused: listing another channel's threads is a privileged capability that is not ` +
          `available here. You can only list your own channel. Requested scope: "${scope}".`,
        true
      );
    }
    // A thread's siblings live under its parent channel. Without a parent this
    // session is not a thread under a channel, so there are no teammates to list.
    if (!caller.parentRef) {
      return textResult(
        "This session is not a thread under a channel, so it has no sibling threads to discover."
      );
    }

    const entries = await this.deps.listThreads(caller);
    if (entries.length === 0) {
      return textResult("No threads found in your channel.");
    }

    const lines = [`Threads in your channel (${entries.length}, newest first):`, ""];
    for (const t of entries) {
      const addressable = looksLikeThreadId(t.id);
      const name = t.name ?? "(unnamed)";
      const flags = [
        t.isSelf ? "YOU" : null,
        t.busy ? "busy" : "idle",
        t.status !== "active" ? t.status : null,
        addressable ? null : "not addressable",
      ].filter(Boolean);
      const loc = t.location ?? "local";
      const agentAt = formatHostPrefixed(t.agent, loc, t.hostEmoji ?? "");
      const cfg = [agentAt.trim(), t.model].filter(Boolean).join(" / ");
      lines.push(
        `• ${name} — id ${t.id} [${flags.join(", ")}]` +
          (cfg ? `\n    ${cfg}${t.cwd ? ` @ ${t.cwd}` : ""}` : "") +
          `\n    last active ${t.lastActivityUtc}`
      );
    }
    lines.push(
      "",
      "To reach a teammate: use its `id` above. If it is busy, prefer send (pull-only, won't interrupt); " +
        "if idle, handoff/forward start a turn directly. Never hand off to the entry marked YOU."
    );
    return textResult(lines.join("\n"));
  }

  /** Rename the caller's own thread. Self-scoped; restricted participants refused. */
  private async toolRenameThread(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.renameThread) {
      return textResult("thread rename is not supported on this deployment.", true);
    }
    const speakerIdForTier = this.deps.currentSpeakerId?.(caller);
    if (
      speakerIdForTier != null &&
      isRestrictedParticipant(
        speakerIdForTier,
        this.deps.configParticipantUserIds,
        this.deps.configAdminUserIds
      )
    ) {
      this.logger.warn(
        { session: caller.id, channel: caller.parentRef, speakerId: speakerIdForTier },
        "seam-mcp rename_thread refused: speaker is a restricted participant"
      );
      return textResult(PARTICIPANT_CONFIG_REFUSAL, true);
    }
    const name = requireString(args, "name").slice(0, 100);
    const result = await this.deps.renameThread(caller, name);
    if (!result.ok) {
      return textResult(`Could not rename this thread: ${result.error}`, true);
    }
    this.logger.info({ thread: caller.channelRef, name }, "seam-mcp rename_thread");
    return textResult(`Renamed this thread to ${name}.`);
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

  private async toolCreateChoice(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.createChoice) {
      return textResult("choice cards are not supported on this deployment.", true);
    }
    const result = await this.deps.createChoice(caller, args);
    if (!result.ok) return textResult(`Choice card not published: ${result.error}`, true);
    this.logger.info(
      { choiceId: result.choiceId, thread: caller.channelRef },
      "seam-mcp create_choice published"
    );
    let msg = `Choice card ${result.choiceId} published (message ${result.messageId}). One click emits one prompt.`;
    if (result.ingestToken) {
      const url = result.ingestUrl ?? "/ingest";
      msg += ` HTTP ingest: POST ${url} with Authorization: Bearer ${result.ingestToken} (token shown once). Declare the HTTP body with submit_result.`;
    }
    return textResult(msg);
  }

  private toolSubmitResult(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): McpToolResult {
    if (!this.deps.submitResult) {
      return textResult("submit_result is not supported on this deployment.", true);
    }
    const result = this.deps.submitResult(caller, args);
    return result.ok
      ? textResult(`Result submitted for dispatch ${result.dispatchId}.`)
      : textResult(result.error, true);
  }

  private async toolCreateIngest(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.createIngest) {
      return textResult("ingest endpoints are not supported on this deployment.", true);
    }
    const result = await this.deps.createIngest(caller, args);
    if (!result.ok) return textResult(`Ingest endpoint not created: ${result.error}`, true);
    this.logger.info(
      { ingestId: result.ingestId, thread: caller.channelRef },
      "seam-mcp create_ingest minted"
    );
    return textResult(
      `Ingest endpoint ${result.ingestId} minted. POST ${result.ingestUrl} with Authorization: Bearer ${result.ingestToken} (token shown once). Isolated silent scoring; declare the HTTP body with submit_result.`
    );
  }

  private async toolCancelIngest(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.cancelIngest) {
      return textResult("ingest endpoints are not supported on this deployment.", true);
    }
    const ingestId = requireString(args, "ingestId");
    const result = await this.deps.cancelIngest(caller, ingestId);
    return result.ok
      ? textResult(`Ingest endpoint ${ingestId} revoked.`)
      : textResult(result.error, true);
  }

  private async toolCreateLiveHelp(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.createLiveHelp) {
      return textResult("live help is not supported on this deployment.", true);
    }
    const result = await this.deps.createLiveHelp(caller, args);
    if (!result.ok) return textResult(`Live help not started: ${result.error}`, true);
    this.logger.info(
      { liveId: result.liveId, thread: caller.channelRef, vc: args.voiceChannelId },
      "seam-mcp create_live_help minted"
    );
    return textResult(
      `Live help ${result.liveId} joining **${result.channelName}** (guild ${result.guildId}). ` +
        `This text session is undisturbed. Hang up with cancel_live_help({ liveId: "${result.liveId}" }) ` +
        `or /seam workflows cancel-live.`
    );
  }

  private toolCancelLiveHelp(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): McpToolResult {
    if (!this.deps.cancelLiveHelp) {
      return textResult("live help is not supported on this deployment.", true);
    }
    const liveId = requireString(args, "liveId");
    const result = this.deps.cancelLiveHelp(caller, liveId);
    return result.ok
      ? textResult(`Live help ${liveId} hanging up.`)
      : textResult(result.error, true);
  }

  private async toolCancelChoice(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.deps.cancelChoice) {
      return textResult("choice cards are not supported on this deployment.", true);
    }
    const choiceId = requireString(args, "choiceId");
    const result = await this.deps.cancelChoice(caller, choiceId);
    return result.ok
      ? textResult(`Choice card ${choiceId} cancelled.`)
      : textResult(result.error, true);
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
   * Drain the calling thread's OWN inbox (#61). Self-scope by construction — the
   * owner is the token-resolved caller, never a caller-supplied id, so a thread
   * can only ever drain its own queue. Deliver-once: the store deletes the rows
   * it returns, so a second poll yields "No new messages." Messages are coalesced
   * into one framed block (oldest first) with each producer attributed.
   */
  private toolPollInbox(caller: SessionRecord): McpToolResult {
    if (!this.deps.drainInbox) {
      return textResult("the inbox is not supported on this deployment.", true);
    }
    const messages = this.deps.drainInbox(caller);
    if (messages.length === 0) {
      return textResult("No new messages.");
    }
    // Priority steering (#66): render urgent items FIRST and DISTINCTLY. A
    // priority message frames as an "abandon your current plan and reorient"
    // directive; normal messages keep the cooperative `[FEEDBACK from <from>]`
    // framing (#62) that a watchFeedback worker absorbs WITHOUT restarting. When
    // a single drain has both, priority items lead under a clear header.
    const priority = messages.filter((m) => m.priority);
    const normal = messages.filter((m) => !m.priority);

    const blocks: string[] = [];
    if (priority.length > 0) {
      const framed = priority
        .map(
          (m) =>
            `[PRIORITY — abandon your current plan and reorient to this]${
              m.fromRef ? ` (from ${m.fromRef})` : ""
            }: ${m.body}`
        )
        .join("\n\n");
      blocks.push(
        `⚠️ PRIORITY — the following ${
          priority.length === 1 ? "message overrides" : "messages override"
        } your current plan; stop and reorient to ${priority.length === 1 ? "it" : "them"} now:\n\n${framed}`
      );
    }
    if (normal.length > 0) {
      const framed = normal
        .map((m) => `[FEEDBACK from ${m.fromRef ?? "unknown"}]: ${m.body}`)
        .join("\n\n");
      blocks.push(
        `${framed}\n\n— incorporate into your current plan; you do not need to restart.`
      );
    }
    this.logger.info(
      { thread: caller.channelRef, count: messages.length, priority: priority.length },
      "seam-mcp poll_inbox drained"
    );
    return textResult(blocks.join("\n\n"));
  }

  /**
   * Leave a PULL-ONLY message in a target thread's inbox (#61), attributed to the
   * caller. Deliberately does NOT enqueue a dispatch or start a turn — that is
   * what `forward`/`handoff` are for; `send` reaches an agent WITHOUT forcing a
   * new turn, delivered on the target's next `poll_inbox`. The push + its ledger
   * row live behind `pushInbox` so this stays a thin, side-effect-free-of-turns
   * call.
   */
  private async toolSend(
    caller: SessionRecord,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const to = requireString(args, "to");
    const message = requireString(args, "message");
    const priority = optionalBool(args, "priority") ?? false;
    const interrupt = optionalBool(args, "interrupt") ?? false;
    const fresh = optionalBool(args, "fresh") ?? false;

    // #67: interrupt SUPERSEDES priority (an interrupt is already preemptive).
    // Route to the cancel-and-redirect path; the queued/priority inbox path
    // below is untouched (#61/#66 behavior) when interrupt is off.
    if (interrupt) {
      if (!this.deps.interruptRedirect) {
        return textResult("interrupt is not supported on this deployment.", true);
      }
      const res = await this.deps.interruptRedirect(caller, to, message, fresh);
      if (!res.ok) {
        return textResult(`Interrupt failed: ${res.error}`, true);
      }
      this.logger.info(
        { from: caller.channelRef, to, fresh, cancelled: res.cancelled, dispatchId: res.dispatchId },
        "seam-mcp interrupt redirected"
      );
      const cancelNote =
        res.cancelled === "idle"
          ? `The target had no active turn, so nothing was cancelled — your directive was delivered immediately anyway. `
          : res.cancelled === "killed"
            ? `The target's turn was wedged and had to be force-killed, then `
            : `Cancelled the target's in-flight turn, then `;
      return textResult(
        `🧭 Interrupted thread ${to}. ` +
          cancelNote +
          `issued your directive as a fresh turn there (${res.fresh ? "session RESET — clean slate" : "session KEPT — it pivots off its partial work"}). ` +
          `The interrupted handoff will deliver NO result back to whoever it was reporting to.`
      );
    }

    if (!this.deps.pushInbox) {
      return textResult("the inbox is not supported on this deployment.", true);
    }
    const result = this.deps.pushInbox(caller, to, message, priority);
    if (!result.ok) {
      return textResult(`Message not sent: ${result.error}`, true);
    }
    this.logger.info(
      { from: caller.channelRef, to, priority, queued: result.queued },
      "seam-mcp send queued"
    );
    return textResult(
      `Left a ${priority ? "PRIORITY " : ""}message in thread ${to}'s inbox (from ${caller.channelRef}). ` +
        `It will be delivered when that agent next calls poll_inbox — this did NOT start or interrupt a turn. ` +
        (priority
          ? `Flagged urgent: the target is asked to abandon its current plan and reorient to it at its next poll. `
          : ``) +
        `${result.queued} message(s) now queued there.`
    );
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
      line("card style:", d.statusCardStyle?.value ?? "full", d.statusCardStyle?.source ?? "default"),
      line("card gif:", d.simpleCardGif?.value ? "on" : "off", d.simpleCardGif?.source ?? "default"),
      line("detached:", d.detached.value ? "true" : "false", d.detached.source),
      line("tts:", d.tts.value ? "true" : "false", d.tts.source),
      line("tts voice:", d.ttsVoice.value ?? "(unset)", d.ttsVoice.source),
      line("tts pace:", d.ttsPace.value, d.ttsPace.source),
      line("tts style:", d.ttsStyle.value, d.ttsStyle.source),
      line("location:", d.location?.value ?? "local", d.location?.source ?? "default"),
    ];
    if (d.rider?.channel || d.rider?.thread) {
      lines.push(
        line("rider ch.:", d.rider.channel ?? "(none)", "channel preset"),
        line("rider th.:", d.rider.thread ?? "(none)", "thread preset")
      );
    }
    if (d.effortIgnoredNote) lines.push(`⚠ ${d.effortIgnoredNote}`);

    const entities = this.deps.listConfigEntities?.(caller);
    if (entities) {
      // FULL schedule definitions (#69): promptText + every field, so an agent
      // asked "what does my morning schedule do?" can actually answer, and has
      // the `id` it needs to edit/delete via config_propose.
      lines.push("", `Scheduled prompts (${entities.schedules.length}):`);
      if (entities.schedules.length === 0) {
        lines.push("  (none)");
      } else {
        for (const s of entities.schedules) {
          lines.push(
            `  • ${s.name} (${s.id})${s.enabled ? "" : " [disabled]"}`,
            `      when:   ${s.cron} ${s.timezone}${s.nextRunUtc ? ` — next ${s.nextRunUtc}` : ""}`,
            `      mode:   ${s.sessionMode}` +
              (s.sessionMode === "isolated"
                ? ` · model ${s.model ?? "(thread default)"} · cwd ${s.cwd ?? "(thread default)"}` +
                  ` · output ${s.outputType}${s.targetChannel ? ` → ${s.targetChannel}` : ""}` +
                  ` · catch-up ${s.catchupSeconds}s`
                : ""),
            `      prompt: ${oneLine(s.promptText, 400)}`
          );
          if (s.attachments.length > 0) {
            lines.push(`      files:  ${s.attachments.join(", ")}`);
          }
          const ran =
            s.lastRunUtc || s.lastStatus
              ? `${s.lastRunUtc ?? "?"}${s.lastStatus ? ` (${s.lastStatus})` : ""}`
              : "never run";
          lines.push(`      last:   ${ran}`);
        }
      }
      lines.push("", `Presets visible here (${entities.presets.length}):`);
      if (entities.presets.length === 0) {
        lines.push(
          "  none in this channel (presets are per-channel; a qualified name <channelId>/<preset> can target another channel's preset)."
        );
      } else {
        lines.push(
          "  Names are this parent channel's; another channel's preset is <channelId>/<name> (snowflake, not #name)."
        );
        for (const p of entities.presets) {
          const bits = [
            p.agentId ? `agent ${p.agentId}` : null,
            p.model ? `model ${p.model}` : null,
            p.effort ? `effort ${p.effort}` : null,
            p.permission ? `perm ${p.permission}` : null,
            p.statusCardStyle ? `card ${p.statusCardStyle}` : null,
            p.cwd ? `cwd ${p.cwd}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          lines.push(`  • ${p.name} [${p.scope}]${bits ? ` — ${bits}` : ""}`);
          if (p.description) lines.push(`      ${oneLine(p.description, 200)}`);
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
   * `LOCK_EXEMPT_SUBCOMMANDS` (cancel/steer). That exemption list exists
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
    // Participant gate (#74) — a DIFFERENT question from the lock. A restricted
    // participant is refused OUTRIGHT, locked or unlocked, before any proposal
    // is built. Keyed on the harness-stamped SPEAKER id (#57 D4), never a
    // display name. No trustworthy id ⇒ we cannot identify a participant, so
    // we do not refuse here (the lock gate below still never fails open).
    // Admin-who-is-also-participant is NOT restricted (admin wins).
    const speakerIdForTier = this.deps.currentSpeakerId?.(caller);
    if (
      speakerIdForTier != null &&
      isRestrictedParticipant(
        speakerIdForTier,
        this.deps.configParticipantUserIds,
        this.deps.configAdminUserIds
      )
    ) {
      this.logger.warn(
        { session: caller.id, channel: caller.parentRef, speakerId: speakerIdForTier },
        "seam-mcp config_propose refused: speaker is a restricted participant"
      );
      return textResult(PARTICIPANT_CONFIG_REFUSAL, true);
    }
    // Locked channel: read-only over MCP for EVERYONE by default (D2) — with one
    // opt-in exemption (#71). A config admin (SEAM_CONFIG_ADMIN_USER_IDS) may
    // propose without unlocking, but ONLY when the CURRENT turn's harness-stamped
    // speaker id (#57 D4 trust anchor, never a display name) is in that set. If
    // speaker identity is off — or this is a dispatched/scheduled turn with no
    // human speaker — `currentSpeakerId` is undefined, so we fall through to the
    // refusal and never fail open. The `locked` flag itself remains unsettable by
    // anyone (enforced in ConfigMutationService); this only relaxes WHO may
    // propose OTHER config in a locked channel.
    if (this.deps.isChannelLocked?.(caller)) {
      const speakerId = this.deps.currentSpeakerId?.(caller);
      const isAdmin =
        speakerId != null && (this.deps.configAdminUserIds?.has(speakerId) ?? false);
      if (!isAdmin) {
        this.logger.warn(
          { session: caller.id, channel: caller.parentRef, speakerId: speakerId ?? null },
          "seam-mcp config_propose refused: channel is locked (speaker is not a config admin)"
        );
        return textResult(
          `🔒 Refused: this channel is locked, so its configuration is strictly read-only over MCP. ` +
            `This cannot be overridden by asking — unlocking is a deliberate out-of-band act ` +
            `(edit the presets file and redeploy). No change was proposed.`,
          true
        );
      }
      this.logger.info(
        { session: caller.id, channel: caller.parentRef, speakerId },
        "seam-mcp config_propose: lock-immune config admin — proceeding in locked channel"
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
    if (args.threadPreset && typeof args.threadPreset === "object") {
      input.threadPreset = args.threadPreset as ConfigMutationInput["threadPreset"];
    }
    if (args.schedule && typeof args.schedule === "object") {
      input.schedule = args.schedule as ConfigMutationInput["schedule"];
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
export function buildSeamMcpServerEntry(
  port: number,
  token: string,
  opts?: { url?: string }
): McpServer {
  const headers: HttpHeader[] = [{ name: "X-Seam-Session", value: token }];
  return {
    type: "http",
    name: "seam-mcp",
    url: opts?.url ?? `http://127.0.0.1:${port}/mcp`,
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
/** Flatten a possibly-multiline string to a single trimmed line, clamped to
 *  `max` chars with an ellipsis. Used to render promptText/description inline in
 *  the config_describe listing without letting a long body blow up the output. */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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

/** Strip query + trailing slashes so `/mcp?seamSession=` and `/mcp/` still route. */
export function mcpPathname(url: string | undefined): string {
  const pathOnly = (url ?? "/").split("?")[0] ?? "/";
  const trimmed = pathOnly.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Header first, then Authorization Bearer, then ?seamSession= (reconnect clients that drop custom headers). */
export function sessionTokenFromRequest(req: {
  headers: http.IncomingHttpHeaders;
  url?: string;
}): string | undefined {
  const header = headerValue(req.headers[SEAM_SESSION_HEADER])?.trim();
  if (header) return header;
  const auth = headerValue(req.headers.authorization)?.trim();
  if (auth && /^bearer\s+/i.test(auth)) {
    const t = auth.replace(/^bearer\s+/i, "").trim();
    if (t) return t;
  }
  try {
    const q = new URL(req.url ?? "/", "http://mcp.local").searchParams.get("seamSession");
    return q?.trim() || undefined;
  } catch {
    return undefined;
  }
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
