import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { enqueueDispatchSpec, dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { projectAttemptCompletions } from "../packages/core/src/core/dispatch/attempt-recovery.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
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
    getOrStartRuntime: async () => runtime,
  };
  const adapter = { sendPanel: async (channel: any) => ({ channel, id: "panel" }),
    sendMessage: async (channel: any) => ({ channel, id: "message" }),
    editPanel: async () => {}, editMessage: async () => {} };
  const config = { DATA_DIR: dataDir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "default", SEAM_DISPATCH_STATUS_PANEL: false,
    SEAM_DISPATCH_OUTPUT_STYLE: "messages", REPO_EMOJIS: new Map(),
    channelPresets: {}, threadPresets: {} };
  const makeOrch = () => new Orchestrator({ logger: pino({ level: "silent" }) as any,
    modelCatalog: fixtureModelCatalog([]),
    store, router: router as any, adapter: adapter as any, renderer: discordRenderer as any,
    config: config as any });
  const orch = makeOrch();
  const reports = vi.spyOn(orch as any, "enqueueReportBack").mockResolvedValue(undefined);
  const watcher = new DispatchWatcher({ dataDir, logger: pino({ level: "silent" }) as any,
    resumeEnabled: true, onDispatch: s => orch.dispatchInjectTurn(s), pollMs: 1000000 });
  orch.setDispatchWatcher(watcher);
  cleanups.push(() => watcher.stop());
  const spec: DispatchSpec = { id: "held", target: "worker", prompt: "original work", session: "live",
    returnTo: "origin", correlationId: "logical", kind: "handoff", stream: false,
    createdUtc: new Date().toISOString() };
  return { orch, store, watcher, dataDir, spec, reports, runtime, started, release, makeOrch };
}

describe("#250 production dispatch lifecycle (synthetic transport, no providers)", () => {
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
    vi.spyOn(h.store.turnAttempts, "registerOwner").mockImplementation(() => {});
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
