// Delegation-ledger anomaly detection (issue #26, detection slice).
//
// A set of PURE functions over an array of `LedgerEntry`. They read the ledger
// and describe what looks wrong — nothing here writes, schedules, or parks.
// Auto-remediation (status=parked, periodic checks) is a deliberately separate,
// later slice. Because these back the `/seam workflows` view and its tests,
// `now` is always passed in — no `Date.now()` inside — so results are
// deterministic for a given input.

import type { LedgerEntry } from "./types.js";
import { DELEGATION_ACTIVE_STATUSES } from "./types.js";

// --- loops -----------------------------------------------------------------

/** A delegation cycle, e.g. `A→B→A`. `cycle` lists the refs in the loop. */
export interface Loop {
  cycle: string[];
}

/**
 * Find delegation loops in the `sourceRef→targetRef` graph.
 *
 * Edges come from rows where both refs are present. A cycle is either a
 * strongly-connected component of two or more nodes (A→B→A, A→B→C→A) or a
 * self-loop (a row whose source and target are the same ref). Node order
 * within a returned cycle is sorted for deterministic output.
 */
export function detectLoops(entries: LedgerEntry[]): Loop[] {
  const adj = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const e of entries) {
    if (!e.sourceRef || !e.targetRef) continue;
    nodes.add(e.sourceRef);
    nodes.add(e.targetRef);
    let out = adj.get(e.sourceRef);
    if (!out) {
      out = new Set();
      adj.set(e.sourceRef, out);
    }
    out.add(e.targetRef);
  }

  const loops: Loop[] = [];
  for (const comp of stronglyConnectedComponents(nodes, adj)) {
    if (comp.length > 1) {
      loops.push({ cycle: [...comp].sort() });
    } else {
      // A singleton SCC is a cycle only if the node points at itself.
      const only = comp[0]!;
      if (adj.get(only)?.has(only)) loops.push({ cycle: [only] });
    }
  }
  return loops;
}

/** Tarjan's SCC algorithm. Returns every strongly-connected component. */
function stronglyConnectedComponents(
  nodes: Set<string>,
  adj: Map<string, Set<string>>
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongconnect = (v: string): void => {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };

  for (const v of nodes) if (!indices.has(v)) strongconnect(v);
  return sccs;
}

// --- frequency spikes ------------------------------------------------------

/** A source that dispatched more than `max` times inside the window. */
export interface FrequencySpike {
  sourceRef: string;
  /** Peak dispatch count found in any single `windowMs`-wide window. */
  count: number;
}

export interface FrequencyOpts {
  /** Sliding-window width. Default 10 minutes. */
  windowMs?: number;
  /** A source is a spike when its peak window count exceeds this. Default 20. */
  max?: number;
}

const DEFAULT_FREQUENCY_WINDOW_MS = 10 * 60_000;
const DEFAULT_FREQUENCY_MAX = 20;

/**
 * Sources whose dispatch rate spikes above `max` within any `windowMs` window.
 *
 * Each row (with a source) counts as one dispatch at its `createdUtc`. For each
 * source we slide a `windowMs` window over its sorted timestamps and take the
 * peak count; a source is reported when that peak exceeds `max`. The window is
 * half-open — rows less than `windowMs` apart share a window. Results are
 * sorted by count (desc), then source ref, for stable output.
 */
export function detectFrequencySpikes(
  entries: LedgerEntry[],
  opts: FrequencyOpts = {}
): FrequencySpike[] {
  const windowMs = opts.windowMs ?? DEFAULT_FREQUENCY_WINDOW_MS;
  const max = opts.max ?? DEFAULT_FREQUENCY_MAX;

  const bySource = new Map<string, number[]>();
  for (const e of entries) {
    if (!e.sourceRef) continue;
    const t = Date.parse(e.createdUtc);
    if (Number.isNaN(t)) continue;
    let times = bySource.get(e.sourceRef);
    if (!times) {
      times = [];
      bySource.set(e.sourceRef, times);
    }
    times.push(t);
  }

  const spikes: FrequencySpike[] = [];
  for (const [sourceRef, times] of bySource) {
    times.sort((a, b) => a - b);
    let peak = 0;
    let lo = 0;
    for (let hi = 0; hi < times.length; hi++) {
      while (times[hi]! - times[lo]! >= windowMs) lo++;
      peak = Math.max(peak, hi - lo + 1);
    }
    if (peak > max) spikes.push({ sourceRef, count: peak });
  }

  spikes.sort((a, b) => b.count - a.count || a.sourceRef.localeCompare(b.sourceRef));
  return spikes;
}

// --- quiet targets ---------------------------------------------------------

export interface QuietOpts {
  /** How long a still-active row may go without an update. Default 30 minutes. */
  timeoutMs?: number;
}

const DEFAULT_QUIET_TIMEOUT_MS = 30 * 60_000;

/**
 * Rows still `dispatched`/`running` that have gone quiet — no `updatedUtc`
 * activity for longer than `timeoutMs`. These are handoffs that neither
 * completed nor failed and have stopped reporting progress. Measured from
 * `updatedUtc` (last sign of life), not `createdUtc`, so an actively-updating
 * long turn is not flagged.
 */
export function detectQuietTargets(
  entries: LedgerEntry[],
  now: Date,
  opts: QuietOpts = {}
): LedgerEntry[] {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUIET_TIMEOUT_MS;
  const nowMs = now.getTime();
  return entries.filter((e) => {
    if (!DELEGATION_ACTIVE_STATUSES.includes(e.status)) return false;
    const t = Date.parse(e.updatedUtc);
    if (Number.isNaN(t)) return false;
    return nowMs - t > timeoutMs;
  });
}

// --- summary ---------------------------------------------------------------

export interface AnomalySummary {
  loops: Loop[];
  spikes: FrequencySpike[];
  quiet: LedgerEntry[];
}

export interface AnomalyOpts {
  frequency?: FrequencyOpts;
  quiet?: QuietOpts;
}

/** True when a summary holds no anomalies of any kind. */
export function hasAnomalies(summary: AnomalySummary): boolean {
  return (
    summary.loops.length > 0 ||
    summary.spikes.length > 0 ||
    summary.quiet.length > 0
  );
}

/**
 * Run every detector over `entries` in one call — the shape the view consumes.
 * `now` is threaded through to the time-sensitive detectors so the whole
 * summary is deterministic for a given input.
 */
export function summarizeAnomalies(
  entries: LedgerEntry[],
  now: Date,
  opts: AnomalyOpts = {}
): AnomalySummary {
  return {
    loops: detectLoops(entries),
    spikes: detectFrequencySpikes(entries, opts.frequency),
    quiet: detectQuietTargets(entries, now, opts.quiet),
  };
}
