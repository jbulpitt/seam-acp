import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { simulateRetiredOwnerProcess } from "./restart-process-fixture.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
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
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { attachLocalBridge, localBridgeHub } from "./local-bridge-fixture.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { AgentProfile } from "@seam/adapters";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
    listProfiles: () => [], describeConfig: () => ({ agent: { value: "codex" }, model: { value: "default" },
      location: { value: "local" }, cwd: { value: "/synthetic" }, effort: { value: null } }),
    ensureSessionRecord: () => ({ ...record }), getProfile: () => undefined,
    adoptRecoveryRuntime: vi.fn(),
    releaseRecoveryRuntime: vi.fn(),
    getOrStartRuntime: vi.fn(async (_record: unknown, _opts?: { resumeSessionId: string }) => runtime),
  };
  const adapter = { sendPanel: async (channel: any) => ({ channel, id: "panel" }),
    sendMessage: vi.fn(async (channel: any, _text?: string) => ({ channel, id: "message" })),
    editMessage: async () => {},
    editPanel: vi.fn(async () => {}) };
  const config = { DATA_DIR: dataDir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
    SEAM_TURN_RESUME_ENABLED: true,
    DEFAULT_MODEL: "default", SEAM_DISPATCH_STATUS_PANEL: false,
    SEAM_DISPATCH_OUTPUT_STYLE: "messages", REPO_EMOJIS: new Map(),
    channelPresets: {}, threadPresets: {} };
  const acquisitionSleep = vi.fn(async (_ms: number) => {});
  const makeOrch = () => attachLocalBridge(new Orchestrator({ logger: pino({ level: "silent" }) as any,
    recoverySleep: acquisitionSleep,
    modelCatalog: fixtureModelCatalog([]),
    store, router: router as any, adapter: adapter as any, renderer: discordRenderer as any,
    config: config as any }), [], dataDir);
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
  return { orch, store, watcher, dataDir, spec, reports, runtime, router, adapter, config, notices, refusals, started, release, makeOrch, acquisitionSleep };
}

async function adoptedCard() {
  const h = setup();
  h.spec.id = "adopted-status";
  h.spec.kind = "wake";
  h.spec.returnTo = undefined;
  h.store.turnAttempts.registerOwner("old-controller");
  const attempt = h.store.turnAttempts.claim(h.spec, "synthetic-identity", "old-controller");
  h.store.turnAttempts.bind(attempt, "recorded-acp");
  h.store.turnAttempts.bindStatusCard(attempt, { channelId: "worker", messageId: "original-card" });
  h.store.turnAttempts.startPrompt(attempt);
  h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "remote-one", slot: 19,
    submissionId: "adopted-submission", acpSessionId: "recorded-acp", delegatedUtc: new Date().toISOString() });
  h.store.turnAttempts.suspendBoot("old-controller");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), killed: false, kill: vi.fn(() => true), detach: vi.fn() });
  h.router.adoptRecoveryRuntime.mockImplementation((_record, adoptedChild, sessionId) => {
    const runtime = new AgentRuntime({ profile: { id: "codex" } as AgentProfile,
      logger: pino({ level: "silent" }) as any,
      spawnFn: () => { throw new Error("recovery must not spawn"); } });
    runtime.attachRecovery(adoptedChild, sessionId);
    return runtime;
  });
  h.router.releaseRecoveryRuntime.mockImplementation((_record, runtime) => runtime.releaseRecovery());
  const mux = { adopt: vi.fn(() => child), sendCmd: vi.fn(async () => ({ health: [{ slot: 19, alive: true,
    recovery: { version: 1, owner: "bridge", submissionId: "adopted-submission", acpSessionId: "recorded-acp",
      rung: 1, phase: "executing", retry: 0, budget: 3, remaining: 3, disposition: "none",
      updatedUtc: new Date().toISOString() } }] })) };
  const restarted = h.makeOrch();
  cleanups.push(() => restarted.stopSentinelWatcher());
  restarted.setBridgeHub({ muxFor: () => mux, slotHealthFor: () => [] } as any);
  const adoption = (restarted as any).adoptRemoteRecoveryOwned(h.store.turnAttempts.get(attempt.id)) as Promise<boolean>;
  await vi.waitFor(() => expect(mux.adopt).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(h.adapter.editPanel).toHaveBeenCalled());
  const finish = (cancelled = false) => child.emit("remoteRecoveryResult", { version: 1,
    submissionId: "adopted-submission", acpSessionId: "recorded-acp", status: "completed",
    text: cancelled ? "" : "recovered answer", stopReason: cancelled ? "cancelled" : "end_turn",
    finishedUtc: new Date().toISOString() });
  const panels = () => h.adapter.editPanel.mock.calls.map(call => (call as any[])[1]);
  return { ...h, restarted, attempt, adoption, finish, panels };
}

describe("#576 adopted status-card diagnosis", () => {
  it("finalizes the original card when an adopted turn is cancelled before its next heartbeat", async () => {
    const h = await adoptedCard();
    expect(h.panels().at(-1).title).toContain("Working");
    expect(h.store.turnAttempts.cancel(h.attempt.id)).toBe(true);
    h.finish(true);
    await h.adoption;
    await (h.restarted as any).settleTrackedContinuations();
    expect(h.store.turnAttempts.get(h.attempt.id)).toMatchObject({ state: "cancelled", deliveryDone: false });
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(h.panels().at(-1)).toMatchObject({ title: "⏰ Wake · Failed",
      fields: expect.arrayContaining([expect.objectContaining({ name: "Action", value: "Cancelled" })]) });
    expect(h.router.releaseRecoveryRuntime).toHaveBeenCalledOnce();
  });

  it("keeps an adopted completion Working while its terminal result delivery is held", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const h = await adoptedCard();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    h.adapter.sendMessage.mockImplementationOnce(async channel => {
      entered(); await gate; return { channel, id: "answer" };
    });
    try {
      h.finish();
      await sending;
      expect(h.store.turnAttempts.get(h.attempt.id)).toMatchObject({ state: "completed", deliveryDone: false,
        outcome: { output: "recovered answer" } });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(h.panels().some(panel => panel.title.includes("Done"))).toBe(false);
    } finally {
      release();
      await h.adoption;
      vi.useRealTimers();
    }
    expect(h.store.turnAttempts.get(h.attempt.id)?.deliveryDone).toBe(true);
    expect(h.panels().at(-1).title).toBe("⏰ Wake · Done");
    expect(h.adapter.sendMessage).toHaveBeenCalledOnce();
  });
});

describe("#250 production dispatch lifecycle (synthetic transport, no providers)", () => {
  it("manually resumes an owned unstarted dispatch with the original brief exactly once", async () => {
    const h = setup();
    const boot = (h.orch as any).attemptBoot;
    h.store.turnAttempts.registerOwner(boot);
    const attempt = h.store.turnAttempts.claim(h.spec, executionIdentity({ agentId: "codex",
      location: "local", session: "live", model: "default", effort: null, cwd: "/synthetic", config: "{}" }), boot);
    h.store.turnAttempts.markStalled(attempt.id, "session load temporarily unavailable");
    h.runtime.prompt.mockImplementation(async text => {
      expect(text).toContain("original work");
      expect(text).not.toMatch(/^continue\n/);
      expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ promptStarted: true, acpSessionId: "recorded-acp" });
      return { stopReason: "end_turn" };
    });
    expect(await h.orch.resumeTurnManually(attempt.id)).toContain("Continuation requested");
    await h.watcher.start();
    await h.watcher.drain();
    await h.watcher.tick();
    expect(h.runtime.prompt).toHaveBeenCalledOnce();
    expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ state: "completed", promptStarted: true, generation: 2 });
    expect(await h.orch.resumeTurnManually(attempt.id)).toContain("No interrupted/abandoned turn");
    expect(h.runtime.prompt).toHaveBeenCalledOnce();
  });

  it.each([false, true])("#355 stalled recorded conversation auto-continues without a notice (old notice delivered=%s)", async delivered => {
    const h = setup();
    h.spec.id = delivered ? "11ac5c69-7785-4e84-bee5-110a86e8af76" : "0a98091b-00e8-44f7-8515-8b3c2c6d71d0";
    simulateRetiredOwnerProcess();
    const first = h.orch.dispatchInjectTurn(h.spec);
    await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ suspension: "shutdown" });
    h.store.turnAttempts.markStalled(h.spec.id, "execution failed before the provider took the turn and the attempt is suspended");
    if (delivered) h.store.turnAttempts.markStallNoticeDelivered(h.spec.id);
    h.adapter.sendMessage.mockClear();
    h.runtime.prompt.mockImplementationOnce(async text => {
      expect(text.startsWith("continue\n")).toBe(true);
      expect(text).toContain("execution failed before the provider took the turn and the attempt is suspended");
      expect(text).not.toContain("original work");
      expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ generation: 2,
        stalledUtc: null, stalledReason: null, stallNoticeUtc: null });
      return { stopReason: "end_turn" };
    });
    const next = h.makeOrch();
    vi.spyOn(next as any, "enqueueReportBack").mockResolvedValue(undefined);
    const notice = vi.spyOn(next, "observeRetainedDispatch");
    const watcher = createRuntimeDispatchWatcher({ attempts: h.store.turnAttempts,
      dataDir: h.dataDir, logger: pino({ level: "silent" }) as any, runtime: next });
    next.setDispatchWatcher(watcher); cleanups.push(() => watcher.stop());
    await watcher.start();
    expect(h.runtime.prompt).toHaveBeenCalledTimes(2);
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).toContain(
      "execution failed before the provider took the turn and the attempt is suspended");
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).not.toContain("original work");
    expect(h.router.getOrStartRuntime.mock.calls.at(-1)).toMatchObject([
      { channelRef: "worker" }, { resumeSessionId: "recorded-acp" }, expect.any(Function),
    ]);
    expect(h.store.turnAttempts.get(h.spec.id)?.state).toBe("completed");
    expect(notice).not.toHaveBeenCalled();
    expect(h.adapter.sendMessage.mock.calls.some(([, text]) => text?.includes("is parked:"))).toBe(false);
  });

  it.each(["legacy-unclaimed", "missing-session", "identity-drift", "unreadable-owner"] as const)(
    "#355 unresolved %s stays quarantined and names the uncertainty", async fault => {
      const h = setup();
      simulateRetiredOwnerProcess();
      if (fault === "legacy-unclaimed") {
        // Unsafe evidence must stay quarantined even when its host is absent;
        // the host wait/expiry path must not silently abandon it first.
        h.spec.location = "unavailable-bridge";
        h.store.turnAttempts.admit(h.spec);
      }
      else {
        const first = h.orch.dispatchInjectTurn(h.spec);
        await h.started; h.orch.suspendForRestart(); h.release();
        await expect(first).rejects.toMatchObject({ suspension: "shutdown" });
      }
      h.store.turnAttempts.markStalled(h.spec.id, "old undifferentiated retention");
      h.store.turnAttempts.markStallNoticeDelivered(h.spec.id);
      const before = h.store.turnAttempts.get(h.spec.id)!;
      if (fault === "missing-session") (h.store as any).db.prepare(
        "UPDATE turn_attempts SET acp_session_id=NULL WHERE id=?").run(h.spec.id);
      if (fault === "identity-drift") vi.spyOn(h.router, "describeConfig").mockReturnValue({ ...h.router.describeConfig(), agent: { value: "claude" } });
      if (fault === "unreadable-owner") (h.store as any).db.prepare(
        "UPDATE turn_attempt_owners SET process_json='{}' WHERE id=?").run(before.ownerBoot);
      h.adapter.sendMessage.mockClear(); h.runtime.prompt.mockClear();
      const next = h.makeOrch();
      const watcher = createRuntimeDispatchWatcher({ attempts: h.store.turnAttempts,
        dataDir: h.dataDir, logger: pino({ level: "silent" }) as any, runtime: next });
      next.setDispatchWatcher(watcher); cleanups.push(() => watcher.stop());
      await watcher.start();
      expect(h.runtime.prompt).not.toHaveBeenCalled();
      expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "suspended",
        generation: before.generation, stalledUtc: before.stalledUtc, stallNoticeUtc: expect.any(String) });
      const reason = { "legacy-unclaimed": "this legacy turn has no recorded execution", "missing-session": "no ACP session id",
        "identity-drift": "thread switched from codex to claude", "unreadable-owner": "owner registration is missing or unreadable" }[fault];
      expect(h.store.turnAttempts.get(h.spec.id)?.stalledReason).toContain(reason);
      const notices = h.adapter.sendMessage.mock.calls.filter(([, text]) => text?.includes("is parked:"));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.[1]).toContain(reason);
      expect(notices[0]?.[1]).not.toContain("Use `/seam workflows` to resume or abandon");
      if (fault === "legacy-unclaimed" || fault === "missing-session") {
        expect(await next.resumeTurnManually(h.spec.id)).toContain(reason);
      }
    });

  it("#559 a queue fence after claim and before prompt cancels the unstarted attempt", async () => {
    const h = setup();
    h.router.getOrStartRuntime.mockImplementationOnce(async () => {
      (h.orch as any).advanceChannelQueueEpoch(h.spec.target);
      return h.runtime;
    });
    await h.watcher.start();
    await enqueueDispatchSpec(h.dataDir, h.spec);
    await h.watcher.tick();
    await h.watcher.drain();
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({
      state: "cancelled",
      promptStarted: false,
      acpSessionId: null,
      outcome: { error: expect.stringContaining("fenced") },
    });
    expect(existsSync(path.join(dispatchDirs(h.dataDir).running, `${h.spec.id}.json`))).toBe(false);
    // The return settled the row. The sweep is the net for a row this path
    // did not reach, and it has nothing to do here.
    expect(h.store.turnAttempts.settleSupersededUnstartedAttempts()).toEqual([]);
  });

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
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0]).startsWith("continue\n")).toBe(true);
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).toContain("The process restarted while the turn was in flight.");
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).not.toContain("original work");
    expect(h.runtime.prompt).toHaveBeenCalledTimes(2);
    expect(h.router.getOrStartRuntime.mock.calls.at(-1)).toMatchObject([
      { channelRef: "worker" }, { resumeSessionId: "recorded-acp" }, expect.any(Function),
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

  it("#421 retries a transient boot acquisition and resumes the same session in the same boot", async () => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.orch.dispatchInjectTurn(h.spec);
    await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ suspension: "shutdown" });
    const recovering = h.makeOrch();
    h.router.getOrStartRuntime.mockRejectedValueOnce(new Error("ACP connection closed"));
    h.runtime.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
    await enqueueDispatchSpec(h.dataDir, h.spec);
    const refusals: DispatchSuspendedError[] = [];
    const watcher = new DispatchWatcher({ attempts: h.store.turnAttempts, dataDir: h.dataDir, logger: pino({ level: "silent" }) as any,
      resumeEnabled: true, onRetained: h.notices, onDispatch: async s => {
        try { return await recovering.dispatchInjectTurn(s); }
        catch (err) { refusals.push(err as DispatchSuspendedError); throw err; }
      }, recoverySleep: vi.fn(async () => {}) });
    cleanups.push(() => watcher.stop());
    await watcher.start(); watcher.stop();
    // #448: recovery stays inside one claimed generation. A transient failure
    // is no longer a watcher-visible suspension/reclaim cycle.
    expect(refusals).toEqual([]);
    expect(h.acquisitionSleep).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "completed", generation: 2,
      acpSessionId: "recorded-acp", promptStarted: true, stalledUtc: null });
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0]).startsWith("continue\n")).toBe(true);
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).toContain("The process restarted while the turn was in flight.");
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).not.toContain("original work");
    expect(h.router.getOrStartRuntime.mock.calls.at(-1)).toMatchObject([{}, { resumeSessionId: "recorded-acp" }, expect.any(Function)]);
    expect(h.notices).not.toHaveBeenCalled();
  });

  it("#421 bounds repeated boot acquisition timeouts and visibly quarantines exhaustion", async () => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.orch.dispatchInjectTurn(h.spec);
    await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ suspension: "shutdown" });
    h.runtime.prompt.mockClear();
    h.router.getOrStartRuntime.mockClear();
    const recovering = h.makeOrch();
    (recovering as any).resumeScheduler = { run: (fn: () => Promise<unknown>) => fn() };
    h.router.getOrStartRuntime.mockRejectedValue(new Error("rpc 'spawn' timed out after 30s"));
    await enqueueDispatchSpec(h.dataDir, h.spec);
    const retrySleep = vi.fn(async () => {});
    const watcher = new DispatchWatcher({ attempts: h.store.turnAttempts, dataDir: h.dataDir,
      logger: pino({ level: "silent" }) as any, resumeEnabled: true,
      onRetained: h.notices, recoverySleep: retrySleep,
      onDispatch: s => recovering.dispatchInjectTurn(s) });
    cleanups.push(() => watcher.stop());
    await watcher.start(); watcher.stop();
    expect(h.router.getOrStartRuntime).toHaveBeenCalledTimes(3);
    expect(retrySleep).not.toHaveBeenCalled();
    expect(h.acquisitionSleep.mock.calls).toEqual([[30_000], [30_000]]);
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.notices).toHaveBeenCalledTimes(1);
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({
      state: "suspended",
      generation: 2,
      stalledReason: "provider acquisition failed during boot-recovery: boot recovery exhausted 3 pre-prompt acquisition attempts: rpc 'spawn' timed out after 30s",
      stallNoticeUtc: expect.any(String),
    });
  });

  it("#448 shutdown during acquisition backoff hands off without replenishing or notifying", async () => {
    const h = setup();
    simulateRetiredOwnerProcess();
    const first = h.orch.dispatchInjectTurn(h.spec);
    await h.started; h.orch.suspendForRestart(); h.release();
    await expect(first).rejects.toMatchObject({ suspension: "shutdown" });
    h.runtime.prompt.mockClear(); h.router.getOrStartRuntime.mockClear();
    const recovering = h.makeOrch();
    h.router.getOrStartRuntime.mockRejectedValue(new Error("ACP connection closed"));
    h.acquisitionSleep.mockImplementationOnce(async () => { recovering.suspendForRestart(); });
    await expect(recovering.dispatchInjectTurn(h.spec)).rejects.toMatchObject({ suspension: "shutdown" });
    expect(h.router.getOrStartRuntime).toHaveBeenCalledTimes(1);
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "suspended", acpSessionId: "recorded-acp", stalledUtc: null });
  });

  it("retries an ordinary saved-session acquisition without changing its conversation", async () => {
    const h = setup();
    h.router.getOrStartRuntime.mockRejectedValueOnce(new Error("Internal error"));
    h.runtime.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
    await h.watcher.start(); await enqueueDispatchSpec(h.dataDir, h.spec);
    await h.watcher.tick(); await h.watcher.drain();
    expect(h.refusals).toEqual([]);
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.acquisitionSleep).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(h.router.getOrStartRuntime).toHaveBeenCalledTimes(2);
    expect(h.runtime.prompt).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(h.spec.prompt), undefined, expect.any(Object));
    expect(h.store.turnAttempts.get(h.spec.id)).toMatchObject({ state: "completed", acpSessionId: "recorded-acp" });
  });

  it("preserves the last load cause when an ordinary acquisition exhausts the existing budget", async () => {
    const h = setup();
    h.router.getOrStartRuntime.mockRejectedValue(new Error("Internal error: native resume failed"));
    await h.watcher.start(); await enqueueDispatchSpec(h.dataDir, h.spec);
    await h.watcher.tick(); await h.watcher.drain();
    expect(h.router.getOrStartRuntime).toHaveBeenCalledTimes(3);
    expect(h.acquisitionSleep.mock.calls).toEqual([[30_000], [30_000]]);
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.store.get("discord:worker")?.acpSessionId).toBe("recorded-acp");
    expect(h.store.turnAttempts.get(h.spec.id)?.stalledReason).toContain("Internal error: native resume failed");
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
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0]).startsWith("continue\n")).toBe(true);
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).toContain("The process restarted while the turn was in flight.");
    expect(String(h.runtime.prompt.mock.calls.at(-1)?.[0])).not.toContain("original work");
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

  it("#691 persists a dispatched status card on the owning attempt", async () => {
    const h = setup();
    h.config.SEAM_DISPATCH_STATUS_PANEL = true;
    h.runtime.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });

    await h.orch.dispatchInjectTurn(h.spec);

    expect(h.store.turnAttempts.get(h.spec.id)?.statusCard).toEqual({
      channelId: "worker",
      messageId: "panel",
    });
  });

  it("#691 reattaches the ACP client and adopts a dispatched result after restart", async () => {
    const h = setup();
    h.spec.id = "wake-recovery";
    h.spec.kind = "wake";
    h.store.turnAttempts.registerOwner("controller-before-restart");
    const attempt = h.store.turnAttempts.claim(
      h.spec,
      "synthetic-identity",
      "controller-before-restart",
      "dispatch",
    );
    h.store.turnAttempts.bind(attempt, "recorded-acp");
    h.store.turnAttempts.bindStatusCard(attempt, {
      channelId: "worker",
      messageId: "wake-card",
    });
    h.store.turnAttempts.startPrompt(attempt);
    h.store.turnAttempts.recordRemoteRecovery(attempt, {
      version: 1,
      location: "remote-one",
      slot: 19,
      submissionId: "submission-wake",
      acpSessionId: "recorded-acp",
      delegatedUtc: "2026-09-27T16:11:00.000Z",
    });
    h.store.turnAttempts.suspendBoot("controller-before-restart");

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: vi.fn(() => true),
      detach: vi.fn(),
    });
    let input = "";
    const permissionAnswered = new Promise<void>((resolve) => {
      stdin.on("data", (chunk) => {
        input += chunk.toString();
        for (const line of input.split("\n").filter(Boolean)) {
          const frame = JSON.parse(line) as { id?: unknown; result?: unknown };
          if (frame.id === 81) resolve();
        }
      });
    });
    const profile = { id: "codex" } as AgentProfile;
    let adoptedRuntime: AgentRuntime | undefined;
    h.router.adoptRecoveryRuntime.mockImplementation((_record, adoptedChild, acpSessionId) => {
      const runtime = new AgentRuntime({
        profile,
        logger: pino({ level: "silent" }) as any,
        spawnFn: () => { throw new Error("recovery must not spawn"); },
      });
      runtime.attachRecovery(adoptedChild, acpSessionId);
      adoptedRuntime = runtime;
      return runtime;
    });
    h.router.releaseRecoveryRuntime.mockImplementation((_recordId, runtime) => {
      runtime.releaseRecovery();
    });

    const mux = {
      sendCmd: vi.fn(async () => ({ health: [{
        slot: 19,
        alive: true,
        recovery: {
          version: 1,
          owner: "bridge",
          submissionId: "submission-wake",
          acpSessionId: "recorded-acp",
          rung: 1,
          phase: "executing",
          retry: 0,
          budget: 3,
          remaining: 3,
          disposition: "none",
          updatedUtc: "2026-09-27T16:12:00.000Z",
        },
      }] })),
      adopt: vi.fn(() => {
        queueMicrotask(() => stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: 81,
          method: "session/request_permission",
          params: {
            sessionId: "recorded-acp",
            toolCall: { toolCallId: "tool-after-restart", kind: "execute", status: "pending", title: "second command" },
            options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
          },
        }) + "\n"));
        void permissionAnswered.then(() => child.emit("remoteRecoveryResult", {
          version: 1,
          submissionId: "submission-wake",
          acpSessionId: "recorded-acp",
          status: "completed",
          text: "recovered wake output",
          stopReason: "end_turn",
          finishedUtc: "2026-09-27T16:12:30.000Z",
        }));
        return child;
      }),
    };
    const restarted = h.makeOrch();
    restarted.setBridgeHub({ muxFor: (location: string) => location === "remote-one" ? mux : undefined,
      slotHealthFor: () => [] } as any);
    restarted.setDispatchWatcher(h.watcher);
    vi.spyOn(restarted as any, "enqueueReportBack").mockResolvedValue(undefined);

    await restarted.recoverInterruptedTurns();
    await vi.waitFor(() => expect(h.store.turnAttempts.get(h.spec.id)?.state).toBe("completed"));

    expect(mux.adopt).toHaveBeenCalledWith(19, { allowAppTraffic: true });
    expect(input).toContain('"id":81');
    expect(input).toContain('"optionId":"allow_once"');
    expect(adoptedRuntime).toBeDefined();
    await vi.waitFor(() => expect(h.router.releaseRecoveryRuntime).toHaveBeenCalledTimes(1));
    expect(h.adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "worker" }),
      "recovered wake output",
      expect.anything(),
    );
    expect(h.adapter.editPanel).toHaveBeenCalledWith(
      { channel: { platform: "discord", id: "worker" }, id: "wake-card" },
      expect.objectContaining({ title: expect.stringContaining("Done"), fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) }),
    );
  });

  it.each(["missing", "dead"])("continues a %s remote wake in its saved session and runs the next queued wake", async fault => {
    const h = setup();
    simulateRetiredOwnerProcess();
    h.store.turnAttempts.registerOwner("controller-before-restart");
    const attempt = h.store.turnAttempts.claim(
      { ...h.spec, id: "dead-wake", kind: "wake", returnTo: undefined },
      executionIdentity({ agentId: "codex", location: "local", session: "live",
        model: "default", cwd: "/synthetic", config: "{}" }),
      "controller-before-restart",
      "dispatch",
    );
    h.store.turnAttempts.bind(attempt, "recorded-acp");
    h.store.turnAttempts.bindStatusCard(attempt, {
      channelId: "worker",
      messageId: "dead-card",
    });
    h.store.turnAttempts.startPrompt(attempt);
    h.store.turnAttempts.recordRemoteRecovery(attempt, {
      version: 1,
      location: "remote-one",
      slot: 19,
      submissionId: "submission-dead",
      acpSessionId: "recorded-acp",
      delegatedUtc: "2026-09-27T20:11:00.000Z",
    });
    h.store.turnAttempts.suspendBoot("controller-before-restart");

    const mux = {
      sendCmd: vi.fn(async () => ({ health: fault === "missing" ? [] : [{
        slot: 19,
        alive: false,
        recovery: {
          version: 1,
          owner: "bridge",
          submissionId: "submission-dead",
          acpSessionId: "recorded-acp",
          rung: 1,
          phase: "local_write_completed",
          retry: 0,
          budget: 3,
          remaining: 3,
          disposition: "none",
          updatedUtc: "2026-09-27T20:12:00.000Z",
        },
      }] })),
      adopt: vi.fn(),
    };
    h.runtime.prompt.mockImplementation(async (text) => {
      if (String(text).startsWith("continue\n")) expect(String(text)).not.toContain("original work");
      else expect(String(text)).toContain("queued wake");
      return { stopReason: "end_turn" };
    });
    const restarted = h.makeOrch();
    restarted.setBridgeHub({
      ...localBridgeHub([], h.dataDir),
      muxFor: (location: string) => location === "remote-one" ? mux : undefined,
      slotHealthFor: () => [],
    } as any);
    vi.spyOn(restarted as any, "enqueueReportBack").mockResolvedValue(undefined);
    const watcher = createRuntimeDispatchWatcher({
      attempts: h.store.turnAttempts,
      dataDir: h.dataDir,
      logger: pino({ level: "silent" }) as any,
      resumeEnabled: true,
      runtime: restarted,
      pollMs: 1_000_000,
    });
    restarted.setDispatchWatcher(watcher);
    cleanups.push(() => watcher.stop());
    const resume = vi.spyOn(restarted, "resumeTurnManually");

    await enqueueDispatchSpec(h.dataDir, {
      ...h.spec,
      id: "wake-after-dead",
      kind: "wake",
      returnTo: undefined,
      prompt: "queued wake",
    });
    await watcher.start();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    await Promise.all(resume.mock.results.map(result => result.value));
    await watcher.tick();
    await watcher.drain();
    await vi.waitFor(() => expect(h.store.turnAttempts.get("dead-wake")?.state).toBe("completed"));
    await vi.waitFor(() => expect(h.store.turnAttempts.get("wake-after-dead")?.state).toBe("completed"));

    expect(mux.adopt).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get("dead-wake")).toMatchObject({
      state: "completed", generation: 2, acpSessionId: "recorded-acp",
      outcome: { status: "completed" },
    });
    expect(h.store.turnAttempts.get("wake-after-dead")?.state).toBe("completed");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(h.runtime.prompt).toHaveBeenCalledTimes(2);
    expect(h.runtime.prompt.mock.calls.filter(([text]) => String(text).startsWith("continue\n"))).toHaveLength(1);
    expect(h.router.getOrStartRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ channelRef: "worker" }), { resumeSessionId: "recorded-acp" }, expect.any(Function),
    );
  }, 15_000);

  it("runs a queued report-back after a human interrupts the active dispatch", async () => {
    const h = setup();
    const order: string[] = [];
    let releaseActive!: () => void;
    let activeStarted!: () => void;
    const active = new Promise<void>((resolve) => { activeStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseActive = resolve; });
    h.runtime.prompt
      .mockImplementationOnce(async () => {
        order.push("active dispatch");
        activeStarted();
        await release;
        return { stopReason: "cancelled" };
      })
      .mockImplementationOnce(async () => {
        order.push("report-back");
        return { stopReason: "end_turn" };
      });
    Object.assign(h.router, {
      isBusy: () => true,
      abortTurn: vi.fn(async () => {
        releaseActive();
        return "cancelled" as const;
      }),
    });
    vi.spyOn(h.orch as any, "handleIncomingMessageInner").mockImplementation(async () => {
      order.push("human");
    });
    await h.watcher.start();
    await enqueueDispatchSpec(h.dataDir, { ...h.spec, returnTo: undefined });
    await enqueueDispatchSpec(h.dataDir, {
      ...h.spec,
      id: "queued-report-back",
      kind: "report_back",
      returnTo: undefined,
      prompt: "worker result",
    });
    void h.watcher.tick();
    await active;

    const handling = (h.orch as any).handleIncomingMessage({
      messageId: "1553034067430215711",
      channel: { platform: "discord", id: "worker" },
      authorId: "human",
      authorName: "Human",
      authorIsBot: false,
      text: "new human direction",
    });
    await vi.waitFor(() => expect(order).toContain("human"));
    await handling;
    await vi.waitFor(() =>
      expect(h.store.turnAttempts.get("queued-report-back")?.state).toBe("completed")
    );

    expect(h.store.turnAttempts.get("held")?.state).toBe("cancelled");
    expect(h.store.turnAttempts.get("queued-report-back")?.outcome?.error).toBeUndefined();
    expect(order).toEqual(["active dispatch", "human", "report-back"]);
  }, 15_000);
});
