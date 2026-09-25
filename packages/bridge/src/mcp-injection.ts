import type { McpServer } from "@agentclientprotocol/sdk";

/**
 * Enrich ACP session/new and session/load on the bridge, where project MCP
 * commands and credentials were read. The resolved config never travels back
 * to the controller. If rewriting cannot recognize one frame, that frame is
 * passed through unchanged so one project MCP problem cannot disable the
 * agent or bridge.
 */
export class BridgeMcpInputRewriter {
  private pending = "";

  constructor(
    private readonly hostServers: readonly McpServer[],
    /** Session cwd the controller asked for, and the one this host uses. */
    private readonly cwdSwap?: { from: string; to: string },
  ) {}

  push(chunk: string): string {
    this.pending += chunk;
    let output = "";
    for (;;) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) return output;
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      output += `${rewriteLine(line, this.hostServers, this.cwdSwap)}\n`;
    }
  }
}

function rewriteLine(line: string, hostServers: readonly McpServer[], cwdSwap?: { from: string; to: string }): string {
  if (hostServers.length === 0 && !cwdSwap) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return line;
  const record = message as Record<string, unknown>;
  if (record.method !== "session/new" && record.method !== "session/load") return line;
  if (!record.params || typeof record.params !== "object" || Array.isArray(record.params)) return line;
  const params = record.params as Record<string, unknown>;
  if (cwdSwap && params.cwd === cwdSwap.from) params.cwd = cwdSwap.to;
  const existing = Array.isArray(params.mcpServers)
    ? params.mcpServers.filter((server): server is McpServer =>
        !!server && typeof server === "object" && typeof (server as { name?: unknown }).name === "string")
    : [];
  const names = new Set(existing.map((server) => server.name));
  params.mcpServers = [
    ...existing,
    ...hostServers.filter((server) => !names.has(server.name)),
  ];
  return JSON.stringify(record);
}
