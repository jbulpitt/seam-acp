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

/**
 * Is this host part a loopback address — one that only resolves on whichever
 * machine reads it? (#264)
 *
 * A remote agent handed one of these points its MCP client at ITS OWN
 * loopback, which is either nothing or, worse, some unrelated local service.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = (host.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1: 127.0.0.53 is a real
  // resolver address and is just as unreachable from another host.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Host part of a base URL, tolerating ws/wss, or "" when unparseable. */
function baseHost(base: string): string {
  const http = base.startsWith("ws") ? base.replace(/^ws/, "http") : base;
  try {
    return new URL(http).hostname;
  } catch {
    return "";
  }
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
  const configured = (opts.publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  // #264: refuse the CONFIGURED base only when it is loopback, and fall
  // through to discovery below. The rule "remote agents must not be handed
  // 127.0.0.1" was already this file's stated contract and was already
  // enforced on the discovery path — but a configured base was used verbatim,
  // so the one input an operator controls was the one nobody checked.
  //
  // What is refused: one unusable URL. What keeps working: everything else —
  // the remote agent still gets its MCP entry from the non-loopback address
  // below, so it keeps its tools rather than being handed an address that
  // answers on the wrong machine (or on nothing at all).
  const base = configured && isLoopbackHost(baseHost(configured)) ? "" : configured;
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

const BRIDGE_PATH = "/bridge";

/** Normalize a configured public URL to `ws(s)://host/bridge`. */
export function normalizePublicBridgeWsUrl(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("https://")) s = `wss://${s.slice("https://".length)}`;
  else if (s.startsWith("http://")) s = `ws://${s.slice("http://".length)}`;
  else if (!s.startsWith("ws://") && !s.startsWith("wss://")) s = `wss://${s}`;
  s = s.replace(/\/+$/, "");
  if (!s.endsWith(BRIDGE_PATH)) s = `${s}${BRIDGE_PATH}`;
  return s;
}

/**
 * Public WS URL handed to `/seamadmin bridge add` bootstrap.
 * Prefer a permanent `SEAM_BRIDGE_PUBLIC_URL`, then the quick-tunnel file,
 * then loopback health (only useful on the same host).
 */
export function resolvePublicBridgeWsUrl(opts: {
  configured?: string | null;
  tunnelUrl?: string | null;
  healthPort: number;
}): string {
  const configured = (opts.configured ?? "").trim();
  if (configured) return normalizePublicBridgeWsUrl(configured);
  const tunnel = (opts.tunnelUrl ?? "").trim();
  if (tunnel) return normalizePublicBridgeWsUrl(tunnel);
  return `ws://127.0.0.1:${opts.healthPort}${BRIDGE_PATH}`;
}

/**
 * Origin a bridge dialed to reach this controller, from its upgrade request
 * (#650). Its agents can reach seam-MCP on the same path: a bridge on the
 * WireGuard link gets `http://10.x:3000`, one through the tunnel gets the
 * public https origin. Undefined when there is no usable host.
 */
export function dialedOriginFromUpgrade(headers: Record<string, string | string[] | undefined>): string | undefined {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  const host = first(headers["x-forwarded-host"]) || first(headers.host);
  if (!host || isLoopbackHost(baseHost(`http://${host}`))) return undefined;
  const proto = first(headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/** Origin used to build `https://host/mcp` from a `/bridge` WS URL. */
export function publicBaseFromBridgeWsUrl(wsUrl: string): string | undefined {
  return publicBaseFromTunnelUrl(wsUrl.replace(/\/bridge\/?$/, ""));
}

/**
 * Origin for minted `POST /ingest` URLs.
 * Prefer `SEAM_INGEST_PUBLIC_URL` (trailing slash stripped). When unset,
 * fall back to the bridge/tunnel origin, then loopback health.
 */
export function resolveIngestPublicBase(opts: {
  ingestPublicUrl?: string | null;
  bridgeWsUrl?: string | null;
  healthPort: number;
}): string {
  const configured = (opts.ingestPublicUrl ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const fromBridge = opts.bridgeWsUrl
    ? publicBaseFromBridgeWsUrl(opts.bridgeWsUrl)
    : undefined;
  return fromBridge ?? `http://127.0.0.1:${opts.healthPort}`;
}
