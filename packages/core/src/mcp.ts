/**
 * Global MCP server configuration applied to every ACP session.
 *
 * Servers are gated by env vars so the bot still runs cleanly on a host
 * that doesn't provide them. Playwright is a single loopback HTTP service;
 * every local agent session receives the same endpoint while the MCP server
 * keeps each client's browser context isolated.
 */

import type { McpServer } from "@agentclientprotocol/sdk";
import { readProjectMcpServers } from "@seam/adapters";
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

  if (process.env.AA_API_KEY?.trim()) {
    const url = process.env.AA_MCP_URL?.trim() || "http://127.0.0.1:8767/mcp";
    servers.push({ name: "artificial-analysis", type: "http", url, headers: [] });
    logger.info(
      { url },
      "MCP enabled: shared artificial-analysis (LLM benchmarks + pricing)"
    );
  }

  return { servers };
}

/**
 * Bridge a project's `.mcp.json` (Claude Code's per-project MCP config) into
 * ACP `McpServer[]`, scoped to the session's `cwd`.
 *
 * WHY: only claude-agent-acp auto-reads a project's `.mcp.json` from cwd. codex,
 * grok, agy, copilot each load MCP from their own config and never saw it, so a
 * project-scoped server (e.g. `google-multi`) worked for claude agents but
 * vanished on any other backend. Merging these into the per-session mcpServers
 * list (which every adapter already wires natively) gives all agents the same
 * project servers claude gets — and reading from `cwd` keeps them project-scoped
 * (a server in one repo's `.mcp.json` never leaks to another).
 *
 * `reservedNames` (seam-mcp, playwright, …) are skipped so a project can't
 * shadow a globally-injected server. Best-effort: a missing/invalid `.mcp.json`
 * yields no servers rather than throwing.
 * `${NAME}` and `${NAME:-fallback}` in transport values are resolved once
 * from Seam's process environment, before adapters receive static ACP values.
 */
export function buildProjectMcpServers(
  cwd: string,
  logger: Logger,
  reservedNames: ReadonlySet<string>
): McpServer[] {
  return readProjectMcpServers({
    cwd,
    logger,
    reservedNames,
    environment: process.env,
  });
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === "true" || v === "1";
}
