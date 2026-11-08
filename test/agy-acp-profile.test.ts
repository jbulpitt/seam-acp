import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCatalogCandidate } from "../packages/adapters/src/catalog-evidence.js";
import { asLocalAdapter, readProcessIdentity, terminateProcessGroup, type CatalogEffort, type ISessionManager } from "@seam/adapters";
import { readErrorClassification } from "../packages/adapters/src/error-classification.js";
import { makeAgyAcpProfile, readAgyAcpTranscript, readAgyAcpTranscriptMessages, AGY_ACP_ARGS } from "../packages/adapters/src/profiles/agy-acp.js";
import { makeAgyProfile } from "../packages/adapters/src/profiles/agy.js";
import { controllerMetadataAdapter } from "../packages/core/src/agents/controller-metadata.js";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import { negotiateReauth } from "../packages/core/src/core/reauth-negotiation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createOrdinaryAgyFixture } from "./helpers/agy-runtime-fixture.js";

const fixture = fileURLToPath(new URL("./fixtures/agy-acp-server.mjs", import.meta.url));
const dirs: string[] = [];
const logger = { child() { return this; }, debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(newSessionError?: { code: number; message: string; data: Record<string, unknown> }, environment = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "seam-agy-acp-test-")); dirs.push(dir);
  const requests = path.join(dir, "requests.jsonl");
  const profile = makeAgyAcpProfile({
    defaultModel: "fixture-deep", cliPath: process.execPath, acpArgs: [fixture], cwd: dir,
    environment: { ...process.env, AGY_ACP_TEST_REQUESTS: requests,
      ...(newSessionError ? { AGY_ACP_TEST_NEW_ERROR: JSON.stringify(newSessionError) } : {}), ...environment },
  });
  return { dir, requests, profile };
}

describe("native AGY ACP integration", () => {
  it("defaults to process-per-session arguments and a separate catalog backend", () => {
    expect(AGY_ACP_ARGS).toEqual(["acp", "--process-per-session"]);
    const profile = makeAgyAcpProfile({ defaultModel: "configured-model" });
    expect(profile).toMatchObject({ id: "agy-acp", brand: "antigravity" });
    expect(profile.catalog.scope()).toMatchObject({ provider: "google-antigravity", backend: "agy-acp-stdio-v1" });
  });

  const wireErrors = [
    { code: -32000, message: "Authentication required", data: { fixture: "auth" }, kind: "auth_required", action: "park" },
    { code: -32603, message: "Fixture upstream unavailable", data: { status: 503, fixture: "server" }, kind: "overloaded", action: "inconclusive" },
    { code: -32603, message: "The Antigravity process serving this session exited unexpectedly", data: { fixture: "worker" }, kind: "unclassified", action: "inconclusive" },
  ];
  it.each(wireErrors.flatMap(error => ["local", "controller"].map(owner => ({ ...error, owner }))))(
    "routes $kind from a bare ACP error through $owner core without losing its cause", async ({ kind, action, owner, ...wireError }) => {
    const { profile, dir } = await setup(wireError);
    const client = owner === "controller"
      ? controllerMetadataAdapter({ id: profile.id, catalog: profile.catalog })
      : profile;
    const runtime = new AgentRuntime({ profile: client, logger, spawnFn: () => profile.spawn() });
    try {
      await runtime.start();
      const error = await runtime.newSession({ cwd: dir }).then(
        () => { throw new Error("Fixture should reject session/new"); },
        error => error,
      );
      expect(error).toMatchObject({ code: wireError.code, message: wireError.message, data: wireError.data });
      expect(readErrorClassification(error)).toMatchObject({ agentId: "agy-acp", errorKind: kind });
      expect(negotiateReauth({ ...readErrorClassification(error), message: error.message }).action).toBe(action);
    } finally { await runtime.dispose(); }
  });

  it("retains an existing classification and the original error object and cause", () => {
    const profile = makeAgyAcpProfile({ defaultModel: "fixture-flash" });
    const cause = new Error("Fixture cause");
    const error = Object.assign(new Error("Authentication required", { cause }), {
      data: { agentId: "agy-acp", errorKind: "rate_limit", fixture: "preserved" },
    });
    expect(profile.classifyError!(error)).toMatchObject({ agentId: "agy-acp", errorKind: "rate_limit" });
    expect(error.cause).toBe(cause);
    expect(error.data).toMatchObject({ agentId: "agy-acp", errorKind: "rate_limit", fixture: "preserved" });
  });

  it("keeps legacy and ACP catalog, retained-session and invalidation ownership separate", async () => {
    const { profile: native, dir } = await setup();
    const fixture = createOrdinaryAgyFixture({
      cwd: dir, environment: { FAKE_AGY_MODELS: "fixture-flash-high\tFixture Flash (High)\n" },
    });
    const legacy = makeAgyProfile({ runtime: fixture.runtime, dataDir: dir, defaultModel: "fixture-flash-high" });
    const store = new SessionStore(":memory:");
    const catalogStore = new ModelCatalogStore(":memory:");
    const bindings = [{ agentId: "agy", location: "local" }, { agentId: "agy-acp", location: "local" }];
    const catalog = new ModelCatalogService({
      store: catalogStore, logger, bindings: () => bindings,
      scope: binding => router.getProfile(binding.agentId)!.catalog.scope(),
      fetch: binding => router.getProfile(binding.agentId)!.catalog.fetch(),
    });
    const router = new SessionRouter({ logger, store, profiles: [legacy, native], modelCatalog: catalog,
      defaultAgentId: "agy", defaultModel: "fixture-flash-high" });
    try {
      expect(router.getProfile("agy")).toBe(legacy);
      expect(router.getProfile("agy-acp")).toBe(native);
      expect(router.getProfile("agy")!.effort?.mechanism).toBe("modelBaked");
      expect(router.getProfile("agy")!.sessionManager).toBe(legacy.sessionManager);
      expect(legacy.sessionManager).toBeDefined();
      expect(router.getProfile("agy-acp")!.sessionManager).toBeUndefined();
      expect(router.getProfile("agy-acp")!.effort).toMatchObject({ mechanism: "configOption", configId: "thought_level" });
      for (const binding of bindings) expect((await catalog.refresh(binding)).result).toBe("published");
      expect(catalog.models(bindings[0]!).map(row => row.id)).toEqual(["fixture-flash-high"]);
      expect(catalog.models(bindings[1]!).map(row => row.id)).toEqual(["fixture-flash", "fixture-deep", "fixture-fixed"]);
      expect(catalog.lookup(bindings[0]!).snapshot!.scopeKey).not.toBe(catalog.lookup(bindings[1]!).snapshot!.scopeKey);
      expect(catalog.lookup(bindings[0]!).snapshot!.candidate.scope.backend).toBe("agy-native-language-server-v1");
      expect(catalog.lookup(bindings[1]!).snapshot!.candidate.scope.backend).toBe("agy-acp-stdio-v1");
      for (const client of [legacy, controllerMetadataAdapter({ id: legacy.id, catalog: legacy.catalog })]) {
        const error = Object.assign(new Error("Authentication required"), { code: -32000, data: { fixture: "legacy" } });
        expect(client.classifyError!(error)).toMatchObject({ agentId: "agy", errorKind: "auth_required" });
        expect(error).toMatchObject({ code: -32000, message: "Authentication required", data: { fixture: "legacy" } });
      }

      const now = new Date().toISOString();
      const records = bindings.map(({ agentId }) => ({ id: `discord:${agentId}`, platform: "discord",
        channelRef: agentId, parentRef: null, agentId, acpSessionId: "same-acp-id", repoPath: dir,
        configJson: "{}", createdUtc: now, updatedUtc: now }));
      for (const record of records) store.upsert(record);
      for (const record of records) {
        const slot = { slot: 1, alive: true, pid: 99, lastStdoutMsAgo: 0, lastStdinMsAgo: 0,
          session: { agentId: record.agentId, acpSessionId: "same-acp-id", busy: false, updatedUtc: now } };
        expect(router.retainedSlotSession("local", slot)?.id).toBe(record.id);
        expect(router.retainedSlotSession("local", { ...slot,
          session: { ...slot.session, threadId: record.agentId === "agy" ? "agy-acp" : "agy" } })).toBeNull();
        await router.invalidate(record.id, { clearAcpSession: true,
          bindingChange: { source: "operator-session-reset", cause: "fixture requested binding clear" } });
      }
      expect(store.get(records[0]!.id)!.acpSessionId).toBe("same-acp-id");
      expect(store.get(records[1]!.id)!.acpSessionId).toBe("");
    } finally {
      catalog.stop(); catalogStore.close(); store.close(); fixture.cleanup();
    }
  });

  it("discovers model-specific effort over real ACP, retaining unknown context instead of token estimates", async () => {
    const { profile, requests } = await setup();
    const catalog = normalizeCatalogCandidate(await profile.catalog.fetch());
    expect(catalog.models.map(row => [row.id, row.default, row.effort.choices.map(c => c.id)])).toEqual([
      ["fixture-flash", false, ["low", "medium", "high"]],
      ["fixture-deep", true, ["high", "extra", "max"]],
      ["fixture-fixed", false, ["default"]],
    ]);
    expect(catalog.models.every(row => row.context.effective === null && row.visionMode === "native")).toBe(true);
    expect(catalog.models.every(row => row.applicationMode === "live")).toBe(true);
    const calls = (await readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls[0].params.clientInfo.name).toBe("seam-acp");
    expect(calls.filter(row => row.method === "session/new")).toHaveLength(3);
    expect(calls.filter(row => row.method === "session/close")).toHaveLength(3);
    expect(calls.some(row => row.method === "session/prompt")).toBe(false);
  });

  it("uses existing core load/reapply and forwards exact thought/context events independently of token totals", async () => {
    const { profile, requests, dir } = await setup();
    const catalog = await profile.catalog.fetch();
    const effort = catalog.models.find(row => row.id === "fixture-deep")!.effort;
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({ profile, logger, effortDescriptor: effort, spawnFn: () => profile.spawn() });
    runtime.onEvent(event => { events.push(event); });
    try {
      await runtime.start();
      await runtime.loadSession({ cwd: dir, sessionId: "own-fixture-session", model: "fixture-deep", effort: "max", strictModel: true });
      expect(runtime.getConfigCurrentValue("model")).toBe("fixture-deep");
      expect(runtime.getConfigCurrentValue("thought_level")).toBe("max");
      expect((await runtime.prompt("fixture turn")).stopReason).toBe("end_turn");
      expect(events.filter(event => event.kind === "agent-thought")).toEqual([
        expect.objectContaining({ kind: "agent-thought", text: "Fixture reasoning α" }),
      ]);
      expect(events.filter(event => event.kind === "usage-update")).toEqual([
        { kind: "usage-update", used: 1234, size: 32768 },
      ]);
      await expect(runtime.setModel("not-advertised", { allowFallback: false })).rejects.toThrow("Unknown fixture model");
      await runtime.request("session/close", { sessionId: "own-fixture-session" });
    } finally { await runtime.dispose(); }
    const calls = (await readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const loaded = calls.findIndex(row => row.method === "session/load");
    expect(calls.slice(loaded + 1, loaded + 3).map(row => row.params)).toEqual([
      { sessionId: "own-fixture-session", configId: "model", value: "fixture-deep" },
      { sessionId: "own-fixture-session", configId: "thought_level", value: "max" },
    ]);
  });
});

describe("native ACP text transcript reader", () => {
  const expected = "### User\nQuestion 🧪\nline\n\n### Assistant\nAnswer αβ\n\n### Assistant\nSeparate assistant\n\n### User\nNext\n\n### Assistant\nDone";
  async function reader(environment: Record<string, string> = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "seam-agy-transcript-")); dirs.push(dir);
    const requests = path.join(dir, "requests.jsonl"), lifecycle = path.join(dir, "lifecycle.jsonl");
    const env = { ...process.env, AGY_ACP_TEST_TRANSCRIPT: "1", AGY_ACP_TEST_REQUESTS: requests,
      AGY_ACP_TEST_LIFECYCLE: lifecycle, ...environment };
    const launch = { cliPath: process.execPath, args: [fixture], cwd: dir, env, sessionId: "own-transcript" };
    const profile = makeAgyAcpProfile({ defaultModel: "fixture-flash", cliPath: launch.cliPath,
      acpArgs: launch.args, cwd: "/unused-default", environment: env });
    return { dir, requests, lifecycle, launch, profile };
  }
  async function records(file: string) {
    return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  }
  async function closed(file: string, graceful = true) {
    const events = await records(file);
    if (graceful) expect(events.map(row => row.event)).toEqual(["start", "close", "eof", "exit"]);
    const first = events[0];
    expect(first.event).toBe("start");
    if (process.platform === "linux") {
      const actual = await readFile(`/proc/${first.pid}/stat`, "utf8").catch(() => "");
      if (actual) {
        const fields = actual.slice(actual.lastIndexOf(")") + 2).trim().split(/\s+/);
        expect(fields[19] !== first.start || ["Z", "X"].includes(fields[0]!)).toBe(true);
      }
    }
  }

  it("returns exact matching-SID text/chunk/message boundaries through the adapter override, then closes and reaps", async () => {
    const r = await reader();
    expect(await r.profile.getTranscript(r.dir, r.launch.sessionId)).toBe(expected);
    expect(r.profile.sessionManager).toBeUndefined();
    const calls = await records(r.requests);
    expect(calls.map(row => row.method)).toEqual(["initialize", "session/load", "session/close"]);
    expect(calls[0].params).toEqual({ protocolVersion: 1, clientInfo: { name: "seam-acp", version: "0.1.0" }, clientCapabilities: {} });
    expect(calls[1].params).toEqual({ sessionId: r.launch.sessionId, cwd: r.dir, mcpServers: [] });
    await closed(r.lifecycle);
  });

  it("keeps supplied empty message IDs distinct while coalescing their repeated and absent-ID chunks", async () => {
    const r = await reader({ AGY_ACP_TEST_EMPTY_MESSAGE_ID: "1" });
    const transcript = await r.profile.getTranscript(r.dir, r.launch.sessionId);
    await closed(r.lifecycle);
    expect(transcript).toBe(expected + "\n\n### Assistant\nNamed γ\n\n### Assistant\nEmpty id δ no-id chunks");
  });

  it("preserves a load error after partial replay and its separate close error", async () => {
    const native = { code: -32603, message: "Fixture load failed", data: { status: 503, fixture: "load-cause" } };
    const cleanup = { code: -32603, message: "Fixture close failed", data: { fixture: "close-cause" } };
    const r = await reader({ AGY_ACP_TEST_LOAD_ERROR: JSON.stringify(native), AGY_ACP_TEST_CLOSE_ERROR: JSON.stringify(cleanup) });
    const error = await r.profile.getTranscript(r.dir, r.launch.sessionId).catch(error => error);
    expect(error).toMatchObject(native);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([expect.objectContaining(native), expect.objectContaining(cleanup)]);
    expect(readErrorClassification(error)).toMatchObject({ agentId: "agy-acp", errorKind: "overloaded" });
    await closed(r.lifecycle);
  });

  it("does not return replayed text as success when supported close fails", async () => {
    const native = { code: -32603, message: "Fixture close failed", data: { fixture: "close-cause" } };
    const r = await reader({ AGY_ACP_TEST_CLOSE_ERROR: JSON.stringify(native) });
    await expect(r.profile.getTranscript(r.dir, r.launch.sessionId)).rejects.toMatchObject(native);
    await closed(r.lifecycle);
  });

  it("retains an initialization RPC error and ends the transport without attempting load/close", async () => {
    const native = { code: -32000, message: "Authentication required", data: { fixture: "init-cause" } };
    const r = await reader({ AGY_ACP_TEST_INIT_ERROR: JSON.stringify(native) });
    const error = await r.profile.getTranscript(r.dir, r.launch.sessionId).catch(error => error);
    expect(error).toMatchObject(native);
    expect(readErrorClassification(error)).toMatchObject({ agentId: "agy-acp", errorKind: "auth_required" });
    expect((await records(r.requests)).map(row => row.method)).toEqual(["initialize"]);
    expect((await records(r.lifecycle)).map(row => row.event)).toEqual(["start", "eof", "exit"]);
  });

  it("keeps readable fidelity replay headers and terminal whitespace byte-exact", async () => {
    const r = await reader({ AGY_ACP_TEST_REPLAY_DATA: "fidelity" });
    const transcript = await r.profile.getTranscript(r.dir, r.launch.sessionId);
    await closed(r.lifecycle);
    expect(transcript).toBe("### User\nOLDER ONLY: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n\n### User\nKeep this user text Ω.\n\n### Assistant\nStill USER data.\n\n### User\nStill the SAME user message.  \n\t\n\n### Assistant\nReal assistant reply β. \t\n\n");
    expect((await records(r.requests)).map(row => row.method)).toEqual(["initialize", "session/load", "session/close"]);
  });

  it("retains null, supplied-empty and omitted source IDs without changing same-role coalescing", async () => {
    const r = await reader({ AGY_ACP_TEST_REPLAY_DATA: "ids" });
    const messages = await readAgyAcpTranscriptMessages(r.launch);
    await closed(r.lifecycle);
    expect(messages).toStrictEqual([
      { role: "User", messageId: null, text: "Null Ω absent" },
      { role: "User", messageId: "", text: "Empty β null absent" },
      { role: "User", messageId: "named", text: "Named absent" },
      { role: "Assistant", messageId: undefined, text: " \t\n" },
      { role: "User", messageId: "", text: "" },
    ]);
    expect((await records(r.requests)).map(row => row.method)).toEqual(["initialize", "session/load", "session/close"]);
    expect(r.profile.sessionManager).toBeUndefined();
  });

  it.each([
    { environment: { AGY_ACP_TEST_LOAD_HANG: "1" }, code: "timeout" },
    { environment: { AGY_ACP_TEST_LOAD_HANG: "1", AGY_ACP_TEST_LOAD_OVERFLOW: "1" }, code: "output_overflow" },
  ])("retains the existing $code lifecycle failure and reaps after partial replay", async ({ environment, code }) => {
    const r = await reader(environment);
    const error = await readAgyAcpTranscript({ ...r.launch, timeoutMs: 1000 }).catch(error => error);
    expect(error).toMatchObject({ code });
    expect(readErrorClassification(error)).toMatchObject({ agentId: "agy-acp" });
    await closed(r.lifecycle, code !== "output_overflow");
  });
});


describe("runtime-owned model identity for catalog effort metadata", () => {
  const descriptor = (selectionDefault: string, choices: string[]): CatalogEffort => ({
    mechanism: "configOption", configId: "thought_level", selectionDefault,
    choices: choices.map(id => ({ id, raw: id })),
  });
  const flash = descriptor("medium", ["low", "medium", "high"]);
  const deep = descriptor("high", ["high", "extra", "max"]);
  type EffortInput = ConstructorParameters<typeof AgentRuntime>[0]["effortDescriptor"];
  async function withRuntime(effortDescriptor: EffortInput,
    body: (runtime: AgentRuntime, h: Awaited<ReturnType<typeof setup>>) => Promise<void>,
    newError?: { code: number; message: string; data: Record<string, unknown> },
    environment: Record<string, string> = {},
  ) {
    const h = await setup(newError, environment);
    let actor: { identity: ReturnType<typeof readProcessIdentity>; closed: Promise<void> } | undefined;
    const runtime = new AgentRuntime({ profile: h.profile, logger, effortDescriptor,
      spawnFn: () => {
        const child = h.profile.spawn();
        actor = { identity: child.pid === undefined ? undefined : readProcessIdentity(child.pid, true),
          closed: new Promise<void>(resolve => child.once("close", () => resolve())) };
        return child;
      },
    });
    let first: { error: unknown } | undefined;
    const cleanup: unknown[] = [];
    try { await body(runtime, h); } catch (error) { first = { error }; }
    try { await runtime.dispose(); } catch (error) { cleanup.push(error); }
    if (actor) {
      try {
        expect(actor.identity).toBeDefined();
        expect(actor.identity!.pgid).toBe(actor.identity!.pid);
        expect(await terminateProcessGroup(actor.identity!)).toBe(true);
        await actor.closed;
        expect(readProcessIdentity(actor.identity!.pid, true)?.started).not.toBe(actor.identity!.started);
      } catch (error) { cleanup.push(error); }
    }
    if (first || cleanup.length) throw new AggregateError([
      ...(first ? [first.error] : []), ...cleanup,
    ], "Descriptor fixture operation and cleanup outcomes", first ? { cause: first.error } : undefined);
  }

  it.each([
    { operation: "new" as const, model: "fixture-flash", effort: "high", wanted: "fixture-flash" },
    { operation: "new" as const, model: undefined, effort: "max", wanted: "fixture-deep" },
    { operation: "load" as const, model: "fixture-flash", effort: "high", wanted: "fixture-flash" },
    { operation: "load" as const, model: undefined, effort: "max", wanted: "fixture-deep" },
  ])("resolves effort for runtime $operation requested/default identity ($wanted)",
    async ({ operation, model, effort, wanted }) => {
      // Independent cache input; the profile has no declared effort levels.
      const cache = new Map<string, CatalogEffort>();
      const requested: string[] = [];
      await withRuntime((chosen: string) => { requested.push(chosen); return cache.get(chosen); }, async (runtime, h) => {
        expect(requested).toEqual([]);
        await runtime.start();
        expect(requested).toEqual([]);
        cache.set("fixture-flash", flash);
        cache.set("fixture-deep", deep);
        const input = { cwd: h.dir, ...(model === undefined ? {} : { model }), effort, strictModel: true };
        const info = operation === "new" ? await runtime.newSession(input)
          : await runtime.loadSession({ ...input, sessionId: "own-descriptor-session" });
        expect(requested).toEqual([wanted]);
        expect(runtime.getConfigCurrentValue("model")).toBe(wanted);
        expect(runtime.getConfigCurrentValue("thought_level")).toBe(effort);
        expect(await runtime.prompt("descriptor fixture turn")).toMatchObject({ stopReason: "end_turn" });
        await runtime.request("session/close", { sessionId: info.sessionId });
        const calls = (await readFile(h.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        const sessionAt = calls.findIndex(row => row.method === (operation === "new" ? "session/new" : "session/load"));
        const setters = calls.filter(row => row.method === "session/set_config_option");
        expect(setters.map(row => row.params)).toEqual([
          ...(wanted === "fixture-flash" ? [] : [{ sessionId: info.sessionId, configId: "model", value: wanted }]),
          { sessionId: info.sessionId, configId: "thought_level", value: effort },
        ]);
        expect(calls.findIndex(row => row.method === "session/set_config_option")).toBeGreaterThan(sessionAt);
        expect(calls.findIndex(row => row.method === "session/prompt"))
          .toBeGreaterThan(calls.findLastIndex(row => row.method === "session/set_config_option"));
        expect(calls.filter(row => row.method === "session/prompt")).toHaveLength(1);
        expect(h.profile.effort?.levels).toEqual([]);
        expect(input).toEqual({ cwd: h.dir, ...(model === undefined ? {} : { model }), effort, strictModel: true });
      });
    }, 15_000);

  it("keeps an undefined model descriptor non-blocking without inventing effort capability", async () => {
    const requested: string[] = [];
    await withRuntime((model: string) => { requested.push(model); return undefined; }, async (runtime, h) => {
      await runtime.start();
      const info = await runtime.newSession({ cwd: h.dir, model: "fixture-deep", effort: "max", strictModel: true });
      expect(requested).toEqual(["fixture-deep"]);
      expect(runtime.getConfigCurrentValue("model")).toBe("fixture-deep");
      expect(runtime.getConfigCurrentValue("thought_level")).toBe("high");
      expect(await runtime.prompt("missing metadata fixture turn")).toMatchObject({ stopReason: "end_turn" });
      await runtime.request("session/close", { sessionId: info.sessionId });
      const calls = (await readFile(h.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls.filter(row => row.method === "session/set_config_option").map(row => row.params)).toEqual([
        { sessionId: info.sessionId, configId: "model", value: "fixture-deep" },
      ]);
      expect(calls.filter(row => row.method === "session/prompt")).toHaveLength(1);
    });
  }, 15_000);

  it.each(["new", "load"] as const)("does not resolve metadata before a rejected native session/%s", async operation => {
    const native = { code: -32603, message: "Fixture session unavailable", data: { status: 503, fixture: "descriptor-session-cause" } };
    const requested: string[] = [];
    const resolve = (model: string): CatalogEffort | undefined => {
      requested.push(model); throw new Error("Metadata must not replace the earlier session error");
    };
    await withRuntime(resolve, async (runtime, h) => {
      await runtime.start();
      const input = { cwd: h.dir, model: "fixture-deep", effort: "max", strictModel: true };
      const error = await (operation === "new" ? runtime.newSession(input)
        : runtime.loadSession({ ...input, sessionId: "own-descriptor-rejected" }))
        .then(() => null, error => error);
      expect(error).toMatchObject(native);
      expect(readErrorClassification(error)).toMatchObject({ agentId: "agy-acp", errorKind: "overloaded" });
      expect(requested).toEqual([]);
      const calls = (await readFile(h.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls.map(row => row.method)).toEqual(["initialize", operation === "new" ? "session/new" : "session/load"]);
    }, operation === "new" ? native : undefined,
    operation === "load" ? { AGY_ACP_TEST_LOAD_ERROR: JSON.stringify(native) } : {});
  }, 15_000);
});


describe("local adapter compaction transcript compatibility", () => {
  it("delegates a manager's typed view with its receiver, otherwise uses the current readable override", async () => {
    const readable = vi.fn(async (_cwd: string, _sid: string) => "manager text");
    const manager: ISessionManager = {
      listSessions: async () => [], cloneSession: async () => {}, deleteSession: async () => {},
      getTranscript: readable,
      async getCompactionTranscript(cwd, sid) {
        expect(this).toBe(manager);
        expect([cwd, sid]).toEqual(["fixture-cwd", "same-sid"]);
        return [{ role: "User", messageId: "", text: " \t" }];
      },
    };
    const adapter = asLocalAdapter({ id: "fixture", displayName: "Fixture", defaultModel: "fixture",
      spawn() { throw new Error("Transcript delegation must not spawn"); }, sessionManager: manager });
    expect(await adapter.getCompactionTranscript!("fixture-cwd", "same-sid"))
      .toStrictEqual([{ role: "User", messageId: "", text: " \t" }]);
    expect(readable).not.toHaveBeenCalled();
    const nativeError = Object.assign(new Error("Fixture metadata read failed"), { code: -32603, data: { fixture: "delegation-cause" } });
    manager.getCompactionTranscript = async () => { throw nativeError; };
    await expect(adapter.getCompactionTranscript!("fixture-cwd", "same-sid")).rejects.toBe(nativeError);
    expect(readable).not.toHaveBeenCalled();
    manager.getCompactionTranscript = undefined;
    expect(await adapter.getCompactionTranscript!("fixture-cwd", "same-sid")).toBe("manager text");
    expect(readable).toHaveBeenCalledExactlyOnceWith("fixture-cwd", "same-sid");
    adapter.sessionManager = undefined;
    const late = vi.fn(async (_cwd: string, _sid: string) => "late native-shaped override");
    adapter.getTranscript = late;
    expect(await adapter.getCompactionTranscript!("fixture-cwd", "same-sid")).toBe("late native-shaped override");
    expect(late).toHaveBeenCalledExactlyOnceWith("fixture-cwd", "same-sid");
    expect(readable).toHaveBeenCalledTimes(1);
  });
});
