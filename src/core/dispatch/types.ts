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
import { mkdir, rename, writeFile } from "node:fs/promises";
import type { DelegationKind } from "../types.js";

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
  correlationId?: string;
  /** When set, after this turn completes the runtime auto-dispatches the
   *  captured output back into this thread (report-back). */
  returnTo?: string;
  /** Ledger classification; defaults to "handoff". The report-back
   *  re-injection sets "report_back"; a fired wake (#59) sets "wake". */
  kind?: DelegationKind;
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
  correlationId: z.string().min(1).optional(),
  returnTo: z.string().min(1).optional(),
  kind: z.enum(["handoff", "forward", "report_back", "scheduled", "wake", "peek"]).optional(),
  wakeChainDepth: z.number().int().min(0).optional(),
  chainId: z.string().min(1).optional(),
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
    ...(d.correlationId ? { correlationId: d.correlationId } : {}),
    ...(d.returnTo ? { returnTo: d.returnTo } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.wakeChainDepth !== undefined ? { wakeChainDepth: d.wakeChainDepth } : {}),
    ...(d.chainId ? { chainId: d.chainId } : {}),
    createdUtc: d.createdUtc ?? new Date().toISOString(),
  };
}

/** A Discord snowflake is a long run of digits; a preset is a human name. Used
 *  to decide whether a chain hop names a thread (stateful, run live in it) or a
 *  preset (stateless specialist, run isolated with output posted to `originRef`
 *  for visibility). Mirrors the seam-MCP handoff heuristic. */
export function hopLooksLikeThreadId(hop: string): boolean {
  return /^\d{15,}$/.test(hop.trim());
}

/**
 * Build the dispatch spec for one chain hop — shared by the `chain` MCP tool
 * (hop 1) and the orchestrator's chain-advance (hops 2…N). The hop carries the
 * `chainId` (so its completion advances the chain) and `kind: "forward"` (this
 * hop's output is piped onward as the next hop's input). It deliberately sets no
 * `returnTo`: the chain, not a report-back, drives delivery.
 */
export function buildChainHopSpec(params: {
  id: string;
  chainId: string;
  /** thread id or preset name. */
  worker: string;
  /** This hop's input — the prior hop's output, or the chain's initial prompt. */
  prompt: string;
  /** Where a preset hop's output is posted for visibility. */
  originRef: string;
  correlationId?: string;
  createdUtc?: string;
}): DispatchSpec {
  const toThread = hopLooksLikeThreadId(params.worker);
  return {
    id: params.id,
    target: toThread ? params.worker : params.originRef,
    prompt: params.prompt,
    session: toThread ? "live" : "isolated",
    ...(toThread ? {} : { preset: params.worker }),
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
