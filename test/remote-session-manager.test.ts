import { describe, expect, it, vi } from "vitest";
import { remoteSessionManager } from "../packages/core/src/core/remote-session-manager.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asLocalAdapter } from "@seam/adapters";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";

describe("remoteSessionManager", () => {
  it.each(["local", "remote-host"])("reads and repairs session history through %s's host RPC", async location => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "seam-host-history-"));
    const history = path.join(cwd, "history.jsonl");
    fs.writeFileSync(history, "original host history");
    const repair = vi.fn(async () => { fs.writeFileSync(history, "repaired host history"); });
    const adapter = asLocalAdapter({
      id: "claude", displayName: "Claude fixture", defaultModel: "default",
      spawn: () => { throw new Error("no process needed for file operations"); },
      sessionManager: {
        listSessions: async () => [], getTranscript: async () => "", cloneSession: async () => {}, deleteSession: async () => {},
        getHistoryPath: async () => history, repairSession: repair,
      },
    });
    const rpc = vi.fn(async (_location, method, params, agentId) => dispatchBridgeRpc(method, params, agentId, {
      adapters: new Map([["claude", adapter]]), workspaceRoot: cwd, cwd,
    }));
    const manager = remoteSessionManager({ rpc } as any, location, "claude", { history: true, repair: true });
    try {
      await expect(manager.getHistory!(cwd, "session")).resolves.toBe("original host history");
      await manager.repairSession!(cwd, "session");
      await expect(manager.getHistory!(cwd, "session")).resolves.toBe("repaired host history");
      expect(repair).toHaveBeenCalledWith(cwd, "session");
      expect(rpc.mock.calls.map(call => [call[0], call[1], call[3]])).toEqual([
        [location, "getHistory", "claude"], [location, "repairSession", "claude"], [location, "getHistory", "claude"],
      ]);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it.each(["local", "remote-host"])("preserves %s's unreadable history error", async location => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "seam-host-history-error-"));
    const missing = path.join(cwd, "missing.jsonl");
    const adapter = asLocalAdapter({
      id: "claude", displayName: "Claude fixture", defaultModel: "default",
      spawn: () => { throw new Error("no process needed for file operations"); },
      sessionManager: {
        listSessions: async () => [], getTranscript: async () => "", cloneSession: async () => {}, deleteSession: async () => {},
        getHistoryPath: async () => missing,
      },
    });
    const rpc = async (_location, method, params, agentId) => dispatchBridgeRpc(method, params, agentId, {
      adapters: new Map([["claude", adapter]]), workspaceRoot: cwd, cwd,
    });
    try {
      const manager = remoteSessionManager({ rpc } as any, location, "claude", { history: true, repair: false });
      await expect(manager.getHistory!(cwd, "session")).rejects.toMatchObject({
        message: expect.stringContaining(`Session host "${location}" could not answer getHistory: ENOENT`),
        cause: expect.objectContaining({ code: "ENOENT", path: missing }),
      });
      expect(manager.repairSession).toBeUndefined();
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("forwards every session operation with the remote agent binding", async () => {
    const rpc = vi.fn(async (_location: string, method: string) => {
      if (method === "listSessions") return [{ sessionId: "remote-session", previewLines: [] }];
      if (method === "getTranscript") return "remote transcript";
      return {};
    });
    const manager = remoteSessionManager({ rpc } as any, "remote-host", "claude");

    await expect(manager.listSessions("/repo")).resolves.toEqual([
      { sessionId: "remote-session", previewLines: [] },
    ]);
    await expect(manager.getTranscript("/repo", "old")).resolves.toBe("remote transcript");
    await manager.cloneSession("/repo", "old", "new");
    await manager.deleteSession("/repo", "new");

    expect(rpc.mock.calls).toEqual([
      ["remote-host", "listSessions", { cwd: "/repo" }, "claude"],
      ["remote-host", "getTranscript", { cwd: "/repo", sessionId: "old" }, "claude"],
      [
        "remote-host",
        "cloneSession",
        { cwd: "/repo", oldSessionId: "old", newSessionId: "new" },
        "claude",
      ],
      ["remote-host", "deleteSession", { cwd: "/repo", sessionId: "new" }, "claude"],
    ]);
  });

  it("keeps the bridge cause and names the host when no bridge is available", async () => {
    const manager = remoteSessionManager(undefined, "missing-host", "claude");

    const error = await manager.listSessions("/repo").catch((err) => err as Error);
    expect(error.message).toBe(
      'Session host "missing-host" could not answer listSessions: bridge "missing-host" is not connected'
    );
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });
});
