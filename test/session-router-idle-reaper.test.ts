import { beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord, SessionConfigState } from "../packages/core/src/core/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const runtimeState = vi.hoisted(() => ({
  failLoad: false,
  instances: [] as Array<{
    busy: boolean;
    lastActivityAtMs: number;
    disposed: boolean;
    disposeWait?: Promise<void>;
    loadCalls: Array<{ sessionId: string }>;
    newCalls: number;
  }>,
}));

vi.mock("../packages/core/src/agents/agent-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return {
    ...actual,
    AgentRuntime: class {
      busy = false;
      lastActivityAtMs = Date.now();
      disposed = false;
      disposeWait?: Promise<void>;
      loadCalls: Array<{ sessionId: string }> = [];
      newCalls = 0;

      constructor() {
        runtimeState.instances.push(this);
      }

      modelOverride?: string;
      effortOverride?: string;
      async start(): Promise<void> {}
      supportsSessionLoad(): boolean { return true; }
      markActivity(): void {
        this.lastActivityAtMs = Date.now();
      }
      async loadSession(opts: { sessionId: string }): Promise<void> {
        this.loadCalls.push({ sessionId: opts.sessionId });
        if (runtimeState.failLoad) throw new Error("synthetic session unavailable");
      }
      getSessionInfo() { return { sessionId: this.loadCalls.at(-1)?.sessionId ?? `new-${runtimeState.instances.length}` }; }
      async newSession(): Promise<{ sessionId: string }> {
        this.newCalls += 1;
        return { sessionId: `new-${runtimeState.instances.length}` };
      }
      async dispose(): Promise<void> {
        if (this.disposeWait) await this.disposeWait;
        this.disposed = true;
      }
    },
  };
});

import { SessionRouter } from "../packages/core/src/core/session-router.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const profile = {
  id: "copilot",
  defaultModel: "gpt-test",
  spawn: () => {
    throw new Error("mock AgentRuntime must not spawn a real child");
  },
} as unknown as AgentProfile;

function makeRecord(): SessionRecord {
  return {
    id: "discord:idle-thread",
    platform: "discord",
    channelRef: "idle-thread",
    parentRef: "channel-1",
    agentId: "copilot",
    acpSessionId: "acp-durable-1",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "gpt-test" } satisfies SessionConfigState),
    createdUtc: "2026-01-01T00:00:00.000Z",
    updatedUtc: "2026-01-01T00:00:00.000Z",
  };
}

function makeStore(record: SessionRecord): SessionStore {
  let row = { ...record };
  return {
    get: (id: string) => (id === row.id ? { ...row } : null),
    upsert: (next: SessionRecord) => {
      row = { ...next };
    },
    needsAgyIdentityRebuild: () => false,
    lookupAgentChannelRestriction: () => ({ state: "absent" as const }),
    readConfig: (input: SessionRecord) => JSON.parse(input.configJson) as SessionConfigState,
  } as unknown as SessionStore;
}

function makeRouter(record: SessionRecord): SessionRouter {
  return new SessionRouter({
    logger: silent,
    store: makeStore(record),
    profiles: [profile],
    modelCatalog: fixtureModelCatalog([profile]),
    defaultAgentId: "copilot",
    defaultModel: "gpt-test",
    runtimeIdleTtlMs: 1_000,
  });
}

beforeEach(() => {
  runtimeState.instances.length = 0;
  runtimeState.failLoad = false;
});

describe("SessionRouter idle runtime reaping", () => {
  it("strict recovery never replaces a different nonempty thread session", async () => {
    const record = makeRecord();
    const router = makeRouter(record);
    await expect(router.getOrStartRuntime(record, { resumeSessionId: "dispatch-session" })).rejects.toThrow(/different ACP/);
    expect(runtimeState.instances).toHaveLength(0);
    expect(record.acpSessionId).toBe("acp-durable-1");
  });

  it("strict recovery verifies the warm runtime as well as the thread row", async () => {
    const record = makeRecord();
    const router = makeRouter(record);
    await router.getOrStartRuntime(record);
    runtimeState.instances[0]!.loadCalls[0]!.sessionId = "warm-other-session";
    await expect(router.getOrStartRuntime(record, { resumeSessionId: record.acpSessionId })).rejects.toThrow(/cached runtime/);
    expect(runtimeState.instances[0]!.newCalls).toBe(0);
    await router.disposeAll();
  });

  it("strict load failure disposes the replacement, never falls back to newSession", async () => {
    const record = makeRecord();
    const router = makeRouter(record);
    runtimeState.failLoad = true;
    await expect(router.getOrStartRuntime(record, { resumeSessionId: record.acpSessionId })).rejects.toThrow(/session unavailable/);
    expect(runtimeState.instances[0]!.newCalls).toBe(0);
    expect(runtimeState.instances[0]!.disposed).toBe(true);
    expect(record.acpSessionId).toBe("acp-durable-1");
    expect(router.hasRuntime(record.id)).toBe(false);
  });
  it("retires only the warm process and resumes the same durable ACP session", async () => {
    const record = makeRecord();
    const router = makeRouter(record);
    const first = (await router.getOrStartRuntime(record)) as unknown as typeof runtimeState.instances[number];
    expect(first.loadCalls).toEqual([{ sessionId: "acp-durable-1" }]);

    first.lastActivityAtMs = 1_000;
    expect(await router.sweepIdleRuntimes(2_001)).toBe(1);
    expect(first.disposed).toBe(true);
    expect(router.hasRuntime(record.id)).toBe(false);
    expect(record.acpSessionId).toBe("acp-durable-1");

    const resumed = (await router.getOrStartRuntime(record)) as unknown as typeof runtimeState.instances[number];
    expect(resumed).not.toBe(first);
    expect(resumed.loadCalls).toEqual([{ sessionId: "acp-durable-1" }]);
    expect(resumed.newCalls).toBe(0);
    await router.disposeAll();
  });

  it("never retires a runtime with an active prompt", async () => {
    const record = makeRecord();
    const router = makeRouter(record);
    const runtime = (await router.getOrStartRuntime(record)) as unknown as typeof runtimeState.instances[number];
    runtime.lastActivityAtMs = 1_000;
    runtime.busy = true;

    expect(await router.sweepIdleRuntimes(20_000)).toBe(0);
    expect(runtime.disposed).toBe(false);
    expect(router.hasRuntime(record.id)).toBe(true);
    runtime.busy = false;
    await router.disposeAll();
  });

  it("blocks respawn until the retiring process tree is fully disposed", async () => {
    const record = makeRecord();
    const router = makeRouter(record);
    const first = (await router.getOrStartRuntime(record)) as unknown as typeof runtimeState.instances[number];
    first.lastActivityAtMs = 1_000;

    let releaseDispose = () => {};
    first.disposeWait = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });

    const reaping = router.sweepIdleRuntimes(2_001);
    const respawn = router.getOrStartRuntime(record);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtimeState.instances).toHaveLength(1);
    expect(router.hasRuntime(record.id)).toBe(false);

    releaseDispose();
    expect(await reaping).toBe(1);
    const second = (await respawn) as unknown as typeof runtimeState.instances[number];
    expect(runtimeState.instances).toHaveLength(2);
    expect(second.loadCalls).toEqual([{ sessionId: "acp-durable-1" }]);
    expect(second.newCalls).toBe(0);
    await router.disposeAll();
  });
});
