/**
 * Global MCP server configuration applied to every ACP session.
 *
 * Servers are gated by env vars so the bot still runs cleanly on a host
 * that doesn't provide them. Playwright is a single loopback HTTP service;
 * every local agent session receives the same endpoint while the MCP server
 * keeps each client's browser context isolated.
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
 */
export function buildProjectMcpServers(
  cwd: string,
  logger: Logger,
  reservedNames: ReadonlySet<string>
): McpServer[] {
  let raw: string;
  const file = path.join(cwd, ".mcp.json");
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // no project .mcp.json — nothing to bridge
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err, file }, "project .mcp.json: parse failed; ignoring");
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object") return [];

  const out: McpServer[] = [];
  for (const [name, defRaw] of Object.entries(servers as Record<string, unknown>)) {
    if (!defRaw || typeof defRaw !== "object") continue;
    if (reservedNames.has(name)) {
      logger.warn({ name, file }, "project .mcp.json: name collides with a reserved MCP server; skipping");
      continue;
    }
    const def = defRaw as Record<string, unknown>;
    const url = typeof def.url === "string" ? def.url : undefined;
    const command = typeof def.command === "string" ? def.command : undefined;
    if (url) {
      out.push({ name, type: "http", url, headers: pairs(def.headers) });
    } else if (command) {
      out.push({
        name,
        command,
        args: Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : [],
        env: pairs(def.env),
      });
    } else {
      logger.warn({ name, file }, "project .mcp.json: entry has neither url nor command; skipping");
    }
  }
  if (out.length > 0) {
    logger.info({ cwd, servers: out.map((s) => s.name) }, "bridged project .mcp.json servers");
  }
  return out;
}

/** Convert a `.mcp.json` `{ key: value }` map (headers/env) to ACP `{ name, value }[]`. */
function pairs(v: unknown): Array<{ name: string; value: string }> {
  if (!v || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => typeof val === "string")
    .map(([name, val]) => ({ name, value: val as string }));
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === "true" || v === "1";
}
