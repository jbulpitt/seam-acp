/**
 * #76 integration-style flows: dispatch-path resume (continue + loadSession),
 * report-back / chain succession, command-layer cancel vs dispose/onDead,
 * live-turn re-fire, flag-off inventory, max-age / deleted-thread abandon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { pino } from "pino";
import { Orchestrator } from "../src/platforms/discord/orchestrator.js";
import { SessionStore } from "../src/core/session-store.js";
import { DispatchWatcher } from "../src/core/dispatch/watcher.js";
import { dispatchDirs, type DispatchSpec } from "../src/core/dispatch/types.js";
import {
  CONTINUE_PROMPT,
  finishLiveTurn,
  listLiveMarkers,
  writeLiveMarker,
} from "../src/core/dispatch/turn-resume.js";
import type { Logger } from "../src/lib/logger.js";
import type { SessionRecord } from "../src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-worker",
  platform: "discord",
  channelRef: "thread-worker",
  parentRef: "channel-1",
  agentId: "claude",
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
  loadSession?: ReturnType<typeof vi.fn>;
  newSession?: ReturnType<typeof vi.fn>;
  handleInner?: ReturnType<typeof vi.fn>;
}): {
  orch: Orchestrator;
  prompts: string[];
  announced: string[];
  loadSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
} {
  const prompts: string[] = [];
  const announced: string[] = [];
  const loadSession = opts?.loadSession ?? vi.fn(async () => ({ sessionId: "acp-recorded" }));
  const newSession = opts?.newSession ?? vi.fn(async () => ({ sessionId: "acp-NEW" }));
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: (o: { channelRef: string }) =>
      record({ id: `discord:${o.channelRef}`, channelRef: o.channelRef }),
    getProfile: () => ({
      id: "claude",
      sessionManager: { deleteSession: async () => {} },
    }),
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
      async sendMessage(_ch: unknown, text: string) {
        announced.push(text);
        return { channel: { platform: "discord", id: "x" }, id: "m" };
      },
      async editMessage() {},
      getThreadLiveState: opts?.getThreadLiveState ?? (async () => ({ locked: false, archived: false })),
    } as any,
    router: router as any,
    store,
    renderer: {} as any,
  });
  (orch as any).postDispatchStartIndicator = async () => undefined;
  (orch as any).postDispatchOutput = async () => {};
  if (opts?.handleInner) {
    (orch as any).handleIncomingMessageInner = opts.handleInner;
  }
  return { orch, prompts, announced, loadSession, newSession };
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-turn-resume-flow-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dispatch-path resume: continue + loadSession (#76)", () => {
  it("swaps the prompt to continue and loadSession(recorded id), never newSession", async () => {
    store.recordDelegation({
      id: "disp-1",
      kind: "handoff",
      targetRef: "thread-worker",
      correlationId: "corr-x",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    const { orch, loadSession, newSession } = makeOrch({ enabled: true });
    const seen: string[] = [];
    (orch as any).injectTurn = async (_t: unknown, prompt: string, opts: { resumeSessionId?: string }) => {
      seen.push(prompt);
      expect(opts.resumeSessionId).toBe("acp-recorded");
      return { text: "picked up where I left off", error: undefined, stopReason: "end_turn" };
    };
    await orch.dispatchInjectTurn(handoffSpec({ resume: true }));
    expect(seen).toEqual([CONTINUE_PROMPT]);
    expect(newSession).not.toHaveBeenCalled();
    void loadSession;
  });

  it("announces the resume in-thread", async () => {
    store.recordDelegation({
      id: "disp-1",
      kind: "handoff",
      targetRef: "thread-worker",
      acpSessionId: "acp-recorded",
      status: "interrupted",
    });
    const { orch, announced } = makeOrch({ enabled: true });
    (orch as any).injectTurn = async () => ({
      text: "ok",
      error: undefined,
      stopReason: "end_turn",
    });
    await orch.dispatchInjectTurn(handoffSpec({ resume: true }));
    expect(announced.some((t) => t.includes("resuming after restart"))).toBe(true);
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
    const { orch } = makeOrch({ enabled: true });
    (orch as any).injectTurn = async () => ({
      text: "finished after continue",
      error: undefined,
      stopReason: "end_turn",
    });
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
    const { orch } = makeOrch({ enabled: true });
    (orch as any).injectTurn = async () => ({
      text: "output of a after continue",
      error: undefined,
      stopReason: "end_turn",
    });
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
    await writeFile(path.join(dirs.running, "disp-1.json"), JSON.stringify(spec), "utf8");

    const seen: string[] = [];
    const watcher = new DispatchWatcher({
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
  it("flag off: re-enqueues unmarked (today's replay); flag on: marks in place", async () => {
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.pending, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    await writeFile(
      path.join(dirs.running, "job-c.json"),
      JSON.stringify({ target: "thread-9", prompt: "resume me", session: "isolated" }),
      "utf8"
    );

    const offSeen: DispatchSpec[] = [];
    const off = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      resumeEnabled: false,
      onDispatch: async (spec) => {
        offSeen.push(spec);
        return { output: "replayed", stopReason: "end_turn" };
      },
    });
    await off.start();
    off.stop();
    expect(offSeen).toHaveLength(1);
    expect(offSeen[0]!.resume).toBeUndefined();
    expect(offSeen[0]!.prompt).toBe("resume me");

    // Reset a leftover in running/ for the flag-on path.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "seam-resume-on-"));
    const dirs2 = dispatchDirs(dir2);
    await mkdir(dirs2.running, { recursive: true });
    await mkdir(dirs2.pending, { recursive: true });
    await mkdir(dirs2.done, { recursive: true });
    await writeFile(
      path.join(dirs2.running, "job-c.json"),
      JSON.stringify({ target: "thread-9", prompt: "resume me", session: "isolated" }),
      "utf8"
    );
    const onSeen: DispatchSpec[] = [];
    const on = new DispatchWatcher({
      dataDir: dir2,
      logger: silent,
      resumeEnabled: true,
      onDispatch: async (spec) => {
        onSeen.push(spec);
        return { output: "should not auto-fire from start()", stopReason: "end_turn" };
      },
    });
    await on.start();
    on.stop();
    expect(onSeen).toEqual([]);
    const marked = JSON.parse(await readFile(path.join(dirs2.running, "job-c.json"), "utf8"));
    expect(marked.resume).toBe(true);
    expect(marked.prompt).toBe("resume me");
    const listed = await on.listStaleRunning();
    expect(listed[0]?.resume).toBe(true);
    fs.rmSync(dir2, { recursive: true, force: true });
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
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      resumeEnabled: true,
      onDispatch: async () => ({ output: "ok", stopReason: "end_turn" }),
    });
    await watcher.start();
    orch.setDispatchWatcher(watcher);
    await orch.recoverInterruptedTurns();
    watcher.stop();
    const pending = await readdir(dirs.pending);
    expect(pending).toContain("disp-1.json");
    const body = JSON.parse(await readFile(path.join(dirs.pending, "disp-1.json"), "utf8"));
    expect(body.resume).toBe(true);
    expect(body.prompt).toBe("do the overnight git push");
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
