/**
 * Control-plane side of the remote-bridge: WS accept/dial, pairing auth,
 * hello_ack + prepare() reconciliation, per-bridge mux, reachable MCP URL
 * for remote spawn (#84).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  makeMux,
  PROTOCOL_VERSION,
  type AdapterRuntimeDescriptor,
  type HelloFrame,
  type WorkspaceInfo,
} from "@seam/adapters";
import { CATALOG_FETCH_TIMEOUT_MS } from "@seam/adapters";
import type { SlotHealthFact } from "./warm-set/manager.js";
import { buildSeamMcpServerEntry } from "./mcp/seam-mcp-server.js";
import {
  publicBaseFromBridgeWsUrl,
  resolvePublicBridgeWsUrl,
  resolveReachableMcpUrl,
} from "./mcp-url.js";
import { tokenMatchesHash } from "./bridge-pairing.js";
import type { BridgeHostConfig, Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import {
  safeNativeAgyRuntimeProvenance,
  type ConfigMutationService,
  type MutationActor,
} from "./config-mutation.js";
import type { SeamTokenRegistry } from "./mcp/token-registry.js";
import { isLocalLocation, normalizeLocation } from "./location.js";
import fs from "node:fs";
import path from "node:path";

const RELEASE_SHA = /^[0-9a-f]{40}$/;

/**
 * The sha hello actually carried. Missing, empty, or not 40 lowercase hex
 * is unknown. Do not keep a previous sha in that case: that process did
 * not say what it is running.
 */
export function releaseShaFromHello(value: unknown): string | null {
  return typeof value === "string" && RELEASE_SHA.test(value) ? value : null;
}
const RELEASE_CHECKSUM = /^[0-9a-f]{64}$/;
const RELEASE_AGENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RELEASE_INSTANCE = /^[A-Za-z0-9._-]{8,128}$/;

export async function verifyStagedReleaseCatalogRpcs(
  hello: HelloFrame,
  agents: ReadonlyMap<string, { installed: boolean }>,
  rpc: (method: string, params: unknown, options: { agentId: string; timeoutMs?: number }) => Promise<unknown>,
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
  await rpc("fetchModelCatalog", {}, { agentId: release.verificationAgent, timeoutMs: CATALOG_FETCH_TIMEOUT_MS });
  return release.verificationAgent;
}

export interface ConnectedBridge {
  bridgeId: string;
  instanceId: string;
  host: {
    os: string;
    arch: string;
    workspaceRoot?: string;
    home?: string;
  };
  devMode: boolean;
  /** Null when hello did not carry a valid release sha. That is unknown. */
  releaseSha: string | null;
  agents: Map<string, {
    version: number;
    installed: boolean;
    ready: boolean;
    runtime?: AdapterRuntimeDescriptor;
  }>;
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
  /** Persistent controller-host credential for the separate local bridge. */
  localBridgeTokenHash: string;
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
  bridges: Map<string, BridgeHostConfig>,
  local?: BridgeHostConfig,
): BridgeHostConfig | undefined {
  if (local && tokenMatchesHash(token, local.tokenHash)) return local;
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

/** Select a remote host path without interpreting it on the controller OS. */
function resolveBridgeDefaultCwd(opts: {
  reportedWorkspaceRoot?: string;
  configuredWorkspaceRoot?: string;
  reportedHome?: string;
}): string | undefined {
  return nonEmptyHostPath(opts.reportedWorkspaceRoot)
    ?? nonEmptyHostPath(opts.configuredWorkspaceRoot)
    ?? nonEmptyHostPath(opts.reportedHome);
}

export class BridgeHub {
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly mutation: ConfigMutationService;
  private readonly healthPort: number;
  private readonly dataDir: string;
  private readonly localBridge: BridgeHostConfig;
  private readonly getMcpPort?: () => number | undefined;
  private readonly getMcpRegistry?: () => SeamTokenRegistry | undefined;
  private wss?: WebSocketServer;
  private readonly connections = new Map<string, ConnectedBridge>();
  /** One mux per bridgeId. Reused across WS reconnects so in-flight fake
   *  processes (AgentRuntime stdin/stdout) stay on the live socket. A new
   *  makeMux() per connection left the old turn writing to a dead mux while
   *  hello landed on a different one — VPS stopped sending, cancel no-op. */
  private readonly muxes = new Map<string, ReturnType<typeof makeMux>>();
  /** Last per-slot health the bridge reported (#442). Facts only. */
  private readonly slotHealth = new Map<string, readonly SlotHealthFact[]>();
  /** In-memory session → bridge mapping. Persistence is the thread-preset `location`. */
  private readonly sessionBridge = new Map<string, string>();
  private readonly readyEvents = new EventEmitter();

  constructor(opts: BridgeHubOpts) {
    this.logger = opts.logger.child({ comp: "bridge-hub" });
    this.config = opts.config;
    this.mutation = opts.mutation;
    this.healthPort = opts.healthPort;
    this.dataDir = opts.dataDir;
    this.localBridge = {
      id: "local",
      tokenHash: opts.localBridgeTokenHash,
      shortName: "local",
      workspaceRoot: opts.config.REPOS_ROOT,
    };
    this.getMcpPort = opts.getMcpPort;
    this.getMcpRegistry = opts.getMcpRegistry;
    this.wss = new WebSocketServer({ server: opts.httpServer, path: "/bridge" });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.logger.info({ path: "/bridge" }, "bridge websocket listening");
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
   * True only after this host's bridge has finished hello + prepare(). Local
   * is deliberately not special: if its separate process is down, local work
   * is unavailable while every other connected host keeps working (#575).
   */
  isBridgeReady(bridgeId: string): boolean {
    const id = normalizeLocation(bridgeId);
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

  /** Last slot-health snapshot from this bridge; empty if none yet / disconnected. */
  slotHealthFor(location: string): readonly SlotHealthFact[] {
    return this.slotHealth.get(normalizeLocation(location)) ?? [];
  }

  pairedBridges(): BridgeHostConfig[] {
    return [...this.config.bridgePresets.values()];
  }

  /**
   * Host-owned default cwd for an implicit bridged dispatch (#367/#575).
   *
   * The connected bridge's actual `--cwd` wins over the controller's paired
   * copy, because it describes the process that will execute this turn. Older
   * bridges do not advertise it, so retain the paired workspace as a
   * compatibility fallback, then use the connected host's HOME. Returning
   * undefined refuses only an implicit-cwd dispatch; explicit cwd dispatches,
   * local work, and every other bridge remain available.
   */
  defaultCwdForLocation(bridgeId: string): string | undefined {
    const id = normalizeLocation(bridgeId);
    const connected = this.connections.get(id)?.host;
    const paired = isLocalLocation(id) ? this.localBridge : this.config.bridgePresets.get(id);
    return resolveBridgeDefaultCwd({
      reportedWorkspaceRoot: connected?.workspaceRoot,
      configuredWorkspaceRoot: paired?.workspaceRoot,
      reportedHome: connected?.home,
    });
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
  mcpServersForBridgeSpawn(sessionId: string): ReturnType<typeof buildSeamMcpServerEntry> | undefined {
    const port = this.getMcpPort?.();
    const registry = this.getMcpRegistry?.();
    if (port === undefined || !registry) return undefined;
    const token = registry.peek(sessionId) ?? registry.mint(sessionId);
    const bridgeId = this.sessionBridge.get(sessionId);
    if (!bridgeId) return undefined;
    if (isLocalLocation(bridgeId)) {
      return buildSeamMcpServerEntry(port, token, {
        url: `http://127.0.0.1:${this.healthPort}/mcp`,
      });
    }
    const url = this.mcpUrlForRemote();
    return buildSeamMcpServerEntry(port, token, url ? { url } : { url: resolveReachableMcpUrl({ port, healthPort: this.healthPort, remote: true }) });
  }

  async rpc(
    bridgeId: string,
    method: string,
    params: unknown,
    agentId?: string,
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const id = normalizeLocation(bridgeId);
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`bridge "${id}" is not connected`);
    return conn.mux.rpc(method, params, { agentId, ...options });
  }

  /** Background catalog refresh; see CATALOG_FETCH_TIMEOUT_MS for the bound. */
  async fetchModelCatalog(location: string, agentId: string): Promise<unknown> {
    return this.rpc(location, "fetchModelCatalog", {}, agentId, { timeoutMs: CATALOG_FETCH_TIMEOUT_MS });
  }

  async listWorkspaces(location: string, agentId?: string): Promise<WorkspaceInfo[]> {
    const result = await this.rpc(location, "listWorkspaces", {}, agentId);
    return Array.isArray(result) ? (result as WorkspaceInfo[]) : [];
  }

  /** Bind a session to its execution bridge. Local is a real bridge (#575). */
  markSessionBridge(sessionId: string, bridgeId: string): void {
    this.sessionBridge.set(sessionId, normalizeLocation(bridgeId));
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
    const paired = findBridgeByToken(token, this.config.bridgePresets, this.localBridge);
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
          this.slotHealth.delete(bridgeId);
          this.logger.info({ bridgeId }, "bridge disconnected; agents unavailable");
          this.readyEvents.emit("disconnect", bridgeId);
        }
      },
      onLivenessTimeout: ({ observedSilenceMs, unansweredProbeMs }) => {
        // #436: the far side sees terminate() as an abnormal network close.
        // Record the server-owned evidence before that ambiguity is created.
        // This refuses only the one half-open bridge socket; other bridges and
        // local agents remain available, and this bridge may reconnect.
        this.logger.warn(
          { bridgeId, observedSilenceMs, unansweredProbeMs },
          "bridge liveness terminated socket after unanswered probe"
        );
      },
      onSlotHealth: (health) => {
        this.slotHealth.set(bridgeId, health);
      },
      onOutputGap: (slot, gap) => {
        this.logger.error({ bridgeId, slot, ...gap },
          "bridge output was lost before this controller read it; the slot's stream has a gap");
      },
      onRemoteRecovery: (slot, recovery) => {
        const health = [...(this.slotHealth.get(bridgeId) ?? [])];
        const index = health.findIndex((entry) => entry.slot === slot);
        if (index >= 0) health[index] = { ...health[index]!, recovery };
        else health.push({ slot, alive: true, pid: null,
          lastStdoutMsAgo: null, lastStdinMsAgo: null, recovery });
        this.slotHealth.set(bridgeId, health);
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
    for (const a of hello.agents ?? []) {
      if (a.agentId === "agy" && a.runtime?.topology === "virtual-acp-native-cli") {
        try {
          safeNativeAgyRuntimeProvenance(a.runtime);
        } catch {
          mux.helloAck(false, "native AGY runtime inventory contains private or invalid launch data");
          return;
        }
      }
    }
    mux.helloAck(true);

    const agents = new Map<string, {
      version: number;
      installed: boolean;
      ready: boolean;
      runtime?: AdapterRuntimeDescriptor;
    }>();
    for (const a of hello.agents ?? []) {
      agents.set(a.agentId, {
        version: a.version,
        installed: a.installed,
        ready: false,
        ...(a.runtime ? { runtime: a.runtime } : {}),
      });
      if (a.agentId === "agy" && a.runtime?.topology === "virtual-acp-native-cli") {
        this.mutation.recordRuntimeProvenance({
          agentId: a.agentId,
          location: expectedId,
          runtime: a.runtime,
        });
      }
    }

    const releaseSha = releaseShaFromHello(hello.releaseSha);
    const conn: ConnectedBridge = {
      bridgeId: expectedId,
      instanceId: hello.instanceId,
      host: hello.host ?? { os: "unknown", arch: "unknown" },
      devMode: hello.devMode === true,
      releaseSha,
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
        releaseSha: releaseSha ?? "unknown",
      },
      "bridge reconciled"
    );
    this.readyEvents.emit("ready", expectedId);
  }
}

function nonEmptyHostPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
