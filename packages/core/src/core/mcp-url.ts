/**
 * Reachable seam-MCP URL for a spawn destination (#84).
 *
 * Local agents keep `http://127.0.0.1:<port>/mcp`. Remote (bridge) agents
 * must not be handed 127.0.0.1 when that only works on the control-plane
 * host. Prefer an explicit public base; otherwise a non-loopback address
 * on the health port (where `/mcp` is proxied).
 */
import os from "node:os";

export function firstNonLoopbackIPv4(): string | undefined {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

export function resolveReachableMcpUrl(opts: {
  port: number;
  healthPort?: number;
  publicBaseUrl?: string | null;
  remote: boolean;
}): string {
  if (!opts.remote) {
    return `http://127.0.0.1:${opts.port}/mcp`;
  }
  const base = (opts.publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (base) {
    if (base.startsWith("wss://")) {
      return `https://${base.slice("wss://".length)}/mcp`;
    }
    if (base.startsWith("ws://")) {
      return `http://${base.slice("ws://".length)}/mcp`;
    }
    return `${base}/mcp`;
  }
  const host = firstNonLoopbackIPv4() ?? os.hostname();
  const listenPort = opts.healthPort ?? opts.port;
  return `http://${host}:${listenPort}/mcp`;
}

export function publicBaseFromTunnelUrl(tunnelUrl: string | null | undefined): string | undefined {
  const u = (tunnelUrl ?? "").trim();
  if (!u) return undefined;
  if (u.startsWith("wss://")) return `https://${u.slice("wss://".length)}`.replace(/\/+$/, "");
  if (u.startsWith("ws://")) return `http://${u.slice("ws://".length)}`.replace(/\/+$/, "");
  if (u.startsWith("https://") || u.startsWith("http://")) return u.replace(/\/+$/, "");
  return undefined;
}
