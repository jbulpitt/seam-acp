/**
 * Global MCP server configuration applied to every ACP session.
 *
 * Servers are gated by env vars so the bot still runs cleanly on a host
 * that doesn't provide them. Playwright is a single loopback HTTP service;
 * every local agent session receives the same endpoint while the MCP server
 * keeps each client's browser context isolated.
 */

import type { McpServer } from "@agentclientprotocol/sdk";
import type { Logger } from "./lib/logger.js";

export interface McpServersResult {
  servers: McpServer[];
}

export function buildGlobalMcpServers(
  logger: Logger,
  _opts: { dataDir: string }
): McpServersResult {
  const servers: McpServer[] = [];

  if (parseBool(process.env.MCP_PLAYWRIGHT_ENABLED)) {
    const url = process.env.MCP_PLAYWRIGHT_URL?.trim() || "http://localhost:8766/mcp";

    servers.push({
      name: "playwright",
      type: "http",
      url,
      headers: [],
    });
    logger.info(
      { url },
      "MCP enabled: shared playwright (browser automation + screenshots)"
    );
  }

  return { servers };
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === "true" || v === "1";
}
