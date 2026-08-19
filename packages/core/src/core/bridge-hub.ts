/**
 * Control-plane side of the remote-bridge: WS accept/dial, pairing auth,
 * hello_ack + prepare() reconciliation, per-bridge mux, reachable MCP URL
 * for remote spawn (#84).
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { makeMux, PROTOCOL_VERSION, type HelloFrame } from "@seam/adapters";
import { buildSeamMcpServerEntry } from "./mcp/seam-mcp-server.js";
import { publicBaseFromTunnelUrl, resolveReachableMcpUrl } from "./mcp-url.js";
import { tokenMatchesHash } from "./bridge-pairing.js";
import type { BridgeHostConfig, Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { ConfigMutationService, MutationActor } from "./config-mutation.js";
import type { SeamTokenRegistry } from "./mcp/token-registry.js";
import fs from "node:fs";
import path from "node:path";

export interface ConnectedBridge {
  bridgeId: string;
  instanceId: string;
  host: { os: string; arch: string };
  devMode: boolean;
  agents: Map<string, { version: number; installed: boolean; ready: boolean }>;
  mux: ReturnType<typeof makeMux>;
  connectedAt: number;
}

export interface BridgeHubOpts {
  logger: Logger;
  config: Config;
  httpServer: HttpServer;
  mutation: ConfigMutationService;
  getMcpPort?: () => number | undefined;
  getMcpRegistry?: () => SeamTokenRegistry | undefined;
  healthPort: number;
  dataDir: string;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || undefined;
  }
  return undefined;
}

function findBridgeByToken(
  token: string,
  bridges: Map<string, BridgeHostConfig>
): BridgeHostConfig | undefined {
  for (const b of bridges.values()) {
    if (tokenMatchesHash(token, b.tokenHash)) return b;
  }
  return undefined;
}

function readTunnelUrl(dataDir: string): string | null {
  try {
    return fs.readFileSync(path.join(dataDir, "tunnel-url.txt"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export class BridgeHub {
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly mutation: ConfigMutationService;
  private readonly healthPort: number;
  private readonly dataDir: string;
  private readonly getMcpPort?: () => number | undefined;
  private readonly getMcpRegistry?: () => SeamTokenRegistry | undefined;
  private wss?: WebSocketServer;
  private readonly connections = new Map<string, ConnectedBridge>();
  /** In-memory session → bridge mapping (PR4 persists this). */
  private readonly sessionBridge = new Map<string, string>();

  constructor(opts: BridgeHubOpts) {
    this.logger = opts.logger.child({ comp: "bridge-hub" });
    this.config = opts.config;
    this.mutation = opts.mutation;
    this.healthPort = opts.healthPort;
    this.dataDir = opts.dataDir;
    this.getMcpPort = opts.getMcpPort;
    this.getMcpRegistry = opts.getMcpRegistry;
    this.wss = new WebSocketServer({ server: opts.httpServer, path: "/bridge" });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.logger.info({ path: "/bridge" }, "bridge websocket listening");
  }

  listConnected(): ConnectedBridge[] {
    return [...this.connections.values()];
  }

  get(bridgeId: string): ConnectedBridge | undefined {
    return this.connections.get(bridgeId);
  }

  pairedBridges(): BridgeHostConfig[] {
    return [...this.config.bridgePresets.values()];
  }

  publicWsUrl(): string {
    const tunnel = readTunnelUrl(this.dataDir);
    if (tunnel) {
      const base = tunnel.replace(/\/+$/, "");
      return base.endsWith("/bridge") ? base : `${base}/bridge`;
    }
    return `ws://127.0.0.1:${this.healthPort}/bridge`;
  }

  mcpUrlForRemote(): string | undefined {
    const port = this.getMcpPort?.();
    if (port === undefined) return undefined;
    return resolveReachableMcpUrl({
      port,
      healthPort: this.healthPort,
      publicBaseUrl: publicBaseFromTunnelUrl(readTunnelUrl(this.dataDir)),
      remote: true,
    });
  }

  /**
   * MCP servers entry for a session spawned on a bridge. Reuses the
   * X-Seam-Session header; URL is reachable from the bridge host (#84).
   */
  mcpServersForRemoteSpawn(sessionId: string): ReturnType<typeof buildSeamMcpServerEntry> | undefined {
    const port = this.getMcpPort?.();
    const registry = this.getMcpRegistry?.();
    if (port === undefined || !registry) return undefined;
    const token = registry.mint(sessionId);
    const url = this.mcpUrlForRemote();
    return buildSeamMcpServerEntry(port, token, url ? { url } : { url: resolveReachableMcpUrl({ port, healthPort: this.healthPort, remote: true }) });
  }

  async rpc(
    bridgeId: string,
    method: string,
    params: unknown,
    agentId?: string
  ): Promise<unknown> {
    const conn = this.connections.get(bridgeId);
    if (!conn) throw new Error(`bridge "${bridgeId}" is not connected`);
    return conn.mux.rpc(method, params, { agentId });
  }

  markSessionBridge(sessionId: string, bridgeId: string): void {
    this.sessionBridge.set(sessionId, bridgeId);
  }

  sessionBridgeId(sessionId: string): string | undefined {
    return this.sessionBridge.get(sessionId);
  }

  async readAttachmentForSession(
    sessionId: string,
    cwd: string,
    requested: string
  ): Promise<{ bytes: Buffer; filename: string; size: number } | null> {
    const bridgeId = this.sessionBridge.get(sessionId);
    if (!bridgeId) return null;
    const conn = this.connections.get(bridgeId);
    if (!conn) return null;
    const agentId = [...conn.agents.keys()][0];
    const result = (await conn.mux.rpc("readAttachment", { cwd, path: requested }, { agentId })) as {
      bytesBase64?: string;
      filename?: string;
      size?: number;
    };
    if (!result?.bytesBase64) return null;
    const buf = Buffer.from(result.bytesBase64, "base64");
    return { bytes: buf, filename: result.filename ?? "file", size: result.size ?? buf.byteLength };
  }

  close(): void {
    this.wss?.close();
    this.wss = undefined;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const token = bearerToken(req);
    if (!token) {
      this.logger.warn("bridge connection refused: missing Authorization");
      ws.close(4001, "unauthorized");
      return;
    }
    const paired = findBridgeByToken(token, this.config.bridgePresets);
    if (!paired) {
      this.logger.warn("bridge connection refused: token does not match any paired bridge");
      ws.close(4001, "unauthorized");
      return;
    }

    const mux = makeMux({
      id: paired.id,
      onHello: (hello) => {
        void this.onHello(paired.id, mux, hello);
      },
      onDisconnect: () => {
        const cur = this.connections.get(paired.id);
        if (cur?.mux === mux) {
          this.connections.delete(paired.id);
          this.logger.info({ bridgeId: paired.id }, "bridge disconnected; agents unavailable");
        }
      },
    });
    mux.attach(ws);
    this.logger.info({ bridgeId: paired.id }, "bridge websocket accepted");
  }

  private async onHello(
    expectedId: string,
    mux: ReturnType<typeof makeMux>,
    hello: HelloFrame
  ): Promise<void> {
    if (hello.bridgeId && hello.bridgeId !== expectedId) {
      mux.helloAck(false, `bridgeId mismatch (paired ${expectedId})`);
      return;
    }
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      mux.helloAck(
        false,
        `protocolVersion ${hello.protocolVersion} unsupported (want ${PROTOCOL_VERSION})`
      );
      return;
    }
    mux.helloAck(true);

    const agents = new Map<string, { version: number; installed: boolean; ready: boolean }>();
    for (const a of hello.agents ?? []) {
      agents.set(a.agentId, {
        version: a.version,
        installed: a.installed,
        ready: false,
      });
    }

    const conn: ConnectedBridge = {
      bridgeId: expectedId,
      instanceId: hello.instanceId,
      host: hello.host ?? { os: "unknown", arch: "unknown" },
      devMode: hello.devMode === true,
      agents,
      mux,
      connectedAt: Date.now(),
    };
    this.connections.set(expectedId, conn);

    if (conn.devMode) {
      this.mutation.recordBridgeAudit({
        bridgeId: expectedId,
        action: "dev-mode-enable",
        actor: { id: "bridge", name: expectedId } satisfies MutationActor,
        extra: { instanceId: hello.instanceId },
      });
    }

    for (const [agentId, state] of agents) {
      if (!state.installed) continue;
      try {
        await mux.rpc("prepare", {}, { agentId });
        state.ready = true;
      } catch (err) {
        this.logger.warn(
          { err, bridgeId: expectedId, agentId },
          "prepare() failed; agent not marked ready"
        );
      }
    }
    this.logger.info(
      {
        bridgeId: expectedId,
        agents: [...agents.entries()].map(([id, s]) => ({ id, ...s })),
        devMode: conn.devMode,
      },
      "bridge reconciled"
    );
  }
}
