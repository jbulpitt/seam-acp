import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { bridgeOwnedRetryInProgress, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { listSiblingThreadEntries } from "../packages/core/src/core/mcp/thread-inventory.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const OWNER = "progress-test-owner";
const TARGET = "thread-worker";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const spec = (id: string): DispatchSpec => ({
  id,
  target: TARGET,
  prompt: `work ${id}`,
  session: "isolated",
  createdUtc: "2026-09-22T00:00:00.000Z",
});

let dataDir: string;
let store: SessionStore;
let runtimeBusy: boolean;
let host: Orchestrator;
const watchers = new Set<DispatchWatcher>();

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-530-progress-"));
  store = new SessionStore(path.join(dataDir, "sessions.db"));
  store.upsert({
    id: `discord:${TARGET}`,
    platform: "discord",
    channelRef: TARGET,
    parentRef: "channel-1",
    agentId: "codex",
    acpSessionId: "",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-09-22T00:00:00.000Z",
    updatedUtc: "2026-09-22T00:00:00.000Z",
  });
  runtimeBusy = false;
  const router = {
    isBusy: () => runtimeBusy,
    listProfiles: () => [],
    describeConfig: () => ({}),
  };
  host = new Orchestrator({
    modelCatalog: fixtureModelCatalog([]),
    logger: silent,
    config: {
      DATA_DIR: dataDir,
      REPOS_ROOT: "/repo",
      TURN_TIMEOUT_SECONDS: 60,
      CHANNEL_QUEUE_WEDGE_GRACE_SECONDS: 30,
      channelPresets: new Map(),
      threadPresets: new Map(),
      bridgePresets: new Map(),
    } as never,
    adapter: {} as never,
    router: router as never,
    store,
    renderer: {} as never,
  });
});

afterEach(async () => {
  for (const watcher of watchers) watcher.stop();
  watchers.clear();
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("#530 composed thread work progress", () => {
  it("does not present an active pre-prompt dispatch as progress", () => {
    store.turnAttempts.registerOwner(OWNER);
    const dispatch = spec("assigned");
    store.turnAttempts.admit(dispatch);
    const attempt = store.turnAttempts.claim(dispatch, "fixture identity", OWNER);

    const progress = host.inspectThreadWorkProgress(
      TARGET,
      Date.parse(attempt.updatedUtc) + 2 * 60 * 60 * 1000
    );

    // This is the incident: the ledger is active, the router is idle, and no
    // prompt was submitted. The composed answer must say all three at once.
    expect(progress).toMatchObject({
      state: "assigned_not_started",
      progressing: false,
      runtimeBusy: false,
      assignedNotStartedDispatchIds: ["assigned"],
      runningDispatchIds: [],
      watcherOwnedDispatchIds: [],
      ageMs: 2 * 60 * 60 * 1000,
    });
  });

  it("publishes that composed answer through the production threads inventory", async () => {
    store.turnAttempts.registerOwner(OWNER);
    const dispatch = spec("published-assignment");
    store.turnAttempts.admit(dispatch);
    store.turnAttempts.claim(dispatch, "fixture identity", OWNER);
    const caller = store.get(`discord:${TARGET}`)!;

    const entries = await listSiblingThreadEntries(caller, {
      listSessionsByParent: (platform, parentRef) =>
        store.listSessionsByParent(platform, parentRef),
      describeConfig: () => ({
        agent: { value: "codex", source: "session config" },
        model: { value: "gpt", source: "default" },
        effort: { value: null, source: "default" },
        fastMode: { value: false, source: "default" },
        cwd: { value: "/repo", source: "default" },
      } as never),
      isRuntimeBusy: () => false,
      adapter: {
        getThreadName: async () => "worker",
        getThreadLiveState: async () => ({ locked: false, archived: false }),
      },
      inspectQueue: (channelRef) => host.inspectChannelQueue(channelRef),
      inspectWorkProgress: (channelRef, nowMs, queue) =>
        host.inspectThreadWorkProgress(channelRef, nowMs, queue),
      locationFor: () => ({ location: "local", hostEmoji: "🏠" }),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: TARGET,
      busy: false,
      workProgress: {
        state: "assigned_not_started",
        progressing: false,
        assignedNotStartedDispatchIds: ["published-assignment"],
      },
    });
  });

  it("recognizes a prompt-started isolated dispatch through real watcher ownership", async () => {
    store.turnAttempts.registerOwner(OWNER);
    const dispatch = spec("isolated-running");
    store.turnAttempts.admit(dispatch);
    const entered = deferred();
    const release = deferred();
    const watcher = new DispatchWatcher({
      attempts: store.turnAttempts,
      dataDir,
      logger: silent,
      pollMs: 60_000,
      onDispatch: async (ownedSpec) => {
        const attempt = store.turnAttempts.claim(ownedSpec, "fixture identity", OWNER);
        store.turnAttempts.bind(attempt, "acp-isolated");
        store.turnAttempts.startPrompt(attempt);
        entered.resolve();
        await release.promise;
        store.turnAttempts.complete(attempt, {
          id: ownedSpec.id,
          target: ownedSpec.target,
          status: "completed",
          suppressedOnward: true,
          output: "done",
          finishedUtc: new Date().toISOString(),
        });
        return { output: "done", stopReason: "end_turn" };
      },
    });
    watchers.add(watcher);
    host.setDispatchWatcher(watcher);

    const running = watcher.start();
    try {
      await entered.promise;
      expect(host.inspectThreadWorkProgress(TARGET)).toMatchObject({
        state: "running",
        progressing: true,
        runtimeBusy: false,
        runningDispatchIds: ["isolated-running"],
        watcherOwnedDispatchIds: ["isolated-running"],
      });
    } finally {
      // Keep a failed assertion from stranding the real watcher callback. This
      // also makes the mutation proof fail as an assertion, not as a timeout.
      release.resolve();
      watcher.stop();
      await running;
      await watcher.drain();
    }
  });

  it("reports a pending pile blocked by a prompted retained attempt without changing either row", () => {
    store.turnAttempts.registerOwner(OWNER);
    const blocker = spec("retained-prompt");
    store.turnAttempts.admit(blocker);
    const active = store.turnAttempts.claim(blocker, "fixture identity", OWNER);
    store.turnAttempts.bind(active, "acp-retained");
    store.turnAttempts.startPrompt(active);
    expect(store.turnAttempts.suspendBoot(OWNER)).toBe(1);
    store.turnAttempts.admit(spec("queued-behind-it"));

    expect(host.inspectThreadWorkProgress(TARGET)).toMatchObject({
      state: "blocked",
      progressing: false,
      queuedDispatchIds: ["queued-behind-it"],
      retainedDispatchIds: ["retained-prompt"],
      blockedByDispatchIds: ["retained-prompt"],
    });
    expect(store.turnAttempts.get("retained-prompt")?.state).toBe("suspended");
    expect(store.turnAttempts.get("queued-behind-it")?.state).toBe("pending");
    expect(store.turnAttempts.get("queued-behind-it")?.ownerBoot).toBe("");
  });

  it("does not infer execution from a prompt-started row after live ownership is gone", () => {
    store.turnAttempts.registerOwner(OWNER);
    const dispatch = spec("unobserved");
    store.turnAttempts.admit(dispatch);
    const active = store.turnAttempts.claim(dispatch, "fixture identity", OWNER);
    store.turnAttempts.bind(active, "acp-unobserved");
    store.turnAttempts.startPrompt(active);

    expect(host.inspectThreadWorkProgress(TARGET)).toMatchObject({
      state: "active_unobserved",
      progressing: false,
      activeUnobservedDispatchIds: ["unobserved"],
      watcherOwnedDispatchIds: [],
    });
  });

  it("reports bridge-owned retry progress from exact closed recovery facts", async () => {
    store.turnAttempts.registerOwner(OWNER);
    const dispatch = spec("remote-retry");
    store.turnAttempts.admit(dispatch);
    const active = store.turnAttempts.claim(dispatch, "fixture identity", OWNER);
    store.turnAttempts.bind(active, "acp-remote");
    store.turnAttempts.startPrompt(active);
    store.turnAttempts.recordRemoteRecovery(active, {
      version: 1,
      location: "remote-one",
      slot: 9,
      submissionId: "submission-9",
      acpSessionId: "acp-remote",
      delegatedUtc: "2026-09-22T12:00:00.000Z",
    });
    store.turnAttempts.suspendBoot(OWNER);
    host.setBridgeHub({
      slotHealthFor: () => [{
        slot: 9,
        alive: true,
        pid: 123,
        lastStdoutMsAgo: 20,
        lastStdinMsAgo: 30,
        recovery: {
          version: 1,
          owner: "bridge",
          submissionId: "submission-9",
          acpSessionId: "acp-remote",
          rung: 1,
          phase: "backoff",
          retry: 1,
          budget: 3,
          remaining: 2,
          disposition: "continue_same_session",
          errorKind: "timeout",
          updatedUtc: "2026-09-22T12:00:30.000Z",
        },
      }],
    } as any);

    expect(host.inspectThreadWorkProgress(TARGET)).toMatchObject({
      state: "running",
      progressing: true,
      // The bridge is executing this turn; the thread is busy (#631 sweep fix).
      runtimeBusy: true,
      remoteRecovery: [{
        attemptId: "remote-retry",
        owner: "bridge",
        location: "remote-one",
        slot: 9,
        submissionId: "submission-9",
        observed: true,
        phase: "backoff",
        retry: 1,
        remaining: 2,
      }],
    });
    // Mutation proof: dropping the exact bridge snapshot makes this retained,
    // not progressing; the ledger binding alone is never treated as liveness.

    const caller = store.get(`discord:${TARGET}`)!;
    const entries = await listSiblingThreadEntries(caller, {
      listSessionsByParent: (platform, parentRef) =>
        store.listSessionsByParent(platform, parentRef),
      describeConfig: () => ({
        agent: { value: "codex", source: "session config" },
        model: { value: "gpt", source: "default" },
        effort: { value: null, source: "default" },
        fastMode: { value: false, source: "default" },
        cwd: { value: "/repo", source: "default" },
      } as never),
      isRuntimeBusy: () => false,
      adapter: {
        getThreadName: async () => "worker",
        getThreadLiveState: async () => ({ locked: false, archived: false }),
      },
      inspectQueue: (channelRef) => host.inspectChannelQueue(channelRef),
      inspectWorkProgress: (channelRef, nowMs, queue) =>
        host.inspectThreadWorkProgress(channelRef, nowMs, queue),
      locationFor: () => ({ location: "remote-one", hostEmoji: "" }),
    });
    expect(entries[0]).toMatchObject({
      busy: true,
      workProgress: { progressing: true, state: "running" },
    });
  });

  it("does not treat a settled bridge phase as an in-flight retry", () => {
    expect(bridgeOwnedRetryInProgress({
      attemptId: "done",
      owner: "bridge",
      location: "remote-one",
      slot: 1,
      submissionId: "submission",
      observed: true,
      phase: "succeeded",
    })).toBe(false);
    expect(bridgeOwnedRetryInProgress({
      attemptId: "waiting",
      owner: "bridge",
      location: "remote-one",
      slot: 1,
      submissionId: "submission",
      observed: true,
      phase: "awaiting_app",
    })).toBe(false);
    expect(bridgeOwnedRetryInProgress({
      attemptId: "unseen",
      owner: "bridge",
      location: "remote-one",
      slot: 1,
      submissionId: "submission",
      observed: false,
      phase: "backoff",
    })).toBe(false);
    expect(bridgeOwnedRetryInProgress({
      attemptId: "retrying",
      owner: "bridge",
      location: "remote-one",
      slot: 1,
      submissionId: "submission",
      observed: true,
      phase: "retrying",
    })).toBe(true);
  });

  it("preserves ordinary live-runtime progress with no dispatch row", () => {
    runtimeBusy = true;
    expect(host.inspectThreadWorkProgress(TARGET)).toMatchObject({
      state: "running",
      progressing: true,
      runtimeBusy: true,
      runningDispatchIds: [],
    });
  });
});
