import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { enqueueDispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import {
  Orchestrator,
  ChannelQueueFencedError,
} from "../packages/core/src/platforms/discord/orchestrator.js";
import { stageRestartSentinel } from "../packages/core/src/core/restart-sentinel.js";
import { DELEGATION_TERMINAL_STATUSES } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
};

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "seam-180-"));
  store = new SessionStore(path.join(dir, "sessions.db"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function admit(id: string, text = id, createdUtc = `2026-09-03T00:00:0${id}.000Z`) {
  return store.admitInbound({
    messageId: id,
    platform: "discord",
    channelRef: "100",
    parentRef: "10",
    sessionRecordId: "discord:100",
    authorId: "200",
    authorName: "Jesse",
    text,
    attachments: [],
    createdUtc,
  });
}

describe("#180 durable inbound admission", () => {
  it("deduplicates by Discord message id and fences late terminal writes", () => {
    expect(admit("1", "first")).toBe(true);
    expect(admit("1", "duplicate")).toBe(false);
    expect(store.getInbound("1")?.text).toBe("first");
    expect(store.claimInbound("1", 0, "2026-09-03T00:00:10.000Z")).toBe(true);

    const recovered = store.recoverInboundChannel("100", "2026-09-03T00:00:11.000Z");
    expect(recovered).toMatchObject({ messageId: "1", state: "pending", queueEpoch: null });
    expect(store.claimInbound("1", 1, "2026-09-03T00:00:11.500Z")).toBe(true);
    expect(store.completeInbound("1", 0, "2026-09-03T00:00:12.000Z")).toBe(false);
    expect(store.getInbound("1")).toMatchObject({ state: "running", queueEpoch: 1 });
    expect(store.completeInbound("1", 1, "2026-09-03T00:00:13.000Z")).toBe(true);
  });

  it("durably applies replacement semantics and recovers only the newest prompt", () => {
    expect(admit("1", "old")).toBe(true);
    expect(store.claimInbound("1", 3, "2026-09-03T00:00:02.000Z")).toBe(true);
    expect(admit("2", "replacement", "2026-09-03T00:00:03.000Z")).toBe(true);

    expect(store.getInbound("1")?.state).toBe("completed");
    expect(store.recoverAllInbound("2026-09-03T00:00:04.000Z")).toEqual([
      expect.objectContaining({ messageId: "2", text: "replacement", state: "pending" }),
    ]);
  });
});

describe("#180 channel queue fencing", () => {
  function makeHost() {
    const record = {
      id: "discord:100",
      platform: "discord",
      channelRef: "100",
      parentRef: "10",
      agentId: "codex",
      acpSessionId: "acp-1",
      repoPath: "/repo",
      configJson: "{}",
      namePrefix: null,
      createdUtc: "2026-09-03T00:00:00.000Z",
      updatedUtc: "2026-09-03T00:00:00.000Z",
    };
    store.upsert(record);
    const router = {
      ensureSessionRecord: () => record,
      getRuntime: () => undefined,
      hasRuntime: () => false,
      isBusy: () => false,
      listProfiles: () => [],
      describeConfig: () => ({
        agent: { value: "codex" },
        model: { value: "test" },
        effort: { value: null },
        cwd: { value: "/repo" },
      }),
      abortTurn: vi.fn(async () => "idle" as const),
      invalidate: vi.fn(async () => undefined),
    };
    const host = new Orchestrator({
      logger: silent,
      config: {
        DATA_DIR: dir,
        REPOS_ROOT: "/repo",
        TURN_TIMEOUT_SECONDS: 60,
        CHANNEL_QUEUE_WEDGE_GRACE_SECONDS: 1,
        channelPresets: new Map(),
        threadPresets: new Map(),
        bridgePresets: new Map(),
      } as never,
      adapter: {} as never,
      router: router as never,
      store,
      renderer: {} as never,
    });
    Object.assign(host as never, {
      tryConsumeConfigEditorRiderUpload: async () => false,
      wouldParkForOfflineBridge: () => false,
      tryParkForOfflineBridge: async () => false,
      clearTurnMarkersForChannel: async () => undefined,
      clearParkedForChannel: async () => null,
      tryFireParked: async () => undefined,
      handleIncomingMessageInner: vi.fn(async () => undefined),
    });
    return { host, router, record };
  }

  it("persists a replacement before waiting behind a never-settling cancelled tail", async () => {
    const { host, router } = makeHost();
    const abandoned = deferred();
    (host as any).channelQueues.set("100", abandoned.promise);
    (host as any).channelQueueMeta.set("100", {
      epoch: 0,
      queued: 1,
      admittedAtMs: 0,
      lastProgressAtMs: 0,
    });
    (router.abortTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      expect(store.getInbound("300")).toMatchObject({ state: "pending", text: "replacement" });
      return "cancelled";
    });

    const received = (host as any).handleIncomingMessage({
      messageId: "300",
      channel: { platform: "discord", id: "100", parentId: "10" },
      authorId: "200",
      authorName: "Jesse",
      authorIsBot: false,
      text: "replacement",
    }).catch((err: unknown) => err);
    await flush();

    expect(store.getInbound("300")?.state).toBe("pending");
    expect((host as any).handleIncomingMessageInner).not.toHaveBeenCalled();
    (host as any).advanceChannelQueueEpoch("100");
    abandoned.resolve();
    expect(await received).toBeInstanceOf(ChannelQueueFencedError);
    expect(store.getInbound("300")?.state).toBe("pending");
  });

  it("reports a first-observed idle tail from its last progress without mutating inspection state", () => {
    const { host } = makeHost();
    (host as any).channelQueues.set("100", new Promise<void>(() => {}));
    const meta = {
      epoch: 4,
      queued: 2,
      admittedAtMs: 100,
      lastProgressAtMs: 1_000,
    };
    (host as any).channelQueueMeta.set("100", meta);
    (host as any).channelQueueEpochs.set("100", 4);

    expect(host.inspectChannelQueue("100", 2_000)).toMatchObject({
      state: "wedged",
      epoch: 4,
      ageMs: 1_000,
    });
    expect((host as any).channelQueueMeta.get("100")).toEqual(meta);
  });

  it("keeps a crash-window durable admission visible without an in-memory tail", () => {
    const { host } = makeHost();
    const created = "2026-09-03T00:00:00.000Z";
    expect(admit("7", "pre-queue crash", created)).toBe(true);
    expect(host.isChannelBusy("100")).toBe(true);
    expect(host.inspectChannelQueue("100", Date.parse(created) + 999).state).toBe("queued");
    expect(host.inspectChannelQueue("100", Date.parse(created) + 1_000)).toMatchObject({
      state: "wedged",
      queued: 1,
    });
  });

  it("detaches a stuck active finalizer and lets the recovered epoch run immediately", async () => {
    const { host } = makeHost();
    const oldRelease = deferred();
    const oldStarted = deferred();
    const old = (host as any).queueOnChannel("100", async () => {
      oldStarted.resolve();
      await oldRelease.promise;
      return "old";
    });
    await oldStarted.promise;

    (host as any).advanceChannelQueueEpoch("100");
    const fresh = (host as any).queueOnChannel("100", async () => "fresh");
    await expect(fresh).resolves.toBe("fresh");

    oldRelease.resolve();
    await expect(old).rejects.toBeInstanceOf(ChannelQueueFencedError);
    expect((host as any).channelQueues.size).toBe(0);
  });

  it("runs a Discord gateway redelivery only once", async () => {
    const { host } = makeHost();
    const message = {
      messageId: "301",
      channel: { platform: "discord", id: "100", parentId: "10" },
      authorId: "200",
      authorName: "Jesse",
      authorIsBot: false,
      text: "once",
    };
    await (host as any).handleIncomingMessage(message);
    await (host as any).handleIncomingMessage(message);
    expect((host as any).handleIncomingMessageInner).toHaveBeenCalledOnce();
    expect(store.getInbound("301")?.state).toBe("completed");
  });

  it("terminalizes an admission when the second availability check parks it", async () => {
    const { host } = makeHost();
    (host as any).tryParkForOfflineBridge = vi.fn(
      async (_msg: unknown, inboundAdmissionId: string | undefined) => {
        store.upsertParked(
          {
            id: "parked-302",
            platform: "discord",
            channelRef: "100",
            parentRef: "10",
            location: "remote",
            kind: "bridge_offline",
            prompt: "park after admission",
            authorId: "200",
            authorName: "Jesse",
            noticeMessageId: null,
            attachments: [],
            createdUtc: "2026-09-03T00:00:30.000Z",
          },
          inboundAdmissionId
        );
        return true;
      }
    );
    await (host as any).handleIncomingMessage({
      messageId: "302",
      channel: { platform: "discord", id: "100", parentId: "10" },
      authorId: "200",
      authorName: "Jesse",
      authorIsBot: false,
      text: "park after admission",
    });

    expect(store.getInbound("302")?.state).toBe("completed");
    expect(store.getParkedByChannel("discord", "100")?.prompt).toBe("park after admission");
    expect(store.recoverAllInbound("2026-09-03T00:01:00.000Z")).toEqual([]);
    expect((host as any).handleIncomingMessageInner).not.toHaveBeenCalled();
  });

  it("auto recovery refuses a healthy runtime; force fences locally and preserves durable work", async () => {
    const { host, router } = makeHost();
    expect(admit("9", "recover me")).toBe(true);
    (host as any).channelQueues.set("100", new Promise<void>(() => {}));
    (host as any).channelQueueMeta.set("100", {
      epoch: 0,
      queued: 1,
      admittedAtMs: 0,
      lastProgressAtMs: 0,
    });
    router.isBusy = () => true;
    const fence = { target: "100", epoch: 1, token: Symbol("fence"), claims: [] };
    const fenceTarget = vi.fn(() => fence);
    const recoverTarget = vi.fn(async () => ["dispatch-1"]);
    const releaseTargetFence = vi.fn();
    const tick = vi.fn(async () => undefined);
    (host as any).dispatchWatcher = { fenceTarget, recoverTarget, releaseTargetFence, tick };
    const startRecovered = vi.fn();
    (host as any).startRecoveredInbound = startRecovered;

    const refused = await host.recoverChannel("100", "auto");
    expect(refused).toMatchObject({ ok: false, before: { state: "runtime_busy" } });
    expect(recoverTarget).not.toHaveBeenCalled();

    const repaired = await host.recoverChannel("100", "force", { id: "1", name: "Admin" });
    expect(repaired).toMatchObject({ ok: true, epoch: 1 });
    expect(router.abortTurn).toHaveBeenCalledWith("discord:100", { force: true });
    expect(router.invalidate).toHaveBeenCalled();
    expect(fenceTarget).toHaveBeenCalledWith("100");
    expect(recoverTarget).toHaveBeenCalledWith(fence);
    expect(releaseTargetFence).toHaveBeenCalledWith(fence);
    expect(startRecovered).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "9", state: "pending" })
    );
    expect(store.getInbound("9")?.state).toBe("pending");
    expect(store.listConfigMutations(1)[0]?.summary).toBe("Recovered channel queue (force)");
  });

  it("fences and requeues the real watcher before abort releases the old channel run", async () => {
    const { host, router } = makeHost();
    const blocker = deferred();
    const dispatchEntered = deferred();
    (host as any).channelQueues.set("100", blocker.promise);
    (host as any).channelQueueMeta.set("100", {
      epoch: 0,
      queued: 1,
      admittedAtMs: 0,
      lastProgressAtMs: 0,
    });

    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      onDispatch: async (spec) => {
        dispatchEntered.resolve();
        return (host as any).queueOnChannel(spec.target, async () => ({
          output: "stale completion",
          stopReason: "end_turn",
        }));
      },
    });
    (host as any).dispatchWatcher = watcher;
    await enqueueDispatchSpec(dir, {
      id: "d1",
      target: "100",
      prompt: "paid work",
      session: "live",
      createdUtc: "2026-09-03T00:00:00.000Z",
    });
    const starting = watcher.start();
    await dispatchEntered.promise;
    watcher.stop();

    (router.abortTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      const watcherWasFenced = (watcher as any).targetEpoch("100") > 0;
      expect((watcher as any).targetFences.has("100")).toBe(true);
      blocker.resolve();
      // Make the old broken ordering deterministic: it terminalizes d1 before
      // recoverTarget gets a chance to see the sole running artifact.
      if (!watcherWasFenced) {
        await vi.waitFor(async () => {
          expect(await readdir(dispatchDirs(dir).done)).toContain("d1.json");
        });
      }
      return "killed";
    });
    (router.invalidate as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      expect((watcher as any).targetFences.has("100")).toBe(true);
    });

    const recovery = host.recoverChannel("100", "force");
    expect((watcher as any).targetEpoch("100")).toBeGreaterThan(0);
    await expect(recovery).resolves.toMatchObject({
      ok: true,
    });
    await starting;
    await watcher.drain();
    expect(await readdir(dispatchDirs(dir).pending)).toContain("d1.json");
    expect(await readdir(dispatchDirs(dir).done)).not.toContain("d1.json");
  }, 15_000);

  it("revokes an old writer paused at the done commit point before recovery publishes", async () => {
    const finalizing = deferred();
    const releaseFinalization = deferred();
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      beforeOwnedDoneCommit: async (id) => {
        if (id !== "commit-race") return;
        finalizing.resolve();
        await releaseFinalization.promise;
      },
      onDispatch: async () => ({ output: "stale", stopReason: "end_turn" }),
    });
    await enqueueDispatchSpec(dir, {
      id: "commit-race",
      target: "100",
      prompt: "recover me",
      session: "isolated",
      createdUtc: "2026-09-03T00:00:00.000Z",
    });

    const starting = watcher.start();
    await finalizing.promise;
    watcher.stop();
    const fence = watcher.fenceTarget("100");
    const recovering = watcher.recoverTarget(fence);
    releaseFinalization.resolve();

    await expect(recovering).resolves.toEqual(["commit-race"]);
    await starting;
    expect(await readdir(dispatchDirs(dir).done)).not.toContain("commit-race.json");
    expect(await readdir(dispatchDirs(dir).pending)).toContain("commit-race.json");
    expect(await readdir(dispatchDirs(dir).running)).not.toContain("commit-race.json");
    watcher.releaseTargetFence(fence);
    await watcher.drain();
  });

  it("reconciles a boot crash between admission and execution", async () => {
    const { host } = makeHost();
    expect(admit("8", "boot replay")).toBe(true);
    const startRecovered = vi.fn();
    (host as any).startRecoveredInbound = startRecovered;
    (host as any).config.SEAM_TURN_RESUME_ENABLED = false;
    await host.recoverInterruptedTurns();
    expect(startRecovered).toHaveBeenCalledOnce();
    expect(startRecovered).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "8", text: "boot replay", state: "pending" })
    );
  });
});

describe("#180 dispatch and restart recovery", () => {
  it("/seam cancel terminalizes queued and running isolated target dispatches", async () => {
    const record = {
      id: "discord:100",
      platform: "discord",
      channelRef: "100",
      parentRef: "10",
      agentId: "codex",
      acpSessionId: "",
      repoPath: "/repo",
      configJson: "{}",
      namePrefix: null,
      createdUtc: "2026-09-03T00:00:00.000Z",
      updatedUtc: "2026-09-03T00:00:00.000Z",
    };
    store.upsert(record);
    const isolatedEntered = deferred();
    const isolatedFinalizing = deferred();
    const releaseFinalization = deferred();
    const calls: string[] = [];
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      beforeOwnedDoneCommit: async (id) => {
        if (id !== "isolated") return;
        isolatedFinalizing.resolve();
        await releaseFinalization.promise;
      },
      onDispatch: async (spec) => {
        calls.push(spec.id);
        if (spec.id === "isolated") isolatedEntered.resolve();
        return { output: "late", stopReason: "end_turn" };
      },
    });
    await enqueueDispatchSpec(dir, {
      id: "isolated",
      target: "100",
      prompt: "isolated paid work",
      session: "isolated",
      createdUtc: "2026-09-03T00:00:00.000Z",
    });
    await enqueueDispatchSpec(dir, {
      id: "queued",
      target: "100",
      prompt: "queued next work",
      session: "live",
      createdUtc: "2026-09-03T00:00:01.000Z",
    });
    const starting = watcher.start();
    await isolatedEntered.promise;
    await isolatedFinalizing.promise;
    watcher.stop();

    const { host, router } = (() => {
      const host = new Orchestrator({
        logger: silent,
        config: {
          DATA_DIR: dir,
          REPOS_ROOT: "/repo",
          TURN_TIMEOUT_SECONDS: 60,
          channelPresets: new Map(),
          threadPresets: new Map(),
          bridgePresets: new Map(),
        } as never,
        adapter: {} as never,
        router: {
          isBusy: () => false,
          abortTurn: vi.fn(async () => "idle" as const),
          listProfiles: () => [],
          describeConfig: () => ({}),
        } as never,
        store,
        renderer: {} as never,
      });
      return { host, router: (host as any).router };
    })();
    host.setDispatchWatcher(watcher);
    (host as any).recordFromInteraction = () => record;
    const replies: string[] = [];
    const cancelling = (host as any).cmdCancel({
      options: { getString: () => null, getBoolean: () => false },
      deferReply: async () => undefined,
      editReply: async (text: string) => void replies.push(text),
    });
    await vi.waitFor(() => expect((watcher as any).targetEpoch("100")).toBeGreaterThan(0));
    releaseFinalization.resolve();
    await cancelling;
    expect(router.abortTurn).toHaveBeenCalled();
    await starting;
    await watcher.drain();

    expect(calls).toEqual(["isolated"]);
    for (const id of ["isolated", "queued"]) {
      const done = JSON.parse(
        await readFile(path.join(dispatchDirs(dir).done, `${id}.json`), "utf8")
      );
      expect(done).toMatchObject({ id, status: "failed", error: "cancelled by operator" });
    }
    expect(await readdir(dispatchDirs(dir).pending)).toEqual([]);
    expect(await readdir(dispatchDirs(dir).running)).toEqual([]);
  }, 15_000);

  it("does not requeue a paid running artifact after its durable ledger becomes terminal", async () => {
    const release = deferred();
    const paidWorkEntered = deferred();
    let calls = 0;
    store.recordDelegation({
      id: "paid",
      kind: "handoff",
      targetRef: "100",
      correlationId: "paid",
      status: "running",
    });
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      mayRecover: (id) => {
        const row = store.getDelegation(id);
        return !row || !DELEGATION_TERMINAL_STATUSES.includes(row.status);
      },
      onDispatch: async () => {
        calls += 1;
        paidWorkEntered.resolve();
        await release.promise;
        return { output: "paid result", stopReason: "end_turn" };
      },
    });
    await enqueueDispatchSpec(dir, {
      id: "paid",
      target: "100",
      prompt: "charge once",
      session: "isolated",
      createdUtc: "2026-09-03T00:00:00.000Z",
    });
    const starting = watcher.start();
    await paidWorkEntered.promise;
    watcher.stop();
    store.updateDelegationStatus("paid", "completed");

    const fence = watcher.fenceTarget("100");
    expect(await watcher.recoverTarget(fence)).toEqual([]);
    watcher.releaseTargetFence(fence);
    const abandoned = JSON.parse(
      await readFile(path.join(dispatchDirs(dir).done, "paid.json"), "utf8")
    );
    expect(abandoned).toMatchObject({
      id: "paid",
      status: "failed",
      error: "abandoned: durable delegation ledger is terminal",
    });
    expect(await readdir(dispatchDirs(dir).pending)).toEqual([]);
    expect(await readdir(dispatchDirs(dir).running)).toEqual([]);

    release.resolve();
    await starting;
    await watcher.drain();
    expect(calls).toBe(1);
  });

  it("rechecks a ledger transition between recovery admission and publication", async () => {
    const publishEntered = deferred();
    const releasePublish = deferred();
    const oldRunEntered = deferred();
    const releaseOldRun = deferred();
    let calls = 0;
    store.recordDelegation({
      id: "ledger-race",
      kind: "handoff",
      targetRef: "100",
      correlationId: "ledger-race",
      status: "running",
    });
    const dirs = dispatchDirs(dir);
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      mayRecover: (id) => {
        const row = store.getDelegation(id);
        return !row || !DELEGATION_TERMINAL_STATUSES.includes(row.status);
      },
      beforeRecoveryPublish: async (id) => {
        if (id !== "ledger-race") return;
        publishEntered.resolve();
        await releasePublish.promise;
      },
      onDispatch: async () => {
        calls += 1;
        oldRunEntered.resolve();
        await releaseOldRun.promise;
        store.updateDelegationStatus("ledger-race", "completed");
        return { output: "already paid", stopReason: "end_turn" };
      },
    });
    await enqueueDispatchSpec(dir, {
      id: "ledger-race",
      target: "100",
      prompt: "must not run twice",
      session: "isolated",
      createdUtc: "2026-09-03T00:00:00.000Z",
    });
    const starting = watcher.start();
    await oldRunEntered.promise;
    watcher.stop();

    const fence = watcher.fenceTarget("100");
    const recovering = watcher.recoverTarget(fence);
    await publishEntered.promise;
    releaseOldRun.resolve();
    await vi.waitFor(() =>
      expect(store.getDelegation("ledger-race")?.status).toBe("completed")
    );
    releasePublish.resolve();
    await expect(recovering).resolves.toEqual([]);
    await starting;
    watcher.releaseTargetFence(fence);

    await watcher.start();
    watcher.stop();
    expect(calls).toBe(1);
    expect(await readdir(dirs.pending)).toEqual([]);
    expect(await readdir(dirs.running)).toEqual([]);
    expect(
      JSON.parse(await readFile(path.join(dirs.done, "ledger-race.json"), "utf8"))
    ).toMatchObject({
      id: "ledger-race",
      status: "failed",
      error: "abandoned: durable delegation ledger is terminal",
    });
  });

  it("blocks a recovered pending artifact whose ledger terminalizes before execution", async () => {
    let calls = 0;
    store.recordDelegation({
      id: "execution-gate",
      kind: "handoff",
      targetRef: "100",
      correlationId: "execution-gate",
      status: "running",
    });
    const dirs = dispatchDirs(dir);
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.pending, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    await writeFile(
      path.join(dirs.running, "execution-gate.json"),
      JSON.stringify({
        id: "execution-gate",
        target: "100",
        prompt: "must still not run twice",
        session: "isolated",
        createdUtc: "2026-09-03T00:00:00.000Z",
      }),
      "utf8"
    );
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      mayRecover: (id) => {
        const row = store.getDelegation(id);
        return !row || !DELEGATION_TERMINAL_STATUSES.includes(row.status);
      },
      onDispatch: async () => {
        calls += 1;
        return { output: "duplicate", stopReason: "end_turn" };
      },
    });

    const fence = watcher.fenceTarget("100");
    await expect(watcher.recoverTarget(fence)).resolves.toEqual(["execution-gate"]);
    store.updateDelegationStatus("execution-gate", "completed");
    watcher.releaseTargetFence(fence);
    await watcher.start();
    watcher.stop();

    expect(calls).toBe(0);
    expect(await readdir(dirs.pending)).toEqual([]);
    expect(await readdir(dirs.running)).toEqual([]);
    expect(
      JSON.parse(await readFile(path.join(dirs.done, "execution-gate.json"), "utf8"))
    ).toMatchObject({
      id: "execution-gate",
      status: "failed",
      error: "abandoned: durable delegation ledger is terminal",
    });
  });

  it("requeues a running dispatch and ignores the late old generation result", async () => {
    const first = deferred();
    const firstEntered = deferred();
    const recoveredEntered = deferred();
    const recoveredRelease = deferred();
    let calls = 0;
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      pollMs: 60_000,
      onDispatch: async () => {
        calls += 1;
        if (calls === 1) {
          firstEntered.resolve();
          await first.promise;
          return { output: "late-old", stopReason: "end_turn" };
        }
        recoveredEntered.resolve();
        await recoveredRelease.promise;
        return { output: "recovered", stopReason: "end_turn" };
      },
    });
    const spec: DispatchSpec = {
      id: "d1",
      target: "100",
      prompt: "work",
      session: "live",
      createdUtc: "2026-09-03T00:00:00.000Z",
    };
    await enqueueDispatchSpec(dir, spec);
    const starting = watcher.start();
    await firstEntered.promise;
    expect(watcher.inFlightCount).toBe(1);

    const fence = watcher.fenceTarget("100");
    expect(await watcher.recoverTarget(fence)).toEqual(["d1"]);
    watcher.releaseTargetFence(fence);
    const recoveredTick = watcher.tick();
    await recoveredEntered.promise;
    expect(calls).toBe(2);
    first.resolve();
    await starting;
    expect(await readdir(dispatchDirs(dir).running)).toContain("d1.json");
    expect(await readdir(dispatchDirs(dir).pending)).not.toContain("d1.json");
    recoveredRelease.resolve();
    await recoveredTick;
    watcher.stop();
    await watcher.drain();

    const done = JSON.parse(
      await readFile(path.join(dispatchDirs(dir).done, "d1.json"), "utf8")
    );
    expect(done).toMatchObject({ status: "completed", output: "recovered" });
  }, 15_000);

  it("stages drain/force sentinels without overwriting the first request", async () => {
    expect(stageRestartSentinel(dir, "drain").staged).toBe(true);
    expect(stageRestartSentinel(dir, "force").staged).toBe(false);
    expect(await readFile(path.join(dir, ".restart-pending"), "utf8")).toBe("");
  });

  it("requires explicit confirmation before staging a force restart", async () => {
    const record = {
      id: "discord:100",
      platform: "discord",
      channelRef: "100",
      parentRef: "10",
      agentId: "codex",
      acpSessionId: "",
      repoPath: "/repo",
      configJson: "{}",
      namePrefix: null,
      createdUtc: "2026-09-03T00:00:00.000Z",
      updatedUtc: "2026-09-03T00:00:00.000Z",
    };
    store.upsert(record);
    const host = new Orchestrator({
      logger: silent,
      config: {
        DATA_DIR: dir,
        REPOS_ROOT: "/repo",
        DEFAULT_MODEL: "test",
        DISCORD_USER_NAMES: new Map(),
        channelPresets: new Map(),
        threadPresets: new Map(),
        bridgePresets: new Map(),
      } as never,
      adapter: {} as never,
      router: {
        listProfiles: () => [],
        describeConfig: () => ({}),
      } as never,
      store,
      renderer: {} as never,
    });
    const replies: string[] = [];
    const interaction = (confirm: boolean) => ({
      user: { id: "1", username: "admin", globalName: null },
      member: null,
      options: {
        getString: (name: string) => (name === "mode" ? "force" : null),
        getBoolean: () => confirm,
      },
      reply: async ({ content }: { content: string }) => void replies.push(content),
    });

    await (host as any).cmdBridgeRestart(interaction(false));
    expect(replies.at(-1)).toContain("confirm:true");
    await expect(readFile(path.join(dir, ".restart-pending"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await (host as any).cmdBridgeRestart(interaction(true));
    expect(await readFile(path.join(dir, ".restart-pending"), "utf8")).toBe("force\n");
  });

  it("allows the established ManageGuild fallback when config-admin ids are unset", async () => {
    const { host } = (() => {
      const host = new Orchestrator({
        logger: silent,
        config: {
          DATA_DIR: dir,
          REPOS_ROOT: "/repo",
          SEAM_CONFIG_ADMIN_USER_IDS: undefined,
          DISCORD_USER_NAMES: new Map(),
          channelPresets: new Map(),
          threadPresets: new Map(),
          bridgePresets: new Map(),
        } as never,
        adapter: {} as never,
        router: { listProfiles: () => [], describeConfig: () => ({}) } as never,
        store,
        renderer: {} as never,
      });
      return { host };
    })();
    const recover = vi.fn(async () => ({
      ok: true,
      message: "recovered",
      before: { state: "wedged" },
      epoch: 1,
    }));
    (host as any).recoverChannel = recover;
    const replies: string[] = [];
    await (host as any).cmdRecover({
      user: { id: "guild-manager", username: "manager", globalName: null },
      member: null,
      options: {
        getString: (name: string) => (name === "thread" ? "100" : "auto"),
      },
      deferReply: async () => undefined,
      editReply: async (text: string) => void replies.push(text),
      reply: async ({ content }: { content: string }) => void replies.push(content),
    });
    expect(recover).toHaveBeenCalledWith("100", "auto", {
      id: "guild-manager",
      name: "manager",
    });
    expect(replies).toEqual(["🛠️ recovered"]);

    (host as any).config.SEAM_CONFIG_ADMIN_USER_IDS = new Set(["configured-admin"]);
    recover.mockClear();
    replies.length = 0;
    await (host as any).cmdRecover({
      user: { id: "guild-manager", username: "manager", globalName: null },
      member: null,
      options: { getString: () => "100" },
      deferReply: async () => undefined,
      editReply: async (text: string) => void replies.push(text),
      reply: async ({ content }: { content: string }) => void replies.push(content),
    });
    expect(recover).not.toHaveBeenCalled();
    expect(replies).toEqual(["🔒 `/seamadmin recover` is config-admin-only."]);
  });
});
