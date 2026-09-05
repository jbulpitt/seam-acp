import { describe, expect, it } from "vitest";
import { runPremiumCompaction } from "../packages/core/src/core/compaction/pipeline.js";
import type { RichHistory } from "../packages/core/src/core/compaction/source-reader.js";

const executor = { id: "agy", displayName: "AGY", model: "gemini-3.8-flash-high" };

function history(count: number): RichHistory {
  const events = Array.from({ length: count }, (_, i) => ({
    kind: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    ts: Date.parse("2026-01-01T00:00:00Z") + i * 1000,
    text: `turn ${i} ${"detail ".repeat(40)}`,
  }));
  return {
    events,
    stats: {
      totalEvents: events.length,
      userTurns: events.filter((e) => e.kind === "user").length,
      assistantTurns: events.filter((e) => e.kind === "assistant").length,
      thinkingKept: 0,
      thinkingRedactedSkipped: 0,
      toolEvents: 0,
      estimatedTokens: 100,
      thinkingAvailable: false,
    },
  };
}

const gapReport = { signals: [], discordRanges: [], needDiscord: false };

describe("runPremiumCompaction analysis executor", () => {
  it("records the actual executor/model instead of hard-coding Gemini", async () => {
    const labels: string[] = [];
    const result = await runPremiumCompaction({
      richHistory: history(12),
      gapReport,
      runAgent: async (_prompt, label) => {
        labels.push(label);
        if (label.startsWith("pinned")) {
          return JSON.stringify({
            corrections: [],
            constraints: [],
            decisions: [],
            openTodos: [],
            activePaths: [],
            rules: [],
          });
        }
        return `summary for ${label}`;
      },
      analysisExecutor: executor,
    });
    expect(result.assembledSeed).toContain("AGY · gemini-3.8-flash-high");
    expect(result.assembledSeed).not.toMatch(/using Gemini\./);
    expect(result.analysisExecutor).toEqual(executor);
    expect(labels.some((l) => l.startsWith("chunk-"))).toBe(true);
    expect(labels.some((l) => l.startsWith("pinned-"))).toBe(true);
  });

  it("fail-closed aborts the run on an analysis failure instead of stubbing", async () => {
    await expect(
      runPremiumCompaction({
        richHistory: history(12),
        gapReport,
        runAgent: async (_prompt, label) => {
          if (label === "chunk-0") throw new Error("agy rejected model");
          return "ok";
        },
        analysisExecutor: executor,
        failClosed: true,
      })
    ).rejects.toThrow(/agy\/gemini-3\.8-flash-high failed at chunk-0/);
  });

  it("without failClosed, a chunk failure still degrades to a stub (session path)", async () => {
    const result = await runPremiumCompaction({
      richHistory: history(12),
      gapReport,
      runAgent: async (_prompt, label) => {
        if (label === "chunk-0") throw new Error("temporary");
        if (label.startsWith("pinned")) {
          return JSON.stringify({
            corrections: [],
            constraints: [],
            decisions: [],
            openTodos: [],
            activePaths: [],
            rules: [],
          });
        }
        return "ok";
      },
      analysisExecutor: { id: "claude", displayName: "Claude", model: "default" },
    });
    expect(result.assembledSeed).toContain("Failed to summarize middle segment");
    expect(result.assembledSeed).toContain("Claude · default");
  });
});
