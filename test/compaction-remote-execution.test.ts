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
import { classifyAgyError, readErrorClassification, readProcessIdentity, terminateProcessGroup, renderTranscriptMessages,
  type AgentProfile, type CatalogModel, type TranscriptMessage } from "@seam/adapters";
import { makeAgyAcpProfile } from "../packages/adapters/src/profiles/agy-acp.js";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
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


function nativeSeedSetup(location: string, newSessionError?: { code: number; message: string; data: Record<string, unknown> }, withReplay = false, replayData?: "fidelity") {
  const h = setup(location);
  const requests = path.join(h.cwd, "native-seed-requests.jsonl");
  const promptStates = path.join(h.cwd, "native-seed-state.jsonl");
  const lifecycle = path.join(h.cwd, "native-seed-lifecycle.jsonl");
  const execution = makeAgyAcpProfile({
    defaultModel: "fixture-flash", cliPath: process.execPath,
    acpArgs: [fileURLToPath(new URL("./fixtures/agy-acp-server.mjs", import.meta.url))], cwd: h.cwd,
    environment: { ...process.env, AGY_ACP_TEST_REQUESTS: requests, AGY_ACP_TEST_PROMPT_STATE: promptStates,
      ...(withReplay ? { AGY_ACP_TEST_TRANSCRIPT: "1", AGY_ACP_TEST_LIFECYCLE: lifecycle } : {}),
      ...(replayData ? { AGY_ACP_TEST_REPLAY_DATA: replayData } : {}),
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
  return { ...h, profile, original, records, requests, promptStates, close, orch: h.make(catalog) as any,
    execution, catalog, actors, lifecycle, legacyProfile: h.profile };
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

  it("connects native remote replay to ordinary default-compaction analysis and replacement seed", async () => {
    const h = nativeSeedSetup(REMOTE, undefined, true);
    // Literal message oracle; never derive expected turns with the consumer splitter.
    const turns = [
      "### User\nQuestion 🧪\nline",
      "### Assistant\nAnswer αβ",
      "### Assistant\nSeparate assistant",
      "### User\nNext",
      "### Assistant\nDone",
    ];
    const canonical = turns.join("\n\n");
    const older = turns.slice(0, 3).join("\n\n");
    const recent = turns.slice(3).join("\n\n");
    const template = "Summarize the supplied older conversation.";
    writeFileSync(path.join(h.cwd, "compact.md"), template);
    const legacyRead = vi.fn(async () => "legacy same-SID sentinel");
    const context = { adapters: new Map([
      ["agy", { ...h.legacyProfile, getTranscript: legacyRead }],
      ["agy-acp", h.execution],
    ]), workspaceRoot: h.cwd, cwd: h.cwd };
    const reads: Array<{ request: unknown; value: unknown; requests: any[]; lifecycle: any[] }> = [];
    // Transport stays mocked; host dispatch and adapter getter are the real implementations.
    (h.hub.rpc as any).mockImplementation(async (location: string, method: string, params: unknown, agentId?: string) => {
      const value = await dispatchBridgeRpc(method, params, agentId, context);
      if (method === "getTranscript") reads.push({ request: { location, method, params, agentId }, value,
        requests: h.records(h.requests), lifecycle: h.records(h.lifecycle) });
      return value;
    });
    vi.spyOn(h.router, "describeConfig").mockReturnValue({
      agent: { value: "agy-acp" }, model: { value: "fixture-flash" }, effort: { value: "high" },
      cwd: { value: h.cwd }, location: { value: REMOTE }, fastMode: { value: false },
    });
    const modelRows = vi.spyOn(h.catalog, "models");
    const modelLookups = vi.spyOn(h.catalog, "model");
    const selections = vi.spyOn(h.catalog, "resolve");
    let primary: { error: unknown } | undefined;
    const cleanupOutcomes: Array<{ phase: string; error: unknown }> = [];
    let completedBody = false;
    try {
      const manager = h.orch.sessionManagerFor(h.profile, "agy-acp", REMOTE);
      const built = await h.orch.buildDefaultCompactionSeed({
        profile: h.profile, manager, agentId: "agy-acp", location: REMOTE, cwd: h.cwd,
        sessionId: "live-session-untouched", restrictionChannelId: "parent", recentWindowTokens: 10,
        bindingThread: { platform: "discord", id: "author", parentId: "parent" },
      });
      expect(reads).toHaveLength(1);
      expect(reads[0]!.request).toEqual({ location: REMOTE, method: "getTranscript", agentId: "agy-acp",
        params: { cwd: h.cwd, sessionId: "live-session-untouched", format: "messages" } });
      expect(reads[0]!.value).toStrictEqual([
        { role: "User", messageId: "u1", text: "Question 🧪\nline" },
        { role: "Assistant", messageId: "a1", text: "Answer αβ" },
        { role: "Assistant", messageId: "a2", text: "Separate assistant" },
        { role: "User", messageId: undefined, text: "Next" },
        { role: "Assistant", messageId: undefined, text: "Done" },
      ]);
      expect(renderTranscriptMessages(reads[0]!.value as readonly TranscriptMessage[])).toBe(canonical);
      expect(reads[0]!.requests.map(row => row.method)).toEqual(["initialize", "session/load", "session/close"]);
      expect(reads[0]!.requests[0].params).toEqual({ protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "seam-acp", version: "0.1.0" }, clientCapabilities: {} });
      expect(reads[0]!.requests[1].params).toEqual({ sessionId: "live-session-untouched", cwd: h.cwd, mcpServers: [] });
      expect(reads[0]!.requests[2].params).toEqual({ sessionId: "live-session-untouched" });
      expect(reads[0]!.lifecycle.map(row => row.event)).toEqual(["start", "close", "eof", "exit"]);
      expect(new Set(reads[0]!.lifecycle.map(row => `${row.pid}/${row.start}`)).size).toBe(1);
      expect(legacyRead).not.toHaveBeenCalled();
      expect(built).not.toBeNull();
      expect(built).toMatchObject({ keptTurns: 2, summarizedTurns: 3 });
      // Plain fixture response exercises existing pinned parse fallback, not pinned-fact fidelity.
      expect(built.pinnedCount).toBe(0);
      expect(built.seed).toContain("\n\nfixture response\n\n## Pinned constraints (verbatim)");
      expect(built.seed).toContain("- Summarized 3 older turn(s); kept the last 2 verbatim below.");
      expect(built.seed.endsWith(`--- Recent context (verbatim) ---\n${recent}`)).toBe(true);
      expect(h.store.get(h.record.id)).toEqual(h.original);

      const seeded = await h.orch.seedNewSession({
        profile: h.profile, restrictionChannelId: "parent", cwd: h.cwd, location: REMOTE,
        sessionId: h.record.id, model: "fixture-flash", effort: "high", summary: built.seed,
      });
      expect(seeded).toBe("fixture-1");
      const calls = h.records(h.requests);
      const prompts = calls.filter(row => row.method === "session/prompt");
      expect(prompts).toHaveLength(3);
      const text = prompts.map(row => {
        expect(row.params.prompt).toEqual([expect.objectContaining({ type: "text" })]);
        return row.params.prompt[0].text as string;
      });
      expect(text[0]).toBe(`${template}\n\nConversation Transcript:\n${older}`);
      expect(text[0]).not.toContain(turns[3]);
      expect(text[0]).not.toContain(turns[4]);
      expect(text[1]).toContain(`=== BEGIN TRANSCRIPT DATA ===\n${canonical}`);
      expect(text[1]!.split(canonical)).toHaveLength(2);
      const leadIn = "[Loading prior-session context after compaction — read the summary below, reply with a one-line acknowledgement, then await the next instruction. Do not begin work yet.]";
      expect(text[2]).toContain(`${leadIn}\n\n${built.seed}`);
      expect(text[2]!.split(built.seed)).toHaveLength(2);
      for (const prompt of text) {
        for (const excluded of ["wrong SID", "not transcript", "AA==", "fixture-tool"]) {
          expect(prompt).not.toContain(excluded);
        }
      }
      expect(calls.filter(row => row.method === "session/set_config_option").map(row => row.params)).toEqual([
        { sessionId: "fixture-1", configId: "model", value: "fixture-fixed" },
        { sessionId: "fixture-1", configId: "model", value: "fixture-fixed" },
        { sessionId: "fixture-1", configId: "thought_level", value: "high" },
      ]);
      const highAt = calls.findIndex(row => row.method === "session/set_config_option" && row.params.configId === "thought_level");
      expect(highAt).toBeGreaterThan(calls.indexOf(prompts[1]));
      expect(highAt).toBeLessThan(calls.indexOf(prompts[2]));
      expect(h.records(h.promptStates)).toEqual([
        { sessionId: "fixture-1", model: "fixture-fixed", effort: "medium" },
        { sessionId: "fixture-1", model: "fixture-fixed", effort: "medium" },
        { sessionId: "fixture-1", model: "fixture-flash", effort: "high" },
      ]);
      const spawns = (h.mux.rpc.mock.calls as any[][]).filter(row => row[0] === "spawn");
      expect(spawns).toHaveLength(3);
      expect(spawns.map(row => row[1].model)).toEqual(["fixture-fixed", "fixture-fixed", "fixture-flash"]);
      expect(spawns.map(row => row[1].effort)).toEqual([undefined, undefined, "high"]);
      for (const spawn of spawns) {
        expect(spawn[1]).toMatchObject({ agentId: "agy-acp", cwd: h.cwd, mcpServers: [h.remoteSeam],
          threadIdentity: { threadId: "author", channelId: "parent", agentId: "agy-acp@remote-synthetic" } });
        expect(spawn[2]).toEqual({ agentId: "agy-acp" });
        expect(spawn[1].mcpServers).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "controllerOnly" })]));
      }
      for (const calls of [modelRows.mock.calls, modelLookups.mock.calls, selections.mock.calls]) {
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call[0]).toEqual({ agentId: "agy-acp", location: REMOTE });
      }
      expect(h.localSpawn).not.toHaveBeenCalled();
      expect(h.remoteSpawn).toHaveBeenCalledTimes(3);
      expect((h.hub.get.mock.calls as unknown[][]).every(call => call[0] === REMOTE)).toBe(true);
      expect(h.hub.markSessionBridge).toHaveBeenCalledWith(h.record.id, REMOTE);
      const deletions = (h.hub.rpc.mock.calls as any[][]).filter(row => row[1] === "deleteSession");
      expect(deletions).toHaveLength(2);
      for (const deletion of deletions) expect(deletion).toEqual([
        REMOTE, "deleteSession", { cwd: h.cwd, sessionId: "fixture-1" }, "agy-acp",
      ]);
      expect(h.localDelete).not.toHaveBeenCalled();
      expect(h.store.get(h.record.id)).toEqual(h.original);
      expect(h.profile.sessionManager).toBeUndefined();
      completedBody = true;
    } catch (error) {
      primary = { error };
    }

    try { await h.close(); }
    catch (error) { cleanupOutcomes.push({ phase: "consumer-close", error }); }
    let starts: any[] | undefined;
    try { starts = h.records(h.lifecycle).filter(row => row.event === "start"); }
    catch (error) { cleanupOutcomes.push({ phase: "lifecycle-records", error }); }
    if (starts) {
      if (completedBody) {
        try {
          expect(starts).toHaveLength(4); // One actual getter child plus three consumer runtimes.
          expect(new Set(starts.map(row => `${row.pid}/${row.start}`)).size).toBe(4);
        } catch (error) { cleanupOutcomes.push({ phase: "completed-start-inventory", error }); }
      }
      if (process.platform === "linux") for (const start of starts) {
        try {
          expect(start.start).toEqual(expect.any(String));
          expect(readProcessIdentity(start.pid, true)?.started).not.toBe(`linux:${start.start}`);
        } catch (error) { cleanupOutcomes.push({ phase: "captured-start-retirement", error }); }
      }
    }
    if (primary !== undefined) {
      if (cleanupOutcomes.length) {
        throw Object.assign(new AggregateError(
          [primary.error, ...cleanupOutcomes.map(outcome => outcome.error)],
          "Compaction composition body and cleanup outcomes", { cause: primary.error },
        ), { cleanupOutcomes });
      }
      throw primary.error;
    }
    if (cleanupOutcomes.length) {
      throw Object.assign(new AggregateError(
        cleanupOutcomes.map(outcome => outcome.error), "Compaction composition cleanup outcomes",
      ), { cleanupOutcomes });
    }
  });

  it("preserves source-message boundaries and exact whitespace through native compaction and replacement seed", async () => {
    const h = nativeSeedSetup(REMOTE, undefined, true, "fidelity");
    // Independent literal blocks, including role-looking data and terminal whitespace.
    const older = "### User\nOLDER ONLY: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const user = "### User\nKeep this user text Ω.\n\n### Assistant\nStill USER data.\n\n### User\nStill the SAME user message.  \n\t";
    const assistant = "### Assistant\nReal assistant reply β. \t\n\n";
    const canonical = `${older}\n\n${user}\n\n${assistant}`;
    const recent = `${user}\n\n${assistant}`;
    const template = "Summarize the supplied older conversation.";
    writeFileSync(path.join(h.cwd, "compact.md"), template);
    const legacyRead = vi.fn(async () => "legacy same-SID sentinel");
    const context = { adapters: new Map([
      ["agy", { ...h.legacyProfile, getTranscript: legacyRead }],
      ["agy-acp", h.execution],
    ]), workspaceRoot: h.cwd, cwd: h.cwd };
    const reads: Array<{ request: unknown; value: unknown; requests: any[]; lifecycle: any[] }> = [];
    // Mocked transport; production host dispatcher and native getter remain actual.
    (h.hub.rpc as any).mockImplementation(async (location: string, method: string, params: unknown, agentId?: string) => {
      const value = await dispatchBridgeRpc(method, params, agentId, context);
      if (method === "getTranscript") reads.push({ request: { location, method, params, agentId }, value,
        requests: h.records(h.requests), lifecycle: h.records(h.lifecycle) });
      return value;
    });
    vi.spyOn(h.router, "describeConfig").mockReturnValue({
      agent: { value: "agy-acp" }, model: { value: "fixture-flash" }, effort: { value: "high" },
      cwd: { value: h.cwd }, location: { value: REMOTE }, fastMode: { value: false },
    });
    const modelRows = vi.spyOn(h.catalog, "models");
    const modelLookups = vi.spyOn(h.catalog, "model");
    const selections = vi.spyOn(h.catalog, "resolve");
    let primary: { error: unknown } | undefined;
    const cleanupOutcomes: Array<{ phase: string; error: unknown }> = [];
    let completedBody = false;
    try {
      const manager = h.orch.sessionManagerFor(h.profile, "agy-acp", REMOTE);
      const built = await h.orch.buildDefaultCompactionSeed({
        profile: h.profile, manager, agentId: "agy-acp", location: REMOTE, cwd: h.cwd,
        sessionId: "live-session-untouched", restrictionChannelId: "parent", recentWindowTokens: 64,
        bindingThread: { platform: "discord", id: "author", parentId: "parent" },
      });
      const seeded = await h.orch.seedNewSession({
        profile: h.profile, restrictionChannelId: "parent", cwd: h.cwd, location: REMOTE,
        sessionId: h.record.id, model: "fixture-flash", effort: "high", summary: built.seed,
      });
      const calls = h.records(h.requests);
      const prompts = calls.filter(row => row.method === "session/prompt");
      const text = prompts.map(row => row.params.prompt[0]?.text as string);
      // Retain controlled fixture observations before any desired-fidelity comparison.
      console.info("native-fidelity-composition-observed", JSON.stringify({
        getter: reads[0]?.value, builder: built, seeded, promptText: text,
      }));
      expect(reads[0]?.value).toStrictEqual([
        { role: "User", messageId: "fidelity-old", text: "OLDER ONLY: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        { role: "User", messageId: "fidelity-user", text: "Keep this user text Ω.\n\n### Assistant\nStill USER data.\n\n### User\nStill the SAME user message.  \n\t" },
        { role: "Assistant", messageId: "fidelity-assistant", text: "Real assistant reply β. \t\n\n" },
      ]);
      expect(reads).toHaveLength(1);
      expect(reads[0]!.request).toEqual({ location: REMOTE, method: "getTranscript", agentId: "agy-acp",
        params: { cwd: h.cwd, sessionId: "live-session-untouched", format: "messages" } });
      expect(reads[0]!.requests.map(row => row.method)).toEqual(["initialize", "session/load", "session/close"]);
      expect(reads[0]!.requests[0].params).toEqual({ protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "seam-acp", version: "0.1.0" }, clientCapabilities: {} });
      expect(reads[0]!.requests[1].params).toEqual({ sessionId: "live-session-untouched", cwd: h.cwd, mcpServers: [] });
      expect(reads[0]!.requests[2].params).toEqual({ sessionId: "live-session-untouched" });
      expect(reads[0]!.lifecycle.map(row => row.event)).toEqual(["start", "close", "eof", "exit"]);
      expect(new Set(reads[0]!.lifecycle.map(row => `${row.pid}/${row.start}`)).size).toBe(1);
      expect(legacyRead).not.toHaveBeenCalled();
      expect(seeded).toBe("fixture-1");
      expect(prompts).toHaveLength(3);
      for (const prompt of prompts) {
        expect(prompt.params.prompt).toEqual([expect.objectContaining({ type: "text", text: expect.any(String) })]);
      }
      // The canned response deliberately retains the existing zero-pinned parse fallback.
      expect(built.pinnedCount).toBe(0);
      expect(built.seed).toContain("\n\nfixture response\n\n## Pinned constraints (verbatim)");
      const leadIn = "[Loading prior-session context after compaction — read the summary below, reply with a one-line acknowledgement, then await the next instruction. Do not begin work yet.]";
      expect(text[2]).toContain(`${leadIn}\n\n${built.seed}`);
      expect(text[2]!.split(built.seed)).toHaveLength(2);
      expect(text[2]!.endsWith(built.seed)).toBe(true);
      for (const prompt of text) {
        for (const excluded of ["wrong SID", "not transcript", "AA==", "fixture-tool"]) {
          expect(prompt).not.toContain(excluded);
        }
      }
      expect(calls.filter(row => row.method === "session/set_config_option").map(row => row.params)).toEqual([
        { sessionId: "fixture-1", configId: "model", value: "fixture-fixed" },
        { sessionId: "fixture-1", configId: "model", value: "fixture-fixed" },
        { sessionId: "fixture-1", configId: "thought_level", value: "high" },
      ]);
      const highAt = calls.findIndex(row => row.method === "session/set_config_option" && row.params.configId === "thought_level");
      expect(highAt).toBeGreaterThan(calls.indexOf(prompts[1]));
      expect(highAt).toBeLessThan(calls.indexOf(prompts[2]));
      expect(h.records(h.promptStates)).toEqual([
        { sessionId: "fixture-1", model: "fixture-fixed", effort: "medium" },
        { sessionId: "fixture-1", model: "fixture-fixed", effort: "medium" },
        { sessionId: "fixture-1", model: "fixture-flash", effort: "high" },
      ]);
      const spawns = (h.mux.rpc.mock.calls as any[][]).filter(row => row[0] === "spawn");
      expect(spawns).toHaveLength(3);
      expect(spawns.map(row => row[1].model)).toEqual(["fixture-fixed", "fixture-fixed", "fixture-flash"]);
      expect(spawns.map(row => row[1].effort)).toEqual([undefined, undefined, "high"]);
      for (const spawn of spawns) {
        expect(spawn[1]).toMatchObject({ agentId: "agy-acp", cwd: h.cwd, mcpServers: [h.remoteSeam],
          threadIdentity: { threadId: "author", channelId: "parent", agentId: "agy-acp@remote-synthetic" } });
        expect(spawn[2]).toEqual({ agentId: "agy-acp" });
        expect(spawn[1].mcpServers).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "controllerOnly" })]));
      }
      for (const calls of [modelRows.mock.calls, modelLookups.mock.calls, selections.mock.calls]) {
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call[0]).toEqual({ agentId: "agy-acp", location: REMOTE });
      }
      expect(h.localSpawn).not.toHaveBeenCalled();
      expect(h.remoteSpawn).toHaveBeenCalledTimes(3);
      expect((h.hub.get.mock.calls as unknown[][]).every(call => call[0] === REMOTE)).toBe(true);
      expect(h.hub.markSessionBridge).toHaveBeenCalledWith(h.record.id, REMOTE);
      const deletions = (h.hub.rpc.mock.calls as any[][]).filter(row => row[1] === "deleteSession");
      expect(deletions).toHaveLength(2);
      for (const deletion of deletions) expect(deletion).toEqual([
        REMOTE, "deleteSession", { cwd: h.cwd, sessionId: "fixture-1" }, "agy-acp",
      ]);
      expect(h.localDelete).not.toHaveBeenCalled();
      expect(h.store.get(h.record.id)).toEqual(h.original);
      expect(h.profile.sessionManager).toBeUndefined();
      const pinnedBegin = "=== BEGIN TRANSCRIPT DATA ===\n";
      const pinnedEnd = "\n\n=== END OF TRANSCRIPT ===\n";
      expect(text[1]!.split(pinnedBegin)).toHaveLength(2);
      const pinnedBodyAndCloser = text[1]!.split(pinnedBegin)[1]!;
      expect(pinnedBodyAndCloser.split(pinnedEnd)).toHaveLength(2);
      expect(text[1]!.split(canonical)).toHaveLength(2);
      const recentMarker = "--- Recent context (verbatim) ---\n";
      expect(built.seed.split(recentMarker)).toHaveLength(2);
      expect(text[2]!.split(recentMarker)).toHaveLength(2);
      // Observable contract only: a typed implementation may bypass the old splitter.
      expect({
        getter: renderTranscriptMessages(reads[0]!.value as readonly TranscriptMessage[]),
        partition: { older: built.summarizedTurns, recent: built.keptTurns },
        summaryInput: text[0],
        pinnedInput: pinnedBodyAndCloser.slice(0, pinnedBodyAndCloser.indexOf(pinnedEnd)),
        builtRecent: built.seed.split(recentMarker)[1],
        submittedRecent: text[2]!.split(recentMarker)[1],
      }).toEqual({
        getter: canonical,
        partition: { older: 1, recent: 2 },
        summaryInput: `${template}\n\nConversation Transcript:\n${older}`,
        pinnedInput: canonical,
        builtRecent: recent,
        submittedRecent: recent,
      });
      completedBody = true;
    } catch (error) {
      primary = { error };
    }

    try { await h.close(); }
    catch (error) { cleanupOutcomes.push({ phase: "consumer-close", error }); }
    let starts: any[] | undefined;
    try { starts = h.records(h.lifecycle).filter(row => row.event === "start"); }
    catch (error) { cleanupOutcomes.push({ phase: "lifecycle-records", error }); }
    if (starts) {
      if (completedBody) {
        try {
          expect(starts).toHaveLength(4); // One actual getter child plus three consumer runtimes.
          expect(new Set(starts.map(row => `${row.pid}/${row.start}`)).size).toBe(4);
        } catch (error) { cleanupOutcomes.push({ phase: "completed-start-inventory", error }); }
      }
      if (process.platform === "linux") for (const start of starts) {
        try {
          expect(start.start).toEqual(expect.any(String));
          expect(readProcessIdentity(start.pid, true)?.started).not.toBe(`linux:${start.start}`);
        } catch (error) { cleanupOutcomes.push({ phase: "captured-start-retirement", error }); }
      }
    }
    if (primary !== undefined) {
      if (cleanupOutcomes.length) {
        throw Object.assign(new AggregateError(
          [primary.error, ...cleanupOutcomes.map(outcome => outcome.error)],
          "Compaction composition body and cleanup outcomes", { cause: primary.error },
        ), { cleanupOutcomes });
      }
      throw primary.error;
    }
    if (cleanupOutcomes.length) {
      throw Object.assign(new AggregateError(
        cleanupOutcomes.map(outcome => outcome.error), "Compaction composition cleanup outcomes",
      ), { cleanupOutcomes });
    }
  });
});


describe("typed compaction no-history contract", () => {
  it.each([
    { name: "empty array", messages: [] as readonly TranscriptMessage[], expectedPrompts: 0 },
    { name: "one zero-length message", messages: [{ role: "User", text: "" }] as readonly TranscriptMessage[], expectedPrompts: 2 },
    { name: "one whitespace-only message", messages: [{ role: "User", messageId: "", text: " \t\n" }] as readonly TranscriptMessage[], expectedPrompts: 2 },
  ])("reads $name once without falling back to readable history", async ({ messages, expectedPrompts }) => {
    const h = setup();
    const orch = h.make() as any;
    const readable = vi.fn(async () => { throw new Error("Typed history must not trigger a readable fallback"); });
    const selected = vi.fn(async (_cwd: string, _sid: string) => messages);
    const manager = { ...h.manager, getTranscript: readable, getCompactionTranscript: selected };
    const seed = vi.spyOn(orch, "seedNewSession");
    const original = h.store.get(h.record.id);
    const built = await orch.buildDefaultCompactionSeed({
      profile: h.profile, manager, agentId: h.profile.id, location: h.location, cwd: h.cwd,
      sessionId: "live-session-untouched", restrictionChannelId: "parent",
      bindingThread: { platform: "discord", id: "author", parentId: "parent" },
    });
    const seeded = built === null ? null : await orch.seedNewSession({
      profile: h.profile, restrictionChannelId: "parent", cwd: h.cwd, location: h.location,
      sessionId: h.record.id, model: MODEL, effort: "high", summary: built.seed,
    });
    expect(selected).toHaveBeenCalledExactlyOnceWith(h.cwd, "live-session-untouched");
    expect(readable).not.toHaveBeenCalled();
    expect(h.calls.prompts).toHaveLength(expectedPrompts);
    if (messages.length === 0) {
      expect(built).toBeNull();
      expect(seeded).toBeNull();
      expect(seed).not.toHaveBeenCalled();
      expect(h.remoteSpawn).not.toHaveBeenCalled();
      expect(h.mux.rpc).not.toHaveBeenCalled();
    } else {
      expect(built).toMatchObject({ keptTurns: 1, summarizedTurns: 0 });
      expect(seeded).toBe("compaction-acp");
      expect(seed).toHaveBeenCalledOnce();
      const literal = `### User\n${messages[0]!.text}`;
      const prompts = h.calls.prompts.map(row => row.prompt[0].text as string);
      const begin = "=== BEGIN TRANSCRIPT DATA ===\n", end = "\n\n=== END OF TRANSCRIPT ===\n";
      expect(prompts[0]!.split(begin)[1]!.split(end)[0]).toBe(literal);
      expect(built.seed.endsWith(`--- Recent context (verbatim) ---\n${literal}`)).toBe(true);
      expect(prompts[1]!.endsWith(built.seed)).toBe(true);
      expect(prompts[1]!.split(built.seed)).toHaveLength(2);
      expect(h.remoteSpawn).toHaveBeenCalledTimes(2);
    }
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.store.get(h.record.id)).toEqual(original);
  });
});
