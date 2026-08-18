/**
 * Types for `Orchestrator.injectTurn` — the single primitive for running an
 * agent turn **programmatically** (no Discord user message behind it).
 *
 * Three call paths grew independently — the scheduled-prompt runner, the
 * premium-compaction fan-out, and the normal live turn — and all bottom out at
 * `AgentRuntime.prompt()`. They differ only in (a) how the session is acquired,
 * (b) where output is routed, and (c) teardown. `injectTurn` owns that
 * lifecycle once so the seam-MCP work (handoff / forward / report-back) has one
 * entry point instead of three near-copies.
 *
 * The types live here rather than in `orchestrator.ts` so callers outside the
 * Discord platform layer can depend on the contract without importing the
 * 6.5k-line orchestrator.
 */

import type { AgentProfile } from "../agents/agent-profile.js";
import type { AgentEventHandler } from "../agents/agent-runtime.js";
import type { ISessionManager } from "../agents/session-manager.js";
import type { ChannelRef, MessageAttachment } from "../platforms/chat-adapter.js";
import type { SessionRecord } from "./types.js";

/** What the turn is being run *against*: a chat thread or a bound session. */
export type InjectTarget = ChannelRef | SessionRecord;

/** Discriminate the two `InjectTarget` shapes. `agentId` exists only on
 *  `SessionRecord`; `ChannelRef` is `{ platform, id, parentId? }`. */
export function isSessionRecord(target: InjectTarget): target is SessionRecord {
  return "agentId" in target;
}

export interface InjectTurnOptions {
  /**
   * How the ACP session is acquired.
   * - `"live"` — reuse the target's persistent session via
   *   `SessionRouter.getOrStartRuntime`. Nothing is torn down.
   * - `"isolated"` — spin up a fresh throwaway `AgentRuntime`, create a new
   *   session, and guarantee teardown (dispose + delete the temp session) in a
   *   `finally`, so the run never shows up in `/seam sessions`.
   */
  session: "live" | "isolated";

  /** Model for the turn. Isolated: passed to `newSession`. */
  model?: string;
  /** Reasoning effort for the turn (agent-specific scale). */
  effort?: string;
  /** Working directory. Required for `"isolated"`; falls back to the target
   *  record's `repoPath` when the target is a session. */
  cwd?: string;

  /**
   * Where captured output routes. Today that means files the agent emits
   * (`agent-file` events) are uploaded here. Defaults to the target when the
   * target is a `ChannelRef`; when it resolves to nothing, agent files are
   * dropped (which is what the compaction fan-out wants — its analysis runs
   * have no thread).
   */
  outputTo?: ChannelRef;

  /**
   * Opaque id threaded through to the result and the log bindings. Unused for
   * routing today — report-back correlation (#20) is what needs it.
   */
  correlationId?: string;

  /** Agent profile to run. Required when `target` is `null`; otherwise
   *  resolved from the target's session record. */
  profile?: AgentProfile;
  /** Session manager used to delete the throwaway session on teardown.
   *  Defaults to `profile.sessionManager`. */
  sessionManager?: ISessionManager;

  /** Attachments to send with the prompt. Empty/omitted ⇒ none. */
  attachments?: ReadonlyArray<MessageAttachment>;

  /** Wall-clock cap on the prompt. Omitted ⇒ no timeout (the compaction
   *  fan-out deliberately runs unbounded). */
  timeoutMs?: number;

  /** Drain the runtime's session-update queue before returning, so trailing
   *  text that arrived after the prompt RPC resolved is included in `text`. */
  awaitIdle?: boolean;

  /** Additional per-event handling, called after the primitive's own text
   *  capture and file routing. */
  onEvent?: AgentEventHandler;

  /** Extra bindings for this turn's child logger (e.g. `{ scheduled: "run" }`). */
  logContext?: Record<string, unknown>;

  /**
   * Fired as soon as the ACP session id is known — after `newSession()` for
   * isolated runs, or once the live runtime is acquired. Dispatch uses this
   * to persist the id on the ledger at the `running` transition so a crash
   * mid-turn is recoverable (#75). Must not be used for teardown.
   */
  onSession?: (sessionId: string) => void | Promise<void>;

  /**
   * Isolated-run resume (#76): `loadSession(resumeSessionId)` instead of
   * `newSession()`. The id is the one persisted on the ledger at the
   * `running` transition. Absent ⇒ today's fresh session.
   */
  resumeSessionId?: string;
}

export interface InjectTurnResult {
  /** Everything the agent emitted as `agent-text`, concatenated. Populated
   *  even on error/timeout — partial output is still output. */
  text: string;
  /** ACP stop reason, when the turn completed. */
  stopReason?: string;
  cancelled?: boolean;
  /** True when `timeoutMs` elapsed before the prompt resolved. */
  timedOut?: boolean;
  /** Human-readable failure reason. Absent on success. */
  error?: string;
  /** The original thrown value behind `error`, so callers that need to
   *  propagate the *same* error (not a re-wrapped one) can rethrow it. */
  cause?: unknown;
  /** ACP session id the turn ran in (the throwaway one, for isolated runs). */
  sessionId?: string;
  /** Echoed back from options. */
  correlationId?: string;
}
