import fsp from "node:fs/promises";
import { runBoundedProbe, type RemoteHostOomEvidence } from "@seam/adapters";

/**
 * Remote OOM evidence (#516).
 *
 * The 2026-09-21/22 incidents killed a long-lived descendant and left its ACP
 * wrapper to exit 1 several seconds later. Exit code 1 is not OOM evidence;
 * the kernel record is. The bridge is the narrow owner that can observe both
 * the process tree and that record, so it matches those facts here and sends
 * only a closed, non-secret result to the controller. If collection is absent,
 * bounded, or ambiguous, only the OOM diagnosis is refused; ordinary exit
 * reporting and every other slot keep working.
 */

// Both observed wrappers exited 8–10s after the descendant OOM. One-second
// ownership sampling gives at least eight chances to see that descendant; a
// 30s journal window is three times the longest observed reporting lag.
export const OOM_PROCESS_SAMPLE_MS = 1_000;
export const OOM_EVIDENCE_LOOKBACK_MS = 30_000;
// Three sample periods tolerate scheduling jitter while keeping the positive
// match narrow enough to refuse an old pid reused later in a long session.
export const OOM_OBSERVATION_SLACK_MS = 3_000;
export const OOM_JOURNAL_TIMEOUT_MS = 2_000;
// Current bridge trees have five processes. 4,096 is deliberately orders of
// magnitude above that while still preventing hostile fork growth from making
// diagnostic bookkeeping itself unbounded.
export const OOM_MAX_TRACKED_PIDS = 4_096;
const OOM_SAMPLE_SETTLE_MS = 500;
const OOM_MAX_TASKS_PER_PROCESS = 1_024;
const OOM_JOURNAL_MAX_BYTES = 256 * 1024;
const OOM_CLOCK_SKEW_MS = 2_000;

export interface KernelOomRecord {
  killedPid: number;
  observedAt: number;
  scope: RemoteHostOomEvidence["scope"];
}

export interface OomEvidenceTracker {
  /** Test/diagnostic seam; production sampling also runs every second. */
  sampleNow(): Promise<void>;
  /** Idempotent: one bounded journal read, then the same result for every caller. */
  finish(exitAt?: number): Promise<RemoteHostOomEvidence | undefined>;
  /** Stop bookkeeping when no exit frame will be emitted. */
  cancel(): void;
}

export interface OomEvidenceRegistry {
  attach(slot: number, rootPid: number | undefined): void;
  drop(slot: number): void;
  exitPayload(
    slot: number,
    payload: Record<string, unknown>,
    abnormal: boolean,
  ): Promise<Record<string, unknown>>;
}

interface TrackerOptions {
  now?: () => number;
  sampleIntervalMs?: number;
  maxTrackedPids?: number;
  readChildren?: (pid: number) => Promise<readonly number[]>;
  queryKernel?: (sinceMs: number, untilMs: number) => Promise<readonly KernelOomRecord[]>;
}

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 2;
}

/** Parse facts only. Raw kernel text is never retained or forwarded. */
export function parseKernelOomRecords(text: string): KernelOomRecord[] {
  const records: KernelOomRecord[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const prefix = /^(\d+(?:\.\d+)?)\s+\S+\s+kernel:\s+(.*)$/.exec(line.trim());
    if (!prefix) continue;
    const observedAt = Number(prefix[1]) * 1_000;
    const message = prefix[2]!;
    const summary = /\boom-kill:.*\bpid=(\d+)\b/.exec(message);
    const killed = /\bOut of memory:\s+Killed process\s+(\d+)\b/.exec(message);
    const killedPid = Number(summary?.[1] ?? killed?.[1]);
    if (!Number.isFinite(observedAt) || !positivePid(killedPid)) continue;
    const key = `${Math.trunc(observedAt / 1_000)}:${killedPid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      killedPid,
      observedAt,
      scope: message.includes("global_oom")
        ? "global"
        : /constraint=CONSTRAINT_(?:MEMCG|MEMORY_POLICY)/.test(message)
          ? "cgroup"
          : "unknown",
    });
  }
  return records;
}

async function readDirectChildren(pid: number): Promise<readonly number[]> {
  let tasks: string[];
  try {
    tasks = await fsp.readdir(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const childPids = new Set<number>();
  for (const task of tasks.filter((entry) => /^\d+$/.test(entry)).slice(0, OOM_MAX_TASKS_PER_PROCESS)) {
    let text: string;
    try {
      text = await fsp.readFile(`/proc/${pid}/task/${task}/children`, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.trim().split(/\s+/)) {
      const child = Number(raw);
      if (positivePid(child)) childPids.add(child);
    }
  }
  return [...childPids];
}

async function queryKernelOoms(sinceMs: number, untilMs: number): Promise<readonly KernelOomRecord[]> {
  try {
    return await runBoundedProbe({
      executable: "journalctl",
      args: [
        "-k",
        "--since", `@${Math.floor(sinceMs / 1_000)}`,
        "--until", `@${Math.ceil(untilMs / 1_000)}`,
        "--no-pager",
        "-o", "short-unix",
      ],
      timeoutMs: OOM_JOURNAL_TIMEOUT_MS,
      killGraceMs: 250,
      finalizeDeadlineMs: 500,
      maxStdoutBytes: OOM_JOURNAL_MAX_BYTES,
      maxStderrBytes: 32 * 1024,
      allowCleanExit: true,
      label: "kernel OOM evidence query",
      run: async (handle) => {
        handle.stdin.end();
        const chunks: Buffer[] = [];
        for await (const chunk of handle.stdout) chunks.push(Buffer.from(chunk));
        await handle.completed;
        return parseKernelOomRecords(Buffer.concat(chunks).toString("utf8"));
      },
    });
  } catch {
    // Journal access is an optional diagnostic capability. It may refuse only
    // this one diagnosis, never an agent, a host, or the exit frame itself.
    return [];
  }
}

export function createOomEvidenceTracker(
  rootPid: number | undefined,
  options: TrackerOptions = {},
): OomEvidenceTracker {
  const now = options.now ?? Date.now;
  const readChildren = options.readChildren ?? readDirectChildren;
  const queryKernel = options.queryKernel ?? queryKernelOoms;
  const maxTrackedPids = options.maxTrackedPids ?? OOM_MAX_TRACKED_PIDS;
  const sampleIntervalMs = options.sampleIntervalMs ?? OOM_PROCESS_SAMPLE_MS;
  const lastSeen = new Map<number, number>();
  let bounded = false;
  let cancelled = false;
  let sampling: Promise<void> | undefined;
  let finished: Promise<RemoteHostOomEvidence | undefined> | undefined;

  const sample = async (): Promise<void> => {
    if (cancelled || bounded || !positivePid(rootPid ?? 0)) return;
    const seenThisSample = new Set<number>();
    const queue = [rootPid!];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seenThisSample.has(pid)) continue;
      if (seenThisSample.size >= maxTrackedPids) {
        // A partial process tree is not positive ancestry evidence. Refuse the
        // OOM label for this exit while the exit itself continues normally.
        bounded = true;
        return;
      }
      seenThisSample.add(pid);
      lastSeen.set(pid, now());
      const children = await readChildren(pid).catch(() => []);
      for (const child of children) if (positivePid(child) && !seenThisSample.has(child)) queue.push(child);
    }
  };

  const sampleNow = (): Promise<void> => {
    if (!sampling) {
      sampling = sample().finally(() => { sampling = undefined; });
    }
    return sampling;
  };

  void sampleNow();
  const timer = setInterval(() => { void sampleNow(); }, sampleIntervalMs);
  timer.unref?.();

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    clearInterval(timer);
  };

  return {
    sampleNow,
    cancel,
    finish(exitAt = now()) {
      if (finished) return finished;
      cancel();
      finished = (async () => {
        if (sampling) {
          // /proc normally resolves in microseconds. Under the exact host
          // pressure this diagnoses, waiting without a ceiling would replace
          // a clear exit with another stuck turn. A prior sample remains valid.
          let timeout: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              sampling.catch(() => undefined),
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, OOM_SAMPLE_SETTLE_MS);
                timeout.unref?.();
              }),
            ]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        }
        if (bounded || lastSeen.size === 0) return undefined;
        const since = exitAt - OOM_EVIDENCE_LOOKBACK_MS;
        const records = await queryKernel(since, exitAt + OOM_CLOCK_SKEW_MS).catch(() => []);
        const match = [...records]
          .filter((record) => {
            const seenAt = lastSeen.get(record.killedPid);
            return seenAt !== undefined
              && record.observedAt >= since
              && record.observedAt <= exitAt + OOM_CLOCK_SKEW_MS
              && record.observedAt >= seenAt - OOM_OBSERVATION_SLACK_MS
              && record.observedAt <= seenAt + OOM_OBSERVATION_SLACK_MS;
          })
          .sort((a, b) => b.observedAt - a.observedAt)[0];
        return match ? { kind: "host_oom", ...match } : undefined;
      })();
      return finished;
    },
  };
}

/**
 * Per-slot owner for publication as well as collection. Keeping the
 * `hostOom` field here makes the production exit path executable in tests;
 * when publication lived as a spread in the CLI entrypoint, deleting that
 * exact line survived every behavioural test even though the diagnosis was
 * then lost on the wire.
 */
export function createOomEvidenceRegistry(options: {
  trackerFactory?: (rootPid: number | undefined) => OomEvidenceTracker;
} = {}): OomEvidenceRegistry {
  const factory = options.trackerFactory ?? ((pid) => createOomEvidenceTracker(pid));
  const trackers = new Map<number, OomEvidenceTracker>();
  return {
    attach(slot, rootPid) {
      trackers.get(slot)?.cancel();
      trackers.set(slot, factory(rootPid));
    },
    drop(slot) {
      trackers.get(slot)?.cancel();
      trackers.delete(slot);
    },
    async exitPayload(slot, payload, abnormal) {
      const tracker = trackers.get(slot);
      trackers.delete(slot);
      if (!tracker) return payload;
      if (!abnormal) {
        tracker.cancel();
        return payload;
      }
      const hostOom = await tracker.finish();
      return hostOom ? { ...payload, hostOom } : payload;
    },
  };
}
