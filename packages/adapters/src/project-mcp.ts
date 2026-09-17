import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";

export interface ProjectMcpLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Read one host's project-scoped MCP configuration.
 *
 * The caller must run this on the machine that owns `cwd`: command paths and
 * project bytes are host-local facts. The supplied environment is deliberately
 * resolved on that same host for bridge sessions, so controller secrets are
 * never exported merely because a remote project names them. A missing or
 * invalid file refuses only the affected project server; the agent and every
 * other MCP server keep working.
 */
export function readProjectMcpServers(opts: {
  cwd: string;
  logger: ProjectMcpLogger;
  reservedNames: ReadonlySet<string>;
  environment?: NodeJS.ProcessEnv;
}): McpServer[] {
  const { cwd, logger, reservedNames } = opts;
  let raw: string;
  const file = path.join(cwd, ".mcp.json");
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseProjectMcpServers(raw, {
    cwd,
    file,
    logger,
    reservedNames,
    environment: opts.environment,
  });
}

function parseProjectMcpServers(raw: string, opts: {
  cwd: string;
  file: string;
  logger: ProjectMcpLogger;
  reservedNames: ReadonlySet<string>;
  environment?: NodeJS.ProcessEnv;
}): McpServer[] {
  const { cwd, file, logger, reservedNames } = opts;
  const environment = opts.environment ?? process.env;
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
      logger.warn(
        { name, file },
        "project .mcp.json: name collides with a reserved MCP server; skipping"
      );
      continue;
    }
    const def = defRaw as Record<string, unknown>;
    const url = typeof def.url === "string" ? def.url : undefined;
    const command = typeof def.command === "string" ? def.command : undefined;
    const missingVariables = new Set<string>();
    // Resolve only the original config string, never recursively interpret
    // credential bytes (or run shell). Object.hasOwn rejects inherited names.
    const expand = (value: string): string => value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?\}/g,
      (reference, variable: string, fallback: string | undefined) => {
        const resolved = (Object.hasOwn(environment, variable)
          ? environment[variable]
          : undefined) ?? fallback;
        if (resolved !== undefined) return resolved;
        missingVariables.add(variable);
        return reference;
      },
    );
    let server: McpServer;
    if (url) {
      server = {
        name,
        type: "http",
        url: expand(url),
        headers: pairs(def.headers, expand),
      };
    } else if (command) {
      server = {
        name,
        command: expand(command),
        args: Array.isArray(def.args)
          ? def.args.filter((a): a is string => typeof a === "string").map(expand)
          : [],
        env: pairs(def.env, expand),
      };
    } else {
      logger.warn(
        { name, file },
        "project .mcp.json: entry has neither url nor command; skipping"
      );
      continue;
    }
    // An unset reference otherwise becomes a literal invalid credential or
    // command. Refuse one server, while the agent and other servers stay live.
    if (missingVariables.size > 0) {
      logger.warn(
        { name, file, missingVariables: [...missingVariables].sort() },
        "project .mcp.json: unresolved environment variables; skipping this server"
      );
      continue;
    }
    out.push(server);
  }
  if (out.length > 0) {
    logger.info(
      { cwd, servers: out.map((server) => server.name) },
      "bridged project .mcp.json servers"
    );
  }
  return out;
}

function pairs(
  value: unknown,
  expand: (value: string) => string
): Array<{ name: string; value: string }> {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === "string")
    .map(([name, entry]) => ({ name, value: expand(entry as string) }));
}
