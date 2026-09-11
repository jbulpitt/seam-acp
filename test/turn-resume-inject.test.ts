/**
 * #76: isolated injectTurn uses loadSession(recorded id) instead of newSession
 * when resumeSessionId is set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { DispatchSuspendedError } from "../packages/core/src/core/dispatch/attempt-store.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const calls: { load: string[]; neu: number; prompts: string[] } = {
  load: [],
  neu: 0,
  prompts: [],
};
let beforeOutcome: (() => void) | undefined;

vi.mock("../packages/core/src/agents/agent-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return {
    ...actual,
    AgentRuntime: class {
      async start(): Promise<void> {}
      supportsSessionLoad(): boolean { return true; }
      async newSession(): Promise<{ sessionId: string }> {
        calls.neu++;
        return { sessionId: "acp-NEW" };
      }
      async loadSession(opts: { sessionId: string }): Promise<{ sessionId: string }> {
        calls.load.push(opts.sessionId);
        return { sessionId: opts.sessionId };
      }
      onEvent(): void {}
      async prompt(p: string): Promise<{ stopReason: string }> {
        calls.prompts.push(p);
        beforeOutcome?.();
        return { stopReason: "end_turn" };
      }
      async idle(): Promise<void> {}
      getSessionInfo(): { sessionId: string } {
        return { sessionId: calls.load[0] ?? "acp-NEW" };
      }
      async dispose(): Promise<void> {}
    },
  };
});

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-w",
  platform: "discord",
  channelRef: "thread-w",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00Z",
  updatedUtc: "2026-01-01T00:00:00Z",
  ...over,
});

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-resume-inject-"));
  store = new SessionStore(path.join(dir, "test.db"));
  calls.load = [];
  calls.neu = 0;
  calls.prompts = [];
  beforeOutcome = undefined;
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("injectTurn isolated resumeSessionId", () => {
  it("an optional cleanup attribution failure cannot prevent isolated disposal/history cleanup (#253)", async () => {
    const deleteSession = vi.fn(async () => {});
    const profile = { id: "codex", defaultModel: "m", sessionManager: { deleteSession } } as any;
    const orch = new Orchestrator({ logger: silent, store, config: { REPOS_ROOT: dir, DATA_DIR: dir } as any,
      adapter: {} as any, renderer: {} as any, modelCatalog: fixtureModelCatalog([profile]),
      router: { listProfiles: () => [], describeConfig: () => ({ location: { value: "local" } }),
        assertAgentAllowedForChannel: () => {} } as any });
    let completed = false;
    await orch.injectTurn(record(), "disposable", { session: "isolated", profile, cwd: dir,
      lifecycle: { isCurrent: () => true, beforePrompt: () => {}, onOutcome: () => { completed = true; },
        mayDeleteSession: () => completed, onCleanup: () => { throw new Error("synthetic observability failure"); } } });
    expect(completed).toBe(true);
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(dir, "acp-NEW");
  });

  it("suspension retains isolated provider material; completion deletes it only after winning", async () => {
    const deleteSession = vi.fn(async () => {});
    const profile = { id: "codex", defaultModel: "m", sessionManager: { deleteSession } } as any;
    const orch = new Orchestrator({
      logger: silent, store, config: { REPOS_ROOT: dir, DATA_DIR: dir } as any,
      adapter: {} as any, renderer: {} as any,
      modelCatalog: fixtureModelCatalog([profile]),
      router: { listProfiles: () => [], describeConfig: () => ({ location: { value: "local" } }),
        assertAgentAllowedForChannel: () => {} } as any,
    });
    let active = true, completed = false;
    beforeOutcome = () => { active = false; };
    const lifecycle = {
      isCurrent: () => active,
      beforePrompt: () => {},
      onOutcome: () => { if (!active) throw new DispatchSuspendedError("job"); completed = true; },
      mayDeleteSession: () => completed,
    };
    await expect(orch.injectTurn(record(), "continue", { session: "isolated", profile, cwd: dir,
      resumeSessionId: "same-acp", lifecycle })).rejects.toBeInstanceOf(DispatchSuspendedError);
    expect(deleteSession).not.toHaveBeenCalled();
    active = true; beforeOutcome = undefined;
    await orch.injectTurn(record(), "continue", { session: "isolated", profile, cwd: dir,
      resumeSessionId: "same-acp", lifecycle });
    expect(completed).toBe(true);
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(dir, "same-acp");
    expect(calls.neu).toBe(0);
    expect(calls.load).toEqual(["same-acp", "same-acp"]);
  });

  it("onSession persistence failure prevents prompt submission and cleanup", async () => {
    const deleteSession = vi.fn(async () => {});
    const profile = { id: "codex", defaultModel: "m", sessionManager: { deleteSession } } as any;
    const orch = new Orchestrator({
      logger: silent, store, config: { REPOS_ROOT: dir, DATA_DIR: dir } as any,
      adapter: {} as any, renderer: {} as any, modelCatalog: fixtureModelCatalog([profile]),
      router: { listProfiles: () => [], describeConfig: () => ({ location: { value: "local" } }),
        assertAgentAllowedForChannel: () => {} } as any,
    });
    await expect(orch.injectTurn(record(), "original", {
      session: "isolated", profile, cwd: dir,
      onSession: () => { throw new DispatchSuspendedError("db-write-failed"); },
      lifecycle: { isCurrent: () => true, beforePrompt: () => {}, onOutcome: () => {}, mayDeleteSession: () => false },
    })).rejects.toBeInstanceOf(DispatchSuspendedError);
    expect(calls.prompts).toEqual([]);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("calls loadSession(recorded) and never newSession", async () => {
    const catalogProfile = { id: "claude", defaultModel: "m" } as any;
    const orch = new Orchestrator({
      logger: silent,
      config: {
        DATA_DIR: dir,
        REPOS_ROOT: dir,
        TURN_TIMEOUT_SECONDS: 60,
        DEFAULT_MODEL: "m",
        SEAM_DISPATCH_STATUS_PANEL: false,
      } as any,
      adapter: {} as any,
      modelCatalog: fixtureModelCatalog([catalogProfile]),
      router: {
        listProfiles: () => [],
        describeConfig: () => ({ location: { value: "local" } }),
        ensureSessionRecord: () => record(),
        getProfile: () => ({ id: "claude", sessionManager: { deleteSession: async () => {} } }),
        assertAgentAllowedForChannel: () => {},
        getOrStartRuntime: async () => {
          throw new Error("isolated must not use live runtime");
        },
      } as any,
      store,
      renderer: {} as any,
    });

    const result = await orch.injectTurn(record(), "continue", {
      session: "isolated",
      profile: { id: "claude" } as any,
      cwd: dir,
      resumeSessionId: "acp-recorded-75",
      awaitIdle: true,
    });

    expect(result.error).toBeUndefined();
    expect(calls.load).toEqual(["acp-recorded-75"]);
    expect(calls.neu).toBe(0);
    expect(calls.prompts).toEqual(["continue"]);
    expect(result.sessionId).toBe("acp-recorded-75");
  });
});
