/**
 * #76: isolated injectTurn uses loadSession(recorded id) instead of newSession
 * when resumeSessionId is set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../src/core/session-store.js";
import { Orchestrator } from "../src/platforms/discord/orchestrator.js";
import type { Logger } from "../src/lib/logger.js";
import type { SessionRecord } from "../src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const calls: { load: string[]; neu: number; prompts: string[] } = {
  load: [],
  neu: 0,
  prompts: [],
};

vi.mock("../src/agents/agent-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/agent-runtime.js")>();
  return {
    ...actual,
    AgentRuntime: class {
      async start(): Promise<void> {}
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
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("injectTurn isolated resumeSessionId", () => {
  it("calls loadSession(recorded) and never newSession", async () => {
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
      router: {
        listProfiles: () => [],
        describeConfig: () => ({}),
        ensureSessionRecord: () => record(),
        getProfile: () => ({ id: "claude", sessionManager: { deleteSession: async () => {} } }),
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
