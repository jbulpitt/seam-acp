import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import {
  dispatchDirs,
  findQueuedReportBackSpec,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-worker",
  platform: "discord",
  channelRef: "thread-worker",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00.000Z",
  updatedUtc: "2026-01-01T00:00:00.000Z",
  ...over,
});

function makeOrch(): Orchestrator {
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    reuseMcpServers: () => [],
    ensureSessionRecord: (o: { channelRef: string }) =>
      record({ id: `discord:${o.channelRef}`, channelRef: o.channelRef }),
    getProfile: () => ({ id: "claude" }),
    getOrStartRuntime: async () => ({
      onEvent() {},
      async prompt() {
        return { stopReason: "end_turn" };
      },
      async idle() {},
      getSessionInfo() {
        return { sessionId: "acp-1" };
      },
      async dispose() {},
    }),
  };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "default",
      SEAM_DISPATCH_STATUS_PANEL: false,
      SEAM_DISPATCH_OUTPUT_STYLE: "messages",
    } as any,
    adapter: {
      async sendMessage() {
        return { channel: { platform: "discord", id: "x" }, id: "m" };
      },
      async editMessage() {},
    } as any,
    router: router as any,
    store,
    renderer: {} as any,
  });
  (orch as any).postDispatchStartIndicator = async () => undefined;
  (orch as any).postDispatchOutput = async () => {};
  (orch as any).injectTurn = async () => ({
    text: "worker result",
    error: undefined,
    stopReason: "end_turn",
  });
  return orch;
}

function handoffSpec(over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    id: "disp-original",
    target: "thread-worker",
    prompt: "do the work",
    session: "isolated",
    returnTo: "thread-boss",
    kind: "handoff",
    correlationId: "corr-x",
    createdUtc: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function pendingSpecs(): DispatchSpec[] {
  const { pending } = dispatchDirs(dir);
  if (!fs.existsSync(pending)) return [];
  return fs
    .readdirSync(pending)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(pending, n), "utf8")) as DispatchSpec);
}

function specsIn(subdir: "pending" | "running" | "done"): string[] {
  const root = dispatchDirs(dir)[subdir];
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => n.endsWith(".json")).sort();
}

function reportBackRows(correlationId: string) {
  return store
    .listRecentDelegations()
    .filter((e) => e.kind === "report_back" && e.correlationId === correlationId);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-rb-dedup-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("report-back enqueue is idempotent on correlationId (#77)", () => {
  it("a normal (uninterrupted) handoff enqueues exactly one report-back and one ledger row", async () => {
    const orch = makeOrch();
    await orch.dispatchInjectTurn(handoffSpec());

    const rbs = pendingSpecs().filter((s) => s.kind === "report_back");
    expect(rbs).toHaveLength(1);
    expect(rbs[0]).toMatchObject({
      target: "thread-boss",
      kind: "report_back",
      correlationId: "corr-x",
    });
    expect(rbs[0]!.prompt).toContain("worker result");
    expect(reportBackRows("corr-x")).toHaveLength(1);
    expect(store.getReportBackByCorrelation("corr-x")?.id).toBe(rbs[0]!.id);
  });

  it("a second enqueue for the same correlation is a no-op (ledger claim)", async () => {
    const orch = makeOrch();
    const spec = handoffSpec();
    await (orch as any).enqueueReportBack(spec, "first result");
    await (orch as any).enqueueReportBack(spec, "second result — must not land");

    const rbs = pendingSpecs().filter((s) => s.kind === "report_back");
    expect(rbs).toHaveLength(1);
    expect(rbs[0]!.prompt).toContain("first result");
    expect(rbs[0]!.prompt).not.toContain("must not land");
    expect(reportBackRows("corr-x")).toHaveLength(1);
  });

  it("killing between report-back enqueue and done-file, then restarting, delivers exactly once", async () => {
    const orch = makeOrch();
    const original = handoffSpec({ session: "isolated" });

    // (1) First run completed the turn and enqueued the report-back.
    await (orch as any).enqueueReportBack(original, "the result");
    expect(pendingSpecs().filter((s) => s.kind === "report_back")).toHaveLength(1);
    expect(reportBackRows("corr-x")).toHaveLength(1);

    // (2) Crash before the watcher's done-file: original still sits in running/.
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    await writeFile(
      path.join(dirs.running, `${original.id}.json`),
      `${JSON.stringify(original, null, 2)}\n`,
      "utf8"
    );
    expect(specsIn("done")).toEqual([]);
    expect(specsIn("running")).toEqual([`${original.id}.json`]);

    // (3) Restart: recoverStale re-enqueues the original; the existing
    // report-back is already in pending/. Both are dispatched this tick.
    let originalReruns = 0;
    let reportBackDeliveries = 0;
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      onDispatch: async (spec) => {
        if (spec.kind === "report_back") {
          reportBackDeliveries++;
          return { output: "delivered", stopReason: "end_turn" };
        }
        originalReruns++;
        // Re-run of the recovered original — the crash-window second shot.
        await (orch as any).enqueueReportBack(spec, "the result AGAIN");
        return { output: spec.prompt.includes("AGAIN") ? "dup" : "the result", stopReason: "end_turn" };
      },
    });
    await watcher.start();
    watcher.stop();

    expect(originalReruns).toBe(1);
    expect(reportBackDeliveries).toBe(1);
    expect(reportBackRows("corr-x")).toHaveLength(1);

    // No second report-back spec was written (pending/running drained; done
    // has the original + the single report-back).
    const doneNames = await readdir(dirs.done);
    const doneBodies = await Promise.all(
      doneNames
        .filter((n) => n.endsWith(".json"))
        .map(async (n) => JSON.parse(await readFile(path.join(dirs.done, n), "utf8")))
    );
    const doneReportBacks = doneBodies.filter((b) => b.correlationId === "corr-x" && b.id !== original.id);
    expect(doneReportBacks).toHaveLength(1);
    expect(await findQueuedReportBackSpec(dir, "corr-x")).toBeNull();
  });

  it("a queued-but-unclaimed spec (no ledger row yet) is found on disk and not duplicated", async () => {
    // Simulate a pre-#77 leftover: the report-back spec is already in pending/
    // but the ledger claim was never written.
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.pending, { recursive: true });
    const leftover: DispatchSpec = {
      id: "rb-leftover",
      target: "thread-boss",
      prompt: "<seam-report-back>old</seam-report-back>",
      session: "live",
      correlationId: "corr-x",
      kind: "report_back",
      createdUtc: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      path.join(dirs.pending, "rb-leftover.json"),
      `${JSON.stringify(leftover, null, 2)}\n`,
      "utf8"
    );
    expect(store.getReportBackByCorrelation("corr-x")).toBeNull();

    const orch = makeOrch();
    await (orch as any).enqueueReportBack(handoffSpec(), "new result");

    const rbs = pendingSpecs().filter((s) => s.kind === "report_back");
    expect(rbs).toHaveLength(1);
    expect(rbs[0]!.id).toBe("rb-leftover");
    // Repair: the leftover is now the durable ledger claim.
    expect(store.getReportBackByCorrelation("corr-x")?.id).toBe("rb-leftover");
    expect(reportBackRows("corr-x")).toHaveLength(1);
  });
});

describe("chain hop advance is idempotent on the completing spec (#77)", () => {
  it("an interrupted hop advances exactly one hop (no double-advance)", async () => {
    // MCP tool already popped hop 1 (`a`) and dispatched it. Remaining: b, c.
    store.createChain({
      id: "chain-1",
      hops: ["b", "c"],
      originRef: "thread-origin",
      promptPreview: "pipe it",
      currentIndex: 1,
    });
    const hopA: DispatchSpec = {
      id: "spec-a",
      target: "thread-origin",
      prompt: "output of a",
      session: "isolated",
      preset: "a",
      chainId: "chain-1",
      kind: "forward",
      correlationId: "chain-1",
      createdUtc: "2026-01-01T00:00:00.000Z",
    };

    const orch = makeOrch();
    await (orch as any).advanceChain(hopA, "output of a");

    const afterFirst = store.getChain("chain-1")!;
    expect(afterFirst.hops).toEqual(["c"]);
    expect(afterFirst.currentIndex).toBe(2);
    const forwards = pendingSpecs().filter((s) => s.kind === "forward" && s.chainId === "chain-1");
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.preset).toBe("b");
    expect(forwards[0]!.prompt).toBe("output of a");

    // Crash window: hop A still in running/, hop B already queued. Re-run
    // the same completing spec — must NOT pop `c` or enqueue a second hop.
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await writeFile(
      path.join(dirs.running, `${hopA.id}.json`),
      `${JSON.stringify(hopA, null, 2)}\n`,
      "utf8"
    );
    await (orch as any).advanceChain(hopA, "output of a AGAIN");

    const afterSecond = store.getChain("chain-1")!;
    expect(afterSecond.hops).toEqual(["c"]);
    expect(afterSecond.currentIndex).toBe(2);
    expect(afterSecond.status).toBe("running");
    const forwardsAfter = pendingSpecs().filter((s) => s.kind === "forward" && s.chainId === "chain-1");
    expect(forwardsAfter).toHaveLength(1);
    expect(forwardsAfter[0]!.id).toBe(forwards[0]!.id);
  });

  it("a last-hop crash window delivers the origin report-back exactly once", async () => {
    // Last hop already popped off the remaining list when it was dispatched.
    store.createChain({
      id: "chain-last",
      hops: [],
      originRef: "thread-origin",
      promptPreview: "final",
      currentIndex: 2,
    });
    const lastHop: DispatchSpec = {
      id: "spec-last",
      target: "thread-origin",
      prompt: "almost done",
      session: "isolated",
      preset: "writer",
      chainId: "chain-last",
      kind: "forward",
      correlationId: "chain-last",
      createdUtc: "2026-01-01T00:00:00.000Z",
    };

    const orch = makeOrch();
    await (orch as any).advanceChain(lastHop, "final output");

    expect(store.getChain("chain-last")?.status).toBe("completed");
    const deliveries = pendingSpecs().filter((s) => s.kind === "report_back");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      target: "thread-origin",
      correlationId: "chain-last",
    });
    expect(deliveries[0]!.prompt).toContain("final output");
    expect(reportBackRows("chain-last")).toHaveLength(1);

    // Re-run the last hop (crash before done-file). No second delivery, no
    // second hop, chain stays completed.
    await (orch as any).advanceChain(lastHop, "final output AGAIN");
    expect(store.getChain("chain-last")?.status).toBe("completed");
    expect(pendingSpecs().filter((s) => s.kind === "report_back")).toHaveLength(1);
    expect(reportBackRows("chain-last")).toHaveLength(1);
  });

  it("a hop error delivers the failure to origin exactly once across the crash window", async () => {
    store.createChain({
      id: "chain-err",
      hops: ["next"],
      originRef: "thread-origin",
      currentIndex: 1,
    });
    const hop: DispatchSpec = {
      id: "spec-err",
      target: "thread-origin",
      prompt: "will fail",
      session: "isolated",
      chainId: "chain-err",
      kind: "forward",
      correlationId: "chain-err",
      createdUtc: "2026-01-01T00:00:00.000Z",
    };

    const orch = makeOrch();
    await (orch as any).advanceChain(hop, "partial", "boom");
    expect(store.getChain("chain-err")?.status).toBe("failed");
    expect(pendingSpecs().filter((s) => s.kind === "report_back")).toHaveLength(1);

    await (orch as any).advanceChain(hop, "partial", "boom");
    expect(store.getChain("chain-err")?.status).toBe("failed");
    expect(pendingSpecs().filter((s) => s.kind === "report_back")).toHaveLength(1);
    expect(reportBackRows("chain-err")).toHaveLength(1);
  });
});
