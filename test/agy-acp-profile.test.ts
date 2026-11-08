import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCatalogCandidate } from "../packages/adapters/src/catalog-evidence.js";
import { readErrorClassification } from "../packages/adapters/src/error-classification.js";
import { makeAgyAcpProfile, readAgyAcpTranscript, AGY_ACP_ARGS } from "../packages/adapters/src/profiles/agy-acp.js";
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
