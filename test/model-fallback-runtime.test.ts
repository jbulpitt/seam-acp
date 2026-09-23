import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { readErrorClassification, unclassified, type AgentProfile } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import type { ModelFallbackPlan } from "../packages/core/src/core/model-fallback.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ModelMetadata } from "../packages/core/src/core/model-metadata/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const logger = pino({ level: "silent" });
const profile = { id: "claude", defaultModel: "original",
  classifyError: (error: unknown) => readErrorClassification(error) ?? unclassified("claude"),
  spawn: () => { throw new Error("No provider process allowed in this test"); },
} as unknown as AgentProfile;
const rejection = (kind = "model_not_found") => Object.assign(new Error(`provider rejected selection: ${kind}`),
  { data: { errorKind: kind, agentId: "claude" } });
const fallback = (): ModelFallbackPlan => ({ version: 1, agentId: "claude", location: "local",
  requestedModel: "original", requiredContextTokens: 400_000,
  alternatives: [{ model: "sibling", normalizedModel: "sibling", applicationMode: "live", contextWindow: 1_000_000,
    notice: "Model fallback: original → sibling; intelligence index -1; price 0.8×; context 1000000 tokens." }] });

function connection(fail: (model: string) => unknown = model => model === "original" ? rejection() : undefined) {
  return {
    newSession: vi.fn(async () => ({ sessionId: "same-session", configOptions: [] })),
    loadSession: vi.fn(async () => ({ configOptions: [] })),
    setSessionConfigOption: vi.fn(async ({ value }: { value: string }) => {
      const error = fail(value);
      if (error) throw error;
      return { configOptions: [] };
    }),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
  };
}
function runtime(plan = fallback(), fail?: (model: string) => unknown) {
  const compute = vi.fn(() => plan);
  const rt = new AgentRuntime({ profile, logger, modelFallbacks: compute });
  const conn = connection(fail);
  Object.assign(rt, { connection: conn, promptCapabilities: {} });
  return { rt, conn, compute };
}
const attempts = (conn: ReturnType<typeof connection>) => conn.setSessionConfigOption.mock.calls.map(([args]) => args.value);
afterEach(() => vi.restoreAllMocks());

describe("model selection fallback execution", () => {
  it("precomputes once, selects a sibling, preserves session identity and reports actual model plus delta", async () => {
    const { rt, conn, compute } = runtime();
    const events: AgentEvent[] = [];
    rt.onEvent(e => { events.push(e); });
    const result = await rt.newSession({ cwd: "/tmp", model: "original" });
    expect(attempts(conn)).toEqual(["original", "sibling"]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.mock.invocationCallOrder[0]).toBeLessThan(conn.setSessionConfigOption.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ sessionId: "same-session", currentModelId: "sibling" });
    expect(conn.newSession).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ kind: "recovery", message: fallback().alternatives[0]!.notice });
  });

  it("queues a startup substitution notice until the first prompt, even if the provider emits no updates", async () => {
    const { rt, conn } = runtime();
    await rt.newSession({ cwd: "/tmp", model: "original" });
    const events: AgentEvent[] = [];
    rt.onEvent(e => { events.push(e); });
    await rt.prompt("test");
    expect(events).toContainEqual({ kind: "recovery", message: fallback().alternatives[0]!.notice });
    expect(conn.prompt).toHaveBeenCalledTimes(1);
  });

  it("leaves a working request unchanged", async () => {
    const { rt, conn } = runtime(fallback(), () => undefined);
    await rt.newSession({ cwd: "/tmp", model: "original" });
    expect(attempts(conn)).toEqual(["original"]);
    expect(rt.getLastModelFallbackNotice()).toBeUndefined();
  });

  it.each(["auth_required", "connection_closed", "cancelled", "unclassified"])("does not turn %s into a model retry", async kind => {
    const error = rejection(kind);
    const { rt, conn } = runtime(fallback(), () => error);
    await rt.newSession({ cwd: "/tmp" });
    conn.setSessionConfigOption.mockClear();
    await expect(rt.setModel("original")).rejects.toBe(error);
    expect(attempts(conn)).toEqual(["original"]);
  });

  it("never replenishes the candidate list and throws the final provider cause", async () => {
    const error = rejection();
    const { rt, conn, compute } = runtime(fallback(), () => error);
    await rt.newSession({ cwd: "/tmp" });
    conn.setSessionConfigOption.mockClear(); compute.mockClear();
    await expect(rt.setModel("original")).rejects.toBe(error);
    expect(attempts(conn)).toEqual(["original", "sibling"]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("preserves strict exact-model callers and does not execute reload/freshSession candidates in place", async () => {
    const strict = runtime();
    await expect(strict.rt.newSession({ cwd: "/tmp", model: "original", strictModel: true })).rejects.toThrow("failed to set initial model");
    expect(attempts(strict.conn)).toEqual(["original"]);
    expect(strict.compute).not.toHaveBeenCalled();
    for (const applicationMode of ["reload", "freshSession"] as const) {
      const plan = fallback(); plan.alternatives[0]!.applicationMode = applicationMode;
      const { rt, conn } = runtime(plan);
      await rt.newSession({ cwd: "/tmp" });
      conn.setSessionConfigOption.mockClear();
      await expect(rt.setModel("original")).rejects.toThrow("model_not_found");
      expect(attempts(conn)).toEqual(["original"]);
    }
  });
});

describe("production router → real runtime → synthetic ACP model boundary", () => {
  it("uses metadata in production wiring, refreshes warm selections, and never changes the session", async () => {
    const record: SessionRecord = { id: "discord:fallback", platform: "discord", channelRef: "fallback", parentRef: "parent",
      agentId: "claude", acpSessionId: "", repoPath: "/tmp", configJson: JSON.stringify({ model: "original" }),
      createdUtc: "2026-09-21", updatedUtc: "2026-09-21" };
    const store = { get: () => record, upsert: (r: SessionRecord) => Object.assign(record, r),
      needsAgyIdentityRebuild: () => false, lookupAgentChannelRestriction: () => ({ state: "absent" }),
      readConfig: (r: SessionRecord) => JSON.parse(r.configJson),
    } as unknown as SessionStore;
    const boundProfile = { ...profile, staticModels: ["original", "sibling"].map(modelId => ({ modelId, name: modelId, contextLimit: 1_000_000 })) };
    const modelCatalog = fixtureModelCatalog([boundProfile]);
    const row = (id: string): ModelMetadata => ({ id, name: id, aliases: [], slug: null, source_id: null, source_name: null,
      provider: "Vendor", creator: null, agents: ["claude"], agent_models: [], context_window: 1_000_000,
      intelligence_index: 60, benchmarks: {}, pricing: null, released_at: "2026-09-01", description: null,
      evidence: [], source: "fixture", fetched_at: "2026-09-21" });
    let rows = [row("original"), row("sibling")];
    const conn = connection();
    vi.spyOn(AgentRuntime.prototype, "start").mockImplementation(async function () {
      Object.assign(this, { connection: conn, promptCapabilities: {} });
    });
    const router = new SessionRouter({ logger, store, profiles: [boundProfile], modelCatalog,
      modelMetadata: { getAll: () => rows }, defaultAgentId: "claude", defaultModel: "original" });
    const rt = await router.getOrStartRuntime(record);
    expect(attempts(conn)).toEqual(["original", "sibling"]);
    expect(rt.getSessionInfo()).toMatchObject({ sessionId: "same-session", currentModelId: "sibling" });
    expect(record.acpSessionId).toBe("same-session");

    // A published replacement is visible to the already-warm runtime BEFORE
    // the next selection. No provider metadata call or error-time discovery.
    boundProfile.staticModels[1] = { modelId: "replacement", name: "replacement", contextLimit: 1_000_000 };
    rows = [row("original"), row("replacement")];
    conn.setSessionConfigOption.mockClear();
    await rt.setModel("original");
    expect(attempts(conn)).toEqual(["original", "replacement"]);
    // Startup now gives the acquisition owner spawn/reload candidates too.
    // Both empty sessions precede any prompt; the warm switch creates none.
    expect(conn.newSession).toHaveBeenCalledTimes(2);
    expect(conn.prompt).not.toHaveBeenCalled();
    expect(rt.getSessionInfo()?.sessionId).toBe("same-session");

    // A legacy/unrelated usage sample must not make this large session appear
    // to need only 2 tokens. Reuse the existing context-budget identity fence.
    const usage = { used: 1, size: 2, model: "original", atUtc: "2026-09-21",
      budget: { agentId: "claude", location: "local", acpSessionId: "another-session", model: "original",
        requestedTier: null, observedTier: null, used: 1, promptBudget: 2, totalWindow: null,
        outputAllocation: null, source: "acp-usage", atUtc: "2026-09-21", previousPromptBudget: null } };
    record.configJson = JSON.stringify({ model: "original", lastContextUsage: usage });
    expect(router.planRuntimeSpawn(record).fallbackContextTokens).toBeNull();
    usage.budget.acpSessionId = record.acpSessionId;
    record.configJson = JSON.stringify({ model: "original", lastContextUsage: usage });
    expect(router.planRuntimeSpawn(record).fallbackContextTokens).toBe(2);
    record.configJson = JSON.stringify({ model: "original", lastContextUsage: { ...usage, budget: undefined } });
    expect(router.planRuntimeSpawn(record).fallbackContextTokens).toBeNull();
  });
});
