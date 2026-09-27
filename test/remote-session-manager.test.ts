import { describe, expect, it, vi } from "vitest";
import { remoteSessionManager } from "../packages/core/src/core/remote-session-manager.js";

describe("remoteSessionManager", () => {
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
