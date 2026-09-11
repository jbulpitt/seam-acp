import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { bindDoneDeliveryResolver, DoneRetention, pruneDoneArtifact, pruneDoneArtifacts } from "../packages/core/src/core/dispatch/done-retention.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { isDoneDeliveryResolved } from "../packages/core/src/core/dispatch/done-reconcile.js";

let dataDir: string;
let store: SessionStore;
const logger = pino({ level: "silent" }) as unknown as Logger;
const managers: DoneRetention[] = [];
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-306-retention-"));
  store = new SessionStore(path.join(dataDir, "seam.db"));
  await mkdir(dispatchDirs(dataDir).done, { recursive: true });
});
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.stop(); await manager.drain(); }
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

const spec = (id: string): DispatchSpec => ({ id, target: "worker", prompt: "private synthetic prompt", session: "live", kind: "wake", createdUtc: new Date().toISOString() });
function complete(id: string, delivered: boolean): void {
  store.recordDelegation({ id, kind: "wake", status: "completed" });
  const a = store.turnAttempts.claim(spec(id), "fixture", "fixture-owner");
  store.turnAttempts.complete(a, { id, target: "worker", status: "completed", output: "private synthetic output", finishedUtc: new Date().toISOString() });
  if (delivered) store.turnAttempts.markDeliveryDone(id);
}
// The retention mechanism consumes a resolver; it never decides whether a
// worker status, report-back, or Discord nonce constitutes delivery proof.
const deps = () => ({ dataDir, logger, isDeliveryResolved: (id: string) => store.turnAttempts.get(id)?.deliveryDone === true });
const artifact = (id: string) => path.join(dispatchDirs(dataDir).done, `${id}.json`);
const canonicalDeps = () => bindDoneDeliveryResolver({ dataDir, logger,
  getDelegation: (id) => store.getDelegation(id),
  getReportBackByCorrelation: (id) => store.getReportBackByCorrelation(id),
  resolveDelivery: isDoneDeliveryResolved,
});
async function routedFile(id: string, fields: Record<string, unknown> = {}): Promise<void> {
  await writeFile(artifact(id), JSON.stringify({ id, target: "worker", kind: "wake", status: "completed",
    finishedUtc: new Date().toISOString(), output: "synthetic captured output", ...fields }));
}

describe("proof-only done retention (#306)", () => {
  it("retains terminal handoff/chain parents until the #305 resolver settles their actual onward child", async () => {
    store.recordDelegation({ id: "handoff", kind: "handoff", status: "completed", correlationId: "correlation" });
    store.recordDelegation({ id: "report", kind: "report_back", status: "dispatched", correlationId: "correlation" });
    await routedFile("handoff", { kind: "handoff", returnTo: "origin", correlationId: "correlation" });
    // Removing the route-aware resolver deletes a parent's only recoverable result while report-back is still pending.
    expect(pruneDoneArtifact(canonicalDeps(), "handoff").state).toBe("retained");
    store.updateDelegationStatus("report", "completed");
    expect(pruneDoneArtifact(canonicalDeps(), "handoff").state).toBe("pruned");

    store.recordDelegation({ id: "chain", kind: "forward", status: "completed" });
    store.recordDelegation({ id: "plan", kind: "report_back", status: "completed", correlationId: "chain", targetRef: "next" });
    store.recordDelegation({ id: "next", kind: "forward", status: "abandoned" });
    await routedFile("chain", { kind: "forward", chainId: "synthetic-chain" });
    // A completed plan is not delivery; unexplained abandonment is not an explicit disposition either.
    expect(pruneDoneArtifact(canonicalDeps(), "chain").state).toBe("retained");
    store.updateDelegationStatus("next", "abandoned", { terminalReason: "operator explicitly declined this synthetic delivery" });
    expect(pruneDoneArtifact(canonicalDeps(), "chain").state).toBe("pruned");
  });

  it("retains unknown/nonterminal sources and expires explicitly resolved legacy abandonment", async () => {
    await routedFile("unknown");
    store.recordDelegation({ id: "running", kind: "wake", status: "running" });
    await routedFile("running");
    // Removing the canonical source-state gate mistakes captured but unsettled output for completed delivery.
    expect(pruneDoneArtifact(canonicalDeps(), "unknown").state).toBe("retained");
    expect(pruneDoneArtifact(canonicalDeps(), "running").state).toBe("retained");
    store.recordDelegation({ id: "legacy", kind: "handoff", status: "abandoned" });
    await routedFile("legacy", { kind: "handoff" });
    expect(pruneDoneArtifact(canonicalDeps(), "legacy").state).toBe("retained");
    store.updateDelegationStatus("legacy", "abandoned", { terminalReason: "legacy delivery cannot be reconstructed; explicitly abandoned" });
    expect(pruneDoneArtifact(canonicalDeps(), "legacy").state).toBe("pruned");
  });

  it("uses the canonical resolver decision and does not log invalid private bodies", async () => {
    complete("routed", true);
    const row = store.getDelegation("routed");
    const result = { id: "routed", target: "worker", status: "completed", kind: "handoff", returnTo: "origin",
      finishedUtc: new Date().toISOString(), output: "private output" };
    await writeFile(artifact("routed"), JSON.stringify(result));
    const resolveDelivery = vi.fn(() => false);
    const warn = vi.fn();
    const configured = bindDoneDeliveryResolver({ dataDir, logger: { warn } as unknown as Logger,
      getDelegation: (id) => store.getDelegation(id), getReportBackByCorrelation: (id) => store.getReportBackByCorrelation(id), resolveDelivery });
    // Without this binding, retention could substitute terminal/local-ack for the canonical onward-delivery decision.
    expect(pruneDoneArtifact(configured, "routed").state).toBe("retained");
    expect(resolveDelivery).toHaveBeenCalledWith(result, row, expect.any(Object));
    resolveDelivery.mockReturnValue(true);
    expect(pruneDoneArtifact(configured, "routed").state).toBe("pruned");
    store.recordDelegation({ id: "malformed", kind: "wake", status: "completed" });
    await writeFile(artifact("malformed"), "PRIVATE-PROMPT-CONTENT");
    expect((await pruneDoneArtifacts(configured))).toMatchObject({ failed: 1, pruned: 0 });
    // Without error redaction JSON.parse includes the private input in the logger's Error message.
    expect(String(warn.mock.calls[0]?.[0].err)).not.toContain("PRIVATE-PROMPT-CONTENT");
  });

  it("prunes all delivered backlog pages without an age cutoff and retains unknown/undelivered files", async () => {
    complete("resolved", true);
    complete("pending", false);
    const count = 5040;
    // One resolver row is enough to test the filesystem mechanism at the
    // measured backlog size; no per-file invented delivery interpretation.
    const configured = { ...deps(), isDeliveryResolved: (id: string) => id.startsWith("resolved-") && deps().isDeliveryResolved("resolved") };
    for (let start = 0; start < count; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, i) =>
        writeFile(artifact(`resolved-${start + i}`), "synthetic prompt and result")));
    }
    await writeFile(artifact("pending"), "undelivered output");
    await writeFile(artifact("unknown"), "unresolved legacy output");
    const dry = await pruneDoneArtifacts(configured, { dryRun: true });
    // Without dry-run separation an audit irreversibly deletes user artifacts.
    expect(dry).toMatchObject({ scanned: count + 2, pruned: count, retained: 2, failed: 0, dryRun: true });
    expect(await readdir(dispatchDirs(dataDir).done)).toHaveLength(count + 2);
    const applied = await pruneDoneArtifacts(configured);
    // Without a full yielding sweep, the measured backlog survives until many restarts.
    expect(applied).toMatchObject({ pruned: count, retained: 2, failed: 0, bytes: dry.bytes });
    expect((await readdir(dispatchDirs(dataDir).done)).sort()).toEqual(["pending.json", "unknown.json"]);
    expect((await pruneDoneArtifacts(configured)).pruned).toBe(0);
    expect(store.turnAttempts.get("resolved")?.outcome?.output).toBe("private synthetic output");
  }, 20_000); // 5,040 real files plus dry-run: bounded I/O, not a 5s unit fixture.

  it("checks current proof, not terminal status, before unlink", async () => {
    complete("pending", false);
    await writeFile(artifact("pending"), "keep");
    // Removing the resolver gate loses results between production and delivery.
    expect(pruneDoneArtifact(deps(), "pending").state).toBe("retained");
    store.turnAttempts.markDeliveryDone("pending");
    expect(pruneDoneArtifact(deps(), "pending").state).toBe("pruned");
    expect(pruneDoneArtifact(deps(), "pending").state).toBe("missing");
  });

  it("preserves unresolved malformed artifacts and contains deletion to regular done files", async () => {
    await writeFile(artifact("corrupt"), "{not JSON");
    await mkdir(artifact("directory"));
    const outside = path.join(dataDir, "outside.json");
    await writeFile(outside, "outside evidence");
    await symlink(outside, artifact("link"));
    const configured = { ...deps(), isDeliveryResolved: (id: string) => id !== "corrupt" };
    // Without basename/type checks, an audit can delete unrelated paths or hide malformed evidence.
    expect(() => pruneDoneArtifact(configured, "../../outside")).toThrow("invalid dispatch artifact id");
    expect((await pruneDoneArtifacts(configured))).toMatchObject({ pruned: 0, retained: 3 });
    expect(await readFile(outside, "utf8")).toBe("outside evidence");
    expect(await readFile(artifact("corrupt"), "utf8")).toBe("{not JSON");
  });

  it("removes the file even when delivery was proved before the watcher publishes it", async () => {
    const manager = new DoneRetention(canonicalDeps());
    managers.push(manager);
    const dirs = dispatchDirs(dataDir);
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(path.join(dirs.pending, "early-proof.json"), JSON.stringify(spec("early-proof")));
    const watcher = new DispatchWatcher({ dataDir, logger,
      onDispatch: async () => { complete("early-proof", true); return { output: "delivered", stopReason: "end_turn" }; },
      onResultPublished: (id) => manager.resultPublished(id),
    });
    try {
      await watcher.start();
      // Without the post-publication hook, every successful live dispatch recreates its already-pruned artifact.
      await expect(access(artifact("early-proof"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(store.turnAttempts.get("early-proof")?.outcome).not.toBeNull();
    } finally { watcher.stop(); await watcher.drain(); }
  });

  it("retries later delivery and stops before a closed-store lookup", async () => {
    complete("later-proof", false);
    await writeFile(artifact("later-proof"), "pending result");
    const lookup = vi.fn(deps().isDeliveryResolved);
    const manager = new DoneRetention({ ...deps(), isDeliveryResolved: lookup }, 10);
    managers.push(manager);
    manager.start();
    await manager.drain();
    expect(await readFile(artifact("later-proof"), "utf8")).toBe("pending result");
    store.turnAttempts.markDeliveryDone("later-proof");
    // Without periodic retry a later report-back acknowledgment leaves the parent forever.
    await vi.waitFor(async () => expect(await readdir(dispatchDirs(dataDir).done)).toEqual([]));
    manager.stop();
    await manager.drain();
    lookup.mockClear();
    await new Promise(resolve => setTimeout(resolve, 30));
    // Without stop fencing an in-flight scan reaches SQLite after shutdown.
    expect(lookup).not.toHaveBeenCalled();
  });
});
