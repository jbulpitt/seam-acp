/**
 * #75 durability prerequisites: persist the isolated ACP session id at the
 * `running` transition, and reconcile orphaned in-flight ledger rows on boot.
 * AgentRuntime is mocked so we can pause mid-prompt (after newSession) and
 * inspect the ledger the way a crash would leave it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const ISOLATED_SESSION_ID = "acp-iso-75";

/** Shared gate so the mock runtime can pause after newSession / inside prompt. */
const promptGate: {
  wait: Promise<void>;
  started: Promise<void>;
  release: () => void;
  markStarted: () => void;
} = {
  wait: Promise.resolve(),
  started: Promise.resolve(),
  release: () => {},
  markStarted: () => {},
};

let sessionDir = "";
let deletedSessions: string[] = [];

function sessionFileFor(id: string): string {
  return path.join(sessionDir, `${id}.json`);
}

function armPromptGate(): void {
  let resolveWait: () => void = () => {};
  let resolveStarted: () => void = () => {};
  promptGate.wait = new Promise<void>((r) => {
    resolveWait = r;
  });
  promptGate.started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  promptGate.release = () => resolveWait();
  promptGate.markStarted = () => resolveStarted();
}

vi.mock("../packages/core/src/agents/agent-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return {
    ...actual,
    AgentRuntime: class {
      async start(): Promise<void> {}
      async newSession(): Promise<{ sessionId: string }> {
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(sessionFileFor(ISOLATED_SESSION_ID), "isolated-session");
        return { sessionId: ISOLATED_SESSION_ID };
      }
      onEvent(): void {}
      async prompt(): Promise<{ stopReason: string }> {
        promptGate.markStarted();
        await promptGate.wait;
        return { stopReason: "end_turn" };
      }
      async idle(): Promise<void> {}
      getSessionInfo(): { sessionId: string } {
        return { sessionId: ISOLATED_SESSION_ID };
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

function makeOrch(store: SessionStore, dataDir: string): Orchestrator {
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    reuseMcpServers: () => [],
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) =>
      record({ id: `discord:${channelRef}`, channelRef }),
    getProfile: () => ({
      id: "claude",
      sessionManager: {
        deleteSession: async (_cwd: string, sid: string) => {
          deletedSessions.push(sid);
          const f = sessionFileFor(sid);
          if (fs.existsSync(f)) fs.unlinkSync(f);
        },
      },
    }),
    getOrStartRuntime: async () => {
      throw new Error("isolated dispatch must not use the live runtime");
    },
  };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dataDir,
      REPOS_ROOT: dataDir,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "claude-opus-4.8",
      SEAM_DISPATCH_STATUS_PANEL: false,
      SEAM_DISPATCH_OUTPUT_STYLE: "messages",
    } as any,
    adapter: {} as any,
    router: router as any,
    store,
    renderer: {} as any,
  });
  (orch as any).postDispatchStartIndicator = async () => undefined;
  (orch as any).postDispatchOutput = async () => {};
  return orch;
}

function isolatedSpec(over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    id: "disp-iso-1",
    target: "thread-w",
    prompt: "do isolated work",
    session: "isolated",
    kind: "handoff",
    correlationId: "corr-iso-1",
    createdUtc: "2026-01-01T00:00:00Z",
    stream: false,
    ...over,
  };
}

let dir: string;
let store: SessionStore;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-durability-"));
  dbPath = path.join(dir, "test.db");
  store = new SessionStore(dbPath);
  sessionDir = path.join(dir, "agent-sessions");
  deletedSessions = [];
  armPromptGate();
});

afterEach(async () => {
  // Unblock any hung prompt so injectTurn's finally can settle before we
  // tear the temp dir down.
  promptGate.release();
  await new Promise<void>((r) => setImmediate(r));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("isolated dispatch persists ACP session id at running (#75)", () => {
  it("writes the session id to the ledger while the turn is still running", async () => {
    const orch = makeOrch(store, dir);
    const done = orch.dispatchInjectTurn(isolatedSpec());

    await promptGate.started;

    const row = store.getDelegation("disp-iso-1");
    expect(row?.status).toBe("running");
    expect(row?.acpSessionId).toBe(ISOLATED_SESSION_ID);
    expect(row?.targetRef).toBe("thread-w");
    expect(row?.correlationId).toBe("corr-iso-1");
    // Still in prompt() — completion has not run.
    expect(deletedSessions).toEqual([]);
    expect(fs.existsSync(sessionFileFor(ISOLATED_SESSION_ID))).toBe(true);

    promptGate.release();
    await done;
  });

  it("simulates a mid-dispatch kill: session id stays, session is not deleted, boot marks interrupted", async () => {
    store.recordDelegation({
      id: "already-done",
      kind: "handoff",
      status: "completed",
      targetRef: "thread-other",
      correlationId: "corr-done",
      acpSessionId: "sess-done",
      createdUtc: "2026-01-01T00:00:00.000Z",
      updatedUtc: "2026-01-01T00:00:00.000Z",
    });
    store.recordDelegation({
      id: "already-failed",
      kind: "handoff",
      status: "failed",
      createdUtc: "2026-01-01T00:00:00.000Z",
      updatedUtc: "2026-01-01T00:00:00.000Z",
    });

    const orch = makeOrch(store, dir);
    const hung = orch.dispatchInjectTurn(isolatedSpec()).catch(() => {
      /* abandoned — simulates SIGKILL skipping finally */
    });
    void hung;
    await promptGate.started;

    const mid = store.getDelegation("disp-iso-1");
    expect(mid?.status).toBe("running");
    expect(mid?.acpSessionId).toBe(ISOLATED_SESSION_ID);
    expect(deletedSessions).toEqual([]);
    expect(fs.existsSync(sessionFileFor(ISOLATED_SESSION_ID))).toBe(true);

    // Process dies: close the store without letting injectTurn finish.
    store.close();

    // Next boot: reopen + reconcile (what index.ts does). No session cleanup.
    store = new SessionStore(dbPath);
    const flipped = store.reconcileOrphanedDelegations();
    expect(flipped).toBe(1);

    const after = store.getDelegation("disp-iso-1");
    expect(after?.status).toBe("interrupted");
    expect(after?.acpSessionId).toBe(ISOLATED_SESSION_ID);
    expect(after?.targetRef).toBe("thread-w");
    expect(after?.correlationId).toBe("corr-iso-1");

    expect(store.getDelegation("already-done")).toMatchObject({
      status: "completed",
      acpSessionId: "sess-done",
    });
    expect(store.getDelegation("already-failed")?.status).toBe("failed");

    expect(deletedSessions).toEqual([]);
    expect(fs.existsSync(sessionFileFor(ISOLATED_SESSION_ID))).toBe(true);
  });

  it("does not delete agent sessions when reconciling on boot", () => {
    fs.mkdirSync(sessionDir, { recursive: true });
    const orphan = sessionFileFor("orphan-on-disk");
    fs.writeFileSync(orphan, "left behind by a prior crash");
    store.recordDelegation({
      id: "crash-row",
      kind: "handoff",
      status: "running",
      acpSessionId: "orphan-on-disk",
    });

    store.reconcileOrphanedDelegations();

    expect(store.getDelegation("crash-row")?.status).toBe("interrupted");
    expect(store.getDelegation("crash-row")?.acpSessionId).toBe("orphan-on-disk");
    expect(fs.existsSync(orphan)).toBe(true);
    expect(deletedSessions).toEqual([]);
  });
});
