/**
 * #631 — one ACP session has one thread. A thread that shares its session
 * with an older thread gets its own copy before its turn, and is told so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "seam-631-fork-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function thread(id: string, createdUtc: string) {
  const record = {
    id: `discord:${id}`, platform: "discord", channelRef: id, parentRef: "10",
    agentId: "claude", acpSessionId: "acp-shared", repoPath: "/repo", configJson: "{}", namePrefix: null,
    createdUtc, updatedUtc: createdUtc,
  };
  store.upsert(record as never);
  return record;
}

function host(forkResult: string | undefined, rebuildAttaches = true) {
  const sent: Array<{ channel: string; text: string }> = [];
  const router = {
    forkSharedSession: vi.fn(async (record: { id: string; acpSessionId: string }) => {
      if (!forkResult) return undefined;
      store.upsert({ ...store.get(record.id)!, acpSessionId: forkResult });
      return forkResult;
    }),
    invalidate: vi.fn(async () => undefined),
  };
  const orchestrator = new Orchestrator({
    modelCatalog: fixtureModelCatalog([]),
    logger: silent,
    config: { DATA_DIR: dir, REPOS_ROOT: "/repo", channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as never,
    adapter: { sendMessage: async (channel: { id: string }, text: string) => { sent.push({ channel: channel.id, text }); return { id: "m" }; } } as never,
    router: router as never,
    store,
    renderer: {} as never,
  });
  const rebuild = vi.fn(async (record: { id: string }) => {
    if (rebuildAttaches) store.upsert({ ...store.get(record.id)!, acpSessionId: "acp-rebuilt" });
    return { attached: rebuildAttaches, attachmentReason: rebuildAttaches ? "attached" : "thread moved on" };
  });
  Object.assign(orchestrator as never, { rebuildThreadFromDiscord: rebuild });
  const ensure = (record: { channelRef: string }) =>
    (orchestrator as unknown as { ensureOwnSession(r: unknown, c: unknown): Promise<void> })
      .ensureOwnSession(record, { platform: "discord", id: record.channelRef });
  return { router, rebuild, sent, ensure };
}

describe("#631 a shared ACP session is forked for the newer thread", () => {
  it("forks the newer thread, leaves the older one alone, and tells the newer thread", async () => {
    const older = thread("older", "2026-09-01T00:00:00.000Z");
    const newer = thread("newer", "2026-09-02T00:00:00.000Z");
    const { router, sent, ensure } = host("acp-own");

    await ensure(older);
    expect(router.forkSharedSession).not.toHaveBeenCalled();

    await ensure(newer);
    expect(router.forkSharedSession).toHaveBeenCalledTimes(1);
    expect(store.get("discord:newer")?.acpSessionId).toBe("acp-own");
    expect(store.get("discord:older")?.acpSessionId).toBe("acp-shared");
    expect(sent).toEqual([{ channel: "newer", text: expect.stringContaining("<#older>") }]);
  });

  it("rebuilds from the thread's history when the agent cannot fork", async () => {
    thread("older", "2026-09-01T00:00:00.000Z");
    const newer = thread("newer", "2026-09-02T00:00:00.000Z");
    const { rebuild, sent, ensure } = host(undefined);
    await ensure(newer);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(sent[0]?.text).toContain("rebuilt from this thread's history");
  });

  it("does not claim success when the rebuild did not attach", async () => {
    thread("older", "2026-09-01T00:00:00.000Z");
    const newer = thread("newer", "2026-09-02T00:00:00.000Z");
    const { rebuild, sent, ensure } = host(undefined, false);
    await ensure(newer);
    await ensure(newer);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("does nothing for a thread that is the only holder of its session", async () => {
    const only = thread("only", "2026-09-01T00:00:00.000Z");
    const { router, sent, ensure } = host("acp-own");
    await ensure(only);
    expect(router.forkSharedSession).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

describe("#631 tier 3: a bridge that stays unreachable", () => {
  it("says so after 15 minutes, keeps waiting, and says when it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sent: Array<{ channel: string; text: string }> = [];
      const ready: Array<(location: string) => void> = [];
      const built = new Orchestrator({
        modelCatalog: fixtureModelCatalog([]),
        logger: silent,
        config: { DATA_DIR: dir, REPOS_ROOT: "/repo", channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as never,
        adapter: { sendMessage: async (channel: { id: string }, text: string) => { sent.push({ channel: channel.id, text }); return { id: "m" }; } } as never,
        router: {} as never,
        store,
        renderer: {} as never,
      });
      built.setBridgeHub({ onBridgeReady: (cb: (location: string) => void) => { ready.push(cb); return () => undefined; } } as never);
      Object.assign(built as never, { adoptRemoteRecovery: vi.fn(async () => true) });
      (built as unknown as { deferRemoteRecoveryAdoption(a: unknown): void }).deferRemoteRecoveryAdoption({
        id: "turn-1", generation: 1, spec: { target: "thread-9" },
        remoteRecovery: { location: "fhr-server", submissionId: "sub", slot: 1 },
      });
      vi.advanceTimersByTime(14 * 60_000);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(sent).toEqual([{ channel: "thread-9", text: expect.stringContaining("Still reconnecting to `fhr-server`") }]);
      for (const listener of ready) listener("fhr-server");
      await Promise.resolve();
      expect(sent.at(-1)).toEqual({ channel: "thread-9", text: "🔌 Reconnected to session" });
    } finally {
      vi.useRealTimers();
    }
  });
});

function orchestratorWith(mux: Record<string, unknown>) {
  const sent: Array<{ channel: string; text: string }> = [];
  const built = new Orchestrator({
    modelCatalog: fixtureModelCatalog([]),
    logger: silent,
    config: { DATA_DIR: dir, REPOS_ROOT: "/repo", channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as never,
    adapter: { sendMessage: async (channel: { id: string }, text: string) => { sent.push({ channel: channel.id, text }); return { id: "m" }; } } as never,
    router: {} as never,
    store,
    renderer: {} as never,
  });
  built.setBridgeHub({ muxFor: () => mux, onBridgeReady: () => () => undefined } as never);
  return { built, sent };
}

describe("#631 slots nobody owns", () => {
  it("stops live slots that are neither bound nor owned by a suspended delegated turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const killed: number[] = [];
      const mux = {
        sendCmd: async () => ({ health: [
          { slot: 1, alive: true }, { slot: 2, alive: true }, { slot: 3, alive: true }, { slot: 4, alive: false },
        ] }),
        isBound: (slot: number) => slot === 1,
        sendFrame: (frame: { slot: number }) => killed.push(frame.slot),
      };
      const { built } = orchestratorWith(mux);
      vi.spyOn(store.turnAttempts, "list").mockImplementation((state?: string) =>
        (state === "suspended" ? [{ remoteRecovery: { location: "local", slot: 2 } }] : []) as never);
      built.sweepUnownedSlots("local");
      await vi.advanceTimersByTimeAsync(90_000);
      expect(killed).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#631 a lost delegated turn continues only after its old slot is gone", () => {
  it("waits for the kill before continuing, and continues exactly once", async () => {
    let alive = true;
    const order: string[] = [];
    const mux = {
      sendCmd: async () => ({ health: [{ slot: 7, alive }] }),
      sendFrame: () => { order.push("kill"); setTimeout(() => { alive = false; }, 700); },
    };
    const { built } = orchestratorWith(mux);
    const resume = vi.fn(async () => { order.push(alive ? "resume-while-alive" : "resume"); return "▶️ Continuation requested"; });
    Object.assign(built as never, { resumeTurnManually: resume });
    const release = vi.spyOn(store.turnAttempts, "releaseLostRemoteRecovery").mockReturnValueOnce(true).mockReturnValue(false);
    const attempt = { id: "t1", spec: { target: "thread-1" },
      remoteRecovery: { location: "local", slot: 7, submissionId: "s" } };
    const lose = (built as unknown as { continueLostRemoteTurn(a: unknown, cause: string): void });
    lose.continueLostRemoteTurn(attempt, "test");
    lose.continueLostRemoteTurn(attempt, "test again");
    await vi.waitFor(() => expect(resume).toHaveBeenCalled(), { timeout: 5_000 });
    expect(order).toEqual(["kill", "resume"]);
    expect(release).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
