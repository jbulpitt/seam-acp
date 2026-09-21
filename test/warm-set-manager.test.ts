import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { WarmSetManager, type WarmSetRouter } from "../packages/core/src/core/warm-set/manager.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function record(over: Partial<SessionRecord> & Pick<SessionRecord, "id" | "channelRef" | "agentId">): SessionRecord {
  return {
    platform: "discord",
    parentRef: "chan",
    acpSessionId: "acp-1",
    repoPath: null,
    configJson: "{}",
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-20T12:00:00.000Z",
    namePrefix: null,
    ...over,
  };
}

describe("WarmSetManager", () => {
  it("does nothing when no hosts are opted in", async () => {
    const list = vi.fn();
    const manager = new WarmSetManager({
      logger: silent,
      store: { listSessionsUncapped: list, get: () => null } as never,
      router: {} as WarmSetRouter,
      hub: { isBridgeReady: () => true },
      threadPresets: new Map(),
      hosts: [],
      intervalMs: 60_000,
      maxConcurrent: 2,
    });
    manager.start();
    await manager.tick();
    expect(list).not.toHaveBeenCalled();
    manager.stop();
  });

  it("resumes a fitting session, marks a failed load cold without retrying, and never newSessions", async () => {
    const grok = record({ id: "discord:g", channelRef: "g", agentId: "grok" });
    const resume = vi.fn(async () => {
      throw new Error("session not found");
    });
    const invalidate = vi.fn(async () => {});
    const manager = new WarmSetManager({
      logger: silent,
      store: {
        listSessionsUncapped: () => [grok],
        get: (id: string) => (id === grok.id ? grok : null),
      } as never,
      router: {
        hasRuntime: () => false,
        turnHealth: () => ({ busy: false, silentMs: 0, stalled: false }),
        getRuntime: () => undefined,
        isBusy: () => false,
        resumeExistingSession: resume,
        invalidate,
      },
      hub: { isBridgeReady: () => true },
      threadPresets: new Map([["g", { location: "fhr-server" }]]),
      hosts: [{ id: "fhr-server", budgetMb: 2500 }],
      intervalMs: 60_000,
      maxConcurrent: 2,
    });
    await manager.tick();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(grok.id, { clearAcpSession: true });
    resume.mockClear();
    await manager.tick();
    expect(resume).not.toHaveBeenCalled();
  });

  it("skips a remote host that is not ready rather than inventing a local load", async () => {
    const resume = vi.fn();
    const manager = new WarmSetManager({
      logger: silent,
      store: { listSessionsUncapped: () => [record({ id: "discord:g", channelRef: "g", agentId: "grok" })], get: () => null } as never,
      router: {
        hasRuntime: () => false,
        turnHealth: () => ({ busy: false, silentMs: 0, stalled: false }),
        getRuntime: () => undefined,
        isBusy: () => false,
        resumeExistingSession: resume,
        invalidate: async () => {},
      },
      hub: { isBridgeReady: () => false },
      threadPresets: new Map([["g", { location: "rhc-server" }]]),
      hosts: [{ id: "rhc-server", budgetMb: 10_000 }],
      intervalMs: 60_000,
      maxConcurrent: 2,
    });
    await manager.tick();
    expect(resume).not.toHaveBeenCalled();
  });

  it("marks a remote hot runtime cold when the bridge reports the slot dead", async () => {
    const grok = record({ id: "discord:g", channelRef: "g", agentId: "grok" });
    const invalidate = vi.fn(async () => {});
    const manager = new WarmSetManager({
      logger: silent,
      store: { listSessionsUncapped: () => [grok], get: () => grok } as never,
      router: {
        hasRuntime: () => true,
        turnHealth: () => ({ busy: false, silentMs: 5_000, stalled: false }),
        getRuntime: () => ({ markActivity: () => {}, getSlot: () => 3 }),
        isBusy: () => false,
        resumeExistingSession: async () => { throw new Error("should not load"); },
        invalidate,
      },
      hub: {
        isBridgeReady: () => true,
        slotHealthFor: () => [{ slot: 3, alive: false, pid: null, lastStdoutMsAgo: null, lastStdinMsAgo: null }],
      },
      threadPresets: new Map([["g", { location: "rhc-server" }]]),
      hosts: [{ id: "rhc-server", budgetMb: 10_000 }],
      intervalMs: 60_000,
      maxConcurrent: 2,
    });
    await manager.tick();
    expect(invalidate).toHaveBeenCalledWith(grok.id);
  });

  it("marks a stalled hot runtime cold using turnHealth, not a guessed busy flag", async () => {
    const claude = record({ id: "discord:c", channelRef: "c", agentId: "claude" });
    const invalidate = vi.fn(async () => {});
    const manager = new WarmSetManager({
      logger: silent,
      store: { listSessionsUncapped: () => [claude], get: () => claude } as never,
      router: {
        hasRuntime: () => true,
        turnHealth: () => ({ busy: true, silentMs: 999_000, stalled: true }),
        getRuntime: () => ({ markActivity: () => {} }),
        isBusy: () => false,
        resumeExistingSession: async () => { throw new Error("should not load"); },
        invalidate,
      },
      hub: { isBridgeReady: () => true },
      threadPresets: new Map([["c", { location: "local" }]]),
      hosts: [{ id: "local", budgetMb: 12_000 }],
      intervalMs: 60_000,
      maxConcurrent: 2,
    });
    await manager.tick();
    expect(invalidate).toHaveBeenCalledWith(claude.id);
  });
});
