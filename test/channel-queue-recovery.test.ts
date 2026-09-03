import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
    expect(store.completeInbound("1", 0, "2026-09-03T00:00:12.000Z")).toBe(false);
    expect(store.getInbound("1")?.state).toBe("pending");
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

  it("reports runtime-idle queue tails as queued, then wedged after the grace", () => {
    const { host } = makeHost();
    (host as any).channelQueues.set("100", new Promise<void>(() => {}));
    (host as any).channelQueueMeta.set("100", {
      epoch: 4,
      queued: 2,
      admittedAtMs: 100,
      lastProgressAtMs: 100,
    });
    (host as any).channelQueueEpochs.set("100", 4);

    expect(host.inspectChannelQueue("100", 1_000)).toMatchObject({ state: "queued", queued: 2 });
    expect(host.inspectChannelQueue("100", 1_999).state).toBe("queued");
    expect(host.inspectChannelQueue("100", 2_000)).toMatchObject({
      state: "wedged",
      epoch: 4,
      ageMs: 1_000,
    });
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
    const recoverTarget = vi.fn(async () => ["dispatch-1"]);
    const tick = vi.fn(async () => undefined);
    (host as any).dispatchWatcher = { recoverTarget, tick };
    const startRecovered = vi.fn();
    (host as any).startRecoveredInbound = startRecovered;

    const refused = await host.recoverChannel("100", "auto");
    expect(refused).toMatchObject({ ok: false, before: { state: "runtime_busy" } });
    expect(recoverTarget).not.toHaveBeenCalled();

    const repaired = await host.recoverChannel("100", "force", { id: "1", name: "Admin" });
    expect(repaired).toMatchObject({ ok: true, epoch: 1 });
    expect(router.abortTurn).toHaveBeenCalledWith("discord:100", { force: true });
    expect(router.invalidate).toHaveBeenCalled();
    expect(recoverTarget).toHaveBeenCalledWith("100");
    expect(startRecovered).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "9", state: "pending" })
    );
    expect(store.getInbound("9")?.state).toBe("pending");
    expect(store.listConfigMutations(1)[0]?.summary).toBe("Recovered channel queue (force)");
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
  it("an idle per-thread cancel cannot erase a pending recovery dispatch", async () => {
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      onDispatch: async () => ({ output: "unused", stopReason: "end_turn" }),
    });
    await enqueueDispatchSpec(dir, {
      id: "keep-me",
      target: "100",
      prompt: "replacement",
      session: "live",
      createdUtc: "2026-09-03T00:00:00.000Z",
    });
    expect(await watcher.cancelRunning({ id: "__no-active-dispatch__" })).toEqual([]);
    expect(await readdir(dispatchDirs(dir).pending)).toContain("keep-me.json");
  });

  it("requeues a running dispatch and ignores the late old generation result", async () => {
    const first = deferred();
    const firstEntered = deferred();
    const recoveredEntered = deferred();
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

    expect(await watcher.recoverTarget("100")).toEqual(["d1"]);
    const recoveredTick = watcher.tick();
    await recoveredEntered.promise;
    await recoveredTick;
    expect(calls).toBe(2);
    first.resolve();
    await starting;
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
});
