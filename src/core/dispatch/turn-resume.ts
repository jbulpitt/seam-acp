/**
 * Turn-resume (#76) — marker lifecycle + resume policy.
 *
 * Resume is "continue" against the SAME ACP session, never a prompt replay.
 * Dispatch-backed turns ride the existing `running/` spec (recoverStale marks
 * it); live human turns get a parallel marker under `<DATA_DIR>/turns/` with
 * the SAME commit ordering as `writeDone` (tmp+rename the done-file, THEN rm
 * the running-file; leave the running-file if the write fails).
 *
 * SINGLE-INSTANCE ASSUMPTION: recovery assumes no other seam-acp process owns
 * the turn. True today (one pm2 process). Two processes against one DATA_DIR
 * would double-resume everything.
 *
 * NON-GOAL: in-memory multi-stage orchestrator work (notably a premium-
 * compaction run) is neither dispatch-backed nor a live human turn. It dies
 * on restart and stays dead — named here so that is a decision, not an
 * oversight.
 *
 * Cancellation is terminal but MUST NOT be hooked into dispose()/invalidate():
 * SIGTERM, abort, and kill all converge on dispose, and wiping markers there
 * would make resume a silent no-op on every graceful reboot. Clear markers
 * at the command layer (cmdCancel / cmdAbort / cmdKill) only.
 */
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { DispatchSpec } from "./types.js";

/** Prompt substituted for the original on resume. Never replay the brief. */
export const CONTINUE_PROMPT = "continue";

/** In-thread announcement so a resumed turn is not mistaken for a malfunction. */
export const RESUME_ANNOUNCE = "▶️ resuming after restart";

/**
 * Max-age window mirroring scheduled-prompt `catchupSeconds` (default 7200).
 * Past this, the turn is abandoned with a notice rather than resumed.
 */
export const TURN_RESUME_MAX_AGE_SECONDS = 7200;

/** Delay between resume starts — avoids a boot-time rate-limit spike. */
export const TURN_RESUME_STAGGER_MS = 1500;

/** Cap on concurrently-starting resumed turns. Per-channel FIFO still
 *  serializes the same thread. */
export const TURN_RESUME_CONCURRENCY = 2;

export function turnDirs(dataDir: string): {
  root: string;
  running: string;
  done: string;
} {
  const root = path.join(dataDir, "turns");
  return {
    root,
    running: path.join(root, "running"),
    done: path.join(root, "done"),
  };
}

/** On-disk record of a live (non-dispatch) human turn. Written at turn START;
 *  removed only after a terminal write. Record, do not infer. */
export interface LiveTurnMarker {
  id: string;
  kind: "live";
  channelRef: string;
  parentRef?: string;
  sessionRecordId: string;
  acpSessionId?: string;
  authorId?: string;
  startedUtc: string;
}

export type LiveTurnTerminalStatus = "completed" | "failed" | "cancelled" | "abandoned";

export interface LiveTurnResult {
  id: string;
  status: LiveTurnTerminalStatus;
  channelRef: string;
  finishedUtc: string;
  reason?: string;
}

export type ResumeDecision = "resume" | "abandon" | "skip";

export type ResumePrecondition = "ok" | "deleted" | "locked" | "archived" | "unreachable";

export interface ResumePolicyInput {
  startedUtc: string;
  maxAgeSeconds: number;
  now: Date;
  precondition: ResumePrecondition;
  /** Recorded ACP session — without it there is nothing to reattach to. */
  acpSessionId?: string | null;
}

/** Pure classifier: max-age + preconditions + session pointer. */
export function decideResume(input: ResumePolicyInput): {
  action: ResumeDecision;
  reason: string;
} {
  if (input.precondition === "deleted") {
    return { action: "abandon", reason: "thread deleted" };
  }
  if (input.precondition === "locked") {
    return { action: "skip", reason: "thread locked" };
  }
  if (input.precondition === "archived") {
    return { action: "skip", reason: "thread archived" };
  }
  if (input.precondition === "unreachable") {
    return { action: "skip", reason: "thread unreachable" };
  }
  if (isPastMaxAge(input.startedUtc, input.maxAgeSeconds, input.now)) {
    return { action: "abandon", reason: "past max-age" };
  }
  if (!input.acpSessionId) {
    return { action: "abandon", reason: "no recorded ACP session" };
  }
  return { action: "resume", reason: "ok" };
}

export function isPastMaxAge(
  startedUtc: string,
  maxAgeSeconds: number,
  now: Date = new Date()
): boolean {
  if (maxAgeSeconds <= 0) return false;
  const then = Date.parse(startedUtc);
  if (Number.isNaN(then)) return true;
  const ageSec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  return ageSec > maxAgeSeconds;
}

export function markSpecAsResume(spec: DispatchSpec): DispatchSpec {
  return { ...spec, resume: true };
}

export async function ensureTurnDirs(dataDir: string): Promise<ReturnType<typeof turnDirs>> {
  const dirs = turnDirs(dataDir);
  await mkdir(dirs.running, { recursive: true });
  await mkdir(dirs.done, { recursive: true });
  return dirs;
}

/** Write the live-turn marker at turn START (tmp+rename into running/). */
export async function writeLiveMarker(
  dataDir: string,
  marker: LiveTurnMarker
): Promise<void> {
  const dirs = await ensureTurnDirs(dataDir);
  const name = `${marker.id}.json`;
  const finalPath = path.join(dirs.running, name);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await rename(tmpPath, finalPath);
}

/** Patch fields on an existing running marker (e.g. acpSessionId once known). */
export async function patchLiveMarker(
  dataDir: string,
  id: string,
  patch: Partial<Pick<LiveTurnMarker, "acpSessionId">>
): Promise<void> {
  const dirs = turnDirs(dataDir);
  const runningPath = path.join(dirs.running, `${id}.json`);
  let current: LiveTurnMarker;
  try {
    current = parseLiveMarker(id, await readFile(runningPath, "utf8"));
  } catch {
    return;
  }
  const next: LiveTurnMarker = { ...current, ...patch };
  const tmpPath = `${runningPath}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, runningPath);
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Write the terminal state BEFORE removing the marker — same commit
 * ordering as `DispatchWatcher.finish` / writeDone. If the done-file write
 * fails, the running-file is left so recovery can see it.
 *
 * If a done-file already exists the running-file is just dropped (the
 * command layer may have already finalized this as cancelled).
 */
export async function finishLiveTurn(
  dataDir: string,
  result: LiveTurnResult
): Promise<boolean> {
  const dirs = await ensureTurnDirs(dataDir);
  const name = `${result.id}.json`;
  const finalPath = path.join(dirs.done, name);
  const tmpPath = `${finalPath}.tmp`;
  const runningPath = path.join(dirs.running, name);
  if (await exists(finalPath)) {
    try {
      const st = await stat(finalPath);
      if (st.isFile()) {
        await rm(runningPath, { force: true }).catch(() => {});
        return true;
      }
    } catch {
      /* fall through and try to write */
    }
    // A non-file at the done path is not a valid terminal write — leave
    // the running-file so recovery can still see the turn.
    return false;
  }
  try {
    await writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
    return false; // leave the running-file so recovery can see it
  }
  await rm(runningPath, { force: true }).catch(() => {});
  return true;
}

export async function listLiveMarkers(dataDir: string): Promise<LiveTurnMarker[]> {
  const dirs = turnDirs(dataDir);
  let names: string[];
  try {
    names = await readdir(dirs.running);
  } catch {
    return [];
  }
  const out: LiveTurnMarker[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (await exists(path.join(dirs.done, name))) continue;
    try {
      out.push(parseLiveMarker(id, await readFile(path.join(dirs.running, name), "utf8")));
    } catch {
      // Unparseable — ignore (tmp leftovers).
    }
  }
  return out;
}

export async function listAbandonedLiveTurns(dataDir: string): Promise<LiveTurnResult[]> {
  const dirs = turnDirs(dataDir);
  let names: string[];
  try {
    names = await readdir(dirs.done);
  } catch {
    return [];
  }
  const out: LiveTurnResult[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dirs.done, name), "utf8")) as LiveTurnResult;
      if (raw?.status === "abandoned" && raw.id && raw.channelRef) out.push(raw);
    } catch {
      // ignore
    }
  }
  return out;
}

export async function readLiveMarker(
  dataDir: string,
  id: string
): Promise<LiveTurnMarker | null> {
  const dirs = turnDirs(dataDir);
  try {
    return parseLiveMarker(id, await readFile(path.join(dirs.running, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function parseLiveMarker(id: string, raw: string): LiveTurnMarker {
  const json = JSON.parse(raw) as Partial<LiveTurnMarker>;
  if (!json.channelRef || !json.sessionRecordId || !json.startedUtc) {
    throw new Error("invalid live-turn marker");
  }
  return {
    id,
    kind: "live",
    channelRef: json.channelRef,
    ...(json.parentRef ? { parentRef: json.parentRef } : {}),
    sessionRecordId: json.sessionRecordId,
    ...(json.acpSessionId ? { acpSessionId: json.acpSessionId } : {}),
    ...(json.authorId ? { authorId: json.authorId } : {}),
    startedUtc: json.startedUtc,
  };
}

export function abandonedNotice(reason: string, maxAgeSeconds: number): string {
  if (reason === "past max-age") {
    const hours = Math.round(maxAgeSeconds / 3600);
    return `⏸️ abandoned interrupted turn (older than ${hours}h) — not resuming`;
  }
  if (reason === "thread deleted") {
    return "⏸️ abandoned interrupted turn (thread deleted)";
  }
  return `⏸️ abandoned interrupted turn (${reason})`;
}

/**
 * Staggered, concurrency-capped queue for resume starts. Holds a slot for
 * the duration of `fn` so N resumes do not fire simultaneously at boot.
 */
export function createResumeScheduler(opts?: {
  concurrency?: number;
  staggerMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** How many `run`s have been handed a start slot (testable). */
  started: () => number;
  active: () => number;
} {
  const concurrency = opts?.concurrency ?? TURN_RESUME_CONCURRENCY;
  const staggerMs = opts?.staggerMs ?? TURN_RESUME_STAGGER_MS;
  const now = opts?.now ?? Date.now;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let inFlight = 0;
  let started = 0;
  let lastStart = Number.NaN;
  const waiters: Array<() => void> = [];

  const pump = (): void => {
    const next = waiters.shift();
    if (next) next();
  };

  return {
    started: () => started,
    active: () => inFlight,
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      while (inFlight >= concurrency) {
        await new Promise<void>((r) => waiters.push(r));
      }
      const wait = Number.isNaN(lastStart) ? 0 : Math.max(0, staggerMs - (now() - lastStart));
      if (wait > 0) await sleep(wait);
      lastStart = now();
      inFlight++;
      started++;
      try {
        return await fn();
      } finally {
        inFlight--;
        pump();
      }
    },
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
