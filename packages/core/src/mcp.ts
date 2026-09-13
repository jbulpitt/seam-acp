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
  } catch {
    // JSON.parse errors can quote credential-bearing config text. Refuse this
    // malformed file without logging its contents; global MCP remains usable.
    logger.warn({ file }, "project .mcp.json: parse failed; ignoring");
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
    const missingVariables = new Set<string>();
    // Codex treats ACP HTTP headers as static strings: forwarding ${TOKEN}
    // literally caused Sentry authentication failures. Resolve only the original
    // config string, never recursively interpret credential bytes (or run shell).
    const expand = (value: string): string => value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?\}/g,
      (reference, variable: string, fallback: string | undefined) => {
        const resolved = process.env[variable] ?? fallback;
        if (resolved !== undefined) return resolved;
        missingVariables.add(variable);
        return reference;
      },
    );
    let server: McpServer;
    if (url) {
      server = { name, type: "http", url: expand(url), headers: pairs(def.headers, expand) };
    } else if (command) {
      server = {
        name,
        command: expand(command),
        args: Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string").map(expand) : [],
        env: pairs(def.env, expand),
      };
    } else {
      logger.warn({ name, file }, "project .mcp.json: entry has neither url nor command; skipping");
      continue;
    }
    // An unset reference otherwise becomes a literal invalid credential/command.
    // Refuse only this server, keeping the agent and other MCP servers usable.
    // Log variable names, never resolved values or credential-bearing URLs.
    if (missingVariables.size > 0) {
      logger.warn({ name, file, missingVariables: [...missingVariables].sort() },
        "project .mcp.json: unresolved environment variables; skipping this server");
      continue;
    }
    out.push(server);
  }
  if (out.length > 0) {
    logger.info({ cwd, servers: out.map((s) => s.name) }, "bridged project .mcp.json servers");
  }
  return out;
}

/** Convert a `.mcp.json` `{ key: value }` map (headers/env) to ACP `{ name, value }[]`. */
function pairs(v: unknown, expand: (value: string) => string): Array<{ name: string; value: string }> {
  if (!v || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => typeof val === "string")
    .map(([name, val]) => ({ name, value: expand(val as string) }));
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return v.toLowerCase() === "true" || v === "1";
}
