/**
 * #480: compaction analysis and seed must run on the thread's bridge.
 * A synthetic local provider that completes successfully is not evidence —
 * the assertion is which spawn ran. Same shape as #466.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { classifyAgyError, type AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const REMOTE = "remote-synthetic";
const MODEL = "synthetic-exact-model";
const silent = pino({ level: "silent" }) as any;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

function setup(location = REMOTE) {
  const cwd = mkdtempSync(path.join(tmpdir(), "seam-480-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  // Present on the controller. A local spawn would be able to read it; the
  // remote spawn must not be handed this server.
  writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
    controllerOnly: { command: "controller-only-sentinel", env: { PRIVATE: "controller-only" } },
  } }));
  const store = new SessionStore(path.join(cwd, "test.db"));
  cleanups.push(() => store.close());
  const calls = { prompts: [] as any[], children: [] as any[] };
  function spawn() {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, slot: calls.children.length,
      pid: undefined, detached: false, killed: false, exitCode: null, signalCode: null,
      kill() { if (!this.killed) { this.killed = true; this.emit("exit", null, "SIGTERM"); } return true; } });
    calls.children.push(child);
    const configOptions = [{ id: "model", name: "Model", type: "select" as const, currentValue: MODEL,
      options: [{ value: MODEL, name: MODEL }] }];
    agent({ name: "synthetic-480" })
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "compaction-acp", configOptions }))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        calls.prompts.push(params);
        await client.notify(methods.client.session.update, { sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "synthetic result" } } });
        return { stopReason: "end_turn" };
      })
      .onNotification(methods.agent.session.cancel, () => {})
      .connect(ndJsonStream(Writable.toWeb(stdout) as WritableStream<Uint8Array>, Readable.toWeb(stdin) as ReadableStream<Uint8Array>));
    return child as any;
  }
  const localSpawn = vi.fn(spawn), remoteSpawn = vi.fn(spawn), localDelete = vi.fn(async () => {});
  const profile = { id: "agy", displayName: "Synthetic", defaultModel: MODEL,
    classifyError: classifyAgyError,
    effort: { mechanism: "spawnArgs", levels: ["high"] }, spawn: localSpawn,
    sessionManager: { deleteSession: localDelete, getTranscript: async () => "" } } as unknown as AgentProfile;
  const now = new Date().toISOString();
  const record = { id: "discord:author", platform: "discord", channelRef: "author", parentRef: "parent",
    agentId: profile.id, acpSessionId: "live-session-untouched", repoPath: cwd, configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const manager = {
    getTranscript: async () => "### User\nhello\n\n### Assistant\nworld\n",
    deleteSession: localDelete,
  };
  const remoteSeam = { type: "http", name: "seam-mcp", url: "https://seam.example/mcp", headers: [{ name: "X-Seam-Session", value: "author-token" }] };
  const router = { ensureSessionRecord: () => ({ ...record }), getProfile: () => profile, listProfiles: () => [profile],
    resolveProfileForChannel: () => profile, assertAgentAllowedForChannel() {}, assertAgentAllowedForRecord() {},
    reuseMcpServers: vi.fn(() => []), isBusy: () => false,
    describeConfig: () => ({ agent: { value: profile.id }, model: { value: MODEL }, effort: { value: "high" },
      cwd: { value: cwd }, location: { value: location }, fastMode: { value: false } }) };
  const mux = { spawn: remoteSpawn, rpc: vi.fn(async () => ({ projectMcpInjection: true })), releaseStdin: vi.fn() };
  const hub = { markSessionBridge: vi.fn(), get: vi.fn(() => ({ mux })),
    mcpServersForRemoteSpawn: vi.fn(() => remoteSeam),
    rpc: vi.fn(async () => ({})) };
  const make = () => {
    const orch = new Orchestrator({ logger: silent, store, router: router as any, adapter: {} as any,
      renderer: discordRenderer, modelCatalog: fixtureModelCatalog([profile]),
      config: { DATA_DIR: cwd, REPOS_ROOT: cwd, TURN_TIMEOUT_SECONDS: 15,
        REPO_EMOJIS: new Map(), channelPresets: new Map(), threadPresets: new Map() } as any });
    orch.setBridgeHub(hub as any);
    return orch;
  };
  return { cwd, store, calls, localSpawn, remoteSpawn, localDelete, profile, record, manager, router, mux, hub, make, remoteSeam, location };
}

describe("#480 compaction execution boundary", () => {
  it("runs analysis and the write-back seed on the remote bridge even though local spawn would succeed", async () => {
    const h = setup();
    const orch = h.make() as any;
    const built = await orch.buildDefaultCompactionSeed({
      profile: h.profile,
      manager: h.manager,
      agentId: h.profile.id,
      location: h.location,
      cwd: h.cwd,
      sessionId: "live-session-untouched",
      restrictionChannelId: "parent",
    });
    const seeded = await orch.seedNewSession({
      profile: h.profile,
      restrictionChannelId: "parent",
      cwd: h.cwd,
      location: h.location,
      sessionId: h.record.id,
      model: MODEL,
      effort: "high",
      summary: built.seed,
    });
    expect(seeded).toBe("compaction-acp");
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.remoteSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.mux.rpc).toHaveBeenCalledWith("spawn", expect.objectContaining({
      agentId: "agy", cwd: h.cwd, model: MODEL, mcpServers: [h.remoteSeam],
    }), { agentId: "agy" });
    const forwarded = h.mux.rpc.mock.calls.map((call: any[]) => call[1]?.mcpServers).flat();
    expect(forwarded).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "controllerOnly" })]));
    expect(h.localDelete).not.toHaveBeenCalled();
    expect(h.hub.rpc).toHaveBeenCalledWith(REMOTE, "deleteSession", expect.objectContaining({ cwd: h.cwd }), "agy");
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("live-session-untouched");
  });

  it("fails a remote compaction honestly when the bridge is down, without using the local provider", async () => {
    const h = setup();
    h.hub.get.mockReturnValue(undefined as any);
    const orch = h.make() as any;
    await expect(orch.seedNewSession({
      profile: h.profile,
      restrictionChannelId: "parent",
      cwd: h.cwd,
      location: h.location,
      sessionId: h.record.id,
      summary: "summary produced elsewhere",
    })).rejects.toThrow(`bridge "${REMOTE}" is not connected`);
    const built = await orch.buildDefaultCompactionSeed({
      profile: h.profile,
      manager: h.manager,
      agentId: h.profile.id,
      location: h.location,
      cwd: h.cwd,
      sessionId: "live-session-untouched",
      restrictionChannelId: "parent",
    });
    expect(built.seed).toContain("hello");
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.remoteSpawn).not.toHaveBeenCalled();
  });

  it("keeps a local-bound compaction on the local provider", async () => {
    const h = setup("local");
    const orch = h.make() as any;
    await orch.buildDefaultCompactionSeed({
      profile: h.profile,
      manager: h.manager,
      agentId: h.profile.id,
      location: "local",
      cwd: h.cwd,
      sessionId: "live-session-untouched",
      restrictionChannelId: "parent",
    });
    await orch.seedNewSession({
      profile: h.profile,
      restrictionChannelId: "parent",
      cwd: h.cwd,
      location: "local",
      sessionId: h.record.id,
      summary: "local seed",
    });
    expect(h.localSpawn).toHaveBeenCalled();
    expect(h.remoteSpawn).not.toHaveBeenCalled();
    expect(h.hub.rpc).not.toHaveBeenCalled();
  });
});
