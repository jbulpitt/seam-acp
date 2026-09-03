import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { restartSentinelPath } from "../packages/core/src/core/restart-sentinel.js";
import { TurnWatchdogTimeoutError } from "../packages/core/src/core/turn-watchdog.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function record(): SessionRecord {
  return {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    agentId: "claude",
    acpSessionId: "acp-1",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-01T00:00:00.000Z",
  };
}

function makeOrchestrator(
  dir: string,
  opts?: { drainMs?: number; turnSeconds?: number; hangNotification?: boolean }
) {
  const restartProcess = vi.fn(async () => {});
  const abortTurn = vi.fn(async () => "killed" as const);
  const session = record();
  const orchestrator = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      DEFAULT_MODEL: "default",
      TURN_TIMEOUT_SECONDS: opts?.turnSeconds ?? 10,
      RESTART_DRAIN_TIMEOUT_MS: opts?.drainMs ?? 1_000,
      ...(opts?.hangNotification
        ? { DISCORD_NOTIFICATIONS_CHANNEL_ID: "notifications" }
        : {}),
      threadPresets: new Map(),
      channelPresets: new Map(),
      bridgePresets: new Map(),
    } as any,
    adapter: {
      ...(opts?.hangNotification
        ? { sendMessage: () => new Promise<never>(() => {}) }
        : {}),
    } as any,
    router: {
      listProfiles: () => [],
      describeConfig: () => ({}),
      abortTurn,
    } as any,
    store: {
      getByChannel: (_platform: string, channelRef: string) =>
        channelRef === session.channelRef ? session : null,
      getParkedByChannel: () => null,
    } as any,
    renderer: {} as any,
    restartProcess,
  });
  return { orchestrator, restartProcess, abortTurn };
}

describe("restart drain and active-turn watchdog", () => {
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-restart-drain-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restarts through the force path after the bounded drain even if activeTurns is permanently leaked", async () => {
    const { orchestrator, restartProcess } = makeOrchestrator(dir, {
      drainMs: 1_000,
      hangNotification: true,
    });
    fs.writeFileSync(restartSentinelPath(dir), "", "utf8");
    // Two turns registered and never released — a genuine leak, not a number
    // set on the side. `activeTurns` is derived from the registrations.
    (orchestrator as any).beginTurn();
    (orchestrator as any).beginTurn();

    const restarting = (orchestrator as any).handleRestartSentinel() as Promise<void>;
    await vi.advanceTimersByTimeAsync(999);
    expect(restartProcess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await restarting;

    expect((orchestrator as any).activeTurns).toBe(2);
    expect(restartProcess).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(restartSentinelPath(dir))).toBe(false);
  });

  it("preserves the explicit force sentinel as an immediate no-drain restart", async () => {
    const { orchestrator, restartProcess } = makeOrchestrator(dir, { drainMs: 5_000 });
    fs.writeFileSync(restartSentinelPath(dir), "force\n", "utf8");
    for (let i = 0; i < 7; i++) (orchestrator as any).beginTurn(); // held open

    await (orchestrator as any).handleRestartSentinel();

    expect(restartProcess).toHaveBeenCalledTimes(1);
    expect((orchestrator as any).activeTurns).toBe(7);
  });

  it("preserves graceful drain and the background-I/O flush when turns finish before timeout", async () => {
    const { orchestrator, restartProcess } = makeOrchestrator(dir, { drainMs: 5_000 });
    fs.writeFileSync(restartSentinelPath(dir), "", "utf8");
    const endTurn = (orchestrator as any).beginTurn() as () => void;
    const restarting = (orchestrator as any).handleRestartSentinel() as Promise<void>;

    await vi.advanceTimersByTimeAsync(400);
    endTurn();
    await vi.advanceTimersByTimeAsync(100);
    expect(restartProcess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(restartProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await restarting;
    expect(restartProcess).toHaveBeenCalledTimes(1);
  });

  it("force-settles a never-resolving queued turn, releases activeTurns, and lets the FIFO continue", async () => {
    const { orchestrator, abortTurn } = makeOrchestrator(dir, { turnSeconds: 10 });
    const hung = (orchestrator as any).queueOnChannel(
      "thread-1",
      () => new Promise<never>(() => {})
    ) as Promise<never>;
    const outcome = hung.catch((error) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.activeTurnCount()).toBe(1);
    // The hard watchdog deliberately trails the ordinary 10s turn timeout by
    // 30s, giving its normal cleanup path first chance to settle.
    await vi.advanceTimersByTimeAsync(39_999);
    expect(orchestrator.activeTurnCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(TurnWatchdogTimeoutError);
    expect(orchestrator.activeTurnCount()).toBe(0);
    expect(abortTurn).toHaveBeenCalledWith("discord:thread-1", { force: true });

    const next = (orchestrator as any).queueOnChannel(
      "thread-1",
      async () => "next-ran"
    ) as Promise<string>;
    await expect(next).resolves.toBe("next-ran");
    expect(orchestrator.activeTurnCount()).toBe(0);
  });
});
