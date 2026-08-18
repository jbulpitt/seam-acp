import { describe, it, expect } from "vitest";
import type { LedgerEntry } from "../src/core/types.js";
import {
  detectLoops,
  detectFrequencySpikes,
  detectQuietTargets,
  summarizeAnomalies,
  hasAnomalies,
} from "../src/core/watchdog.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");

let seq = 0;
const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: `del-${(seq++).toString().padStart(4, "0")}`,
  sourceRef: "discord:thread-a",
  targetRef: "discord:thread-b",
  worker: "researcher",
  kind: "handoff",
  promptPreview: "do the thing",
  correlationId: null,
  acpSessionId: null,
  status: "completed",
  createdUtc: "2026-08-16T11:00:00.000Z",
  updatedUtc: "2026-08-16T11:00:00.000Z",
  ...over,
});

// Timestamp `minsBefore` minutes before NOW.
const ago = (minsBefore: number): string =>
  new Date(NOW.getTime() - minsBefore * 60_000).toISOString();

describe("detectLoops", () => {
  it("finds a simple A→B→A cycle", () => {
    const loops = detectLoops([
      entry({ sourceRef: "A", targetRef: "B" }),
      entry({ sourceRef: "B", targetRef: "A" }),
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.cycle).toEqual(["A", "B"]);
  });

  it("finds a longer A→B→C→A cycle", () => {
    const loops = detectLoops([
      entry({ sourceRef: "A", targetRef: "B" }),
      entry({ sourceRef: "B", targetRef: "C" }),
      entry({ sourceRef: "C", targetRef: "A" }),
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.cycle).toEqual(["A", "B", "C"]);
  });

  it("detects a self-loop (A→A)", () => {
    const loops = detectLoops([entry({ sourceRef: "A", targetRef: "A" })]);
    expect(loops).toEqual([{ cycle: ["A"] }]);
  });

  it("returns nothing for an acyclic chain", () => {
    const loops = detectLoops([
      entry({ sourceRef: "A", targetRef: "B" }),
      entry({ sourceRef: "B", targetRef: "C" }),
      entry({ sourceRef: "C", targetRef: "D" }),
    ]);
    expect(loops).toEqual([]);
  });

  it("ignores rows with a missing ref (no edge)", () => {
    const loops = detectLoops([
      entry({ sourceRef: "A", targetRef: null }),
      entry({ sourceRef: null, targetRef: "A" }),
    ]);
    expect(loops).toEqual([]);
  });
});

describe("detectFrequencySpikes", () => {
  it("flags a source exceeding max within the window", () => {
    // 25 dispatches from one source inside a ~4-minute span → spike (default max 20).
    const rows = Array.from({ length: 25 }, (_, i) =>
      entry({ sourceRef: "busy", createdUtc: ago(10 - i * 0.15) })
    );
    const spikes = detectFrequencySpikes(rows);
    expect(spikes).toEqual([{ sourceRef: "busy", count: 25 }]);
  });

  it("does not flag dispatches spread outside the window", () => {
    // 25 dispatches, one every 5 minutes → never more than a few per 10-min window.
    const rows = Array.from({ length: 25 }, (_, i) =>
      entry({ sourceRef: "steady", createdUtc: ago(5 * i) })
    );
    expect(detectFrequencySpikes(rows)).toEqual([]);
  });

  it("respects custom window/max options", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      entry({ sourceRef: "S", createdUtc: ago(1 - i * 0.1) })
    );
    expect(detectFrequencySpikes(rows, { windowMs: 60_000, max: 3 })).toEqual([
      { sourceRef: "S", count: 4 },
    ]);
    expect(detectFrequencySpikes(rows, { windowMs: 60_000, max: 5 })).toEqual([]);
  });

  it("counts each source independently", () => {
    const rows = [
      ...Array.from({ length: 22 }, (_, i) =>
        entry({ sourceRef: "loud", createdUtc: ago(9 - i * 0.2) })
      ),
      ...Array.from({ length: 5 }, () =>
        entry({ sourceRef: "quiet", createdUtc: ago(1) })
      ),
    ];
    const spikes = detectFrequencySpikes(rows);
    expect(spikes.map((s) => s.sourceRef)).toEqual(["loud"]);
  });
});

describe("detectQuietTargets", () => {
  it("flags active rows stale past the timeout", () => {
    const stale = entry({
      id: "del-stale",
      status: "running",
      updatedUtc: ago(45),
    });
    const quiet = detectQuietTargets([stale], NOW);
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.id).toBe("del-stale");
  });

  it("ignores recently-updated active rows", () => {
    const fresh = entry({ status: "dispatched", updatedUtc: ago(5) });
    expect(detectQuietTargets([fresh], NOW)).toEqual([]);
  });

  it("ignores terminal rows even when old", () => {
    const done = entry({ status: "completed", updatedUtc: ago(120) });
    const failed = entry({ status: "failed", updatedUtc: ago(120) });
    const parked = entry({ status: "parked", updatedUtc: ago(120) });
    expect(detectQuietTargets([done, failed, parked], NOW)).toEqual([]);
  });

  it("respects a custom timeout", () => {
    const row = entry({ status: "running", updatedUtc: ago(20) });
    expect(detectQuietTargets([row], NOW, { timeoutMs: 10 * 60_000 })).toHaveLength(1);
    expect(detectQuietTargets([row], NOW, { timeoutMs: 60 * 60_000 })).toEqual([]);
  });
});

describe("summarizeAnomalies", () => {
  it("reports a clean ledger as having no anomalies", () => {
    const clean = [
      entry({ sourceRef: "A", targetRef: "B", status: "completed" }),
      entry({ sourceRef: "B", targetRef: "C", status: "completed" }),
      entry({
        sourceRef: "C",
        targetRef: "D",
        status: "running",
        updatedUtc: ago(2),
      }),
    ];
    const summary = summarizeAnomalies(clean, NOW);
    expect(summary).toEqual({ loops: [], spikes: [], quiet: [] });
    expect(hasAnomalies(summary)).toBe(false);
  });

  it("surfaces all three anomaly kinds at once", () => {
    const rows = [
      // loop A→B→A
      entry({ sourceRef: "A", targetRef: "B", status: "completed" }),
      entry({ sourceRef: "B", targetRef: "A", status: "completed" }),
      // frequency spike from "S"
      ...Array.from({ length: 25 }, (_, i) =>
        entry({ sourceRef: "S", targetRef: "T", createdUtc: ago(9 - i * 0.2) })
      ),
      // quiet target
      entry({
        id: "del-quiet",
        sourceRef: "X",
        targetRef: "Y",
        status: "running",
        updatedUtc: ago(90),
      }),
    ];
    const summary = summarizeAnomalies(rows, NOW);
    expect(summary.loops).toEqual([{ cycle: ["A", "B"] }]);
    expect(summary.spikes.some((s) => s.sourceRef === "S")).toBe(true);
    expect(summary.quiet.map((q) => q.id)).toContain("del-quiet");
    expect(hasAnomalies(summary)).toBe(true);
  });
});
