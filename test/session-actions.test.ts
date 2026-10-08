import { describe, it, expect, vi, beforeEach } from "vitest";
import { pino } from "pino";
import type { ISessionManager } from "@seam/adapters";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { SessionActions } from "../packages/core/src/core/session-actions.js";
import { remoteSessionManager } from "../packages/core/src/core/remote-session-manager.js";

const runtime = vi.hoisted(() => ({ events: [] as string[], sessions: [] as unknown[], fail: undefined as Error | undefined }));
vi.mock("../packages/core/src/agents/agent-runtime.js", () => ({
  AgentRuntime: class {
    handler?: (event: { kind: "agent-text"; text: string }) => void;
    async start() { runtime.events.push("start"); }
    async newSession(args: unknown) { runtime.sessions.push(args); }
    onEvent(handler: typeof this.handler) { this.handler = handler; }
    async prompt() {
      if (runtime.fail) throw runtime.fail;
      this.handler?.({ kind: "agent-text", text: "SUMMARY" });
    }
    getSessionInfo() { return { sessionId: "temporary" }; }
    async dispose() { runtime.events.push("dispose"); }
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, promises: { ...fs.promises, readFile: async (name: string, encoding: "utf8") =>
    name.endsWith("compact.md") ? "TEMPLATE" : fs.promises.readFile(name, encoding) } };
});

function fixture(location = "local") {
  const record: SessionRecord = {
    id: "discord:thread", platform: "discord", channelRef: "thread", parentRef: "parent",
    agentId: "source", acpSessionId: "active", repoPath: "/srv/repos/project", configJson: "{}",
    createdUtc: "2026-01-01", updatedUtc: "2026-01-01",
  };
  let stored = { ...record };
  const events: string[] = [];
  const rows = [{ sessionId: "active", createdAt: 1, lastActivityAt: 2, previewLines: [] }];
  const manager: ISessionManager = {
    listSessions: vi.fn(async () => rows),
    getTranscript: vi.fn(async () => "human: source transcript"),
    cloneSession: vi.fn(async () => { events.push("clone"); }),
    deleteSession: vi.fn(async () => { events.push("delete"); }),
    repairSession: vi.fn(async () => { events.push("repair"); }),
  };
  const rpc = vi.fn(async (_location: string, method: string) => {
    events.push(method);
    if (method === "listSessions") return rows;
    if (method === "getTranscript") return "human: source transcript";
  });
  const source = { id: "source", displayName: "Source", sessionManager: manager };
  const target = { id: "target", displayName: "Target", sessionManager: manager };
  const invalidate = vi.fn(async (_id: string, options?: { clearAcpSession?: boolean }) => {
    events.push("invalidate");
    if (options?.clearAcpSession) stored.acpSessionId = "";
  });
  const seed = vi.fn(async (_args: unknown) => { events.push("seed"); return "seeded"; });
  const cleanup = vi.fn(async () => { runtime.events.push("cleanup"); });
  const launch = vi.fn(() => ({ spawnFn: vi.fn(), mcpServers: [] }));
  const resolve = vi.fn(() => ({ raw: { model: "advertised-model", effort: "high" },
    normalized: { model: "catalog-model", effort: "high" } }));
  const adoptMigration = vi.fn(async (targetRecord: SessionRecord, selection: { agent: string; acpSessionId: string }) => {
    events.push("adopt");
    stored = { ...stored, agentId: selection.agent, acpSessionId: selection.acpSessionId };
    Object.assign(targetRecord, stored);
    events.push("identity");
  });
  const deps = {
    record, manager: location === "local" ? manager : remoteSessionManager({ rpc } as never, location, "source"),
    cwd: record.repoPath!, profile: source, binding: { agentId: "source", location },
    logger: pino({ level: "silent" }),
    store: {
      get: () => ({ ...stored }),
      upsert: (next: SessionRecord) => { events.push("upsert"); stored = { ...next }; },
      compareAndSwapAcpSession: (_id: string, expected: string, next: string) => {
        if (stored.acpSessionId !== expected) return false;
        events.push("cas"); stored.acpSessionId = next; return true;
      },
      readConfig: () => ({ model: "chosen-model", reasoningEffort: "medium" }),
      writeConfig: (config: unknown) => JSON.stringify(config),
    },
    router: {
      invalidate, getProfile: (id: string) => id === "source" ? source : id === "target" ? target : undefined,
      listProfiles: () => [source, target], assertAgentAllowedForRecord: vi.fn(), permissionOptions: () => ({}),
    },
    services: {
      modelCatalog: { resolve }, reposRoot: "/srv/repos", compactionModel: () => "summarizer",
      compactionWindow: () => 100000, launch, cleanup, seed,
      buildSeed: vi.fn(async () => ({ seed: "SEED", keptTurns: 2, summarizedTurns: 3, pinnedCount: 1 })),
      rebuild: vi.fn(), compactFromThread: vi.fn(), premium: vi.fn(),
      adoptMigration,
    },
  } as unknown as ConstructorParameters<typeof SessionActions>[0];
  return { actions: new SessionActions(deps), deps, record, manager, rpc, events, invalidate, seed, cleanup, launch, resolve, adoptMigration,
    current: () => stored, rebind: (id: string) => { stored.acpSessionId = id; } };
}

beforeEach(() => { runtime.events = []; runtime.sessions = []; runtime.fail = undefined; });

describe("SessionActions", () => {
  it.each(["local", "remote"])("keeps %s CRUD on the browser's execution host and cwd", async (location) => {
    const h = fixture(location);
    await h.actions.list(); await h.actions.transcript("other");
    await h.actions.clone("other", "copy"); await h.actions.delete("other");
    if (location === "local") {
      expect(h.manager.cloneSession).toHaveBeenCalledWith("/srv/repos/project", "other", "copy");
      expect(h.manager.deleteSession).toHaveBeenCalledWith("/srv/repos/project", "other");
    } else {
      expect(h.rpc.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ["remote", "listSessions"], ["remote", "getTranscript"], ["remote", "cloneSession"], ["remote", "deleteSession"],
      ]);
      expect(h.rpc).toHaveBeenLastCalledWith("remote", "deleteSession", { cwd: "/srv/repos/project", sessionId: "other" }, "source");
    }
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it("retires before attaching, and deletes before clearing an active binding", async () => {
    const h = fixture();
    await h.actions.attach("attached");
    expect(h.events).toEqual(["invalidate", "upsert"]);
    expect(h.record.acpSessionId).toBe("attached");
    h.events.length = 0;
    await h.actions.delete("attached");
    expect(h.events).toEqual(["delete", "invalidate"]);
    expect(h.invalidate).toHaveBeenLastCalledWith(h.record.id, { clearAcpSession: true, operatorIntent: "replace-session",
      bindingChange: { source: "SessionActions.delete", cause: "operator deleted attached provider session" },
    });
    expect(h.record.acpSessionId).toBe("");
  });

  it("does not let compaction steal a binding changed since admission", async () => {
    const h = fixture(); h.rebind("elsewhere");
    const result = await h.actions.compact("active", "active");
    expect(result.newId).toBe("seeded");
    expect(result.attachment).toEqual({ attached: false, reason: "rebound-elsewhere" });
    expect(h.record.acpSessionId).toBe("elsewhere");
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it.each(["local", "remote"])("uses the real catalog selection for a %s summary and cleans up after delivery", async (location) => {
    const h = fixture(location);
    await h.actions.summary("active", async (summary) => { expect(summary).toBe("SUMMARY"); runtime.events.push("delivery"); });
    expect(h.resolve).toHaveBeenCalledWith({ agentId: "source", location }, { model: "default" });
    expect(runtime.sessions).toEqual([{ cwd: "/srv/repos/project", model: "advertised-model", effort: "high", strictModel: true }]);
    expect(runtime.events).toEqual(["start", "delivery", "dispose", "cleanup"]);
    expect(h.cleanup).toHaveBeenCalledWith(expect.objectContaining({ location, cwd: "/srv/repos/project", sessionId: "temporary" }));
  });

  it("passes runtime failures through and still cleans up", async () => {
    const h = fixture(); const failure = new Error("provider rejected request"); runtime.fail = failure;
    await expect(h.actions.summary("active", vi.fn())).rejects.toBe(failure);
    expect(runtime.events).toEqual(["start", "dispose", "cleanup"]);
  });

  it("delivers a failure before disposing the throwaway session", async () => {
    const h = fixture(); const failure = new Error("provider rejected request"); runtime.fail = failure;
    await h.actions.summary("active", vi.fn(), async (error) => {
      expect(error).toBe(failure); runtime.events.push("failure delivery");
    });
    expect(runtime.events).toEqual(["start", "failure delivery", "dispose", "cleanup"]);
  });

  it("imports under the target cwd with the admission-time summarizer", async () => {
    const h = fixture();
    await h.actions.import("active", "/srv/repos/imported", "admitted-model", async () => {});
    expect(runtime.sessions).toEqual([{ cwd: "/srv/repos/imported", model: "admitted-model", meta: { reasoningEffort: "low" } }]);
    expect(h.events).toEqual(["seed", "invalidate", "upsert"]);
    expect(h.current()).toMatchObject({ repoPath: "/srv/repos/imported", acpSessionId: "seeded" });
    expect(JSON.parse(h.current().configJson).sessionCwdExplicit).toBe(true);
  });

  it("migrates with the target binding's default selection and actor before delivery", async () => {
    const h = fixture("remote");
    const actor = { id: "operator", name: "Operator" };
    await h.actions.migrate("active", "target", actor, async () => { h.events.push("delivery"); });
    expect(h.resolve).toHaveBeenCalledWith({ agentId: "target", location: "remote" }, { model: "default" });
    expect(h.seed).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ id: "target" }),
      location: "remote", model: "advertised-model", effort: "high" }));
    expect(h.adoptMigration).toHaveBeenCalledWith(h.record,
      { agent: "target", model: "catalog-model", effort: "high", acpSessionId: "seeded" }, actor);
    expect(h.events).toEqual(["getTranscript", "seed", "adopt", "identity", "delivery"]);
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.record).toMatchObject({ agentId: "target", acpSessionId: "seeded" });
  });

  it("leaves the thread selection alone when seeding the target fails", async () => {
    const h = fixture();
    const failure = new Error("target provider failed");
    h.seed.mockRejectedValueOnce(failure);
    await expect(h.actions.migrate("active", "target", { id: "operator", name: "Operator" }, vi.fn())).rejects.toBe(failure);
    expect(h.adoptMigration).not.toHaveBeenCalled();
    expect(h.current()).toMatchObject({ agentId: "source", acpSessionId: "active" });
  });
});
