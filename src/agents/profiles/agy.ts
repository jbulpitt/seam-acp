/**
 * Antigravity (`agy`) CLI as an in-process ACP agent.
 *
 * `agy` doesn't speak ACP, so this profile fakes a `ChildProcessByStdio`
 * (`PassThrough` streams instead of a real subprocess) and runs an
 * `AgentSideConnection` against it directly inside seam-acp. Every ACP
 * `session/prompt` is fulfilled by spawning a real `agy -p` child,
 * discovering the language server it boots, and translating its
 * `StreamAgentStateUpdates` events into ACP `sessionUpdate` notifications.
 *
 * Streaming mapping:
 *   plannerResponse.thinking          → agent_thought_chunk (delta)
 *   plannerResponse.modifiedResponse  → agent_message_chunk (delta)
 *   tool-call step types              → tool_call + tool_call_update
 *   USER_INPUT / CONVERSATION_HISTORY / CHECKPOINT → suppressed (internal)
 *
 * Session continuity: the first prompt in an ACP session spawns a fresh
 * agy conversation; subsequent prompts pass `--conversation <id>` so the
 * agent picks up where it left off.
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AgentProfile } from "../agent-profile.js";
import {
  discoverAgyLs,
  subscribeToAgyStream,
  type AgyStep,
} from "../agy-stream.js";

const CONVERSATION_DIR = path.join(
  process.env.HOME ?? "/root",
  ".gemini/antigravity-cli/conversations",
);

export function makeAgyProfile(opts: {
  /** Override the agy binary location. Defaults to `agy` on PATH. */
  cliPath?: string;
  /**
   * Model id to advertise. Antigravity's CLI ignores ACP `set_model`, so this
   * is purely cosmetic — the actual model is whatever agy picks. We pass through
   * a reasonable default so the AgentRuntime has something to record.
   */
  defaultModel?: string;
} = {}): AgentProfile {
  const cli = opts.cliPath?.trim() || resolveAgyBinary();
  const defaultModel = opts.defaultModel ?? "antigravity";
  return {
    id: "agy",
    displayName: "Antigravity",
    defaultModel,
    spawn() {
      return makeFakeAgyProcess(cli);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake ChildProcess: PassThrough streams + EventEmitter, ACP server attached.
// ---------------------------------------------------------------------------

type FakeProc = ChildProcessByStdio<Writable, Readable, Readable>;

function makeFakeAgyProcess(cli: string): FakeProc {
  const fakeStdin = new PassThrough(); // client writes here; we read from it
  const fakeStdout = new PassThrough(); // we write here; client reads from it
  const fakeStderr = new PassThrough();
  const emitter = new EventEmitter();
  let killed = false;

  const agent = new AgyAgent(cli);

  const stream = ndJsonStream(
    Writable.toWeb(fakeStdout),
    Readable.toWeb(fakeStdin) as ReadableStream<Uint8Array>,
  );
  // The constructor wires `conn` into the agent via the factory callback.
  new AgentSideConnection((conn) => {
    agent.bind(conn);
    return agent;
  }, stream);

  const fake = Object.assign(emitter, {
    stdin: fakeStdin as unknown as Writable,
    stdout: fakeStdout as unknown as Readable,
    stderr: fakeStderr as unknown as Readable,
    get killed() {
      return killed;
    },
    kill(): boolean {
      if (killed) return false;
      killed = true;
      agent.shutdown();
      fakeStdin.destroy();
      fakeStdout.push(null);
      fakeStderr.push(null);
      emitter.emit("exit", 0, null);
      return true;
    },
    pid: undefined,
  });

  return fake as unknown as FakeProc;
}

// ---------------------------------------------------------------------------
// ACP agent implementation
// ---------------------------------------------------------------------------

interface AgySession {
  cwd: string;
  /** Set after the first `agy -p` run; used for `--conversation` continuity. */
  cascadeId?: string;
}

interface ActiveRun {
  proc: ChildProcess;
  abort: AbortController;
  sessionId: string;
}

class AgyAgent implements Agent {
  private conn?: AgentSideConnection;
  private readonly sessions = new Map<string, AgySession>();
  private active?: ActiveRun;

  constructor(private readonly cli: string) {}

  bind(conn: AgentSideConnection): void {
    this.conn = conn;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // agy only consumes text prompts from us; richer block support can be
        // added later if we want to forward attachments through the CLI.
        promptCapabilities: {},
        loadSession: false,
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    this.sessions.set(id, { cwd: params.cwd });
    return { sessionId: id };
  }

  async loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // `loadSession: false` was advertised in initialize, but the SDK still
    // requires the method to exist. Reject loads explicitly.
    throw RequestError.methodNotFound("session/load");
  }

  async setSessionMode(
    _params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    return {};
  }

  async setSessionModel(
    _params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.conn) throw new Error("ACP connection not bound");
    const sess = this.sessions.get(params.sessionId);
    if (!sess) {
      throw RequestError.invalidParams({
        details: `unknown session ${params.sessionId}`,
      });
    }

    const promptText = flattenPrompt(params.prompt);
    if (!promptText.trim()) {
      return { stopReason: "end_turn" };
    }

    // Cancel any prior run for this session before starting a new one.
    if (this.active?.sessionId === params.sessionId) {
      try { this.active.proc.kill(); } catch {}
      this.active.abort.abort();
      this.active = undefined;
    }

    const before = await listConversations();
    const agyStart = Date.now();
    const args = [
      "-p",
      promptText,
      "--print-timeout",
      "600s",
      "--dangerously-skip-permissions",
    ];
    if (sess.cascadeId) {
      args.push("--conversation", sess.cascadeId);
    }

    if (process.env.AGY_PROFILE_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[agy] spawn ${this.cli} cwd=${sess.cwd} args=${JSON.stringify(args)}`);
    }
    const proc = spawn(this.cli, args, {
      cwd: sess.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on("data", () => {}); // drain; we get the real output via gRPC
    proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    // Two independent signals:
    //   `cancelAbort` — external cancel from the ACP client (session/cancel).
    //   `procExited` — agy itself finished; the LS will close the stream
    //     naturally afterward, so we don't need to abort fetch on its own.
    const cancelAbort = new AbortController();
    let procExited = false;
    let exitCode: number | null = null;
    this.active = { proc, abort: cancelAbort, sessionId: params.sessionId };
    const runRef = this.active;
    proc.once("exit", (code, signal) => {
      if (process.env.AGY_PROFILE_DEBUG) {
        // eslint-disable-next-line no-console
        console.error(`[agy] child exit code=${code} signal=${signal}`);
      }
      procExited = true;
      exitCode = code;
      if (this.active === runRef) this.active = undefined;
    });
    proc.once("error", (e) => {
      if (process.env.AGY_PROFILE_DEBUG) {
        // eslint-disable-next-line no-console
        console.error(`[agy] child error`, e);
      }
      cancelAbort.abort();
      if (this.active === runRef) this.active = undefined;
    });

    try {
      const ls = await discoverAgyLs({
        timeoutMs: 30_000,
        newerThanMs: agyStart - 1_000,
        signal: cancelAbort.signal,
      });
      const cid = sess.cascadeId ?? (await waitForNewCascade(before, cancelAbort.signal));
      sess.cascadeId = cid;

      const lastText = new Map<number, string>();
      const lastThinking = new Map<number, string>();
      const heldText = new Map<number, string>();
      const heldThinking = new Map<number, string>();
      const toolCallIds = new Map<number, string>();

      try {
        for await (const update of subscribeToAgyStream({
          port: ls.port,
          conversationId: cid,
          signal: cancelAbort.signal,
        })) {
          if (cancelAbort.signal.aborted) break;
          const sup = update.mainTrajectoryUpdate?.stepsUpdate;
          if (!sup?.indices || !sup.steps) continue;
          for (let i = 0; i < sup.indices.length; i++) {
            const idx = sup.indices[i];
            const step = sup.steps[i];
            if (idx === undefined || step === undefined) continue;
            await this.emitStep(
              params.sessionId,
              idx,
              step,
              lastText,
              lastThinking,
              toolCallIds,
              heldText,
              heldThinking,
              sess.cwd,
            );
          }
        }
      } catch (streamErr) {
        // The LS closes the socket after the cascade reaches IDLE; undici
        // surfaces that as `TypeError: terminated` (incomplete chunked
        // read) since Connect doesn't always send a final HTTP trailer.
        // Treat any post-subscribe stream error as natural EOF — except
        // for an explicit user cancel.
        if (cancelAbort.signal.aborted) {
          return { stopReason: "cancelled" };
        }
        if (process.env.AGY_PROFILE_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(
            `[agy] stream ended:`,
            streamErr instanceof Error ? streamErr.message : streamErr,
          );
        }
        // Fall through to end_turn — agy completed and the LS closed.
      }
      // Flush any text held back as a potentially-partial pattern.
      await this.flushHeld(params.sessionId, heldText, "agent_message_chunk", sess.cwd);
      await this.flushHeld(params.sessionId, heldThinking, "agent_thought_chunk", sess.cwd);
    } catch (err) {
      if (cancelAbort.signal.aborted) return { stopReason: "cancelled" };
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (stderr) {
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `\n[agy error]\n${stderr.slice(0, 2000)}` },
          },
        }).catch(() => {});
      }
      throw err;
    } finally {
      if (this.active === runRef) this.active = undefined;
    }

    if (exitCode !== null && exitCode !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (stderr) {
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `\n[agy exit ${exitCode}]\n${stderr.slice(0, 2000)}` },
          },
        }).catch(() => {});
      }
    }
    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (this.active?.sessionId === params.sessionId) {
      this.active.abort.abort();
      try { this.active.proc.kill(); } catch {}
    }
  }

  shutdown(): void {
    if (this.active) {
      try { this.active.proc.kill(); } catch {}
      this.active.abort.abort();
      this.active = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Step → ACP translation
  // -----------------------------------------------------------------------

  private async emitStep(
    sessionId: string,
    idx: number,
    step: AgyStep,
    lastText: Map<number, string>,
    lastThinking: Map<number, string>,
    toolCallIds: Map<number, string>,
    heldText: Map<number, string>,
    heldThinking: Map<number, string>,
    cwd: string,
  ): Promise<void> {
    if (!this.conn) return;
    const type = step.type ?? "";

    if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      // Stream thinking deltas before visible text — agy fills them in that
      // order, so consumers see "thinking…" before the answer arrives.
      const thinking = step.plannerResponse?.thinking ?? "";
      const prevTh = lastThinking.get(idx) ?? "";
      if (thinking.length > prevTh.length) {
        const delta = thinking.slice(prevTh.length);
        lastThinking.set(idx, thinking);
        await this.emitTextChunk(sessionId, idx, delta, heldThinking, "agent_thought_chunk", cwd);
      }
      const text = step.plannerResponse?.modifiedResponse ?? "";
      const prevTx = lastText.get(idx) ?? "";
      if (text.length > prevTx.length) {
        const delta = text.slice(prevTx.length);
        lastText.set(idx, text);
        await this.emitTextChunk(sessionId, idx, delta, heldText, "agent_message_chunk", cwd);
      }
      return;
    }

    // Skip internal trajectory steps — they're noise to a chat consumer.
    if (
      type === "CORTEX_STEP_TYPE_USER_INPUT" ||
      type === "CORTEX_STEP_TYPE_CONVERSATION_HISTORY" ||
      type === "CORTEX_STEP_TYPE_CHECKPOINT"
    ) {
      return;
    }

    // Anything else (VIEW_FILE, RUN_COMMAND, …) becomes a tool call.
    const status = mapToolStatus(step.status);
    const title = toolTitle(step);
    let toolCallId = toolCallIds.get(idx);
    if (!toolCallId) {
      toolCallId = `agy-step-${idx}`;
      toolCallIds.set(idx, toolCallId);
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          status,
          kind: "other",
        },
      });
    } else {
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          ...(title ? { title } : {}),
          status,
        },
      });
    }
  }

  /**
   * Append `delta` to any previously-held tail for `idx`, emit the safe
   * portion (transformed for Discord), and re-hold whatever might still be
   * mid-pattern (unclosed markdown link or partial cwd prefix).
   */
  private async emitTextChunk(
    sessionId: string,
    idx: number,
    delta: string,
    held: Map<number, string>,
    updateType: "agent_thought_chunk" | "agent_message_chunk",
    cwd: string,
  ): Promise<void> {
    if (!this.conn) return;
    const combined = (held.get(idx) ?? "") + delta;
    const safeLen = findSafeBoundary(combined, cwd);
    const safe = combined.slice(0, safeLen);
    held.set(idx, combined.slice(safeLen));
    if (!safe) return;
    const transformed = transformAgyText(safe, cwd);
    await this.conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: updateType, content: { type: "text", text: transformed } },
    });
  }

  /** Emit any text held back as a potentially-partial pattern. */
  private async flushHeld(
    sessionId: string,
    held: Map<number, string>,
    updateType: "agent_thought_chunk" | "agent_message_chunk",
    cwd: string,
  ): Promise<void> {
    if (!this.conn) return;
    for (const tail of held.values()) {
      if (!tail) continue;
      const transformed = transformAgyText(tail, cwd);
      if (!transformed) continue;
      await this.conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: updateType, content: { type: "text", text: transformed } },
      });
    }
    held.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenPrompt(blocks: ReadonlyArray<ContentBlock>): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function mapToolStatus(
  s: string | undefined,
): "pending" | "in_progress" | "completed" | "failed" {
  switch (s) {
    case "CORTEX_STEP_STATUS_DONE":
      return "completed";
    case "CORTEX_STEP_STATUS_WAITING":
      return "pending";
    case "CORTEX_STEP_STATUS_FAILED":
    case "CORTEX_STEP_STATUS_ERROR":
      return "failed";
    default:
      return "in_progress";
  }
}

function toolTitle(step: AgyStep): string {
  const t = step.type ?? "";
  return t.replace(/^CORTEX_STEP_TYPE_/, "").replace(/_/g, " ").toLowerCase();
}

/**
 * Find the last position in `text` past which we shouldn't emit yet, because
 * the suffix could still grow into a pattern we want to transform — either an
 * unclosed `[label](url)` markdown link, or a partial absolute path that may
 * complete into the session cwd.
 */
function findSafeBoundary(text: string, cwd: string): number {
  let safe = text.length;

  const lastOpenBracket = text.lastIndexOf("[");
  if (lastOpenBracket !== -1) {
    const after = text.slice(lastOpenBracket);
    if (!/\]\([^)]*\)/.test(after)) safe = Math.min(safe, lastOpenBracket);
  }

  const minStart = Math.max(0, text.length - cwd.length);
  for (let i = minStart; i < text.length; i++) {
    if (cwd.startsWith(text.slice(i))) {
      safe = Math.min(safe, i);
      break;
    }
  }

  return safe;
}

/**
 * Discord-friendly rewrites of agy output:
 *   `[label](file:///abs/path)` →
 *     - inside cwd  → `` `label` (`relative/path`) ``
 *     - outside cwd → `` `label` `` (the absolute path is noise — usually agy's
 *                     internal brain dir — and Discord can't render file:// anyway)
 *   bare absolute paths under cwd → relative paths
 *   bare cwd alone                → basename of cwd (reads naturally in prose)
 */
function transformAgyText(text: string, cwd: string): string {
  const cwdNorm = cwd.replace(/\/+$/, "");

  text = text.replace(
    /\[([^\]]+)\]\(file:\/\/([^)]+)\)/g,
    (_match, label: string, urlPath: string) => {
      let p: string;
      try { p = decodeURIComponent(urlPath); } catch { p = urlPath; }
      if (p === cwdNorm) return `\`${label}\``;
      if (p.startsWith(cwdNorm + "/")) {
        return `\`${label}\` (\`${p.slice(cwdNorm.length + 1)}\`)`;
      }
      return `\`${label}\``;
    },
  );

  const cwdEsc = cwdNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = path.basename(cwdNorm);
  text = text.replace(
    new RegExp(`${cwdEsc}(/[\\w./\\-]*)?`, "g"),
    (_match, sub: string | undefined) => (sub ? sub.slice(1) : base),
  );

  return text;
}

/**
 * Locate the agy binary. The official installer (`agy install`) puts it at
 * `~/.local/bin/agy` and updates the user's shell rc, but the bot often runs
 * under a daemon (systemd / pm2) where that PATH isn't loaded. Fall back to
 * the known install path so the profile works out of the box; let the user
 * override via `cliPath` if their install is elsewhere.
 */
function resolveAgyBinary(): string {
  const home = process.env.HOME ?? os.homedir();
  const candidate = path.join(home, ".local/bin/agy");
  try {
    if (fsSync.statSync(candidate).isFile()) return candidate;
  } catch {
    /* fall through */
  }
  return "agy";
}

async function listConversations(): Promise<Set<string>> {
  try {
    const names = await fs.readdir(CONVERSATION_DIR);
    return new Set(names);
  } catch {
    return new Set();
  }
}

async function waitForNewCascade(
  before: Set<string>,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("aborted waiting for new cascade");
    const now = await listConversations();
    for (const name of now) {
      if (!before.has(name) && name.endsWith(".pb")) {
        return name.slice(0, -3);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    "no new agy conversation appeared within 30s — is `agy` installed and logged in?",
  );
}
