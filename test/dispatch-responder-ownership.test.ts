import { describe, it, expect, vi } from "vitest";
import { pino } from "pino";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const caller: SessionRecord = {
  id: "discord:700000000000000004", channelRef: "700000000000000004", parentRef: "700000000000000005",
  platform: "discord", agentId: "codex", acpSessionId: "source-acp", repoPath: "/synthetic",
  configJson: "{}", createdUtc: "2026-01-01T00:00:00Z", updatedUtc: "2026-01-01T00:00:00Z",
};

describe("dispatch responder ownership", () => {
  // Protects server-only ownership stamping; deleting it loses ownership, while
  // trusting a tool argument lets the model select an unauthorized responder.
  it.each(["handoff", "forward", "steer"])("%s stamps trusted ownership and ignores forged arguments", async name => {
    const enqueued: DispatchSpec[] = [];
    let owner: string | undefined = "700000000000000003";
    const resolveOwner = vi.fn(() => owner);
    const server = new SeamMcpServer({
      logger: pino({ level: "silent" }) as unknown as Logger,
      resolveSession: token => token === "synthetic-token" ? caller : undefined,
      enqueueDispatch: async spec => { enqueued.push(spec); },
      dispatchResponderUserId: resolveOwner,
    });
    await server.start();
    try {
      const call = async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: "POST", headers: { "content-type": "application/json", "X-Seam-Session": "synthetic-token" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {
            worker: "700000000000000001", to: "700000000000000001", thread: "700000000000000001",
            content: "start", prompt: "start", responderUserId: "attacker",
          } } }),
        });
        expect(response.ok).toBe(true);
        await response.text();
      };
      await call();
      expect(resolveOwner).toHaveBeenCalledWith(caller);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.responderUserId).toBe(owner);
      owner = undefined;
      await call();
      expect(enqueued).toHaveLength(2);
      expect(enqueued[1]?.responderUserId).toBeUndefined();
    } finally { await server.stop(); }
  });
});
