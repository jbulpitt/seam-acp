import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type AgentProfile } from "@seam/adapters";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
import { buildChannelPresetMaps, type Config } from "../packages/core/src/config.js";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { hashBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

// Only the provider is synthetic; MCP, bridge binding, host RPC and writes are real.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    busy = false;
    disposed = false;
    detached = false;
    sessionId = "";
    cwd = "";
    lastActivityAtMs = Date.now();
    modelOverride?: string;
    finishPrompt?: () => void;
    async start() {}
    markActivity() {}
    async loadSession(input: { sessionId: string; cwd: string; model?: string }) {
      this.sessionId = input.sessionId; this.cwd = input.cwd; this.modelOverride = input.model;
    }
    async newSession(input: { cwd: string; model?: string }) {
      this.sessionId = "fresh-context"; this.cwd = input.cwd; this.modelOverride = input.model;
      return { sessionId: this.sessionId };
    }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride }; }
    getConfigSelectValues() { return ["default", "low", "high"]; }
    hasDelegatedTurnInFlight() { return false; }
    async dispose() { this.disposed = true; }
    async detach() { this.detached = true; }
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption() {}
    async prompt() {
      this.busy = true;
      try { await new Promise<void>(resolve => { this.finishPrompt = resolve; }); return this.cwd; }
      finally { this.busy = false; }
    }
  } };
});

const logger = pino({ level: "silent" });
const profiles = ["claude", "codex"].map(id => ({ id, displayName: id, defaultModel: "native",
  staticModels: [{ modelId: "native", name: "Native" }], effort: { mechanism: "meta", levels: ["low", "high"] },
})) as unknown as AgentProfile[];
const channel = { platform: "discord", id: "111111111111111111", parentId: "222222222222222222" };
const stops: Array<() => void | Promise<void>> = [];
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "configure-location-")); });
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(separateHostRoots = false) {
  const root = path.join(dir, "execution");
  const nextCwd = path.join(root, "seam-acp");
  fs.mkdirSync(nextCwd, { recursive: true });
  const remoteRoot = separateHostRoots ? path.join(dir, "remote-execution") : root;
  const remoteCwd = path.join(remoteRoot, "seam-acp");
  fs.mkdirSync(remoteCwd, { recursive: true });
  const presetsFile = path.join(dir, "presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ threads: { [channel.id]: { location: "seam-dev-server" } } }));
  const maps = buildChannelPresetMaps(presetsFile);
  const config = { ...maps, REPOS_ROOT: path.join(dir, "controller"), CHANNEL_PRESETS_FILE: presetsFile,
    bridgePresets: new Map(["seam-dev-server", "gh-server"].map(id => [id, {
      id, tokenHash: hashBridgeToken(`${id}-fixture`), workspaceRoot: id === "gh-server" ? remoteRoot : root,
    }])),
  } as Config;
  const store = new SessionStore(path.join(dir, "seam.db"));
  stops.push(() => store.close());
  const modelCatalog = fixtureModelCatalog(profiles);
  let hub: BridgeHub;
  const router = new SessionRouter({ store, logger, profiles, modelCatalog, ...maps,
    defaultAgentId: "codex", defaultModel: "native", defaultCwd: root,
    // index.ts supplies a catalog adapter even for an unknown/composite id.
    profileCatalog: (agentId, location) => ({
      scope: () => {
        const scope = modelCatalog.lookup({ agentId, location }).snapshot?.candidate.scope;
        if (!scope) throw new Error(`catalog scope for ${agentId}@${location} is not available yet`);
        return scope;
      },
      fetch: async () => await hub.fetchModelCatalog(location, agentId) as any,
    }),
    bindSessionLocation: (id, host) => hub?.markSessionBridge(id, host),
    executionBridge: {
      isBridgeSession: id => Boolean(hub?.sessionBridgeId(id)),
      muxForSession: id => { const host = hub?.sessionBridgeId(id); return host ? hub?.muxFor(host) : undefined; },
    },
  });
  stops.push(() => router.disposeAll());
  const mutation = new ConfigMutationService({ store, logger, modelCatalog, presetsFile,
    describeConfig: row => router.describeConfig(row), isAgentAvailable: id => Boolean(router.getProfile(id)),
    reloadPresets: () => {
      maps.threadPresets.clear();
      for (const [id, value] of buildChannelPresetMaps(presetsFile).threadPresets) maps.threadPresets.set(id, value);
      return { ok: true };
    },
  });
  const { plan, runtime } = createConfigFacades({ store, router, mutation, modelCatalog, config, logger,
    get bridgeHub() { return hub; }, identityCommitted: async () => {}, persistConfig: () => {},
    repoDisplay: repo => repo ?? "", unregisteredAgentMessage: (_id, fallback) => fallback });
  const server = createServer();
  stops.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  hub = new BridgeHub({ config, logger, httpServer: server, healthPort: port, dataDir: dir, mutation,
    localBridgeTokenHash: hashBridgeToken("unused-local-fixture") });
  stops.push(() => hub.close());
  const rpcs: Array<{ host: string; method: string; params: any }> = [];
  for (const host of ["seam-dev-server", "gh-server"]) {
    const workspaceRoot = host === "gh-server" ? remoteRoot : root;
    const ready = new Promise<string>(resolve => hub.onBridgeReady(resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { Authorization: `Bearer ${host}-fixture` },
    });
    stops.push(async () => { const closed = once(socket, "close"); socket.terminate(); await closed; });
    socket.on("message", async raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "cmd" && frame.action === "listSlots") {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "cmd_reply", cmdId: frame.cmdId,
          payload: { slots: [], health: [] } }));
        return;
      }
      if (frame.type !== "rpc") return;
      rpcs.push({ host, method: frame.method, params: frame.params });
      try {
        const result = frame.method === "prepare" ? {} : await dispatchBridgeRpc(frame.method, frame.params, frame.agentId,
          { adapters: new Map(), workspaceRoot, cwd: workspaceRoot });
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "rpc_reply", id: frame.id, ok: true, result }));
      } catch (err) {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "rpc_reply", id: frame.id, ok: false,
          error: err instanceof Error ? err.message : String(err) }));
      }
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", bridgeId: host, instanceId: `${host}-instance`,
      protocolVersion: PROTOCOL_VERSION, capabilities: { durableSlots: true },
      host: { os: process.platform, arch: process.arch, workspaceRoot },
      agents: profiles.map(profile => ({ agentId: profile.id, version: 1, installed: true })),
    }));
    expect(await ready).toBe(host);
  }
  const row = router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id,
    parentRef: channel.parentId, cwd: root });
  store.upsert({ ...row, acpSessionId: "existing-context" }, { source: "fixture", cause: "existing provider session" });
  const record = store.get(row.id)!;
  const caller = router.ensureSessionRecord({ platform: "discord", channelRef: "333333333333333333", parentRef: channel.parentId, cwd: root });
  const outcomes: any[] = [];
  const mcp = new SeamMcpServer({ logger, resolveSession: token => token === "caller-fixture" ? caller : undefined,
    resolveThread: id => id === channel.id ? store.get(record.id) ?? undefined : undefined,
    enqueueDispatch: async () => {}, configureThread: async (from, to, input) => {
      const result = await runtime.configure(from, to, input); outcomes.push(result); return result;
    },
  });
  await mcp.start();
  stops.push(() => mcp.stop());
  const call = async (input: Record<string, unknown>) => {
    const reply = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", "X-Seam-Session": "caller-fixture" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "configure_thread", arguments: { thread: channel.id, ...input } } }),
    });
    expect(reply.status).toBe(200);
    const body = await reply.json();
    expect(body.error).toBeUndefined();
    return body.result as { isError?: boolean; content: Array<{ text: string }> };
  };
  return { call, store, router, plan, hub, record, rpcs, root, nextCwd, remoteRoot, remoteCwd, outcomes, presetsFile };
}

describe("configure_thread agent@location and shared cwd selection", () => {
  it("parses the MCP composite, commits a separate host binding and starts a fresh session there", async () => {
    const h = await fixture();
    const reply = await h.call({ agent: "claude@gh-server", model: "native", effort: "high" });
    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    const row = h.store.get(h.record.id)!;
    expect(row.agentId).toBe("claude");
    expect(h.router.describeConfig(row).location.value).toBe("gh-server");
    expect(h.router.planRuntimeSpawn(row)).toMatchObject({ agentId: "claude", location: "gh-server", effort: "high" });
    expect(h.hub.sessionBridgeId(row.id)).toBe("gh-server");
    expect(row.acpSessionId).toBe("fresh-context");
    expect(h.outcomes.at(-1)).toMatchObject({ sessionReset: true, resetReason: "agent-switch" });
    expect(reply.content[0]?.text).toContain("Host: gh-server");
    expect(h.store.listConfigMutations()).toHaveLength(1);
  });

  it("resets a same-agent host switch but does not reset the repeated selection", async () => {
    const h = await fixture();
    expect((await h.call({ agent: "codex@gh-server" })).isError).toBeFalsy();
    expect(h.outcomes.at(-1)).toMatchObject({ sessionReset: true, resetReason: "location-switch" });
    const current = await h.router.getOrStartRuntime(h.store.get(h.record.id)!);
    const audits = h.store.listConfigMutations().length;
    expect((await h.call({ agent: "codex@gh-server" })).isError).toBeFalsy();
    expect(h.outcomes.at(-1)).toMatchObject({ sessionReset: false, runtimeReloaded: false });
    expect(await h.router.getOrStartRuntime(h.store.get(h.record.id)!)).toBe(current);
    expect(h.store.listConfigMutations()).toHaveLength(audits);
  });

  it("keeps the bound host for a bare agent id", async () => {
    const h = await fixture();
    expect((await h.call({ agent: "claude" })).isError).toBeFalsy();
    expect(h.router.planRuntimeSpawn(h.store.get(h.record.id)!)).toMatchObject({ agentId: "claude", location: "seam-dev-server" });
  });

  it("returns the real disconnected-host error and rolls back without retiring the old context", async () => {
    const h = await fixture();
    const warm = await h.router.getOrStartRuntime(h.record);
    const reply = await h.call({ agent: "claude@missing-host" });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text).toContain('bound to bridge "missing-host" that is not connected');
    const row = h.store.get(h.record.id)!;
    expect(row.agentId).toBe("codex");
    expect(row.acpSessionId).toBe("existing-context");
    expect(h.router.describeConfig(row).location.value).toBe("seam-dev-server");
    expect(h.hub.sessionBridgeId(row.id)).toBe("seam-dev-server");
    expect(await h.router.getOrStartRuntime(row)).toBe(warm);
    expect((warm as any).disposed).toBe(false);
  });

  it("replaces a stale session cwd pin and validates the combined host/cwd selection on the destination", async () => {
    const h = await fixture(true);
    h.store.upsert({ ...h.store.get(h.record.id)!, repoPath: h.nextCwd,
      configJson: JSON.stringify({ sessionCwdExplicit: true }) });
    const reply = await h.call({ agent: "claude@gh-server", cwd: "seam-acp" });
    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect(h.rpcs).toContainEqual({ host: "gh-server", method: "shell", params: { command: "pwd", cwd: h.remoteCwd } });
    expect(h.rpcs.filter(rpc => rpc.method === "shell").every(rpc => rpc.host === "gh-server")).toBe(true);
    const row = h.store.get(h.record.id)!;
    expect(h.router.planRuntimeSpawn(row)).toMatchObject({ location: "gh-server", cwd: h.remoteCwd });
    expect(row.repoPath).toBe(h.remoteCwd);
    expect(h.store.readConfig(row).sessionCwdExplicit).toBe(true);
    expect(h.outcomes.at(-1)).toMatchObject({ changes: { cwd: { before: h.nextCwd, after: h.remoteCwd, changed: true } } });
    expect(h.store.listConfigMutations()).toHaveLength(1);
    expect(reply.content[0]?.text).toContain(`Repo: ${h.remoteCwd}`);
  });

  it("defers a cwd-only reset until the running turn completes", async () => {
    const h = await fixture();
    h.store.upsert({ ...h.store.get(h.record.id)!, repoPath: h.root,
      configJson: JSON.stringify({ sessionCwdExplicit: true }) });
    const warm = await h.router.getOrStartRuntime(h.store.get(h.record.id)!);
    const running = warm.prompt("keep working");
    expect((await h.call({ cwd: h.nextCwd })).isError).toBeFalsy();
    expect(h.outcomes.at(-1)).toMatchObject({ sessionReset: false, resetPending: true });
    expect((warm as any).disposed).toBe(false);
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("existing-context");
    (warm as any).finishPrompt();
    expect(await running).toBe(h.root);
    const next = await h.router.getOrStartRuntime(h.store.get(h.record.id)!);
    expect((warm as any).disposed).toBe(true);
    expect((next as any).cwd).toBe(h.nextCwd);
    expect(next.getSessionInfo()?.sessionId).toBe("fresh-context");
  });

  it("returns cwd's real ENOENT before writing the combined host/agent selection", async () => {
    const h = await fixture();
    const missing = path.join(h.root, "missing");
    const reply = await h.call({ agent: "claude@gh-server", cwd: missing });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text).toContain("ENOENT");
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("existing-context");
    expect(h.store.get(h.record.id)?.agentId).toBe("codex");
    expect(h.router.describeConfig(h.store.get(h.record.id)!).location.value).toBe("seam-dev-server");
    expect(h.store.listConfigMutations()).toHaveLength(0);
  });

  it("does not reset an unchanged cwd", async () => {
    const h = await fixture();
    expect((await h.call({ cwd: h.root })).isError).toBeFalsy();
    expect(h.outcomes.at(-1)).toMatchObject({ sessionReset: false, resetPending: false });
  });

  it("replaces an explicit session cwd pin through MCP and reports the effective change", async () => {
    const h = await fixture();
    h.store.upsert({ ...h.store.get(h.record.id)!, repoPath: h.root, configJson: JSON.stringify({ sessionCwdExplicit: true }) });
    const reply = await h.call({ cwd: h.nextCwd });
    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    const row = h.store.get(h.record.id)!;
    expect(row.repoPath).toBe(h.nextCwd);
    expect(h.store.readConfig(row).sessionCwdExplicit).toBe(true);
    expect(h.router.describeConfig(row).cwd.value).toBe(h.nextCwd);
    expect(h.outcomes.at(-1)).toMatchObject({ sessionReset: true, resetReason: "cwd-switch",
      applied: { cwd: h.nextCwd }, changes: { cwd: { before: h.root, after: h.nextCwd, changed: true } } });
    expect(reply.content[0]?.text).toContain(`Repo: ${h.nextCwd} (changed`);
  });

  it("keeps session cwd precedence when configure_thread does not supply cwd", async () => {
    const h = await fixture();
    expect((await h.call({ cwd: h.nextCwd })).isError).toBeFalsy();
    h.store.upsert({ ...h.store.get(h.record.id)!, repoPath: h.root, configJson: JSON.stringify({ sessionCwdExplicit: true }) });
    expect((await h.call({ effort: "high" })).isError).toBeFalsy();
    const row = h.store.get(h.record.id)!;
    expect(h.router.describeConfig(row).cwd.value).toBe(h.root);
    expect(row.repoPath).toBe(h.root);
    expect(h.store.readConfig(row).sessionCwdExplicit).toBe(true);
  });

  it("clears the explicit session cwd pin when inheritance is requested", async () => {
    const h = await fixture();
    expect((await h.call({ cwd: h.nextCwd })).isError).toBeFalsy();
    h.store.upsert({ ...h.store.get(h.record.id)!, repoPath: h.nextCwd,
      configJson: JSON.stringify({ sessionCwdExplicit: true }) });
    expect((await h.call({ cwd: "__inherit__" })).isError).toBeFalsy();
    const row = h.store.get(h.record.id)!;
    expect(row.repoPath).toBeNull();
    expect(h.store.readConfig(row).sessionCwdExplicit).toBeUndefined();
    expect(h.router.describeConfig(row).cwd.value).toBe(h.root);
    expect(h.outcomes.at(-1)).toMatchObject({ applied: { cwd: h.root }, changes: { cwd: { changed: true } } });
  });
});
