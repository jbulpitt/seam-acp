/** #466: real scheduled runner + injectTurn + ACP, synthetic execution boundaries only. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { classifyAgyError, readErrorClassification, SEAM_AGY_STDOUT_FALLBACK_META, type AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SeamTokenRegistry } from "../packages/core/src/core/mcp/token-registry.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { scheduledOccurrenceKey } from "../packages/core/src/core/scheduled-prompts/occurrence-store.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";
import { simulateRetiredOwnerProcess } from "./restart-process-fixture.js";
import { guardLocalProfileSpawn, parseAgentLocationDeny } from "../packages/core/src/core/location.js";

const REMOTE = "remote-synthetic";
const MODEL = "synthetic-exact-model";
const OVERRIDE_MODEL = "synthetic-override-model";
const silent = pino({ level: "silent" }) as any;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

function setup(location = REMOTE) {
  const cwd = mkdtempSync(path.join(tmpdir(), "seam-466-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  // This path exists on the controller too. Its project config is NOT the remote config.
  writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
    controllerOnly: { command: "controller-only-sentinel", env: { PRIVATE: "controller-only" } },
  } }));
  const store = new SessionStore(path.join(cwd, "test.db"));
  cleanups.push(() => store.close());
  const calls = { news: [] as any[], loads: [] as any[], prompts: [] as any[], configs: [] as any[], children: [] as any[] };
  const onPrompt = vi.fn(async () => {});
  const afterText = vi.fn(async () => {});
  const fallback = { code: undefined as string | undefined };
  const logs: any[] = [];
  const logger = pino({ level: "warn" }, { write(line) { logs.push(JSON.parse(line)); } }) as any;
  function spawn() {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, slot: calls.children.length,
      pid: undefined, detached: false, killed: false, exitCode: null, signalCode: null,
      kill() { if (!this.killed) { this.killed = true; this.emit("exit", null, "SIGTERM"); } return true; } });
    calls.children.push(child);
    const configOptions = [{ id: "model", name: "Model", type: "select" as const, currentValue: MODEL,
      options: [MODEL, OVERRIDE_MODEL].map(value => ({ value, name: value })) }];
    agent({ name: "synthetic-466" })
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
      .onRequest(methods.agent.session.new, ({ params }) => { calls.news.push(params); return { sessionId: "scheduled-acp", configOptions }; })
      .onRequest(methods.agent.session.load, ({ params }) => { calls.loads.push(params); return { sessionId: params.sessionId, configOptions }; })
      .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        calls.configs.push(params); configOptions[0]!.currentValue = String(params.value); return { configOptions };
      })
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        calls.prompts.push(params); await onPrompt();
        await client.notify(methods.client.session.update, { sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "synthetic result" },
            ...(fallback.code ? { _meta: { [SEAM_AGY_STDOUT_FALLBACK_META]: { code: fallback.code } } } : {}) } });
        await afterText();
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
    sessionManager: { deleteSession: localDelete } } as unknown as AgentProfile;
  const now = new Date().toISOString();
  const record = { id: "discord:author", platform: "discord", channelRef: "author", parentRef: "parent",
    agentId: profile.id, acpSessionId: "live-session-untouched", repoPath: cwd, configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const row: ScheduledPrompt = { id: "schedule-466", platform: "discord", channelRef: "author", parentRef: "parent",
    name: "Remote schedule", promptText: "ORIGINAL SCHEDULE", cron: "* * * * *", timezone: "UTC", model: null,
    cwd: null, targetChannel: "output", outputType: "card", sessionMode: "isolated", catchupSeconds: 0, enabled: true,
    legacyAttachmentCount: 0, createdBy: "user", createdUtc: now, updatedUtc: now, lastRunUtc: null, lastStatus: null,
    nextRunUtc: null, pinnedSessionId: null };
  store.upsertScheduled(row);
  const seam = { type: "http", name: "seam-mcp", url: "http://127.0.0.1:1234/mcp", headers: [{ name: "X-Seam-Session", value: "author-token" }] };
  const globalMcp = { name: "global-tool", command: "host-tool", args: [], env: [] };
  const remoteSeam = { ...seam, url: "https://seam.example/mcp" };
  const router = { ensureSessionRecord: () => ({ ...record }), getProfile: () => profile, listProfiles: () => [profile],
    resolveProfileForChannel: () => profile, assertAgentAllowedForChannel() {}, assertAgentAllowedForRecord() {},
    reuseMcpServers: vi.fn(() => [globalMcp, seam]), isBusy: () => false,
    revokeMcpSession: vi.fn(),
    describeConfig: () => ({ agent: { value: profile.id }, model: { value: MODEL }, effort: { value: "high" },
      cwd: { value: cwd }, location: { value: location }, fastMode: { value: false } }) };
  const mux = { spawn: remoteSpawn, rpc: vi.fn(async (_method: string, _params: unknown, _opts?: unknown) => ({ projectMcpInjection: true })), releaseStdin: vi.fn(),
    sendCmd: vi.fn(async (_action: string, _payload: unknown) => ({ health: calls.children.map(child => ({ slot: child.slot, alive: !child.killed })) })) };
  const hub = { markSessionBridge: vi.fn(), get: vi.fn(() => ({ mux })),
    mcpServersForRemoteSpawn: vi.fn(() => remoteSeam), rpc: vi.fn(async (_location: string, _method: string, _params: unknown, _agent: string) => ({})) };
  const adapter = { sendPanel: vi.fn(async (channel: any, _panel?: unknown) => ({ channel, id: "panel" })),
    sendMessage: vi.fn(async (channel: any, _text?: string) => ({ channel, id: "message" })),
    editPanel: vi.fn(async () => {}), editMessage: vi.fn(async () => {}),
    findMessageByNonce: vi.fn(async () => ({ status: "absent" })) };
  const make = () => {
    const orch = new Orchestrator({ logger, store, router: router as any, adapter: adapter as any,
      renderer: discordRenderer, modelCatalog: fixtureModelCatalog([profile]),
      config: { DATA_DIR: cwd, REPOS_ROOT: cwd, TURN_TIMEOUT_SECONDS: 15, SEAM_TURN_RESUME_ENABLED: true,
        REPO_EMOJIS: new Map(), channelPresets: new Map(), threadPresets: new Map() } as any });
    orch.setBridgeHub(hub as any);
    return orch;
  };
  return { cwd, store, calls, onPrompt, afterText, fallback, logs, logger, localSpawn, remoteSpawn, localDelete, profile, record, row, router, mux, hub, adapter, make, globalMcp, remoteSeam };
}

describe("#545 durable scheduled degradation", () => {
  it("records an isolated ingest fallback through real injectTurn and the durable attempt", async () => {
    const h = setup(); h.fallback.code = "unauthenticated";
    await h.make().dispatchInjectTurn({ id: "degraded-ingest", target: "headless", kind: "ingest",
      session: "isolated", agentId: "agy", location: REMOTE, cwd: h.cwd, model: MODEL,
      prompt: "fixture input", createdUtc: new Date().toISOString() });
    expect(h.store.turnAttempts.get("degraded-ingest")).toMatchObject({ state: "completed",
      stdoutFallback: { count: 1, reasons: { unauthenticated: 1 } } });
    // #536: without either ingest/inject hook, successful turns silently lose their submission receipt.
    expect(h.store.turnAttempts.get("degraded-ingest")!.submissions).toMatchObject([
      { phase: "local_write_completed", outcome: "completed", acceptance: { state: "unknown" } },
    ]);
  });

  it.each(["unauthenticated", "unimplemented", "http_503", undefined])("records %s without failing a completed remote turn", async code => {
    const h = setup(), orch = h.make(); h.fallback.code = code;
    await orch.runScheduledPrompt(h.row.id);
    const attempts = h.store.turnAttempts.list("completed");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toMatchObject({ status: "completed", output: "synthetic result" });
    // #536: scheduled work must use the same durable evidence path as conversational turns.
    expect(attempts[0]!.submissions).toMatchObject([
      { phase: "local_write_completed", outcome: "completed", acceptance: { state: "unknown" } },
    ]);
    if (code) expect(attempts[0]!.stdoutFallback).toMatchObject({ count: 1, reasons: { [code]: 1 } });
    else expect(attempts[0]!.stdoutFallback).toBeUndefined();
  });

  it("does not fail a successful turn when observational storage fails, and reports the gap", async () => {
    const h = setup(); h.fallback.code = "unauthenticated";
    vi.spyOn(h.store.turnAttempts, "recordStdoutFallback").mockImplementation(() => { throw new Error("fixture storage fault"); });
    await h.make().runScheduledPrompt(h.row.id);
    expect(h.store.turnAttempts.list("completed")).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ msg: "stdout fallback evidence could not be persisted", code: "unauthenticated" }));
  });
});

describe("#487 production remote construction paths", () => {
  const failAfterText = () => { throw new RequestError(-32603, "Internal error: native AGY exited_early", { code: "exited_early" }); };

  it("consults the live bridge before scheduled occurrence recovery and only then cleans up", async () => {
    const h = setup(); h.afterText.mockImplementation(failAfterText);
    await h.make().runScheduledPrompt(h.row.id);
    expect(h.calls.prompts).toHaveLength(1); // The ladder's ephemeral exception is unchanged.
    expect(h.mux.sendCmd).toHaveBeenCalledExactlyOnceWith("listSlots", {});
    expect(h.logs).toContainEqual(expect.objectContaining({ msg: "bridge slot health consulted before exit classification", slot: 0, alive: true }));
    expect(h.logs).toContainEqual(expect.objectContaining({ msg: "adapter error classified", errorKind: "protocol_error" }));
    expect(h.logs).not.toContainEqual(expect.objectContaining({ msg: "adapter error classified", errorKind: "agent_exit" }));
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toContain("native AGY exited_early");
    expect(h.calls.children[0].killed).toBe(true); // Cleanup is a consequence, not evidence of death.
    expect(h.localSpawn).not.toHaveBeenCalled();
  });

  it("pins the real router runtime's health query to its spawning mux", async () => {
    const h = setup(); h.afterText.mockImplementation(failAfterText);
    const muxForSession = vi.fn(() => h.mux);
    const router = new SessionRouter({ logger: h.logger, store: h.store, profiles: [h.profile],
      modelCatalog: fixtureModelCatalog([h.profile]), defaultAgentId: "agy", defaultModel: MODEL,
      threadPresets: new Map([["author", { location: REMOTE }]]), defaultCwd: h.cwd,
      seamMcp: { registry: new SeamTokenRegistry(), getPort: () => undefined, isRemoteSession: () => true, muxForSession } });
    try {
      const runtime = await router.getOrStartRuntime(h.record);
      // A later binding change must not ask a different host about this slot.
      const other = { ...h.mux, sendCmd: vi.fn(async () => ({ health: [{ slot: 0, alive: false }] })) };
      muxForSession.mockReturnValue(other);
      const error = await runtime.prompt("fixture", undefined, { recoveryScope: "ephemeral" }).catch(error => error);
      expect(readErrorClassification(error)?.errorKind).toBe("protocol_error");
      expect(h.mux.sendCmd).toHaveBeenCalledExactlyOnceWith("listSlots", {});
      expect(other.sendCmd).not.toHaveBeenCalled();
      expect(h.calls.children[0].killed).toBe(false);
    } finally { await router.disposeAll(); }
  });

  it("surfaces a bridge-proven host OOM through the real scheduled turn state without replaying", async () => {
    const h = setup();
    h.onPrompt.mockImplementation(async () => {
      const child = h.calls.children[0];
      child.remoteExit = {
        bridgeId: "fhr-server",
        hostOom: { kind: "host_oom", killedPid: 221249, observedAt: 1_790_033_574_259, scope: "global" },
      };
      child.exitCode = 1;
      child.emit("exit", 1, null);
      // Ensure the runtime's death rejection wins the ACP response race.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await h.make().runScheduledPrompt(h.row.id);
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toContain("memory exhaustion on host 'fhr-server'");
    expect(h.logs).toContainEqual(expect.objectContaining({
      msg: "adapter error classified",
      errorKind: "host_oom",
    }));
    expect(h.logs).toContainEqual(expect.objectContaining({
      msg: "turn recovery resolved",
      resolution: expect.objectContaining({
        errorKind: "host_oom",
        transience: "transient",
        startRung: 3,
      }),
    }));
  });

  it("names a code-only remote supervisor exit without inventing a SIGKILL cause", async () => {
    const h = setup();
    h.onPrompt.mockImplementation(async () => {
      const child = h.calls.children[0];
      child.remoteExit = { bridgeId: "fhr-server" };
      child.killed = true;
      child.exitCode = 1;
      child.emit("exit", 1, null);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await h.make().runScheduledPrompt(h.row.id);
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toContain(
      "remote agent supervisor exited mid-turn on host 'fhr-server' (code=1, signal=null)"
    );
    expect(h.store.getScheduled(h.row.id)?.lastStatus).not.toContain("memory exhaustion");
    expect(h.logs).toContainEqual(expect.objectContaining({
      msg: "adapter error classified",
      errorKind: "agent_exit",
    }));
  });
});

describe("#466 scheduled execution boundary", () => {
  it("runs the issue reproduction through the real isolated job and injectTurn", async () => {
    const h = setup();
    h.localSpawn.mockImplementation(() => { throw new Error("synthetic local spawn reached"); });
    const key = scheduledOccurrenceKey(h.row.id);
    const orch = h.make();
    const occurrence = h.store.scheduledOccurrences.prepare(key, h.row, row => orch.scheduleExecution(row))!;
    // The owned snapshot, not a later mutable thread binding, determines launch.
    const described = h.router.describeConfig();
    vi.spyOn(h.router, "describeConfig").mockReturnValue({ ...described, location: { value: "local" } });
    h.store.turnAttempts.registerOwner("repro");
    const attempt = h.store.turnAttempts.claim({ id: key.id, target: "author", prompt: h.row.promptText,
      session: "isolated", kind: "scheduled", createdUtc: h.row.createdUtc }, occurrence.execution!.fingerprint, "repro", "schedule");
    const result = await (orch as any).runIsolatedScheduledJob({ profile: h.profile, record: h.record, cwd: h.cwd,
      model: MODEL, effort: "high", channel: { platform: "discord", id: "output" }, promptText: h.row.promptText,
      owned: { occurrence, attempt } });
    expect({ result, localSpawns: h.localSpawn.mock.calls.length, remoteSpawns: h.remoteSpawn.mock.calls.length })
      .toEqual({ result: { text: "synthetic result" }, localSpawns: 0, remoteSpawns: 1 });
  });

  it("routes an ordinary durable occurrence remotely with exact inputs, host MCP, output and cleanup", async () => {
    const h = setup(), orch = h.make();
    const manager = new ScheduledPromptManager({ store: h.store, logger: silent,
      resolveExecution: row => orch.scheduleExecution(row), onFire: (id, key) => orch.runScheduledPrompt(id, key) });
    try { await manager.runNow(h.row.id); } finally { manager.stop(); }
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.remoteSpawn).toHaveBeenCalledExactlyOnceWith({ holdStdinUntilReady: true });
    expect(h.mux.rpc).toHaveBeenCalledExactlyOnceWith("spawn", {
      slot: 0, agentId: "agy", model: MODEL, effort: "high", cwd: h.cwd,
      mcpServers: [h.globalMcp, h.remoteSeam],
    }, { agentId: "agy" });
    expect(h.hub.get).toHaveBeenCalledWith(REMOTE);
    expect(h.hub.markSessionBridge).toHaveBeenCalledWith(h.record.id, REMOTE);
    expect(h.hub.mcpServersForRemoteSpawn).toHaveBeenCalledExactlyOnceWith(h.record.id);
    expect(h.router.reuseMcpServers).toHaveBeenCalledExactlyOnceWith(h.record.id);
    expect(h.calls.news).toEqual([expect.objectContaining({ cwd: h.cwd, mcpServers: [h.globalMcp, h.remoteSeam] })]);
    expect(h.calls.configs).toEqual([]); // The advertised model is already exact.
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0].prompt).toEqual([{ type: "text", text: h.row.promptText }]);
    expect(h.adapter.sendPanel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "output" }),
      expect.objectContaining({ description: "synthetic result", fields: expect.arrayContaining([{ name: "Host", value: `\`${REMOTE}\``, inline: true }]) }), expect.anything());
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("live-session-untouched");
    const attempt = h.store.turnAttempts.list("completed")[0]!;
    expect(attempt).toMatchObject({ source: "schedule", promptStarted: true, acpSessionId: "scheduled-acp", deliveryDone: true });
    expect(h.store.scheduledOccurrences.get(attempt.id)).toMatchObject({ settled: true, execution: { location: REMOTE } });
    expect(h.calls.children.every(child => child.killed)).toBe(true);
    expect(h.localDelete).not.toHaveBeenCalled();
    expect(h.hub.rpc).toHaveBeenCalledExactlyOnceWith(REMOTE, "deleteSession", { cwd: h.cwd, sessionId: "scheduled-acp" }, "agy");
  });

  it("keeps a local isolated schedule local", async () => {
    const h = setup("local");
    await h.make().runScheduledPrompt(h.row.id);
    expect(h.localSpawn).toHaveBeenCalledTimes(1);
    expect(h.remoteSpawn).not.toHaveBeenCalled();
    expect(h.localDelete).toHaveBeenCalledExactlyOnceWith(h.cwd, "scheduled-acp");
    expect(h.hub.rpc).not.toHaveBeenCalled();
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toBe("ok");
  });

  it("preserves explicit schedule model/cwd overrides and inherited effort at the remote boundary", async () => {
    const h = setup();
    const cwd = "/remote-only/explicit-schedule-workspace";
    h.store.upsertScheduled({ ...h.row, model: OVERRIDE_MODEL, cwd });
    await h.make().runScheduledPrompt(h.row.id);
    expect(h.mux.rpc).toHaveBeenCalledWith("spawn", expect.objectContaining({ model: OVERRIDE_MODEL, effort: "high", cwd }), { agentId: "agy" });
    expect(h.calls.news[0]).toMatchObject({ cwd });
    expect(h.calls.configs).toContainEqual(expect.objectContaining({ configId: "model", value: OVERRIDE_MODEL }));
    expect(h.hub.rpc).toHaveBeenCalledWith(REMOTE, "deleteSession", { cwd, sessionId: "scheduled-acp" }, "agy");
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toBe("ok");
  });

  it.each(["no-connection", "no-hub", "spawn-rpc"])("reports %s honestly without local fallback, while local work remains usable", async failure => {
    const h = setup(), orch = h.make();
    if (failure === "no-connection") h.hub.get.mockReturnValue(undefined as any);
    if (failure === "no-hub") (orch as any).bridgeHub = undefined;
    if (failure === "spawn-rpc") h.mux.rpc.mockRejectedValue(new Error(`bridge "${REMOTE}" lost transport during spawn`));
    await orch.runScheduledPrompt(h.row.id);
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.calls.prompts).toEqual([]);
    const reason = failure === "spawn-rpc" ? `bridge "${REMOTE}" lost transport during spawn` : `bridge "${REMOTE}" is not connected`;
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toBe(`error: ${reason}`);
    expect(h.store.turnAttempts.list("completed")[0]?.outcome).toMatchObject({ status: "failed", error: reason });
    expect(h.adapter.sendPanel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "output" }),
      expect.objectContaining({ description: `❌ ${reason}`, fields: expect.arrayContaining([{ name: "Host", value: `\`${REMOTE}\``, inline: true }]) }), expect.anything());
    expect(h.calls.children.every(child => child.killed)).toBe(true);
    const local = setup("local"); await local.make().runScheduledPrompt(local.row.id);
    expect(local.localSpawn).toHaveBeenCalledTimes(1);
    expect(local.store.getScheduled(local.row.id)?.lastStatus).toBe("ok");
  });

  it("does not depend on #474 denying local spawn", async () => {
    const h = setup();
    const guarded = guardLocalProfileSpawn(h.profile, parseAgentLocationDeny("agy@local"));
    h.profile.spawn = guarded.spawn;
    await h.make().runScheduledPrompt(h.row.id);
    expect(h.remoteSpawn).toHaveBeenCalledTimes(1);
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toBe("ok");
  });

  it("recovers the same remote occurrence and recorded session with continue, never replacement work", async () => {
    const h = setup(); simulateRetiredOwnerProcess();
    const first = h.make(), key = scheduledOccurrenceKey(h.row.id);
    h.onPrompt.mockImplementationOnce(async () => { first.suspendForRestart(); throw new Error("interrupted"); });
    await first.runScheduledPrompt(h.row.id, key);
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ state: "suspended", acpSessionId: "scheduled-acp", promptStarted: true });
    expect(h.hub.rpc).not.toHaveBeenCalled();
    expect(h.calls.children[0].killed).toBe(true);
    await h.make().runScheduledPrompt(h.row.id, key);
    expect(h.localSpawn).not.toHaveBeenCalled();
    expect(h.remoteSpawn).toHaveBeenCalledTimes(2);
    expect(h.calls.news).toHaveLength(1);
    expect(h.calls.loads).toEqual([expect.objectContaining({ sessionId: "scheduled-acp", cwd: h.cwd })]);
    const sent = h.calls.prompts.map(p => p.prompt[0].text as string);
    expect(sent[0]).toBe(h.row.promptText);
    expect(sent[1]?.startsWith("continue\n")).toBe(true);
    expect(sent[1]).toContain("The process restarted while the turn was in flight.");
    expect(sent[1]).toContain(`The session runs on ${REMOTE}. This resume does not include that host's git state.`);
    expect(sent[1]).not.toContain("ORIGINAL SCHEDULE");
    expect(h.store.turnAttempts.get(key.id)).toMatchObject({ state: "completed", generation: 2, deliveryDone: true });
    expect(h.store.scheduledOccurrences.get(key.id)).toMatchObject({ settled: true, execution: { location: REMOTE } });
    expect(h.hub.rpc).toHaveBeenCalledTimes(1);
  });
});
