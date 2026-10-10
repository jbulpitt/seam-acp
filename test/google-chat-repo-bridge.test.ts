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
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const logger = pino({ level: "silent" });
const profiles = [{ id: "copilot", displayName: "Copilot", defaultModel: "native",
  staticModels: [{ modelId: "native", name: "Native" }], effort: { mechanism: "none", levels: [] },
}] as unknown as AgentProfile[];
const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const cleanup: Array<() => void | Promise<void>> = [];
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "gchat-repo-bridge-")); });
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(location: "local" | "remote") {
  const controllerRoot = path.join(dir, "controller");
  const hostRoot = path.join(dir, "host");
  const oldCwd = path.join(hostRoot, "old");
  const nextCwd = path.join(hostRoot, "seam-acp");
  for (const root of [controllerRoot, oldCwd, nextCwd]) fs.mkdirSync(root, { recursive: true });
  const presetsFile = path.join(dir, "presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ threads: {
    [`google-chat:${channel.id}`]: { location, cwd: { value: oldCwd } },
  } }));
  const maps = buildChannelPresetMaps(presetsFile);
  const config = { ...maps, DATA_DIR: dir, REPOS_ROOT: controllerRoot, CHANNEL_PRESETS_FILE: presetsFile,
    DEFAULT_AGENT: "copilot", DEFAULT_MODEL: "native", TURN_TIMEOUT_SECONDS: 60,
    SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false, REPO_EMOJIS: new Map(),
    SEAM_CONFIG_ADMIN_USER_IDS: new Set(), bridgePresets: new Map([[
      "remote", { id: "remote", tokenHash: hashBridgeToken("remote-fixture"), shortName: "remote", workspaceRoot: hostRoot },
    ]]),
  } as Config;
  const store = new SessionStore(path.join(dir, "seam.db"));
  cleanup.push(() => store.close());
  const modelCatalog = fixtureModelCatalog(profiles);
  let hub: BridgeHub | undefined;
  const router = new SessionRouter({ store, logger, profiles, modelCatalog, ...maps,
    defaultAgentId: "copilot", defaultModel: "native", defaultCwd: controllerRoot,
    bindSessionLocation: (id, host) => hub?.markSessionBridge(id, host),
    executionBridge: {
      isBridgeSession: id => Boolean(hub?.sessionBridgeId(id)),
      muxForSession: id => { const host = hub?.sessionBridgeId(id); return host ? hub?.muxFor(host) : undefined; },
    },
  });
  cleanup.push(() => router.disposeAll());
  const record = router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id,
    parentRef: channel.parentId, cwd: controllerRoot });
  const messages: Array<{ text?: string }> = [];
  const request = vi.fn(async (_scope: string, input: any) => {
    messages.push(input.data);
    return { name: "spaces/dm/messages/app", thread: input.data?.thread };
  });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: controllerRoot, logger, writeIntervalMs: 0 });
  const admitted = vi.fn();
  adapter.onMessage(admitted);
  const orch = new Orchestrator({ store, router, config, modelCatalog, logger, adapter, renderer: {} as any });
  await orch.loadPlugins();
  // index.ts installs Chat commands before constructing and attaching BridgeHub.
  adapter.setCommandDeps({ store, router, mutation: orch.getConfigMutation(), modelCatalog,
    configPlan: orch.getConfigApplyPlan(), runtimeTransition: orch.getRuntimeTransition(),
    cancelChannel: ch => orch.cancelChannel(ch) });
  const server = createServer();
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  hub = new BridgeHub({ logger, config, httpServer: server, healthPort: port, dataDir: dir,
    mutation: orch.getConfigMutation(), localBridgeTokenHash: hashBridgeToken("local-fixture") });
  cleanup.push(() => hub!.close());
  orch.setBridgeHub(hub);
  const ready = new Promise<string>(resolve => hub!.onBridgeReady(resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { Authorization: `Bearer ${location}-fixture` },
  });
  cleanup.push(async () => { const closed = once(socket, "close"); socket.terminate(); await closed; });
  const rpcs: Array<{ method: string; params: any }> = [];
  socket.on("message", async raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type !== "rpc") return;
    rpcs.push(frame);
    try {
      const result = frame.method === "prepare" ? {} : await dispatchBridgeRpc(frame.method, frame.params, frame.agentId,
        { adapters: new Map(), workspaceRoot: hostRoot, cwd: hostRoot });
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "rpc_reply", id: frame.id, ok: true, result }));
    } catch (err) {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "rpc_reply", id: frame.id, ok: false,
        error: err instanceof Error ? err.message : String(err) }));
    }
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", bridgeId: location, instanceId: `${location}-instance`,
    protocolVersion: PROTOCOL_VERSION, capabilities: { durableSlots: true },
    host: { os: process.platform, arch: process.arch, workspaceRoot: hostRoot },
    agents: [{ agentId: "copilot", version: 1, installed: true }],
  }));
  expect(await ready).toBe(location);
  expect(hub.isBridgeReady(location)).toBe(true);
  let commandId = 0;
  const run = (args: string) => adapter.receiveEvent({ type: "MESSAGE", space: { name: "spaces/dm" },
    user: { name: "users/42", displayName: "Tester" }, message: {
      name: `spaces/dm/messages/repo-${++commandId}`, text: `/repo ${args}`.trim(), argumentText: args,
      thread: { name: "spaces/dm/threads/thread" }, threadReply: true, slashCommand: { commandId: 5 },
    } });
  return { orch, router, store, record, hub, run, rpcs, messages, admitted, oldCwd, nextCwd, hostRoot };
}

describe("Google Chat repo commands after late bridge attachment", () => {
  it.each(["local", "remote"] as const)("lists %s repos from the connected bridge, just like Discord's picker", async location => {
    const h = await fixture(location);
    const discordRepos = await (h.orch as any).listHostWorkspacePaths(undefined, location);
    expect(discordRepos).toContain(h.nextCwd);
    await h.run("");
    expect(h.messages.at(-1)?.text).toContain(h.nextCwd);
    expect(h.messages.at(-1)?.text).toContain(`host: ${location}`);
    expect(h.rpcs.filter(frame => frame.method === "listWorkspaces")).toHaveLength(2);
    expect(h.hub.sessionBridgeId(h.record.id)).toBe(location);
    expect(h.admitted).not.toHaveBeenCalled();
  });

  it.each(["local", "remote"] as const)("selects %s's repo through real host shell RPC and persists the next turn's cwd", async location => {
    const h = await fixture(location);
    await h.run("seam-acp");
    expect(h.messages.at(-1)?.text).toContain("Repo set to");
    expect(h.messages.at(-1)?.text).toContain(h.nextCwd);
    expect(h.rpcs).toContainEqual(expect.objectContaining({ method: "shell", params: { command: "pwd", cwd: h.nextCwd } }));
    const current = h.store.get(h.record.id)!;
    expect(h.router.describeConfig(current).cwd.value).toBe(h.nextCwd);
    expect(h.router.planRuntimeSpawn(current)).toMatchObject({ cwd: h.nextCwd, location });
    expect(h.store.listConfigMutations()).toHaveLength(1);
    expect(h.admitted).not.toHaveBeenCalled();
  });

  it("preserves the real local host's ENOENT cause without writing the overlay", async () => {
    const h = await fixture("local");
    const missing = path.join(h.hostRoot, "missing");
    await h.run(missing);
    expect(h.messages.at(-1)?.text).toContain("ENOENT");
    expect(h.rpcs).toContainEqual(expect.objectContaining({ method: "shell", params: { command: "pwd", cwd: missing } }));
    expect(h.router.describeConfig(h.store.get(h.record.id)!).cwd.value).toBe(h.oldCwd);
    expect(h.store.listConfigMutations()).toHaveLength(0);
    expect(h.admitted).not.toHaveBeenCalled();
  });
});
