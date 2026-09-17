import { describe, expect, it } from "vitest";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  buildCopilotMcpConfigJson,
  mergeCopilotMcpServers,
} from "../packages/adapters/src/profiles/copilot.js";

const seamMcp = (token: string): McpServer => ({
  type: "http",
  name: "seam-mcp",
  url: "http://127.0.0.1:3000/mcp",
  headers: [{ name: "X-Seam-Session", value: token }],
});

describe("Copilot per-runtime MCP configuration", () => {
  it("overrides a stale same-name server with the current session token", () => {
    const merged = mergeCopilotMcpServers(
      [
        {
          name: "playwright",
          command: "npx",
          args: ["-y", "@playwright/mcp"],
        } as McpServer,
        seamMcp("old-token"),
      ],
      [seamMcp("current-token")]
    );

    expect(merged.map((server) => server.name)).toEqual(["playwright", "seam-mcp"]);
    const json = JSON.parse(buildCopilotMcpConfigJson(merged)!) as {
      mcpServers: Record<
        string,
        {
          type?: string;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          headers?: Record<string, string>;
          deferTools?: string;
        }
      >;
    };
    expect(json.mcpServers["seam-mcp"]?.headers).toEqual({
      "X-Seam-Session": "current-token",
    });
    expect(json.mcpServers["seam-mcp"]?.deferTools).toBe("never");
    expect(json.mcpServers.playwright?.deferTools).toBeUndefined();
    expect(json.mcpServers.playwright).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp"],
    });
  });

  it("preserves stdio environment values for a host-owned project server", () => {
    const json = JSON.parse(buildCopilotMcpConfigJson([{
      name: "langfuse",
      command: "node",
      args: ["langfuse-mcp.mjs"],
      env: [{ name: "LANGFUSE_MCP_AUTH", value: "synthetic-secret" }],
    }])!) as { mcpServers: Record<string, { env?: Record<string, string> }> };

    expect(json.mcpServers.langfuse?.env).toEqual({
      LANGFUSE_MCP_AUTH: "synthetic-secret",
    });
  });
});
