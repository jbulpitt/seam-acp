import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { spawnRemoteSlot } from "../packages/core/src/core/remote-spawn.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const logger = pino({ level: "silent" });
const profile = { id: "claude", defaultModel: "default", effort: { mechanism: "none", levels: [] } } as unknown as AgentProfile;
function record(platform = "discord", channelRef = "thread-a", parentRef: string | null = "parent-a"): SessionRecord {
  return { id: `${platform}:${channelRef}`, platform, channelRef, parentRef, agentId: "claude",
    acpSessionId: "", repoPath: os.tmpdir(), configJson: "{}", createdUtc: "", updatedUtc: "" };
}
function harness(row = record()) {
  const calls: any[] = [];
  const mux = {
    spawn: () => Object.assign(new EventEmitter(), { slot: calls.length + 1,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} }),
    rpc: async (_method: string, params: unknown) => { calls.push(params); return { projectMcpInjection: true }; },
    releaseStdin() {},
  };
  const store = { readConfig: (r: SessionRecord) => JSON.parse(r.configJson), get: (id: string) => id === row.id ? row : null,
    lookupAgentChannelRestriction: () => ({ state: "absent" }), needsAgyIdentityRebuild: () => false };
  const modelCatalog = fixtureModelCatalog([profile]);
  const router = new SessionRouter({ logger, store, profiles: [profile], modelCatalog,
    defaultAgentId: "claude", defaultModel: "default", executionBridge: { isBridgeSession: () => true, muxForSession: () => mux },
    threadPresets: new Map([[row.channelRef, { location: "gh-server" }]]) } as any);
  const hub = { get: () => ({ mux }), markSessionBridge: vi.fn(), mcpServersForBridgeSpawn: () => undefined };
  const orchestrator = Object.assign(Object.create(Orchestrator.prototype), { store, router, modelCatalog, bridgeHub: hub, logger,
    config: { threadPresets: new Map() }, adapter: {} });
  return { calls, mux, router, orchestrator };
}

describe("thread identity travels with the controller spawn", () => {
  it.each(["", "saved-acp"])("uses the routing id on new/load acquisition (ACP=%s)", async acpSessionId => {
    const row = { ...record(), acpSessionId };
    const h = harness(row);
    const plan = h.router.planRuntimeSpawn(row);
    await plan.spawnChild(plan.model, plan.effort);
    expect(h.calls[0].threadIdentity).toEqual({ threadId: row.channelRef, channelId: row.parentRef,
      agentId: "claude@gh-server" });
    expect(h.calls[0].env).toBeUndefined();
  });

  it("uses the exact Chat thread ref, and its Space as channel", async () => {
    const row = record("google-chat", "AAA.BBB", "AAA");
    const h = harness(row);
    const plan = h.router.planRuntimeSpawn(row);
    await plan.spawnChild(plan.model, plan.effort);
    expect(h.calls[0].threadIdentity).toEqual({ threadId: "AAA.BBB", channelId: "AAA", agentId: "claude@gh-server" });
  });

  it("uses the thread itself as channel when there is no parent", async () => {
    const row = record("discord", "thread-a", null);
    const h = harness(row);
    const plan = h.router.planRuntimeSpawn(row);
    await plan.spawnChild(plan.model, plan.effort);
    expect(h.calls[0].threadIdentity).toEqual({ threadId: "thread-a", channelId: "thread-a",
      agentId: "claude@gh-server" });
  });

  it.each(["scheduled", "specialist"])("isolated %s uses its binding thread, not its dispatch id", async kind => {
    const row = record();
    const h = harness(row);
    const opts = h.orchestrator.remoteDispatchSpawnOpts({ record: row,
      spec: { id: `${kind}-dispatch`, target: row.channelRef }, effectiveSession: "isolated",
      workerLocation: "gh-server", profile, cwd: os.tmpdir(), model: "default" });
    await opts.spawnFn("default");
    expect(h.calls[0].threadIdentity).toEqual({ threadId: row.channelRef, channelId: row.parentRef,
      agentId: "claude@gh-server" });
  });

  it("isolated seed/analysis launch uses the saved binding thread", async () => {
    const row = record();
    const h = harness(row);
    const plan = h.orchestrator.launchForLocation({ profile, location: "gh-server", cwd: os.tmpdir(), sessionId: row.id });
    await plan.spawnFn("default");
    expect(h.calls[0].threadIdentity).toEqual({ threadId: row.channelRef, channelId: row.parentRef,
      agentId: "claude@gh-server" });
  });

  it("a collected analysis run retains its binding without posting to the thread", async () => {
    const row = record();
    const h = harness(row);
    h.orchestrator.injectTurn = vi.fn(async () => ({ text: "summary" }));
    const thread = { platform: row.platform, id: row.channelRef, parentId: row.parentRef };
    const run = h.orchestrator.makeCompactionRunAgent(profile, {}, { bindingThread: thread });
    expect(await run("summarize", "analysis")).toBe("summary");
    expect(h.orchestrator.injectTurn).toHaveBeenCalledWith(null, "summarize", expect.objectContaining({ bindingThread: thread }));
    const plan = h.orchestrator.launchForLocation({ profile, location: "gh-server", cwd: os.tmpdir(),
      sessionId: "isolated:claude", thread });
    await plan.spawnFn("default");
    expect(h.calls[0].threadIdentity).toEqual({ threadId: row.channelRef, channelId: row.parentRef,
      agentId: "claude@gh-server" });
  });

  it("RPC carries identity into the configured slot without transporting controller env", async () => {
    const h = harness();
    const identity = { threadId: "thread-b", channelId: "parent-a", agentId: "codex@gh-server" };
    await spawnRemoteSlot(h.mux as any, { agentId: "codex", cwd: os.tmpdir(), mcpServers: [], threadIdentity: identity } as any);
    const configureSlot = vi.fn();
    await dispatchBridgeRpc("spawn", h.calls[0], "codex", { adapters: new Map(), cwd: os.tmpdir(), workspaceRoot: os.tmpdir(), configureSlot });
    expect(configureSlot.mock.calls[0][1].threadIdentity).toEqual(identity);
    expect(configureSlot.mock.calls[0][1].env).toBeUndefined();
  });
});
