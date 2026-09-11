import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { AgentRuntime, type AgentEvent, type AgentEventHandler } from "../packages/core/src/agents/agent-runtime.js";
import { resolveContextWindow } from "../packages/core/src/core/context-window.js";
import { matchesContextBudget, type ContextBudgetIdentity } from "../packages/core/src/core/context-budget.js";
import { copilotRequestedContextTier, makeCopilotProfile } from "../packages/adapters/src/profiles/copilot.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";

const identity: ContextBudgetIdentity = {
  agentId: "copilot", location: "local", acpSessionId: "synthetic-session",
  model: "gpt-6-astra", requestedTier: null,
};
const measurement = (over = {}) => ({
  ...identity, used: 30_000, promptBudget: 272_000, totalWindow: null,
  outputAllocation: null, observedTier: null, source: "acp-usage" as const,
  atUtc: "2026-09-11T00:00:00Z", ...over,
});
let dir: string;
let store: SessionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-context-budget-"));
  store = new SessionStore(path.join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("qualified context budget observations", () => {
  // Each row prevents total/output allocations or another provider's effective limit becoming input capacity.
  it.each([
    ["copilot", "gpt-6-astra", 400_000, 272_000, 128_000],
    ["copilot", "gpt-5.6-sol", 400_000, 272_000, 128_000],
    ["copilot", "claude-sonnet-5", 264_000, 200_000, 64_000],
    ["copilot", "claude-opus-5", 264_000, 200_000, 64_000],
    ["copilot", "gemini-3.8-flash", 265_536, 200_000, 65_536],
    ["codex", "gpt-6-astra", null, 258_400, null],
    ["claude", "claude-opus-5", null, 1_000_000, null],
  ] as const)("keeps %s %s dimensions separate", (agentId, model, totalWindow, promptBudget, outputAllocation) => {
    // Explicit fixture dimensions model an already sourced measurement, not a live catalog/provider probe.
    const observation = store.contextBudgets.record(measurement({ agentId, model, totalWindow, promptBudget, outputAllocation }));
    const read = store.contextBudgets.get({ ...identity, agentId, model });
    expect(read).toMatchObject({ totalWindow, promptBudget, outputAllocation, observedTier: null });
    const resolved = resolveContextWindow({
      agentId, model, identity: observation,
      lastContextUsage: { model, size: promptBudget, budget: observation },
      catalogModels: [{ modelId: model, contextLimit: 1_050_000 }],
    });
    expect(resolved.window).toBe(promptBudget);
  });

  // Removing any identity comparison lets a different execution (especially Codex vs Copilot) supply the budget.
  it.each([
    { agentId: "codex" }, { location: "office" }, { acpSessionId: "other-session" },
    { model: "gpt-5.6-sol" }, { requestedTier: "long_context" },
  ])("rejects reuse after identity change %j", (change) => {
    const observation = store.contextBudgets.record(measurement());
    const expected = { ...identity, ...change };
    expect(matchesContextBudget(observation, expected)).toBe(false);
    expect(store.contextBudgets.get(expected)).toBeUndefined();
    expect(() => resolveContextWindow({
      agentId: expected.agentId, model: expected.model, identity: expected,
      lastContextUsage: { model: identity.model, size: 272_000, budget: observation },
    })).toThrow(/cannot resolve/);
  });

  // Legacy bare ids and research totals are not evidence: deleting this test permits the original 258400/1050000 leak.
  it("fails closed for unqualified usage and cross-provider metadata", () => {
    expect(() => resolveContextWindow({
      ...identity, identity,
      lastContextUsage: { model: identity.model, size: 1_050_000 },
      metadataBudget: { ...identity, agentId: "codex", promptBudget: 258_400 },
    })).toThrow(/cannot resolve/);
  });

  // Lower served capacity must replace (not max with) prior capacity and remain readable after restart.
  it("persists a smaller budget and its previous value across reopening SQLite", () => {
    store.contextBudgets.record(measurement());
    store.contextBudgets.record(measurement({ promptBudget: 200_000, used: 0 }));
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.contextBudgets.get(identity)).toMatchObject({
      promptBudget: 200_000, previousPromptBudget: 272_000, used: 0,
    });
  });

  // Requested tier is not observed tier; removing the tier key makes a launch change reuse prior capacity.
  it("keeps default, long-context and acknowledged tiers independent", () => {
    for (const requestedTier of [null, "default", "long_context"]) {
      store.contextBudgets.record(measurement({ requestedTier }));
    }
    store.contextBudgets.record(measurement({ requestedTier: "long_context", observedTier: "default", promptBudget: 200_000 }));
    expect(store.contextBudgets.get({ ...identity, requestedTier: "long_context" })?.observedTier).toBeNull();
    expect(store.contextBudgets.get({ ...identity, requestedTier: "long_context" }, "default")?.promptBudget).toBe(200_000);
    expect(store.contextBudgets.get({ ...identity, requestedTier: "default" })?.promptBudget).toBe(272_000);
  });

  // Invalid telemetry cannot corrupt JSON/SQLite with null NaNs or unusable capacity.
  it.each([{ promptBudget: 0 }, { promptBudget: NaN }, { used: -1 }, { used: Infinity }, { acpSessionId: "" },
    { totalWindow: Infinity }, { outputAllocation: -1 }, { requestedTier: "" }, { observedTier: "" }])(
    "rejects invalid measurements %j", (change) => {
      expect(() => store.contextBudgets.record(measurement(change))).toThrow(/Invalid context/);
      expect(store.contextBudgets.get(identity)).toBeUndefined();
    }
  );

  // Flag parsing records only optional launch intent; assuming success would fabricate an ACP tier acknowledgment.
  it("records both CLI flag forms without treating the request as observed", () => {
    expect(copilotRequestedContextTier([])).toBeUndefined();
    expect(copilotRequestedContextTier(["--context", "default"])).toBe("default");
    expect(copilotRequestedContextTier(["--context=long_context"])).toBe("long_context");
    expect(copilotRequestedContextTier(["--context", "unknown"])).toBeUndefined();
    const profile = makeCopilotProfile({
      defaultModel: identity.model, acpArgs: ["--acp", "--context", "long_context"], environment: {},
    });
    expect(profile.requestedContextTier).toBe("long_context");
    expect(profile.describe().requestedContextTier).toBe("long_context");
    expect(store.contextBudgets.record(measurement({ requestedTier: profile.requestedContextTier })).observedTier).toBeNull();
  });
});

function injectionFixture() {
  const profile = { id: identity.agentId, defaultModel: identity.model, requestedContextTier: undefined,
    spawn: () => { throw new Error("live process forbidden in offline test"); } };
  const record: SessionRecord = {
    id: "discord:synthetic-thread", platform: "discord", channelRef: "synthetic-thread",
    parentRef: null, agentId: identity.agentId, acpSessionId: identity.acpSessionId, repoPath: dir,
    configJson: "{}", createdUtc: "2026-09-11T00:00:00Z", updatedUtc: "2026-09-11T00:00:00Z",
  };
  store.upsert(record);
  let events: AgentEvent[] = [{ kind: "usage-update", used: 30_000, size: 272_000 }];
  let handler: AgentEventHandler | undefined;
  const runtime = {
    onEvent(h: AgentEventHandler) { handler = h; },
    async prompt() { for (const event of events) await handler?.(event); return { stopReason: "end_turn" }; },
    getSessionInfo: () => ({ sessionId: identity.acpSessionId }),
  };
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  Object.assign(orch, {
    store, logger: pino({ level: "silent" }), adapter: {}, config: { REPOS_ROOT: dir },
    modelCatalog: fixtureModelCatalog([profile as never]),
    router: {
      describeConfig: (rec: SessionRecord) => ({
        agent: { value: rec.agentId }, location: { value: "local" },
        model: { value: identity.model },
      }),
      getProfile: () => profile,
      assertAgentAllowedForChannel: () => {},
      getOrStartRuntime: async () => runtime,
    },
  });
  return { orch, record, profile, runtime, setEvents: (next: AgentEvent[]) => { events = next; } };
}

describe("real injection recording, offline runtime only", () => {
  // Without the ordinary receipt-time writer, interrupted turns lose observations and side-channel estimates can inflate them.
  it("ordinary turns retain the same observation despite a larger inferred side-channel limit", async () => {
    const { record, runtime, profile, setEvents } = injectionFixture();
    const logs: string[] = [];
    const prompts = vi.spyOn(runtime, "prompt");
    const panels: unknown[] = [];
    Object.assign(profile, { sessionManager: {
      getUsage: async () => ({ model: identity.model, totalUsed: 31_000, contextLimit: 400_000 }),
    } });
    Object.assign(runtime, {
      idle: async () => {},
      getFastModeOutcome: () => undefined, getPromptCapabilities: () => ({}),
      getProcessId: () => undefined, getProviderIdentity: () => "synthetic",
    });
    setEvents([{ kind: "usage-update", used: 30_000, size: 272_000 },
      { kind: "usage-update", used: 0, size: 200_000 }]);
    const orch = new Orchestrator({
      logger: pino({ level: "debug" }, { write: (line: string) => { logs.push(line); } }) as never,
      store, modelCatalog: fixtureModelCatalog([profile as never]),
      renderer: discordRenderer,
      config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60, REPO_EMOJIS: new Map(),
        DEFAULT_MODEL: identity.model, channelPresets: new Map(), threadPresets: new Map() } as never,
      router: {
        listProfiles: () => [profile], ensureSessionRecord: () => store.get(record.id)!, getProfile: () => profile,
        assertAgentAllowedForRecord: () => {},
        getOrStartRuntime: async () => runtime,
        describeConfig: () => ({
          agent: { value: identity.agentId }, location: { value: "local" }, model: { value: identity.model },
          effort: { value: null }, cwd: { value: dir }, fastMode: { value: false },
        }),
      } as never,
      adapter: {
        async sendPanel(channel: unknown, panel: unknown) { panels.push(panel); return { channel, id: "panel" }; },
        async editPanel(_ref: unknown, panel: unknown) { panels.push(panel); },
        async sendMessage(channel: unknown) { return { channel, id: "message" }; },
        async editMessage() {}, async sendFile() {},
      } as never,
    });
    await (orch as any).handleIncomingMessageInner({
      messageId: "synthetic-message", channel: { platform: "discord", id: record.channelRef },
      authorId: "synthetic-user", authorIsBot: false, text: "offline fixture",
    });
    expect(store.readConfig(store.get(record.id)!).lastContextUsage?.budget)
      .toMatchObject({ ...identity, promptBudget: 200_000, used: 0, previousPromptBudget: 272_000 });
    expect(JSON.stringify(panels.at(-1))).toContain("200k");
    expect(JSON.stringify(panels.at(-1))).not.toContain("400k");
    // Unlike an inferred limit, a fresh measured side-channel limit may replace the preceding turn's budget.
    Object.assign(profile, { sessionManager: {
      getUsage: async () => ({ model: identity.model, totalUsed: 17, contextLimit: 180_000, contextLimitSource: "observed" }),
    } });
    setEvents([]);
    await (orch as any).handleIncomingMessageInner({
      messageId: "synthetic-measured-message", channel: { platform: "discord", id: record.channelRef },
      authorId: "synthetic-user", authorIsBot: false, text: "offline measured turn",
    });
    // Assert actual turn execution; otherwise an early setup/transport failure can make cached-value checks pass vacuously.
    expect(prompts, logs.join("\n")).toHaveBeenCalledTimes(2);
    expect(store.readConfig(store.get(record.id)!).lastContextUsage?.budget, logs.join("\n"))
      .toMatchObject({ promptBudget: 180_000, source: "session-usage", previousPromptBudget: 200_000 });
    // A quiet subsequent turn must not replace a matching cached observation with a larger inference.
    Object.assign(profile, { sessionManager: {
      getUsage: async () => ({ model: identity.model, totalUsed: 31_000, contextLimit: 400_000 }),
    } });
    setEvents([]);
    await (orch as any).handleIncomingMessageInner({
      messageId: "synthetic-next-message", channel: { platform: "discord", id: record.channelRef },
      authorId: "synthetic-user", authorIsBot: false, text: "offline next turn",
    });
    expect(JSON.stringify(panels.at(-1))).toContain("180k");
    expect(JSON.stringify(panels.at(-1))).not.toContain("400k");
    // All three runs must reach normal completion, including the inferred and measured side-channel reads.
    expect(prompts, logs.join("\n")).toHaveBeenCalledTimes(3);
    expect(logs.filter(line => line.includes('"level":50'))).toEqual([]);
  });

  // Removing the inject handler write loses dispatch telemetry whenever the UI is off or fails to post (#292).
  it("persists a silent live dispatch into both qualified storage and the thread cache", async () => {
    const { orch, record } = injectionFixture();
    expect(await orch.injectTurn(record, "synthetic", { session: "live" })).toMatchObject({ stopReason: "end_turn" });
    const budget = store.contextBudgets.get(identity);
    expect(budget).toMatchObject({ ...identity, used: 30_000, promptBudget: 272_000, totalWindow: null, outputAllocation: null });
    expect(store.readConfig(store.get(record.id)!).lastContextUsage?.budget).toEqual(budget);
  });

  // Isolated dispatches need their own durable row; removing isolation corrupts the authoring/live session cache.
  it("retains isolated telemetry without overwriting the authoring thread", async () => {
    const { orch, record, profile, runtime } = injectionFixture();
    vi.spyOn(AgentRuntime.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(AgentRuntime.prototype, "newSession").mockResolvedValue({ sessionId: "isolated-session" } as never);
    vi.spyOn(AgentRuntime.prototype, "getSessionInfo").mockReturnValue({ sessionId: "isolated-session" } as never);
    vi.spyOn(AgentRuntime.prototype, "onEvent").mockImplementation(runtime.onEvent);
    vi.spyOn(AgentRuntime.prototype, "prompt").mockImplementation(runtime.prompt as never);
    vi.spyOn(AgentRuntime.prototype, "dispose").mockResolvedValue(undefined);
    expect(await orch.injectTurn(record, "synthetic", {
      session: "isolated", profile: profile as never, cwd: dir, location: "local",
    })).toMatchObject({ stopReason: "end_turn" });
    expect(store.contextBudgets.get({ ...identity, acpSessionId: "isolated-session" })?.promptBudget).toBe(272_000);
    expect(store.readConfig(store.get(record.id)!).lastContextUsage).toBeUndefined();
  });

  // No current-owner check means teardown callbacks from a retired attempt can publish misleading measurements.
  it("ignores old-attempt callbacks and prevents old-session cache overwrite", async () => {
    const { orch, record } = injectionFixture();
    await orch.injectTurn(record, "synthetic", {
      session: "live", lifecycle: { isCurrent: () => false, beforePrompt() {}, onOutcome() {} } as never,
    });
    expect(store.contextBudgets.get(identity)).toBeUndefined();
    store.upsert({ ...record, acpSessionId: "replacement-session" });
    await orch.injectTurn(record, "synthetic", { session: "live" });
    expect(store.contextBudgets.get(identity)?.promptBudget).toBe(272_000);
    expect(store.readConfig(store.get(record.id)!).lastContextUsage).toBeUndefined();
  });

  // Recording after model/tier selection changes must not silently reuse the old model's key.
  it("records the runtime model and new launch-tier key, not the preceding execution", async () => {
    const { orch, record, profile, setEvents } = injectionFixture();
    await orch.injectTurn(record, "synthetic", { session: "live" });
    Object.assign(profile, { requestedContextTier: "long_context" });
    setEvents([{ kind: "model-changed", modelId: "gpt-5.6-sol" }, { kind: "usage-update", used: 42, size: 200_000 }]);
    await orch.injectTurn(record, "synthetic", { session: "live" });
    expect(store.contextBudgets.get({ ...identity, model: "gpt-5.6-sol", requestedTier: "long_context" }))
      .toMatchObject({ promptBudget: 200_000, requestedTier: "long_context", observedTier: null });
    expect(store.contextBudgets.get(identity)?.promptBudget).toBe(272_000);
  });
});
