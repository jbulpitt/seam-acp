/**
 * Control-plane side of the remote-bridge: WS accept/dial, pairing auth,
 * hello_ack + prepare() reconciliation, per-bridge mux, reachable MCP URL
 * for remote spawn (#84).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { makeMux, PROTOCOL_VERSION, type HelloFrame } from "@seam/adapters";
import type { WorkspaceInfo } from "@seam/adapters";
import { buildSeamMcpServerEntry } from "./mcp/seam-mcp-server.js";
import {
  publicBaseFromBridgeWsUrl,
  resolvePublicBridgeWsUrl,
  resolveReachableMcpUrl,
} from "./mcp-url.js";
import { tokenMatchesHash } from "./bridge-pairing.js";
import type { BridgeHostConfig, Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { ConfigMutationService, MutationActor } from "./config-mutation.js";
import type { SeamTokenRegistry } from "./mcp/token-registry.js";
import { isLocalLocation, normalizeLocation } from "./location.js";
import type { LoopbackHost } from "./loopback-host.js";
import fs from "node:fs";
import path from "node:path";

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const RELEASE_CHECKSUM = /^[0-9a-f]{64}$/;
const RELEASE_AGENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RELEASE_INSTANCE = /^[A-Za-z0-9._-]{8,128}$/;

export async function verifyStagedReleaseCatalogRpcs(
  hello: HelloFrame,
  agents: ReadonlyMap<string, { installed: boolean }>,
  rpc: (method: string, params: unknown, options: { agentId: string }) => Promise<unknown>,
): Promise<string | null> {
  const release = hello.release;
  const startedAt = Date.parse(release?.startedAt ?? "");
  const deadlineAt = Date.parse(release?.deadlineAt ?? "");
  const now = Date.now();
  if (
    !release ||
    release.formatVersion !== 2 ||
    release.bridgeId !== hello.bridgeId ||
    !RELEASE_INSTANCE.test(hello.instanceId) ||
    !RELEASE_CHECKSUM.test(release.activationId) ||
    !RELEASE_CHECKSUM.test(release.stageId) ||
    !RELEASE_SHA.test(release.sourceSha) ||
    !RELEASE_CHECKSUM.test(release.artifactChecksum) ||
    !RELEASE_AGENT.test(release.verificationAgent) ||
    !Number.isSafeInteger(release.oldPid) ||
    !Number.isSafeInteger(release.pid) ||
    release.oldPid < 2 ||
    release.pid < 2 ||
    release.oldPid === release.pid ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(deadlineAt) ||
    startedAt > now ||
    now > deadlineAt ||
    deadlineAt - startedAt > 900_000 ||
    !agents.get(release.verificationAgent)?.installed
  ) return null;
  await rpc("describeModelCatalog", {}, { agentId: release.verificationAgent });
  await rpc("fetchModelCatalog", {}, { agentId: release.verificationAgent });
  return release.verificationAgent;
}

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
  /** One mux per bridgeId. Reused across WS reconnects so in-flight fake
   *  processes (AgentRuntime stdin/stdout) stay on the live socket. A new
   *  makeMux() per connection left the old turn writing to a dead mux while
   *  hello landed on a different one — VPS stopped sending, cancel no-op. */
  private readonly muxes = new Map<string, ReturnType<typeof makeMux>>();
  /** In-memory session → bridge mapping. Persistence is the thread-preset `location`. */
  private readonly sessionBridge = new Map<string, string>();
  private readonly readyEvents = new EventEmitter();
  private loopback?: LoopbackHost;

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

  setLoopback(loopback: LoopbackHost): void {
    this.loopback = loopback;
  }

  listConnected(): ConnectedBridge[] {
    return [...this.connections.values()];
  }

  connectedIds(): Set<string> {
    return new Set(this.connections.keys());
  }

  /** Installed agent ids per connected bridge (hello inventory). */
  installedAgentsByHost(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const c of this.connections.values()) {
      const ids = new Set<string>();
      for (const [id, info] of c.agents) {
        if (info.installed) ids.add(id);
      }
      out.set(c.bridgeId, ids);
    }
    return out;
  }

  /**
   * True when a remote bridge has finished hello + prepare(), or when
   * `location` is the local loopback (always ready).
   */
  isBridgeReady(bridgeId: string): boolean {
    const id = normalizeLocation(bridgeId);
    if (isLocalLocation(id)) return true;
    const conn = this.connections.get(id);
    if (!conn) return false;
    const installed = [...conn.agents.values()].filter((a) => a.installed);
    if (installed.length === 0) return true;
    return installed.every((a) => a.ready);
  }

  /** Subscribe to post-reconcile "bridge ready". Returns an unsubscribe. */
  onBridgeReady(listener: (bridgeId: string) => void): () => void {
    this.readyEvents.on("ready", listener);
    return () => {
      this.readyEvents.off("ready", listener);
    };
  }

  /** Subscribe to WS drop after a successful hello. Returns an unsubscribe. */
  onBridgeDisconnect(listener: (bridgeId: string) => void): () => void {
    this.readyEvents.on("disconnect", listener);
    return () => {
      this.readyEvents.off("disconnect", listener);
    };
  }

  get(bridgeId: string): ConnectedBridge | undefined {
    return this.connections.get(bridgeId);
  }

  /** Mux for this bridge, including the gap after WS drop before hello. */
  muxFor(bridgeId: string): ReturnType<typeof makeMux> | undefined {
    return this.muxes.get(normalizeLocation(bridgeId));
  }

  pairedBridges(): BridgeHostConfig[] {
    return [...this.config.bridgePresets.values()];
  }

  publicWsUrl(): string {
    return resolvePublicBridgeWsUrl({
      configured: this.config.SEAM_BRIDGE_PUBLIC_URL,
      tunnelUrl: readTunnelUrl(this.dataDir),
      healthPort: this.healthPort,
    });
  }

  mcpUrlForRemote(): string | undefined {
    const port = this.getMcpPort?.();
    if (port === undefined) return undefined;
    return resolveReachableMcpUrl({
      port,
      healthPort: this.healthPort,
      publicBaseUrl: publicBaseFromBridgeWsUrl(this.publicWsUrl()),
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
    const token = registry.peek(sessionId) ?? registry.mint(sessionId);
    const url = this.mcpUrlForRemote();
    return buildSeamMcpServerEntry(port, token, url ? { url } : { url: resolveReachableMcpUrl({ port, healthPort: this.healthPort, remote: true }) });
  }

  async rpc(
    bridgeId: string,
    method: string,
    params: unknown,
    agentId?: string
  ): Promise<unknown> {
    const id = normalizeLocation(bridgeId);
    if (isLocalLocation(id)) {
      if (!this.loopback) throw new Error('loopback host is not configured');
      return this.loopback.rpc(method, params, { agentId });
    }
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`bridge "${id}" is not connected`);
    return conn.mux.rpc(method, params, { agentId });
  }

  async listWorkspaces(location: string, agentId?: string): Promise<WorkspaceInfo[]> {
    const result = await this.rpc(location, "listWorkspaces", {}, agentId);
    return Array.isArray(result) ? (result as WorkspaceInfo[]) : [];
  }

  /** Bind a session to a bridge. `local` unbinds (loopback MCP as today). */
  markSessionBridge(sessionId: string, bridgeId: string): void {
    if (isLocalLocation(bridgeId)) {
      this.sessionBridge.delete(sessionId);
      return;
    }
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

    const mux = this.ensureMux(paired.id);
    mux.attach(ws);
    this.logger.info({ bridgeId: paired.id }, "bridge websocket accepted");
  }

  private ensureMux(bridgeId: string): ReturnType<typeof makeMux> {
    const existing = this.muxes.get(bridgeId);
    if (existing) return existing;
    const mux = makeMux({
      id: bridgeId,
      onHello: (hello) => {
        void this.onHello(bridgeId, mux, hello);
      },
      onDisconnect: () => {
        const cur = this.connections.get(bridgeId);
        if (cur?.mux === mux) {
          this.connections.delete(bridgeId);
          this.logger.info({ bridgeId }, "bridge disconnected; agents unavailable");
          this.readyEvents.emit("disconnect", bridgeId);
        }
      },
    });
    this.muxes.set(bridgeId, mux);
    return mux;
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
    if (hello.release) {
      try {
        // Call the remote adapter methods directly. The normal catalog refresh
        // may share provider work with another binding, which would not prove
        // that this newly deployed bridge can dispatch both RPCs itself.
        const verifiedAgent = await verifyStagedReleaseCatalogRpcs(hello, agents, mux.rpc);
        if (verifiedAgent) {
          mux.sendFrame({
            v: PROTOCOL_VERSION,
            type: "event",
            name: "release_verified",
            payload: {
              activationId: hello.release.activationId,
              bridgeId: expectedId,
              instanceId: hello.instanceId,
              pid: hello.release.pid,
              sourceSha: hello.release.sourceSha,
              artifactChecksum: hello.release.artifactChecksum,
              verificationAgent: verifiedAgent,
            },
          });
        }
      } catch (err) {
        this.logger.warn(
          { err, bridgeId: expectedId, agentId: hello.release.verificationAgent, sourceSha: hello.release.sourceSha },
          "staged bridge catalog RPC verification failed"
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
    this.readyEvents.emit("ready", expectedId);
  }
}
