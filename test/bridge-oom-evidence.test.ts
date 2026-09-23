import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createOomEvidenceRegistry,
  createOomEvidenceTracker,
  parseKernelOomRecords,
  type KernelOomRecord,
} from "../packages/bridge/src/oom-evidence.js";

const KERNEL_SAMPLE = [
  "1790033574.259647 fhr-server kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/seam-bridge.service,task=node,pid=221249,uid=1000",
  "1790033574.260775 fhr-server kernel: Out of memory: Killed process 221249 (node) total-vm:2233508kB, anon-rss:619500kB, oom_score_adj:300",
].join("\n");

describe("#516 bridge-owned kernel OOM evidence", () => {
  it("reduces the real journal shape to a closed fact without retaining raw text", () => {
    expect(parseKernelOomRecords(KERNEL_SAMPLE)).toEqual([{
      killedPid: 221249,
      observedAt: 1_790_033_574_259.647,
      scope: "global",
    }]);
    expect(JSON.stringify(parseKernelOomRecords(KERNEL_SAMPLE))).not.toContain("seam-bridge.service");
    expect(JSON.stringify(parseKernelOomRecords(KERNEL_SAMPLE))).not.toContain("node");
  });

  it("matches only a recent kernel victim observed in this exact process tree", async () => {
    let now = 1_790_033_573_000;
    const children = new Map([[100, [200]], [200, [221249]], [221249, []]]);
    const query = async (): Promise<KernelOomRecord[]> => [{
      killedPid: 221249,
      observedAt: 1_790_033_574_259,
      scope: "global",
    }];
    const tracker = createOomEvidenceTracker(100, {
      now: () => now,
      sampleIntervalMs: 60_000,
      readChildren: async (pid) => children.get(pid) ?? [],
      queryKernel: query,
    });
    await tracker.sampleNow();
    now = 1_790_033_582_000; // wrapper exits eight seconds after its descendant
    await expect(tracker.finish()).resolves.toEqual({
      kind: "host_oom",
      killedPid: 221249,
      observedAt: 1_790_033_574_259,
      scope: "global",
    });
  });

  it.each([
    ["unrelated pid", 999, 1_790_033_574_259, 4_096],
    ["stale observation", 221249, 1_790_033_590_001, 4_096],
    ["bounded partial tree", 221249, 1_790_033_574_259, 2],
  ])("refuses %s rather than guessing", async (_case, killedPid, observedAt, maxTrackedPids) => {
    let now = 1_790_033_573_000;
    const children = new Map([[100, [200]], [200, [221249]], [221249, []]]);
    const tracker = createOomEvidenceTracker(100, {
      now: () => now,
      maxTrackedPids,
      sampleIntervalMs: 60_000,
      readChildren: async (pid) => children.get(pid) ?? [],
      queryKernel: async () => [{ killedPid, observedAt, scope: "global" }],
    });
    await tracker.sampleNow();
    now = 1_790_033_600_000;
    await expect(tracker.finish()).resolves.toBeUndefined();
  });

  it("publishes the matched fact through the per-slot production registry", async () => {
    const hostOom = {
      kind: "host_oom" as const,
      killedPid: 221249,
      observedAt: 1_790_033_574_259,
      scope: "global" as const,
    };
    const finish = vi.fn(async () => hostOom);
    const cancel = vi.fn();
    const registry = createOomEvidenceRegistry({ trackerFactory: () => ({
      sampleNow: async () => {},
      finish,
      cancel,
    }) });
    registry.attach(7, 100);
    await expect(registry.exitPayload(7, { code: 1 }, true)).resolves.toEqual({ code: 1, hostOom });
    expect(finish).toHaveBeenCalledOnce();
    await expect(registry.exitPayload(7, { code: 1 }, true)).resolves.toEqual({ code: 1 });
  });

  it("keeps the unimportable bridge CLI wired through the tested registry", () => {
    // index.ts invokes the CLI on import, so it cannot be executed in-process.
    // The registry above owns the behaviour; this narrow contract pins its one
    // production call site after deleting that call survived mutation.
    const source = readFileSync(path.resolve("packages/bridge/src/index.ts"), "utf8");
    expect(source).toMatch(/oomEvidence\.exitPayload\(frame\.slot, payload, abnormal\)\.then\(\(exitPayload\) => \{/);
    expect(source).toMatch(/wsSend\(\{\s*slot: frame\.slot,\s*type: "exit",\s*\.\.\.exitPayload,/s);
  });
});
