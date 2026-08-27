import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadThreadMigrationPlan,
  parseThreadMigrationPlan,
  runThreadMigrationPool,
} from "../packages/core/src/core/thread-migration.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("thread migration sentinel", () => {
  it("returns null when the sentinel is missing", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "seam-thread-migration-"));
    tempDirs.push(dir);
    await expect(loadThreadMigrationPlan(path.join(dir, ".migrate-threads.json"))).resolves.toBeNull();
  });

  it("loads and validates a sentinel file", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "seam-thread-migration-"));
    tempDirs.push(dir);
    const sentinel = path.join(dir, ".migrate-threads.json");
    await fsp.writeFile(
      sentinel,
      JSON.stringify({
        agentId: " codex ",
        model: " gpt-5.6-sol ",
        concurrency: 3,
        threadIds: [" 123 ", "456"],
      })
    );
    await expect(loadThreadMigrationPlan(sentinel)).resolves.toEqual({
      agentId: "codex",
      model: "gpt-5.6-sol",
      concurrency: 3,
      threadIds: ["123", "456"],
    });
  });

  it("rejects invalid JSON from the sentinel file", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "seam-thread-migration-"));
    tempDirs.push(dir);
    const sentinel = path.join(dir, ".migrate-threads.json");
    await fsp.writeFile(sentinel, "{not-json");
    await expect(loadThreadMigrationPlan(sentinel)).rejects.toThrow(/Invalid thread migration JSON/);
  });

  it("rejects malformed plans", () => {
    expect(() => parseThreadMigrationPlan({})).toThrow(/agentId/);
    expect(() =>
      parseThreadMigrationPlan({ agentId: "codex", model: "gpt-5.6-sol", threadIds: [] })
    ).toThrow(/threadIds/);
    expect(() =>
      parseThreadMigrationPlan({
        agentId: "codex",
        model: "gpt-5.6-sol",
        concurrency: "two",
        threadIds: ["123"],
      })
    ).toThrow(/concurrency/);
  });

  it("defaults concurrency to two and clamps it to one through four", () => {
    const base = { agentId: "codex", model: "gpt-5.6-sol", threadIds: ["123"] };
    expect(parseThreadMigrationPlan(base).concurrency).toBe(2);
    expect(parseThreadMigrationPlan({ ...base, concurrency: 0 }).concurrency).toBe(1);
    expect(parseThreadMigrationPlan({ ...base, concurrency: 99 }).concurrency).toBe(4);
  });
});

describe("thread migration pool", () => {
  it("bounds concurrency and isolates a per-thread failure", async () => {
    let active = 0;
    let peak = 0;
    const outcomes = await runThreadMigrationPool(["a", "bad", "c", "d"], 2, async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (id === "bad") throw new Error("expected failure");
      return `session-${id}`;
    });

    expect(peak).toBe(2);
    expect(outcomes).toHaveLength(4);
    expect(outcomes[0]).toEqual({ threadId: "a", ok: true, value: "session-a" });
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[2]).toEqual({ threadId: "c", ok: true, value: "session-c" });
    expect(outcomes[3]).toEqual({ threadId: "d", ok: true, value: "session-d" });
  });
});
