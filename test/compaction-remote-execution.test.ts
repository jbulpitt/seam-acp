import { testSessionRouter } from "./helpers/session-fixture.js";
/**
 * #480: compaction analysis and seed must run on the thread's bridge.
 * A synthetic local provider that completes successfully is not evidence —
 * the assertion is which spawn ran. Same shape as #466.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { classifyAgyError, readErrorClassification, readProcessIdentity, terminateProcessGroup,
  type AgentProfile, type CatalogModel } from "@seam/adapters";
import { makeAgyAcpProfile } from "../packages/adapters/src/profiles/agy-acp.js";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const REMOTE = "remote-synthetic";
const MODEL = "synthetic-exact-model";
const silent = pino({ level: "silent" }) as any;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

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
  const router = testSessionRouter({ permissionOptions: () => ({}), ensureSessionRecord: () => ({ ...record }), getProfile: () => profile, listProfiles: () => [profile],
    resolveProfileForChannel: () => profile, assertAgentAllowedForChannel() {}, assertAgentAllowedForRecord() {},
    reuseMcpServers: vi.fn(() => []), isBusy: () => false,
    describeConfig: () => ({ agent: { value: profile.id }, model: { value: MODEL }, effort: { value: "high" },
      cwd: { value: cwd }, location: { value: location }, fastMode: { value: false } }) });
  const mux = { spawn: remoteSpawn, rpc: vi.fn(async () => ({ projectMcpInjection: true })), releaseStdin: vi.fn() };
  const hub = { markSessionBridge: vi.fn(), get: vi.fn(() => ({ mux })),
    isBridgeReady: vi.fn(() => true), onBridgeReady: vi.fn(() => () => {}),
    mcpServersForBridgeSpawn: vi.fn(() => remoteSeam),
    rpc: vi.fn(async () => ({})) };
  const make = (catalog = fixtureModelCatalog([profile])) => {
    const orch = new Orchestrator({ logger: silent, store, router: router as any, adapter: {} as any,
      renderer: discordRenderer, modelCatalog: catalog,
      config: { DATA_DIR: cwd, REPOS_ROOT: cwd, TURN_TIMEOUT_SECONDS: 15,
        REPO_EMOJIS: new Map(), channelPresets: new Map(), threadPresets: new Map(),
        bridgePresets: new Map([[REMOTE, {}]]) } as any });
    orch.setBridgeHub(hub as any);
    return orch;
  };
  return { cwd, store, calls, localSpawn, remoteSpawn, localDelete, profile, record, manager, router, mux, hub, make, remoteSeam, location };
}


function nativeSeedSetup(location: string, newSessionError?: { code: number; message: string; data: Record<string, unknown> }) {
  const h = setup(location);
  const requests = path.join(h.cwd, "native-seed-requests.jsonl");
  const promptStates = path.join(h.cwd, "native-seed-state.jsonl");
  const execution = makeAgyAcpProfile({
    defaultModel: "fixture-flash", cliPath: process.execPath,
    acpArgs: [fileURLToPath(new URL("./fixtures/agy-acp-server.mjs", import.meta.url))], cwd: h.cwd,
    environment: { ...process.env, AGY_ACP_TEST_REQUESTS: requests, AGY_ACP_TEST_PROMPT_STATE: promptStates,
      ...(newSessionError ? { AGY_ACP_TEST_NEW_ERROR: JSON.stringify(newSessionError) } : {}) },
  });
  // Cache-owned metadata is independent of the profile's empty effort levels.
  const flash: CatalogModel = {
    id: "fixture-flash", runtimeId: "fixture-flash", displayName: "Fixture Flash", aliases: [], default: false,
    context: { native: null, maximum: null, effective: null },
    modalities: { input: ["text"], output: ["text"] }, visionMode: "none", availability: "available",
    lifecycle: "stable", serviceTiers: [], pricingCategory: null, compatibility: null, applicationMode: "live",
    effort: { mechanism: "configOption", configId: "thought_level", selectionDefault: "medium",
      choices: [{ id: "low", raw: "low" }, { id: "medium", raw: "medium" }, { id: "high", raw: "high" }] },
    bindings: [
      { model: "fixture-flash", effort: "low", rawModel: "fixture-flash", rawEffort: "low" },
      { model: "fixture-flash", effort: "medium", rawModel: "fixture-flash", rawEffort: "medium" },
      { model: "fixture-flash", effort: "high", rawModel: "fixture-flash", rawEffort: "high" },
    ],
  };
  // A different catalog default must not replace the existing profile default.
  const fixed: CatalogModel = { ...flash, id: "fixture-fixed", runtimeId: "fixture-fixed", displayName: "Fixture Fixed",
    default: true, effort: { mechanism: "none", choices: [{ id: "default" }], selectionDefault: "default" },
    bindings: [{ model: "fixture-fixed", effort: "default", rawModel: "fixture-fixed" }] };
  const rows = (binding: { agentId: string; location: string }) =>
    binding.agentId === "agy-acp" && binding.location === location ? [flash, fixed] : [];
  const catalog = Object.assign(fixtureModelCatalog([execution]), {
    models: rows,
    model: (binding: { agentId: string; location: string }, id: string) =>
      rows(binding).find(row => id === "default" ? row.default : row.id === id) ?? null,
  });
  const actors: Array<{ child: ReturnType<typeof execution.spawn>;
    identity: ReturnType<typeof readProcessIdentity>; closed: Promise<void> }> = [];
  h.remoteSpawn.mockImplementation(() => {
    const child = execution.spawn();
    const identity = child.pid === undefined ? undefined : readProcessIdentity(child.pid, true);
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    actors.push({ child, identity, closed });
    return Object.assign(child, { slot: actors.length - 1 });
  });
  const profile = { ...execution, spawn: h.localSpawn };
  h.store.upsert({ ...h.record, agentId: "agy-acp" });
  const original = h.store.get(h.record.id);
  const records = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const close = async () => {
    for (const actor of actors) {
      actor.child.stdin.end();
      const reaped = actor.identity ? await terminateProcessGroup(actor.identity) : false;
      await actor.closed;
      expect(actor.identity).toBeDefined();
      expect(reaped).toBe(true);
      expect(readProcessIdentity(actor.identity!.pid, true)?.started).not.toBe(actor.identity!.started);
    }
  };
  return { ...h, profile, original, records, requests, promptStates, close, orch: h.make(catalog) as any };
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

  it("waits for offline analysis before falling back, without using the local provider", async () => {
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
    h.hub.isBridgeReady.mockReturnValue(false);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const building = orch.buildDefaultCompactionSeed({
      profile: h.profile,
      manager: h.manager,
      agentId: h.profile.id,
      location: h.location,
      cwd: h.cwd,
      sessionId: "live-session-untouched",
      restrictionChannelId: "parent",
    });
    await vi.waitFor(() => expect(h.hub.onBridgeReady).toHaveBeenCalledOnce());
    expect(h.remoteSpawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const built = await building;
    expect(built.seed).toContain("hello");
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.remoteSpawn).not.toHaveBeenCalled();
  });

  it("keeps a local-bound compaction on the local bridge", async () => {
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
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.remoteSpawn).toHaveBeenCalled();
    expect(h.hub.rpc).toHaveBeenCalled();
  });

  it.each([
    { name: "explicit model on remote host", location: REMOTE, model: "fixture-flash" },
    { name: "inherited profile default on local host", location: "local", model: undefined },
  ])("applies native thought_level high before the $name seed", async ({ location, model }) => {
    const h = nativeSeedSetup(location);
    try {
      const seeded = await h.orch.seedNewSession({
        profile: h.profile, restrictionChannelId: "parent", cwd: h.cwd, location,
        sessionId: h.record.id, ...(model === undefined ? {} : { model }),
        effort: "high", summary: "retain the fixture context", leadIn: null,
      });
      expect(seeded).toBe("fixture-1");
      const calls = h.records(h.requests);
      const setters = calls.filter(row => row.method === "session/set_config_option");
      expect(setters.map(row => row.params)).toEqual([
        { sessionId: "fixture-1", configId: "thought_level", value: "high" },
      ]);
      expect(calls.findIndex(row => row.method === "session/set_config_option"))
        .toBeLessThan(calls.findIndex(row => row.method === "session/prompt"));
      expect(calls.filter(row => row.method === "session/prompt")).toHaveLength(1);
      expect(h.records(h.promptStates)).toEqual([
        { sessionId: "fixture-1", model: "fixture-flash", effort: "high" },
      ]);
      expect(h.localSpawn).not.toHaveBeenCalled();
      expect(h.remoteSpawn).toHaveBeenCalledOnce();
      expect(h.hub.get).toHaveBeenCalledWith(location);
      expect(h.hub.markSessionBridge).toHaveBeenCalledWith(h.record.id, location);
      const spawn = (h.mux.rpc.mock.calls as any[][]).find(row => row[0] === "spawn")!;
      expect(spawn[1]).toMatchObject({ agentId: "agy-acp", cwd: h.cwd, effort: "high", mcpServers: [h.remoteSeam] });
      expect(spawn[1].model).toBe(model);
      expect(spawn[2]).toEqual({ agentId: "agy-acp" });
      expect(spawn[1].mcpServers).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "controllerOnly" }),
      ]));
      expect(h.localDelete).not.toHaveBeenCalled();
      expect(h.store.get(h.record.id)).toEqual(h.original);
      expect(h.profile.sessionManager).toBeUndefined();
    } finally { await h.close(); }
  }, 15_000);

  it("preserves the native reseed session error and original binding", async () => {
    const native = { code: -32603, message: "Fixture upstream unavailable", data: { status: 503, fixture: "seed-cause" } };
    const h = nativeSeedSetup(REMOTE, native);
    try {
      const error = await h.orch.seedNewSession({
        profile: h.profile, restrictionChannelId: "parent", cwd: h.cwd, location: REMOTE,
        sessionId: h.record.id, model: "fixture-flash", effort: "high", summary: "unused seed",
      }).then(() => null, (cause: unknown) => cause);
      expect(error).toMatchObject(native);
      expect(readErrorClassification(error)).toMatchObject({ agentId: "agy-acp", errorKind: "overloaded" });
      expect(h.records(h.requests).some(row => row.method === "session/prompt")).toBe(false);
      expect(h.localSpawn).not.toHaveBeenCalled();
      expect(h.store.get(h.record.id)).toEqual(h.original);
    } finally { await h.close(); }
  }, 15_000);
});
