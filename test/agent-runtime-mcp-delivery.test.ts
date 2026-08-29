import { describe, expect, it } from "vitest";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { logger } from "../packages/core/src/lib/logger.js";

const seamMcp: McpServer = {
  type: "http",
  name: "seam-mcp",
  url: "http://127.0.0.1:3000/mcp",
  headers: [{ name: "X-Seam-Session", value: "token" }],
};

class FakeConn {
  newParams: { mcpServers?: McpServer[] } | undefined;
  loadParams: { mcpServers?: McpServer[] } | undefined;

  async newSession(params: { mcpServers?: McpServer[] }) {
    this.newParams = params;
    return { sessionId: "fresh", configOptions: null, modes: null };
  }

  async loadSession(params: { sessionId: string; mcpServers?: McpServer[] }) {
    this.loadParams = params;
    return { sessionId: params.sessionId, configOptions: null, modes: null };
  }

  async setSessionConfigOption() {}
  async setSessionMode() {}
}

function runtime(mcpServersAtSpawn: boolean) {
  const profile = {
    id: "test",
    defaultModel: "default",
    mcpServersAtSpawn,
  } as unknown as AgentProfile;
  const rt = new AgentRuntime({ profile, logger, mcpServers: [seamMcp] });
  const conn = new FakeConn();
  (rt as unknown as { connection: unknown }).connection = conn;
  (rt as unknown as { promptCapabilities: unknown }).promptCapabilities = {};
  return { rt, conn };
}

describe("AgentRuntime MCP delivery", () => {
  it("does not duplicate spawn-configured servers into ACP new/load", async () => {
    const fresh = runtime(true);
    await fresh.rt.newSession({ cwd: "/tmp" });
    expect(fresh.conn.newParams?.mcpServers).toEqual([]);

    const resumed = runtime(true);
    await resumed.rt.loadSession({ sessionId: "existing", cwd: "/tmp" });
    expect(resumed.conn.loadParams?.mcpServers).toEqual([]);
  });

  it("continues delivering servers through ACP for ordinary adapters", async () => {
    const resumed = runtime(false);
    await resumed.rt.loadSession({ sessionId: "existing", cwd: "/tmp" });
    expect(resumed.conn.loadParams?.mcpServers).toEqual([seamMcp]);
  });
});
