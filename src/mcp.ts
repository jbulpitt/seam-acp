/**
 * Global MCP server configuration applied to every ACP session.
 *
 * Servers are gated by env vars so the bot still runs cleanly on a host
 * that doesn't have their dependencies installed. Today only Playwright
 * is wired up; new servers should follow the same pattern.
 *
 * Discovery / debugging tip: the agent must be able to resolve the
 * server's `command` on its PATH. For npx-based servers we assume Node
 * is available; for binaries we assume the user has them installed.
 */

import type { McpServer } from "@agentclientprotocol/sdk";
import type { Logger } from "./lib/logger.js";

export function buildGlobalMcpServers(logger: Logger): McpServer[] {
  const servers: McpServer[] = [];

  if (parseBool(process.env.MCP_PLAYWRIGHT_ENABLED)) {
    servers.push({
      name: "playwright",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        "--isolated",
        "--headless",
        "--image-responses",
        "allow",
      ],
      env: [],
    });
    logger.info("MCP enabled: playwright (browser automation + screenshots)");
  }

  return servers;
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === "true" || v === "1";
}
