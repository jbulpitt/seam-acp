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

import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { Logger } from "./lib/logger.js";

export interface McpServersResult {
  servers: McpServer[];
}

export function buildGlobalMcpServers(
  logger: Logger,
  opts: { dataDir: string }
): McpServersResult {
  const servers: McpServer[] = [];

  if (parseBool(process.env.MCP_PLAYWRIGHT_ENABLED)) {
    // Pin Playwright's outputs to a known scratch dir under DATA_DIR so
    // they don't pollute whatever repo the session happens to be in.
    const scratch = path.resolve(opts.dataDir, "agent-scratch", "playwright");
    fs.mkdirSync(scratch, { recursive: true });

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
        "--output-dir",
        scratch,
      ],
      env: [],
    });
    logger.info(
      { outputDir: scratch },
      "MCP enabled: playwright (browser automation + screenshots)"
    );
  }

  return { servers };
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === "true" || v === "1";
}
