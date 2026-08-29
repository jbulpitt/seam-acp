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
      mcpServers: Record<string, { headers?: Array<{ name: string; value: string }> }>;
    };
    expect(json.mcpServers["seam-mcp"]?.headers).toEqual([
      { name: "X-Seam-Session", value: "current-token" },
    ]);
  });
});
