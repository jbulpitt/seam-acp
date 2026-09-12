import { afterEach, describe, expect, it, vi } from "vitest";
import { simulateRetiredOwnerProcess } from "./restart-process-fixture.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher, createRuntimeDispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { enqueueDispatchSpec, dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { projectAttemptCompletions } from "../packages/core/src/core/dispatch/attempt-recovery.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { DispatchSuspendedError } from "../packages/core/src/core/dispatch/attempt-store.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.restoreAllMocks(); });
function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "seam-250-dispatch-"));
  cleanups.push(() => rmSync(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(path.join(dataDir, "test.db"));
  cleanups.push(() => store.close());
  const record = { id: "discord:worker", platform: "discord", channelRef: "worker",
    parentRef: null, agentId: "codex", acpSessionId: "recorded-acp", repoPath: "/synthetic",
    configJson: "{}", createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString() };
  store.upsert(record);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const runtime = {
    onEvent() {}, getSessionInfo: () => ({ sessionId: "recorded-acp" }),
    prompt: vi.fn(async (_text: string): Promise<{ stopReason: string }> => { entered(); await gate; throw new Error("ACP connection closed"); }),
    idle: async () => {},
  };
  const router = {
    listProfiles: () => [], describeConfig: () => ({}),
    ensureSessionRecord: () => ({ ...record }), getProfile: () => undefined,
    getOrStartRuntime: vi.fn(async (_record: unknown, _opts?: { resumeSessionId: string }) => runtime),
  };
  const adapter = { sendPanel: async (channel: any) => ({ channel, id: "panel" }),
    sendMessage: async (channel: any) => ({ channel, id: "message" }),
    editPanel: async () => {}, editMessage: async () => {} };
  const config = { DATA_DIR: dataDir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
    SEAM_TURN_RESUME_ENABLED: true,
    DEFAULT_MODEL: "default", SEAM_DISPATCH_STATUS_PANEL: false,
    SEAM_DISPATCH_OUTPUT_STYLE: "messages", REPO_EMOJIS: new Map(),
    channelPresets: {}, threadPresets: {} };
  const makeOrch = () => new Orchestrator({ logger: pino({ level: "silent" }) as any,
    modelCatalog: fixtureModelCatalog([]),
    store, router: router as any, adapter: adapter as any, renderer: discordRenderer as any,
    config: config as any });
  const orch = makeOrch();
  const reports = vi.spyOn(orch as any, "enqueueReportBack").mockResolvedValue(undefined);
  const notices = vi.fn((s: DispatchSpec, err: DispatchSuspendedError) => orch.observeRetainedDispatch(s, err));
  const refusals: DispatchSuspendedError[] = [];
  const watcher = new DispatchWatcher({ attempts: store.turnAttempts, dataDir, logger: pino({ level: "silent" }) as any,
    resumeEnabled: true, onRetained: notices, onDispatch: async s => {
      try { return await orch.dispatchInjectTurn(s); }
      catch (err) { if (err instanceof DispatchSuspendedError) refusals.push(err); throw err; }
    }, pollMs: 1000000 });
  orch.setDispatchWatcher(watcher);
  cleanups.push(() => watcher.stop());
  const spec: DispatchSpec = { id: "held", target: "worker", prompt: "original work", session: "live",
    returnTo: "origin", correlationId: "logical", kind: "handoff", stream: false,
    createdUtc: new Date().toISOString() };
  return { orch, store, watcher, dataDir, spec, reports, runtime, router, notices, refusals, started, release, makeOrch };
}

describe("#250 production dispatch lifecycle (synthetic transport, no providers)", () => {
  it("#304 admitting to SQL does not turn an ordinary setup failure into a stall", async () => {
    const h = setup();
    vi.spyOn(h.router, "ensureSessionRecord").mockImplementationOnce(() => { throw new Error("target unavailable"); });
    await enqueueDispatchSpec(h.dataDir, h.spec);
    await h.watcher.start();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "completed", stalledUtc: null,
      outcome: { status: "failed", error: "target unavailable" } });
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.runtime.prompt).not.toHaveBeenCalled();
  });

  it.each([false, true])("#304 SQL alone resumes prompted work; conflicting projections=%s", async conflict => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.orch.dispatchInjectTurn(h.spec);
    await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ suspension: "shutdown" });
    const dirs = dispatchDirs(h.dataDir);
    rmSync(dirs.running, { recursive: true, force: true });
    const logs: Array<{ msg?: string; authority?: string }> = [];
    const logger = pino({ level: "warn" }, { write: (line: string) => logs.push(JSON.parse(line)) } as any);
    if (conflict) {
      mkdirSync(dirs.pending, { recursive: true });
      mkdirSync(dirs.done, { recursive: true });
      writeFileSync(path.join(dirs.pending, `${h.spec.id}.json`), JSON.stringify({
        ...h.spec, target: "wrong-thread", prompt: "WRONG ORIGINAL INPUT", resume: false,
      }));
      writeFileSync(path.join(dirs.done, `${h.spec.id}.json`), JSON.stringify({ id: h.spec.id,
        target: "wrong-thread", status: "completed", output: "stale projection" }));
    }
    const next = h.makeOrch();
    vi.spyOn(next as any, "enqueueReportBack").mockResolvedValue(undefined);
    h.runtime.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
    const watcher = createRuntimeDispatchWatcher({ attempts: h.store.turnAttempts,
      dataDir: h.dataDir, logger: logger as any, runtime: next, resumeEnabled: true });
    next.setDispatchWatcher(watcher); cleanups.push(() => watcher.stop());
    await watcher.start();
    expect(h.runtime.prompt.mock.calls.at(-1)?.[0]).toBe("continue");
    expect(h.runtime.prompt).toHaveBeenCalledTimes(2);
    expect(h.router.getOrStartRuntime.mock.calls.at(-1)).toMatchObject([
      { channelRef: "worker" }, { resumeSessionId: "recorded-acp" },
    ]);
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "completed", generation: 2,
      acpSessionId: "recorded-acp", stalledUtc: null });
    if (conflict) expect(logs.some(l => l.authority === "turn_attempts" && l.msg?.includes("conflicts"))).toBe(true);
  });

  it("#336 shutdown during acquisition retains without notice and the next boot completes", async () => {
    const h = setup();
    h.spec.id = "11ac5c69-7785-4e84-bee5-110a86e8af76";
    simulateRetiredOwnerProcess();
    let entered!: () => void;
    const acquiring = new Promise<void>(resolve => { entered = resolve; });
    let fail!: (err: Error) => void;
    h.router.getOrStartRuntime.mockImplementationOnce(() => {
      entered();
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    await h.watcher.start();
    await enqueueDispatchSpec(h.dataDir, h.spec);
    const tick = h.watcher.tick();
    await acquiring;
    h.orch.suspendForRestart();
    // The event has already attributed cancellation; ambient state must not
    // decide the eventual refusal after the transport finishes unwinding.
    (h.orch as any).restartCutoff = false;
    fail(new Error("ACP connection closed"));
    await tick; await h.watcher.drain(); h.watcher.stop();
    expect(h.refusals).toMatchObject([{ suspension: "shutdown", reason: expect.stringContaining("shutdown interrupted provider acquisition") }]);
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "suspended", stalledUtc: null, promptStarted: false });
    expect(existsSync(path.join(dispatchDirs(h.dataDir).running, `${h.spec.id}.json`))).toBe(true);
    h.runtime.prompt.mockResolvedValue({ stopReason: "end_turn" });
    const next = h.makeOrch();
    vi.spyOn(next as any, "enqueueReportBack").mockResolvedValue(undefined);
    const nextWatcher = createRuntimeDispatchWatcher({ attempts: h.store.turnAttempts, dataDir: h.dataDir, logger: pino({ level: "silent" }) as any,
      resumeEnabled: true, runtime: next });
    next.setDispatchWatcher(nextWatcher);
    cleanups.push(() => nextWatcher.stop());
    await nextWatcher.start(); await nextWatcher.initialDispatchesSettled();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "completed", generation: 2, stalledUtc: null });
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it("#336 boot-recovery acquisition failure hands off, then resumes the same session on a later boot", async () => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.orch.dispatchInjectTurn(h.spec);
    await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ suspension: "shutdown" });
    const recovering = h.makeOrch();
    h.router.getOrStartRuntime.mockRejectedValueOnce(new Error("ACP connection closed"));
    await enqueueDispatchSpec(h.dataDir, h.spec);
    const refusals: DispatchSuspendedError[] = [];
    const watcher = new DispatchWatcher({ attempts: h.store.turnAttempts, dataDir: h.dataDir, logger: pino({ level: "silent" }) as any,
      resumeEnabled: true, onRetained: h.notices, onDispatch: async s => {
        try { return await recovering.dispatchInjectTurn(s); }
        catch (err) { refusals.push(err as DispatchSuspendedError); throw err; }
      } });
    cleanups.push(() => watcher.stop());
    await watcher.start(); watcher.stop();
    expect(refusals).toMatchObject([{ suspension: "shutdown", reason: "provider acquisition failed during boot-recovery: ACP connection closed" }]);
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "suspended", generation: 2,
      acpSessionId: "recorded-acp", promptStarted: true, stalledUtc: null });
    h.runtime.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
    const next = h.makeOrch();
    vi.spyOn(next as any, "enqueueReportBack").mockResolvedValue(undefined);
    const nextWatcher = createRuntimeDispatchWatcher({ attempts: h.store.turnAttempts, dataDir: h.dataDir, logger: pino({ level: "silent" }) as any,
      resumeEnabled: true, runtime: next });
    next.setDispatchWatcher(nextWatcher);
    cleanups.push(() => nextWatcher.stop());
    await nextWatcher.start();
    expect(h.runtime.prompt.mock.calls.at(-1)?.[0]).toBe("continue");
    expect(h.router.getOrStartRuntime.mock.calls.at(-1)).toMatchObject([{}, { resumeSessionId: "recorded-acp" }]);
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "completed", generation: 3, stalledUtc: null });
    expect(h.notices).not.toHaveBeenCalled();
  });

  it.each([false, true])("#336 ordinary acquisition failure remains defect with ambient cutoff=%s", async ambientCutoff => {
    const h = setup();
    h.router.getOrStartRuntime.mockImplementationOnce(async () => {
      // No shutdown event cancelled this acquisition. A window flag alone
      // must never turn its independent failure into a shutdown handoff.
      (h.orch as any).restartCutoff = ambientCutoff;
      throw new Error("ACP connection closed");
    });
    await h.watcher.start(); await enqueueDispatchSpec(h.dataDir, h.spec);
    await h.watcher.tick(); await h.watcher.drain();
    expect(h.refusals).toMatchObject([{ suspension: "defect", reason: "provider acquisition failed during execution: ACP connection closed" }]);
    expect(h.notices).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "suspended",
      stalledReason: "provider acquisition failed during execution: ACP connection closed",
      stallNoticeUtc: expect.any(String) });
  });

  it("#336 a classified defect survives a real shutdown during non-acquisition setup", async () => {
    const h = setup();
    vi.spyOn(h.orch as any, "postDispatchStartIndicator").mockImplementation(async () => {
      h.orch.suspendForRestart();
      throw DispatchSuspendedError.defect(h.spec.id, "recorded provider identity is corrupt");
    });
    await h.watcher.start(); await enqueueDispatchSpec(h.dataDir, h.spec);
    await h.watcher.tick(); await h.watcher.drain();
    expect(h.refusals).toMatchObject([{ suspension: "defect", reason: "recorded provider identity is corrupt" }]);
    expect(h.notices).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get(h.spec.id)?.stalledReason).toBe("recorded provider identity is corrupt");
  });

  it("restart cutoff keeps running artifact and ACP binding without an early report", async () => {
    const h = setup();
    await h.watcher.start();
    await enqueueDispatchSpec(h.dataDir, h.spec);
    const tick = h.watcher.tick();
    await h.started;
    h.orch.suspendForRestart();
    h.release();
    await tick; await h.watcher.drain();
    expect(h.reports).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "suspended", acpSessionId: "recorded-acp", promptStarted: true });
    expect(existsSync(path.join(dispatchDirs(h.dataDir).running, "held.json"))).toBe(true);
    expect(existsSync(path.join(dispatchDirs(h.dataDir).done, "held.json"))).toBe(false);
    expect(h.store.getDelegation(h.spec.id)?.status).toBe("running");
  });
  it("the same provider error during a living attempt still fails and reports", async () => {
    const h = setup();
    await h.watcher.start(); await enqueueDispatchSpec(h.dataDir, h.spec);
    const tick = h.watcher.tick(); await h.started; h.release();
    await tick; await h.watcher.drain();
    expect(h.reports).toHaveBeenCalledTimes(1);
    expect(h.store.getDelegation(h.spec.id)?.status).toBe("failed");
    expect(h.store.turnAttempts.get(h.spec.id)?.state).toBe("completed");
  });

  it.each(["handoff", "wake"] as const)("resumes a genuinely in-flight %s without replaying original input", async kind => {
    const h = setup(); h.spec.kind = kind;
    // Isolate process death from dispatch lifecycle in this in-process test.
    // Process/PID-reuse guards are tested separately; this is NOT a live provider canary.
    simulateRetiredOwnerProcess();
    const first = h.orch.dispatchInjectTurn(h.spec);
    await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ name: "DispatchSuspendedError" });
    expect(h.reports).not.toHaveBeenCalled();
    h.runtime.prompt.mockImplementationOnce(async () => ({ stopReason: "end_turn" }));
    const resumed = h.makeOrch();
    const report = vi.spyOn(resumed as any, "enqueueReportBack").mockResolvedValue(undefined);
    await resumed.dispatchInjectTurn({ ...h.spec, resume: true });
    expect(h.runtime.prompt.mock.calls.at(-1)?.[0]).toBe("continue");
    expect(h.store.turnAttempts.get(h.spec.id)?.acpSessionId).toBe("recorded-acp");
    expect(h.store.turnAttempts.get(h.spec.id)?.generation).toBe(2);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("completion captured before output delivery beats a later restart cutoff", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => ({ stopReason: "end_turn" }));
    let releaseOutput!: () => void; let outputStarted!: () => void;
    const atOutput = new Promise<void>(r => { outputStarted = r; });
    const outputGate = new Promise<void>(r => { releaseOutput = r; });
    vi.spyOn(h.orch as any, "postDispatchOutput").mockImplementation(async () => { outputStarted(); await outputGate; });
    const first = h.orch.dispatchInjectTurn(h.spec);
    await atOutput;
    expect(h.store.turnAttempts.get(h.spec.id)?.state).toBe("completed");
    h.orch.suspendForRestart(); releaseOutput(); await first;
    expect(h.reports).toHaveBeenCalledTimes(1);
    await h.makeOrch().dispatchInjectTurn(h.spec);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it("a captured completion repairs missing queue output without a provider call", async () => {
    const h = setup();
    h.runtime.prompt.mockImplementationOnce(async () => ({ stopReason: "end_turn" }));
    h.reports.mockRejectedValueOnce(new Error("synthetic delivery outage"));
    await expect(h.orch.dispatchInjectTurn(h.spec)).rejects.toThrow(/delivery outage/);
    expect(existsSync(path.join(dispatchDirs(h.dataDir).done, "held.json"))).toBe(false);
    expect(h.store.getDelegation(h.spec.id)?.status).toBe("running");
    await projectAttemptCompletions(h.dataDir, h.store.turnAttempts);
    expect(existsSync(path.join(dispatchDirs(h.dataDir).done, "held.json"))).toBe(true);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
  });
});
