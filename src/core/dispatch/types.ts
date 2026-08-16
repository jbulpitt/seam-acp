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
  correlationId?: string;
  /** When set, after this turn completes the runtime auto-dispatches the
   *  captured output back into this thread (report-back). */
  returnTo?: string;
  /** Ledger classification; defaults to "handoff". The report-back
   *  re-injection sets "report_back". */
  kind?: DelegationKind;
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
  correlationId: z.string().min(1).optional(),
  returnTo: z.string().min(1).optional(),
  kind: z.enum(["handoff", "forward", "report_back", "scheduled", "peek"]).optional(),
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
    ...(d.correlationId ? { correlationId: d.correlationId } : {}),
    ...(d.returnTo ? { returnTo: d.returnTo } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
    createdUtc: d.createdUtc ?? new Date().toISOString(),
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
