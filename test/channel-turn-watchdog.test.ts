import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
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

function makeOrchestrator(dir: string) {
  const abortTurn = vi.fn(async () => "killed" as const);
  const session = record();
  const orchestrator = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      DEFAULT_MODEL: "default",
      TURN_TIMEOUT_SECONDS: 10,
      threadPresets: new Map(),
      channelPresets: new Map(),
      bridgePresets: new Map(),
    } as any,
    adapter: {} as any,
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
  });
  return { orchestrator, abortTurn };
}

describe("active-turn watchdog", () => {
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-turn-watchdog-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("force-settles a never-resolving queued turn and lets the FIFO continue", async () => {
    const { orchestrator, abortTurn } = makeOrchestrator(dir);
    const hung = (orchestrator as any).queueOnChannel(
      "thread-1",
      () => new Promise<never>(() => {})
    ) as Promise<never>;
    const outcome = hung.catch((error) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.activeTurnCount()).toBe(1);
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
