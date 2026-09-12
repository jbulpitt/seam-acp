/**
 * #76 integration-style flows: dispatch-path resume (continue + loadSession),
 * report-back / chain succession, command-layer cancel vs dispose/onDead,
 * live-turn re-fire, flag-off inventory, max-age / deleted-thread abandon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { simulateRetiredOwnerProcess } from "./restart-process-fixture.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher, createRuntimeDispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import {
  CONTINUE_PROMPT,
  finishLiveTurn,
  listLiveMarkers,
  writeLiveMarker,
} from "../packages/core/src/core/dispatch/turn-resume.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { DispatchSuspendedError } from "../packages/core/src/core/dispatch/attempt-store.js";
import type { InjectTurnOptions } from "../packages/core/src/core/inject-turn.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-worker",
  platform: "discord",
  channelRef: "thread-worker",
  parentRef: "channel-1",
  agentId: "codex",
  acpSessionId: "acp-recorded",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00.000Z",
  updatedUtc: "2026-01-01T00:00:00.000Z",
  ...over,
});

function makeOrch(opts?: {
  enabled?: boolean;
  getThreadLiveState?: (ch: { id: string }) => Promise<{ locked: boolean; archived: boolean } | undefined>;
  loadSession?: ReturnType<typeof vi.fn<(opts: { sessionId: string }) => Promise<{ sessionId: string }>>>;
  newSession?: ReturnType<typeof vi.fn<() => Promise<{ sessionId: string }>>>;
  handleInner?: ReturnType<typeof vi.fn>;
  getProfile?: (id?: string, location?: string) => unknown;
}): {
  orch: Orchestrator;
  prompts: string[];
  announced: string[];
  sent: Array<{ channel: string; text: string }>;
  loadSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
} {
  const catalogProfile = { id: "codex", defaultModel: "default" } as any;
  const prompts: string[] = [];
  const announced: string[] = [];
  const sent: Array<{ channel: string; text: string }> = [];
  const loadSession = opts?.loadSession ?? vi.fn(async () => ({ sessionId: "acp-recorded" }));
  const newSession = opts?.newSession ?? vi.fn(async () => ({ sessionId: "acp-NEW" }));
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    reuseMcpServers: () => [],
    ensureSessionRecord: (o: { channelRef: string }) =>
      record({ id: `discord:${o.channelRef}`, channelRef: o.channelRef }),
    getProfile: opts?.getProfile ?? (() => ({
      id: "codex",
      sessionManager: { deleteSession: async () => {} },
    })),
    resolveProfileForChannel: (id?: string, _channel?: string, location?: string) => router.getProfile(id, location),
    assertAgentAllowedForChannel: () => {},
    assertAgentAllowedForRecord: () => {},
    getOrStartRuntime: async () => ({
      onEvent() {},
      async prompt(p: string) {
        prompts.push(p);
        return { stopReason: "end_turn" };
      },
      async idle() {},
      getSessionInfo() {
        return { sessionId: "acp-recorded" };
      },
      async dispose() {},
      async loadSession(o: { sessionId: string }) {
        return loadSession(o);
      },
      async newSession() {
        return newSession();
      },
    }),
    hasRuntime: () => true,
    abortTurn: vi.fn(async () => "cancelled"),
    invalidate: vi.fn(async () => {}),
    killAll: vi.fn(async () => 1),
    disposeAll: vi.fn(async () => {}),
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
      SEAM_TURN_RESUME_ENABLED: opts?.enabled === true,
      SEAM_TURN_RESUME_MAX_AGE_SECONDS: 7200,
    } as any,
    adapter: {
      async sendMessage(ch: { id?: string }, text: string) {
        announced.push(text);
        sent.push({ channel: ch.id ?? "", text });
        return { channel: { platform: "discord", id: "x" }, id: "m" };
      },
      async editMessage() {},
      getThreadLiveState: opts?.getThreadLiveState ?? (async () => ({ locked: false, archived: false })),
    } as any,
    modelCatalog: fixtureModelCatalog([catalogProfile]),
    router: router as any,
    store,
    renderer: {
      statusPanel: () => ({ title: "", fields: [] }),
      panel: () => ({ title: "", fields: [] }),
    } as any,
  });
  (orch as any).postDispatchStartIndicator = async () => undefined;
  (orch as any).postDispatchOutput = async () => {};
  if (opts?.handleInner) {
    (orch as any).handleIncomingMessageInner = opts.handleInner;
  }
  return { orch, prompts, announced, sent, loadSession, newSession };
}

function handoffSpec(over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    id: "disp-1",
    target: "thread-worker",
    prompt: "do the overnight git push",
    session: "isolated",
    returnTo: "thread-boss",
    kind: "handoff",
    correlationId: "corr-x",
    createdUtc: new Date().toISOString(),
    stream: false,
    ...over,
  };
}

async function seedInterrupted(spec: DispatchSpec = handoffSpec()): Promise<void> {
  // Synthetic process boundary; separate ownership tests verify actual PID
  // liveness. The production dispatcher captures the exact spec/identity.
  simulateRetiredOwnerProcess();
  const { orch } = makeOrch({ enabled: true });
  if (spec.location && spec.location !== "local") {
    orch.setBridgeHub({
      markSessionBridge: () => {},
      get: () => ({ mux: {} }),
      mcpServersForRemoteSpawn: () => undefined,
    } as any);
  }
  (orch as any).injectTurn = async (_t: unknown, _p: string, opts: InjectTurnOptions) => {
    await opts.onSession?.("acp-recorded");
    opts.lifecycle?.beforePrompt();
    orch.suspendForRestart();
    throw DispatchSuspendedError.shutdown(spec.id, "fixture restart");
  };
  await expect(orch.dispatchInjectTurn({ ...spec, resume: false })).rejects.toBeInstanceOf(DispatchSuspendedError);
}

async function syntheticStart(opts: InjectTurnOptions): Promise<void> {
  await opts.onSession?.("acp-recorded");
  opts.lifecycle?.beforePrompt();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-turn-resume-flow-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dispatch-path resume: continue + loadSession (#76)", () => {
  it("retains legacy ACP-only jobs whose provider identity cannot be proven (#250)", async () => {
    store.recordDelegation({ id: "disp-1", kind: "handoff", targetRef: "thread-worker", acpSessionId: "acp-recorded", status: "interrupted" });
    const { orch } = makeOrch({ enabled: true });
    const inject = vi.spyOn(orch, "injectTurn");
    await expect(orch.dispatchInjectTurn(handoffSpec({ resume: true }))).rejects.toBeInstanceOf(DispatchSuspendedError);
    expect(inject).not.toHaveBeenCalled();
    expect(store.getDelegation("disp-1")?.status).toBe("interrupted");
  });
  it("swaps the prompt to continue and loadSession(recorded id), never newSession", async () => {
    store.recordDelegation({
      id: "disp-1",
      kind: "handoff",
      targetRef: "thread-worker",
      correlationId: "corr-x",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    await seedInterrupted();
    const { orch, loadSession, newSession } = makeOrch({ enabled: true });
    const seen: string[] = [];
    (orch as any).injectTurn = async (_t: unknown, prompt: string, opts: InjectTurnOptions) => {
      await syntheticStart(opts);
      seen.push(prompt);
      expect(opts.resumeSessionId).toBe("acp-recorded");
      return { text: "picked up where I left off", error: undefined, stopReason: "end_turn" };
    };
    await orch.dispatchInjectTurn(handoffSpec({ resume: true }));
    expect(seen).toEqual([CONTINUE_PROMPT]);
    expect(newSession).not.toHaveBeenCalled();
    void loadSession;
  });

  it("does not announce an intermediate restart state (#250)", async () => {
    store.recordDelegation({
      id: "disp-1",
      kind: "handoff",
      targetRef: "thread-worker",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    await seedInterrupted();
    const { orch, announced } = makeOrch({ enabled: true });
    (orch as any).injectTurn = async (_t: unknown, _p: string, opts: InjectTurnOptions) => {
      await syntheticStart(opts);
      return ({
      text: "ok",
      error: undefined,
      stopReason: "end_turn",
    }); };
    await orch.dispatchInjectTurn(handoffSpec({ resume: true }));
    expect(announced.some((t) => t.includes("resuming after restart"))).toBe(false);
  });

  it("a resumed turn's report-back is delivered to returnTo exactly once", async () => {
    store.recordDelegation({
      id: "disp-1",
      kind: "handoff",
      targetRef: "thread-worker",
      correlationId: "corr-x",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    await seedInterrupted();
    const { orch } = makeOrch({ enabled: true });
    (orch as any).injectTurn = async (_t: unknown, _p: string, opts: InjectTurnOptions) => {
      await syntheticStart(opts);
      return ({
      text: "finished after continue",
      error: undefined,
      stopReason: "end_turn",
    }); };
    await orch.dispatchInjectTurn(handoffSpec({ resume: true }));
    const pending = fs
      .readdirSync(dispatchDirs(dir).pending)
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(fs.readFileSync(path.join(dispatchDirs(dir).pending, n), "utf8")));
    const rbs = pending.filter((s: DispatchSpec) => s.kind === "report_back");
    expect(rbs).toHaveLength(1);
    expect(rbs[0].target).toBe("thread-boss");
    expect(rbs[0].prompt).toContain("finished after continue");
    expect(
      store.listRecentDelegations().filter((e) => e.kind === "report_back" && e.correlationId === "corr-x")
    ).toHaveLength(1);

    // Second completion of the same correlation must not enqueue another.
    await (orch as any).enqueueReportBack(handoffSpec({ resume: true }), "again");
    expect(
      store.listRecentDelegations().filter((e) => e.kind === "report_back" && e.correlationId === "corr-x")
    ).toHaveLength(1);
  });

  it("a resumed chain hop advances to the next hop on completion", async () => {
    store.createChain({
      id: "chain-1",
      hops: ["b", "c"],
      originRef: "thread-origin",
      promptPreview: "pipe it",
      currentIndex: 1,
    });
    store.recordDelegation({
      id: "spec-a",
      kind: "forward",
      targetRef: "thread-origin",
      correlationId: "chain-1",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    await seedInterrupted(handoffSpec({ id: "spec-a", target: "thread-origin", chainId: "chain-1", kind: "forward", correlationId: "chain-1" }));
    const { orch } = makeOrch({ enabled: true });
    (orch as any).injectTurn = async (_t: unknown, _p: string, opts: InjectTurnOptions) => {
      await syntheticStart(opts);
      return ({
      text: "output of a after continue",
      error: undefined,
      stopReason: "end_turn",
    }); };
    await orch.dispatchInjectTurn({
      id: "spec-a",
      target: "thread-origin",
      prompt: "original hop a",
      session: "isolated",
      chainId: "chain-1",
      kind: "forward",
      correlationId: "chain-1",
      resume: true,
      createdUtc: new Date().toISOString(),
      stream: false,
    });
    const after = store.getChain("chain-1")!;
    expect(after.hops).toEqual(["c"]);
    expect(after.currentIndex).toBe(2);
    const pending = fs
      .readdirSync(dispatchDirs(dir).pending)
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(fs.readFileSync(path.join(dispatchDirs(dir).pending, n), "utf8")) as DispatchSpec);
    expect(pending.some((s) => s.chainId === "chain-1" && s.prompt.includes("output of a after continue"))).toBe(
      true
    );
  });
});

describe("command-layer cancel vs dispose / onDead", () => {
  it("cancelRunning writes a done-file so recoverStale does NOT re-run the spec", async () => {
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.pending, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    const spec = handoffSpec();
    store.turnAttempts.admit(spec);
    await writeFile(path.join(dirs.running, "disp-1.json"), JSON.stringify(spec), "utf8");

    const seen: string[] = [];
    const watcher = new DispatchWatcher({ attempts: store.turnAttempts,
      dataDir: dir,
      logger: silent,
      onDispatch: async (s) => {
        seen.push(s.id);
        return { output: "should not run", stopReason: "end_turn" };
      },
    });
    const cancelled = await watcher.cancelRunning({ target: "thread-worker" });
    expect(cancelled).toEqual(["disp-1"]);
    expect(await readdir(dirs.running)).toEqual([]);
    const done = JSON.parse(await readFile(path.join(dirs.done, "disp-1.json"), "utf8"));
    expect(done.error).toMatch(/cancelled/);

    await watcher.start();
    watcher.stop();
    expect(seen).toEqual([]);
  });

  it("cmdCancel / cmdKill finalize markers BEFORE abortTurn / killAll", async () => {
    const { orch } = makeOrch();
    const order: string[] = [];
    const watcher = {
      cancelRunning: async () => {
        order.push("cancelRunning");
        return ["disp-1"];
      },
    };
    orch.setDispatchWatcher(watcher as any);
    (orch as any).router.abortTurn = async () => {
      order.push("abortTurn");
      return "cancelled";
    };
    (orch as any).router.killAll = async () => {
      order.push("killAll");
      return 1;
    };
    await writeLiveMarker(dir, {
      id: "live-x",
      kind: "live",
      channelRef: "thread-worker",
      sessionRecordId: "discord:thread-worker",
      acpSessionId: "acp-recorded",
      startedUtc: new Date().toISOString(),
    });
    (orch as any).liveTurnByChannel.set("thread-worker", "live-x");

    const i = {
      options: { getString: () => null, getBoolean: () => false },
      deferReply: async () => {},
      editReply: async () => {},
      reply: async () => {},
      channelId: "thread-worker",
    };
    (orch as any).recordFromInteraction = () => record();
    await (orch as any).cmdCancel(i);
    expect(order[0]).toBe("cancelRunning");
    expect(order).toContain("abortTurn");
    expect(await listLiveMarkers(dir)).toEqual([]);

    order.length = 0;
    await writeLiveMarker(dir, {
      id: "live-y",
      kind: "live",
      channelRef: "thread-other",
      sessionRecordId: "discord:thread-other",
      acpSessionId: "acp-2",
      startedUtc: new Date().toISOString(),
    });
    await (orch as any).cmdKill(i);
    expect(order[0]).toBe("cancelRunning");
    expect(order).toContain("killAll");
    expect(await listLiveMarkers(dir)).toEqual([]);
  });

  it("disposeAll / invalidate do not clear live markers (SIGTERM is not cancel)", async () => {
    await writeLiveMarker(dir, {
      id: "live-sigterm",
      kind: "live",
      channelRef: "thread-worker",
      sessionRecordId: "discord:thread-worker",
      acpSessionId: "acp-recorded",
      startedUtc: new Date().toISOString(),
    });
    const { orch } = makeOrch();
    // Simulate what SIGTERM does: watcher.stop() + router.disposeAll().
    // Neither path calls clearTurnMarkers*.
    await (orch as any).router.disposeAll();
    await (orch as any).router.invalidate("discord:thread-worker");
    expect((await listLiveMarkers(dir)).map((m) => m.id)).toEqual(["live-sigterm"]);
  });
});

describe("watcher recoverStale vs resumeEnabled", () => {
  it("keeps boot admission closed until a slow resume pass restores thread FIFO (#303)", async () => {
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.pending, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    const created = Date.now();
    const p1 = handoffSpec({ id: "p1", createdUtc: new Date(created).toISOString() });
    const p2 = handoffSpec({ id: "p2", createdUtc: new Date(created + 1_000).toISOString() });
    const p3 = handoffSpec({ id: "p3", createdUtc: new Date(created + 2_000).toISOString() });
    await writeFile(path.join(dirs.running, "p1.json"), JSON.stringify(p1), "utf8");
    await writeFile(path.join(dirs.pending, "p2.json"), JSON.stringify(p2), "utf8");
    await writeFile(path.join(dirs.pending, "p3.json"), JSON.stringify(p3), "utf8");
    store.recordDelegation({
      id: "p1",
      kind: "handoff",
      targetRef: "thread-worker",
      correlationId: "corr-x",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });

    await seedInterrupted(p1);
    let resumePassEntered!: () => void;
    const resumePassStarted = new Promise<void>((resolve) => { resumePassEntered = resolve; });
    let releaseResumePass!: () => void;
    const slowResumePass = new Promise<void>((resolve) => { releaseResumePass = resolve; });
    const { orch } = makeOrch({
      enabled: true,
      getThreadLiveState: async () => {
        resumePassEntered();
        await slowResumePass;
        return { locked: false, archived: false };
      },
    });
    const seen: string[] = [];
    const watcher = createRuntimeDispatchWatcher({ attempts: store.turnAttempts,
      dataDir: dir,
      logger: silent,
      resumeEnabled: true,
      pollMs: 60_000,
      runtime: {
        dispatchInjectTurn: async (spec) => {
          seen.push(spec.id);
          return { output: spec.id, stopReason: "end_turn" };
        },
        observeRetainedDispatch: (spec) => orch.observeRetainedDispatch(spec),
        recoverInterruptedTurns: () => orch.recoverInterruptedTurns(),
      },
    });
    orch.setDispatchWatcher(watcher);

    await watcher.start({ waitForInitialDispatches: false });
    await resumePassStarted;
    // #307: protects the closed boot gate; deleting this assertion lets queued
    // work begin while interrupted-turn preconditions are still unresolved.
    expect(seen).toEqual([]);
    releaseResumePass();
    await watcher.initialDispatchesSettled();
    watcher.stop();

    // #307: protects restart FIFO and original pending order; deleting this
    // assertion lets the interrupted turn land behind either queued successor.
    expect(seen).toEqual(["p1", "p2", "p3"]);
  });

  it("resume opt-out never replays prompted SQL work; opt-in continues without files", async () => {
    const spec = handoffSpec();
    await seedInterrupted(spec);
    const seen: DispatchSpec[] = [];
    for (const enabled of [false, true]) {
      const { orch } = makeOrch({ enabled });
      const watcher = createRuntimeDispatchWatcher({ attempts: store.turnAttempts,
        dataDir: dir, logger: silent, resumeEnabled: enabled, runtime: {
          dispatchInjectTurn: async s => { seen.push(s); throw DispatchSuspendedError.shutdown(s.id, "fixture handoff"); },
          observeRetainedDispatch: (s, err) => orch.observeRetainedDispatch(s, err),
          recoverInterruptedTurns: () => orch.recoverInterruptedTurns(),
        } });
      orch.setDispatchWatcher(watcher);
      await watcher.start(); watcher.stop();
      expect(seen).toHaveLength(enabled ? 1 : 0);
    }
    expect(seen[0]).toMatchObject({ id: spec.id, resume: true, prompt: spec.prompt });
    expect(store.turnAttempts.get(spec.id)).toMatchObject({ promptStarted: true, acpSessionId: "acp-recorded" });
  });

  it("recoverInterruptedTurns requeues a marked dispatch spec when the flag is on", async () => {
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.pending, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    const spec = handoffSpec({ createdUtc: new Date().toISOString() });
    await writeFile(path.join(dirs.running, "disp-1.json"), JSON.stringify(spec), "utf8");
    store.recordDelegation({
      id: "disp-1",
      kind: "handoff",
      targetRef: "thread-worker",
      correlationId: "corr-x",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    const { orch } = makeOrch({ enabled: true });
    const watcher = new DispatchWatcher({ attempts: store.turnAttempts,
      dataDir: dir,
      logger: silent,
      resumeEnabled: true,
      onDispatch: async () => ({ output: "ok", stopReason: "end_turn" }),
    });
    await seedInterrupted(spec);
    await watcher.start();
    orch.setDispatchWatcher(watcher);
    await orch.recoverInterruptedTurns();
    watcher.stop();
    const pending = await readdir(dirs.pending);
    expect(pending).toEqual([]);
    const body = (await watcher.listStaleRunning())[0]!;
    expect(body.resume).toBe(true);
    expect(body.prompt).toBe("do the overnight git push");
  });

  it("does not publish an owned remote resume until bridge reconciliation is ready (#290)", async () => {
    const spec = handoffSpec({
      location: "remote-a",
      agentId: "codex",
      createdUtc: new Date().toISOString(),
    });
    await seedInterrupted(spec);
    const before = store.turnAttempts.get(spec.id)!;
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.pending, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    await writeFile(path.join(dirs.running, `${spec.id}.json`), JSON.stringify(spec), "utf8");

    const { orch, sent } = makeOrch({ enabled: true });
    (orch as any).injectTurn = async (_t: unknown, prompt: string, opts: InjectTurnOptions) => {
      expect(prompt).toBe(CONTINUE_PROMPT);
      await syntheticStart(opts);
      return { text: "continued after reconciliation", error: undefined, stopReason: "end_turn" };
    };
    let ready = false;
    let readyListener: ((id: string) => void) | undefined;
    const markSessionBridge = vi.fn();
    orch.setBridgeHub({
      isBridgeReady: () => ready,
      onBridgeReady: (listener: (id: string) => void) => {
        readyListener = listener;
        return () => { readyListener = undefined; };
      },
      markSessionBridge,
      get: () => ({ mux: {} }),
      mcpServersForRemoteSpawn: () => undefined,
    } as any);
    const watcher = createRuntimeDispatchWatcher({ attempts: store.turnAttempts,
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      resumeEnabled: true,
      runtime: orch,
    });
    orch.setDispatchWatcher(watcher);
    await watcher.start({ waitForInitialDispatches: false });

    let settled = false;
    const recovery = watcher.initialDispatchesSettled().then(() => { settled = true; });
    await vi.waitFor(() => {
      expect(Boolean(readyListener) || settled).toBe(true);
    });
    expect(readyListener).toBeTypeOf("function");
    expect(settled).toBe(false);
    expect(await readdir(dirs.pending)).toEqual([]);
    expect(await readdir(dirs.running)).toEqual([`${spec.id}.json`]);

    ready = true;
    readyListener?.("remote-a");
    await recovery;
    expect(markSessionBridge).toHaveBeenCalledWith("discord:thread-worker", "remote-a");
    watcher.stop();
    const retained = store.turnAttempts.get(spec.id)!;
    // #250 deliberately forbids prompt-started remote replay. Readiness gates
    // the attempt, then the unsupported continuation is made loud instead of
    // being retried as a new prompt.
    expect(retained.state).toBe("suspended");
    expect(retained.generation).toBe(before.generation);
    expect(retained.ownerBoot).toBe(before.ownerBoot);
    expect(retained.stalledUtc).toEqual(expect.any(String));
    // #333: the notice names the cause now instead of saying "stalled after restart".
    expect(sent.some((message) => message.channel === "thread-boss"
      && message.text.includes("could not resume:"))).toBe(true);
    expect(await readdir(dirs.running)).toEqual([`${spec.id}.json`]);
  });

  it("durably quarantines and reports a post-readiness retain through the production watcher path (#290)", async () => {
    const spec = handoffSpec({ agentId: "codex", createdUtc: new Date().toISOString() });
    await seedInterrupted(spec);
    const before = store.turnAttempts.get(spec.id)!;
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(
      path.join(dirs.pending, `${spec.id}.json`),
      JSON.stringify({ ...spec, resume: true }),
      "utf8"
    );

    // Reproduce the incident's pre-claim availability loss after boot: the
    // configured provider is absent, so ownership cannot advance and the
    // orchestrator retains rather than replaying/terminalizing.
    const { orch, sent } = makeOrch({ enabled: true, getProfile: () => undefined });
    const watcher = createRuntimeDispatchWatcher({ attempts: store.turnAttempts,
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      resumeEnabled: true,
      runtime: orch,
    });
    orch.setDispatchWatcher(watcher);
    await watcher.start();
    watcher.stop();

    const after = store.turnAttempts.get(spec.id)!;
    expect(after.state).toBe("suspended");
    expect(after.ownerBoot).toBe(before.ownerBoot);
    expect(after.generation).toBe(before.generation);
    expect(after.stalledUtc).toEqual(expect.any(String));
    // #333: the recorded reason is the specific refusal, not a constant that
    // described where execution stopped and was identical for all 65 sites.
    expect(after.stalledReason).toMatch(/execution failed before the provider took the turn/);
    expect(after.stallNoticeUtc).toEqual(expect.any(String));
    expect(sent).toContainEqual(expect.objectContaining({
      channel: "thread-boss",
      text: expect.stringContaining(`/seam workflows`),
    }));
    // #333: the notice carries the specific cause. The old sentence was the
    // same for all 65 throw sites, so an operator could not tell a transient
    // condition from a permanent one without reading the source.
    const notice = sent.find((message) => message.channel === "thread-boss")!.text;
    expect(notice).toContain("execution failed before the provider took the turn");
    expect(notice).not.toContain("is stalled after restart");
    expect(orch.inspectChannelQueue("thread-worker", Date.now())).toMatchObject({
      state: "stalled",
      runtimeBusy: false,
      stalledDispatchCount: 1,
      stalledDispatchIds: [spec.id],
    });
    expect(await readdir(dirs.running)).toEqual([`${spec.id}.json`]);
    await expect(readFile(path.join(dirs.done, `${spec.id}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Another boot must keep the quarantine and must not silently retry it.
    const secondWatcher = new DispatchWatcher({ attempts: store.turnAttempts,
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      resumeEnabled: true,
      onDispatch: vi.fn(async () => ({ output: "must not run", stopReason: "end_turn" })),
    });
    await secondWatcher.start();
    orch.setDispatchWatcher(secondWatcher);
    await orch.recoverInterruptedTurns();
    secondWatcher.stop();
    expect(await readdir(dirs.pending)).toEqual([]);
    expect(await readdir(dirs.running)).toEqual([`${spec.id}.json`]);
  });
});

describe("live-turn re-fire + flag + preconditions", () => {
  it("re-fires via queueOnChannel + handleIncomingMessageInner with text continue", async () => {
    const inner = vi.fn(async (msg: { text: string }) => {
      expect(msg.text).toBe(CONTINUE_PROMPT);
    });
    const { orch, announced } = makeOrch({ enabled: true, handleInner: inner });
    await writeLiveMarker(dir, {
      id: "live-1",
      kind: "live",
      channelRef: "thread-worker",
      sessionRecordId: "discord:thread-worker",
      acpSessionId: "acp-recorded",
      authorId: "user-1",
      startedUtc: new Date().toISOString(),
    });
    await orch.recoverInterruptedTurns();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(announced.some((t) => t.includes("resuming after restart"))).toBe(true);
  });

  it("with SEAM_TURN_RESUME_ENABLED=false, markers are reconciled but nothing auto-resumes", async () => {
    const inner = vi.fn(async () => {});
    const { orch } = makeOrch({ enabled: false, handleInner: inner });
    await writeLiveMarker(dir, {
      id: "live-off",
      kind: "live",
      channelRef: "thread-worker",
      sessionRecordId: "discord:thread-worker",
      acpSessionId: "acp-recorded",
      startedUtc: new Date().toISOString(),
    });
    await orch.recoverInterruptedTurns();
    expect(inner).not.toHaveBeenCalled();
    expect((await listLiveMarkers(dir)).map((m) => m.id)).toEqual(["live-off"]);
  });

  it("a turn older than max-age is abandoned with a notice, not resumed", async () => {
    const inner = vi.fn(async () => {});
    const { orch, announced } = makeOrch({ enabled: true, handleInner: inner });
    await writeLiveMarker(dir, {
      id: "live-old",
      kind: "live",
      channelRef: "thread-worker",
      sessionRecordId: "discord:thread-worker",
      acpSessionId: "acp-recorded",
      startedUtc: "2020-01-01T00:00:00.000Z",
    });
    await orch.recoverInterruptedTurns();
    expect(inner).not.toHaveBeenCalled();
    expect(await listLiveMarkers(dir)).toEqual([]);
    expect(announced.some((t) => /abandoned/i.test(t))).toBe(true);
  });

  it("a turn whose thread was deleted is abandoned cleanly (no notice post)", async () => {
    const inner = vi.fn(async () => {});
    const { orch, announced } = makeOrch({
      enabled: true,
      handleInner: inner,
      getThreadLiveState: async () => undefined,
    });
    await writeLiveMarker(dir, {
      id: "live-gone",
      kind: "live",
      channelRef: "thread-deleted",
      sessionRecordId: "discord:thread-deleted",
      acpSessionId: "acp-recorded",
      startedUtc: new Date().toISOString(),
    });
    await orch.recoverInterruptedTurns();
    expect(inner).not.toHaveBeenCalled();
    expect(await listLiveMarkers(dir)).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("manual resume from workflows works even when the flag is off", async () => {
    const inner = vi.fn(async (msg: { text: string }) => {
      expect(msg.text).toBe(CONTINUE_PROMPT);
    });
    const { orch } = makeOrch({ enabled: false, handleInner: inner });
    await writeLiveMarker(dir, {
      id: "live-manual",
      kind: "live",
      channelRef: "thread-worker",
      sessionRecordId: "discord:thread-worker",
      acpSessionId: "acp-recorded",
      startedUtc: new Date().toISOString(),
    });
    const msg = await orch.resumeTurnManually("live-manual");
    expect(msg).toMatch(/Resuming live turn/);
    await new Promise((r) => setTimeout(r, 30));
    expect(inner).toHaveBeenCalled();
  });

  it("manual abandon removes the marker without resuming", async () => {
    const inner = vi.fn(async () => {});
    const { orch } = makeOrch({ enabled: true, handleInner: inner });
    await writeLiveMarker(dir, {
      id: "live-ab",
      kind: "live",
      channelRef: "thread-worker",
      sessionRecordId: "discord:thread-worker",
      acpSessionId: "acp-recorded",
      startedUtc: new Date().toISOString(),
    });
    const msg = await orch.abandonTurnManually("live-ab");
    expect(msg).toMatch(/Abandoned/);
    expect(await listLiveMarkers(dir)).toEqual([]);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("workflows inventory", () => {
  it("collects interrupted ledger rows and live markers", async () => {
    store.recordDelegation({
      id: "disp-int",
      kind: "handoff",
      targetRef: "thread-worker",
      correlationId: "corr-z",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    await writeLiveMarker(dir, {
      id: "live-inv",
      kind: "live",
      channelRef: "thread-other",
      sessionRecordId: "discord:thread-other",
      acpSessionId: "acp-2",
      startedUtc: new Date().toISOString(),
    });
    const { orch } = makeOrch();
    const rows = await (orch as any).collectInterruptedRows();
    const ids = rows.map((r: { id: string }) => r.id).sort();
    expect(ids).toContain("disp-int");
    expect(ids).toContain("live-inv");
    expect(rows.find((r: { id: string }) => r.id === "disp-int")?.correlationId).toBe("corr-z");
  });
});

describe("finishLiveTurn is not invoked by dispose helpers", () => {
  it("an already-written marker survives finishLiveTurn only when we call it", async () => {
    await writeLiveMarker(dir, {
      id: "live-keep",
      kind: "live",
      channelRef: "t",
      sessionRecordId: "discord:t",
      startedUtc: new Date().toISOString(),
    });
    expect(await listLiveMarkers(dir)).toHaveLength(1);
    await finishLiveTurn(dir, {
      id: "live-keep",
      status: "cancelled",
      channelRef: "t",
      finishedUtc: new Date().toISOString(),
    });
    expect(await listLiveMarkers(dir)).toHaveLength(0);
  });
});
