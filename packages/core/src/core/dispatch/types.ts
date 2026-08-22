/**
 * Operator-dispatch bridge — on-disk contract.
 *
 * A trusted operator process drops a JSON "dispatch spec" into
 * `<DATA_DIR>/dispatch/pending/`; `DispatchWatcher` picks it up, runs one
 * programmatic turn in the target Discord thread via `Orchestrator.injectTurn`,
 * and writes the captured output to `<DATA_DIR>/dispatch/done/`.
 *
 * Auth is the filesystem: anything that can write to the dispatch dir is
 * operator-trusted by construction. There is deliberately no token here.
 */
import { z } from "zod";
import * as path from "node:path";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import type { DelegationKind } from "../types.js";
import { parseDispatchWorker } from "../location.js";

/** How the dispatched turn acquires its ACP session — see `InjectTurnOptions`. */
export type DispatchSessionMode = "live" | "isolated";

/** `pending/<id>.json`. The **filename stem is the canonical id** — see
 *  `parseDispatchSpec`. */
export interface DispatchSpec {
  id: string;
  /** Discord thread/channel id to dispatch into (the worker). */
  target: string;
  prompt: string;
  session: DispatchSessionMode;
  /** Isolated runs only — a live run inherits the thread's own model/effort. */
  model?: string;
  effort?: string;
  cwd?: string;
  /** Dispatch to a reusable stateless preset worker by name instead of the
   *  target thread's own session — forces an isolated run under the preset's
   *  agent/model/effort/cwd + instructions (cold-start identity). #23. */
  preset?: string;
  /**
   * Host this worker should run on (D10 / #84). `"local"` or omitted ⇒
   * loopback. A bridge id is passed to `markSessionBridge` before spawn.
   * `agentId@location` as a worker target is parsed into this + `agentId`.
   */
  location?: string;
  /** Isolated worker agent when the target is `agentId@location` rather than a preset. */
  agentId?: string;
  correlationId?: string;
  /** When set, after this turn completes the runtime auto-dispatches the
   *  captured output back into this thread (report-back). */
  returnTo?: string;
  /** Ledger classification; defaults to "handoff". The report-back
   *  re-injection sets "report_back"; a fired wake (#59) sets "wake"; a fired
   *  watch (#60) sets "watch"; an agent-triggered compaction sets "compact";
   *  a parked prompt firing after a remote-bridge reconnect (#88) sets "parked". */
  kind?: DelegationKind;
  /** Compact-kind specs only: which history the pipeline reads — "session"
   *  (the raw session JSONL, the default) or "discord" (reconstructed from the
   *  full Discord thread). Ignored for every other kind. */
  compactSource?: "session" | "discord";
  /** Wake self-renewal depth (#59). Set only on wake-kind specs so the turn
   *  knows its chain depth while it runs — a wake armed *during* this turn
   *  inherits `wakeChainDepth + 1`, and the chain-depth cap (D8) trips past a
   *  threshold. Absent/0 for every non-wake dispatch. */
  wakeChainDepth?: number;
  /** Durable multi-hop chain id (#25). When set, on completion the runtime
   *  advances the chain (pipe this hop's output into the next hop, or deliver
   *  the final output to the chain's origin) instead of the normal `returnTo`
   *  report-back. */
  chainId?: string;
  /** Live-visibility toggle. When absent or `true` (the default), the runtime
   *  posts a start indicator into the target thread and progressively streams
   *  the worker's agent-text into it as it runs. When `false`, the run stays
   *  quiet — the indicator still posts, but the body is captured silently and
   *  posted once at the end (the escape hatch for a single clean artifact).
   *  Report-back / chain delivery of the FULL captured text is unaffected
   *  either way — streaming is purely about live visibility in the run's own
   *  target thread. */
  stream?: boolean;
  /** Handoff feedback channel (#62/#65). When true, the worker's prompt gets a
   *  standing instruction to poll its OWN inbox after each discrete step/item
   *  (and at least every 1–2 minutes) for mid-task steering from its delegator —
   *  a cooperative, opt-in-per-handoff channel that never cancels or restarts
   *  the turn (contrast the preemptive `steer` path). Absent/false → the prompt
   *  is untouched and behavior is unchanged. */
  watchFeedback?: boolean;
  /**
   * Set by recoverStale when a crash leftover is re-enqueued (#76). The
   * dispatcher then substitutes prompt → "continue" and session acquisition
   * → loadSession(recordedAcpSessionId) instead of replaying the brief.
   */
  resume?: boolean;
  createdUtc: string;
}

/** `done/<id>.json`. Written exactly once per spec, atomically. */
export interface DispatchResult {
  id: string;
  status: "completed" | "failed";
  /** ACP stop reason, when the turn completed. */
  stopReason?: string;
  /** Captured agent text. Present on success; may be partial on failure. */
  output?: string;
  /** Failure reason. Absent on success. */
  error?: string;
  target: string;
  correlationId?: string;
  finishedUtc: string;
}

/**
 * Spec validation. `id` is intentionally *not* trusted from the file body —
 * `parseDispatchSpec` overwrites it with the filename stem, so `done/<id>.json`
 * always lands where the operator (and `seam-dispatch --wait`) is looking, even
 * if the body's `id` field disagrees or is missing.
 */
export const DispatchSpecSchema = z.object({
  id: z.string().optional(),
  target: z.string().min(1, "target (a Discord thread/channel id) is required"),
  prompt: z.string().min(1, "prompt is required"),
  session: z.enum(["live", "isolated"]).default("live"),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  preset: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  returnTo: z.string().min(1).optional(),
  kind: z.enum(["handoff", "forward", "report_back", "scheduled", "wake", "watch", "peek", "compact", "parked", "choice"]).optional(),
  compactSource: z.enum(["session", "discord"]).optional(),
  wakeChainDepth: z.number().int().min(0).optional(),
  chainId: z.string().min(1).optional(),
  stream: z.boolean().optional(),
  watchFeedback: z.boolean().optional(),
  resume: z.boolean().optional(),
  createdUtc: z.string().optional(),
});

/** Parse + validate a spec file body. Throws with a readable message on
 *  malformed JSON or a schema violation; the watcher turns that into a
 *  `failed` done-file rather than retrying a file that can never succeed. */
export function parseDispatchSpec(id: string, raw: string): DispatchSpec {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`malformed JSON: ${(err as Error).message}`);
  }
  const parsed = DispatchSpecSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid dispatch spec: ${issues}`);
  }
  const d = parsed.data;
  return {
    id,
    target: d.target,
    prompt: d.prompt,
    session: d.session,
    ...(d.model ? { model: d.model } : {}),
    ...(d.effort ? { effort: d.effort } : {}),
    ...(d.cwd ? { cwd: d.cwd } : {}),
    ...(d.preset ? { preset: d.preset } : {}),
    ...(d.location ? { location: d.location } : {}),
    ...(d.agentId ? { agentId: d.agentId } : {}),
    ...(d.correlationId ? { correlationId: d.correlationId } : {}),
    ...(d.returnTo ? { returnTo: d.returnTo } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.compactSource ? { compactSource: d.compactSource } : {}),
    ...(d.wakeChainDepth !== undefined ? { wakeChainDepth: d.wakeChainDepth } : {}),
    ...(d.chainId ? { chainId: d.chainId } : {}),
    ...(d.stream !== undefined ? { stream: d.stream } : {}),
    ...(d.watchFeedback !== undefined ? { watchFeedback: d.watchFeedback } : {}),
    ...(d.resume !== undefined ? { resume: d.resume } : {}),
    createdUtc: d.createdUtc ?? new Date().toISOString(),
  };
}

/** The standing instruction appended to a `watchFeedback` handoff's worker
 *  prompt (#62/#65). Motivates the worker to poll its OWN inbox after each
 *  discrete step/item (not once at a vague "halfway" checkpoint) so its
 *  delegator can push mid-task steering it absorbs WITHOUT a cancel or restart.
 *  Wording is kept here (one place) so it stays tunable. */
export const WATCH_FEEDBACK_INSTRUCTION =
  "After each discrete step or item you complete, call `poll_inbox` before " +
  "starting the next. Also poll at the start of the turn, and at least every " +
  "1–2 minutes of work if a step runs long. Do not poll in a tight loop or " +
  "after every individual tiny tool call — once per completed item/step is " +
  "enough. If poll_inbox returns guidance, incorporate it into your current " +
  "plan before continuing — you do not need to restart. If poll_inbox returns " +
  "a PRIORITY item, stop your current approach immediately and reorient to it, " +
  "even mid-task.";

/** Append the `watchFeedback` standing instruction to an already-assembled
 *  worker prompt when the spec opts in (#62); otherwise return it verbatim.
 *  Applied AFTER any preset-identity prepend so the polling instruction is the
 *  final thing the worker reads. This is exactly what `dispatchInjectTurn`
 *  composes for the dispatched prompt. */
export function applyWatchFeedback(prompt: string, watchFeedback?: boolean): string {
  if (!watchFeedback) return prompt;
  return `${prompt}\n\n${WATCH_FEEDBACK_INSTRUCTION}`;
}

/** Prepend a preset worker's identity to its cold-start prompt (#23/#72). When a
 *  preset runs as a stateless handoff/dispatch worker it has no session history,
 *  so its `instructions` ARE its personality — they are injected here as a
 *  `<seam-worker-identity name="…">…</seam-worker-identity>` block ahead of the
 *  task prompt. No instructions ⇒ the prompt is returned verbatim. Kept as a pure
 *  function (one place) so the exact injection is unit-testable end-to-end, and
 *  `dispatchInjectTurn` composes it with `applyWatchFeedback` (identity first,
 *  polling instruction last). */
export function applyPresetIdentity(
  prompt: string,
  preset?: { name: string; instructions: string | null } | null
): string {
  if (!preset?.instructions) return prompt;
  return `<seam-worker-identity name="${preset.name}">\n${preset.instructions}\n</seam-worker-identity>\n\n${prompt}`;
}

/** A Discord snowflake is a long run of digits; a preset is a human name. Used
 *  to decide whether a chain hop names a thread (stateful, run live in it) or a
 *  preset (stateless specialist, run isolated with output posted to `originRef`
 *  for visibility). Mirrors the seam-MCP handoff heuristic. */
export function hopLooksLikeThreadId(hop: string): boolean {
  return parseDispatchWorker(hop).kind === "thread";
}

/**
 * Build the dispatch spec for one chain hop — shared by the `chain` MCP tool
 * (hop 1) and the orchestrator's chain-advance (hops 2…N). The hop carries the
 * `chainId` (so its completion advances the chain) and `kind: "forward"` (this
 * hop's output is piped onward as the next hop's input). It deliberately sets no
 * `returnTo`: the chain, not a report-back, drives delivery.
 *
 * Worker parsing matches handoff: a snowflake runs live in that thread; a bare
 * name is a local preset / agent id; `agentId@location` is the name before `@`
 * isolated on the host after `@` (never a preset named `claude@mac`).
 */
export function buildChainHopSpec(params: {
  id: string;
  chainId: string;
  /** thread id, preset/agent name, or `agentId@location`. */
  worker: string;
  /** This hop's input — the prior hop's output, or the chain's initial prompt. */
  prompt: string;
  /** Where a preset hop's output is posted for visibility. */
  originRef: string;
  correlationId?: string;
  createdUtc?: string;
}): DispatchSpec {
  const parsed = parseDispatchWorker(params.worker);
  const toThread = parsed.kind === "thread";
  return {
    id: params.id,
    target: toThread ? parsed.threadId : params.originRef,
    prompt: params.prompt,
    session: toThread ? "live" : "isolated",
    ...(toThread ? {} : { preset: parsed.name }),
    ...(parsed.kind === "named" && parsed.location ? { location: parsed.location } : {}),
    chainId: params.chainId,
    kind: "forward",
    correlationId: params.correlationId ?? params.chainId,
    createdUtc: params.createdUtc ?? new Date().toISOString(),
  };
}

/** The three queue directories, derived from `DATA_DIR`. Kept in one place so
 *  the watcher, the orchestrator and `scripts/seam-dispatch.mjs` agree. */
export function dispatchDirs(dataDir: string): {
  root: string;
  pending: string;
  running: string;
  done: string;
} {
  const root = path.join(dataDir, "dispatch");
  return {
    root,
    pending: path.join(root, "pending"),
    running: path.join(root, "running"),
    done: path.join(root, "done"),
  };
}

/**
 * Atomically enqueue a dispatch spec into `pending/<id>.json` (write to a
 * dot-prefixed tmp, then rename), so the DispatchWatcher never observes a
 * half-written file. The filename stem is the canonical id. Shared by the
 * seam-MCP tools and `Orchestrator.enqueueReportBack`.
 */
export async function enqueueDispatchSpec(
  dataDir: string,
  spec: DispatchSpec
): Promise<void> {
  const dirs = dispatchDirs(dataDir);
  await mkdir(dirs.pending, { recursive: true });
  const tmp = path.join(dirs.pending, `.${spec.id}.json.tmp`);
  const final = path.join(dirs.pending, `${spec.id}.json`);
  await writeFile(tmp, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  await rename(tmp, final);
}

/**
 * Look for an already-queued report-back spec for `correlationId` in
 * `pending/` and `running/`. `done/` holds *results* (no `kind`), so it
 * cannot identify a report-back — the ledger is the durable record once
 * the spec has left the queue (#77).
 */
export async function findQueuedReportBackSpec(
  dataDir: string,
  correlationId: string
): Promise<DispatchSpec | null> {
  const dirs = dispatchDirs(dataDir);
  for (const dir of [dirs.pending, dirs.running]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        const spec = parseDispatchSpec(id, await readFile(path.join(dir, name), "utf8"));
        if (spec.kind === "report_back" && spec.correlationId === correlationId) {
          return spec;
        }
      } catch {
        // Unparseable / not a spec — ignore (done-shaped files, tmp leftovers).
      }
    }
  }
  return null;
}
